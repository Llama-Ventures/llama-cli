#!/usr/bin/env node

// llama-mcp — stdio MCP server for Llama Command. Pairs with the `llama`
// CLI in the same package; both share auth + HTTP via lib/client.mjs.
//
// Wire into Claude Code / Cursor / Claude Desktop / OpenClaw via your
// agent's MCP config — see README for snippets. Auth is identical to the
// CLI: gcloud (preferred) → $LLAMA_TOKEN → ~/.llama/token.

import { createRequire } from "module";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  getAuthHeaders,
  getBaseUrl,
  readBriefing,
  request,
  requestSse,
  setClientRuntime,
} from "../lib/client.mjs";

const requireFromHere = createRequire(import.meta.url);
const { version: PKG_VERSION } = requireFromHere("../package.json");
import {
  clearExternalSession,
  getExternalSessionStatus,
  sendExternalMessage,
  startExternalSession,
  uploadExternalFile,
} from "../lib/external.mjs";

setClientRuntime({ client: "mcp" });

function newHtmlUploadId() {
  return `mcp-${randomUUID()}`;
}

function normalizeUploadId(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const id = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
    throw new Error("clientUploadId must be 1-128 chars: letters, numbers, dot, underscore, colon, or hyphen");
  }
  return id;
}

// Wrap a request() call into the MCP CallToolResult shape. Catches errors
// (NO_AUTH / 401 / 5xx / network) and surfaces them as `isError: true`
// content so the calling agent sees a clean error string instead of the
// MCP transport closing.
async function callApi(method, path, body, opts = {}) {
  try {
    const result = await request(method, path, body, opts);
    const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    return { content: [{ type: "text", text }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err?.message ?? String(err)}` }],
      isError: true,
    };
  }
}

function textResult(text, isError = false) {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

function jsonResult(value, isError = false) {
  return textResult(JSON.stringify(value, null, 2), isError);
}

function splitSources(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value || value === true) return undefined;
  return String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildEnrichmentAgentMessage(args = {}) {
  if (args.message) return String(args.message);
  const sources = splitSources(args.sources) ?? [
    "website",
    "github",
    "linkedin",
    "yc",
    "launch",
    "web",
    "monid",
  ];
  const budget = args.budgetCents ?? "50";
  const memo = args.generateMemo
    ? "Generate memo only after enrichment because the caller explicitly requested it."
    : "Do not generate memo.";
  return [
    "Run server-side deal enrichment for this deal.",
    `Use sources: ${sources.join(", ")}.`,
    `Private Monid budget cap: ${budget} cents.`,
    "Read the enrichment harness first, then collect current company/founder evidence.",
    "Write canonical evidence links, sourced deal facts, stable deal fields, and typed factual values where supported.",
    "For typed factual values, call read_typed_factual_layer first and use upsert_typed_fact for queryable fields.",
    "Search snippets alone are not high-confidence evidence; fetch direct sources where possible.",
    memo,
    "End with what was written, what was skipped, and open questions.",
  ].join(" ");
}

function summarizeAgentEvents(events = []) {
  return events
    .flatMap((event) => {
      if (event.tool_use?.name) return [{ type: "tool_use", name: event.tool_use.name }];
      if (event.tool_result?.name) {
        return [
          {
            type: "tool_result",
            name: event.tool_result.name,
            ok: event.tool_result.ok ?? null,
            summary: event.tool_result.summary ?? null,
          },
        ];
      }
      if (event.error) return [{ type: "error", error: String(event.error) }];
      return [];
    })
    .slice(-80);
}

async function runDealAgentTool({ dealId, message, title = "MCP agent run" }) {
  try {
    const thread = await request("POST", `/api/deals/${encodeURIComponent(dealId)}/threads`, { title });
    if (!thread?.id) throw new Error("Thread creation did not return an id");
    const result = await requestSse(
      "POST",
      `/api/deals/${encodeURIComponent(dealId)}/threads/${encodeURIComponent(thread.id)}`,
      { message },
    );
    return textResult(
      JSON.stringify(
        {
          ok: true,
          threadId: thread.id,
          text: result.text,
          toolEvents: summarizeAgentEvents(result.events),
        },
        null,
        2,
      ),
    );
  } catch (err) {
    return textResult(`Error: ${err?.message ?? String(err)}`, true);
  }
}

// Append a block to a deal brief. The /blocks route only accepts atomic
// full-array PUTs (no POST), so we GET current blocks, prepend the new
// one (matches UI default since 2026-05-03), and PUT the merged array.
// Server stamps identity meta on PUT; we don't send any.
async function addBriefBlock(dealId, block) {
  try {
    const id = globalThis.crypto.randomUUID();
    const cur = await request("GET", `/api/deals/${encodeURIComponent(dealId)}/blocks`);
    const existing = Array.isArray(cur?.blocks) ? cur.blocks : [];
    const result = await request(
      "PUT",
      `/api/deals/${encodeURIComponent(dealId)}/blocks`,
      { blocks: [{ id, ...block }, ...existing] }
    );
    const text = JSON.stringify(
      { ok: result?.ok ?? true, id, count: result?.count ?? existing.length + 1 },
      null,
      2
    );
    return { content: [{ type: "text", text }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err?.message ?? String(err)}` }],
      isError: true,
    };
  }
}

const server = new McpServer({
  name: "llama-mcp",
  version: PKG_VERSION,
});

// ============================================================
// Auth + diagnostics
// ============================================================

server.registerTool(
  "auth_status",
  {
    description:
      "Verify Llama Command credentials and return current user identity. " +
      "Call this first if any other tool returns Error[NO_AUTH] or Error[UNAUTHORIZED].",
    inputSchema: {},
  },
  async () => {
    const headers = await getAuthHeaders();
    if (Object.keys(headers).length === 0) {
      return {
        content: [
          {
            type: "text",
            text:
              "Error[NO_AUTH]: No credentials found. Mint a token at " +
              "https://command.llamaventures.vc/settings/tokens, then save the " +
              "llc_... value to ~/.llama/token (mode 0600), or set $LLAMA_TOKEN.",
          },
        ],
        isError: true,
      };
    }
    return callApi("GET", "/api/me");
  }
);

server.registerTool(
  "agent_bootstrap",
  {
    description:
      "Fetch the live Llama Command + Llama OS runtime manifest. Use this at " +
      "the start of an agent session to discover current skills, the skill " +
      "bundle version, and the object-inspection contract. Unlike the bundled " +
      "agent_briefing prompt, this comes from authenticated Command runtime.",
    inputSchema: {
      limit: z.number().optional().describe("number of skill summaries to include; default 25"),
    },
  },
  async ({ limit } = {}) => {
    const params = new URLSearchParams();
    params.set("clientVersion", PKG_VERSION);
    if (limit) params.set("limit", String(limit));
    return callApi("GET", `/api/agent/manifest${params.toString() ? `?${params}` : ""}`);
  }
);

server.registerTool(
  "skills_search",
  {
    description:
      "Search the authenticated Llama OS runtime skill library. Call this " +
      "before choosing a workflow for Llama pipeline/wiki/DD/research/ops tasks. " +
      "Returns summaries only; call skills_read for the exact SKILL.md.",
    inputSchema: {
      q: z.string().describe("workflow/task query, e.g. 'wiki delete tombstone' or 'deal DD memo'"),
      limit: z.number().optional().describe("default 20"),
    },
  },
  async ({ q, limit }) => {
    const params = new URLSearchParams({ q });
    if (limit) params.set("limit", String(limit));
    return callApi("GET", `/api/agent/skills?${params}`);
  }
);

server.registerTool(
  "pref_list",
  {
    description:
      "List standing agent preferences (team scope + the caller's user scope). " +
      "These are injected into every server-side agent turn. Use status=proposed " +
      "to review pending proposals awaiting approval.",
    inputSchema: {
      status: z.enum(["active", "proposed", "retired", "all"]).optional()
        .describe("filter; defaults to active"),
    },
  },
  async ({ status }) => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    return callApi("GET", `/api/agent/preferences${params.toString() ? `?${params}` : ""}`);
  }
);

server.registerTool(
  "pref_add",
  {
    description:
      "Save a standing preference so every Llama agent follows it from the next " +
      "turn on. Use when the user states a durable way they want agents to work " +
      "(style, workflow, defaults). Content is hard-capped at 280 chars — if it " +
      "does not fit, it is a procedure and belongs in a skill. Team scope needs " +
      "system-admin approval; own user scope activates immediately.",
    inputSchema: {
      key: z.string().describe("short slug, e.g. reply-style.conclusion-first"),
      content: z.string().describe("the preference, max 280 chars"),
      scope: z.enum(["user", "team"]).optional().describe("default user (the caller)"),
      evidence: z.string().optional().describe("what prompted this (run, correction)"),
    },
  },
  async ({ key, content, scope, evidence }) =>
    callApi("POST", "/api/agent/preferences", { key, content, scope, evidence })
);

server.registerTool(
  "pref_set_status",
  {
    description:
      "Approve (activate) or retire a standing preference by id. Own user scope " +
      "is self-service; team scope requires a system admin.",
    inputSchema: {
      id: z.number().describe("preference id from pref_list"),
      status: z.enum(["active", "retired"]).describe("new status"),
    },
  },
  async ({ id, status }) =>
    callApi("PATCH", `/api/agent/preferences/${encodeURIComponent(String(id))}`, { status })
);

server.registerTool(
  "skills_read",
  {
    description:
      "Read one runtime Llama OS skill by slug. Use after skills_search. " +
      "Returns the full SKILL.md content from Llama Command; public npm does " +
      "not bundle private skill text.",
    inputSchema: {
      slug: z.string().describe("skill slug, e.g. llama-command or llama-wiki"),
    },
  },
  async ({ slug }) => callApi("GET", `/api/agent/skills/${encodeURIComponent(slug)}`)
);

server.registerTool(
  "object_inspect",
  {
    description:
      "Explain a Llama Command URL or object id. Use for 404s, deleted wiki " +
      "pages, notifier links, deal URLs, brief blocks, HTML docs, and unknown " +
      "Command objects before guessing that the system is broken.",
    inputSchema: {
      q: z.string().optional().describe("URL or compact query, e.g. wiki:my-slug or a Command URL"),
      type: z.string().optional().describe("explicit object type if not using q"),
      id: z.string().optional().describe("explicit object id if not using q"),
      lang: z.enum(["en", "zh"]).optional().describe("wiki language; default en"),
    },
  },
  async ({ q, type, id, lang } = {}) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (type) params.set("type", type);
    if (id) params.set("id", id);
    if (lang) params.set("lang", lang);
    return callApi("GET", `/api/agent/explain?${params}`);
  }
);

server.registerTool(
  "activity_query",
  {
    description:
      "Read Command's curated agent activity projection. Use this before " +
      "scanning raw timelines or event-bus payloads. Examples: new deals in " +
      "the past 24h, deals with meaningful updates in the past 7d, or recent " +
      "fact/memo/brief events. Returns source ids so callers can drill down.",
    inputSchema: {
      kind: z
        .enum(["events", "new_deals", "updated_deals"])
        .default("events")
        .describe("events = raw curated rows; new_deals = deal.created; updated_deals = grouped meaningful deal updates"),
      since: z.string().optional().describe("24h, 7d, 30d, or ISO timestamp; default 24h"),
      limit: z.number().optional().describe("default 50, cap 100"),
      dealId: z.string().optional().describe("optional single deal UUID"),
      entity: z.enum(["deal", "wiki", "all"]).optional().describe("default deal"),
      verb: z.string().optional().describe("comma-separated activity verbs, e.g. fact.added,brief.revised"),
      cursor: z.number().optional().describe("pagination cursor from next_cursor"),
      minSignificance: z.number().optional().describe("1..3; default 2, new_deals default 3"),
    },
  },
  async ({ kind, since, limit, dealId, entity, verb, cursor, minSignificance } = {}) => {
    const params = new URLSearchParams({ kind: kind || "events" });
    if (since) params.set("since", since);
    if (limit) params.set("limit", String(limit));
    if (dealId) params.set("deal_id", dealId);
    if (entity) params.set("entity", entity);
    if (verb) params.set("verb", verb);
    if (cursor) params.set("cursor", String(cursor));
    if (minSignificance) params.set("min_sig", String(minSignificance));
    return callApi("GET", `/api/agent/activity?${params}`);
  }
);

// ============================================================
// Deals — read
// ============================================================

server.registerTool(
  "deal_search",
  {
    description:
      "Search the Llama Ventures deal pipeline. Fuzzy match on company name, " +
      "founders, description, founder info, notes, deal owner, source, source direction, and location. " +
      "Returns up to `limit` deals (default 200, cap 1000).",
    inputSchema: {
      q: z.string().optional().describe("fuzzy search query across all text fields"),
      companyName: z.string().optional().describe("fuzzy match on companyName only"),
      founder: z.string().optional().describe("fuzzy match on founders / founderInfo"),
      owner: z.string().optional().describe("fuzzy match on dealOwner"),
      status: z
        .string()
        .optional()
        .describe(
          "exact match on 'Our Stage' (Interested, Outreached, Sourced, First Meeting, Diligence, Partner Meeting, Term Sheet, Invested, Passed, Stalled, Future, Unknown). Interested means we want to record/track before contact; Outreached means contact was logged but no effective relationship/response exists yet."
        ),
      theirStage: z.string().optional().describe("exact match on 'Their Stage'"),
      stage: z
        .string()
        .optional()
        .describe(
          "exact match on Round (Pre-Seed, Seed, Series A, Series B, Series C+, Stealth)"
        ),
      sourceDirection: z
        .string()
        .optional()
        .describe("exact match on source direction: Inbound, Outbound, or Unknown"),
      limit: z.number().optional().describe("max results (default 200, cap 1000)"),
      offset: z.number().optional(),
    },
  },
  async (args = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(args)) {
      if (v != null && v !== "") params.set(k, String(v));
    }
    return callApi("GET", `/api/deals${params.toString() ? `?${params}` : ""}`);
  }
);

server.registerTool(
  "deal_show",
  {
    description:
      "Get the full canonical record for one deal by uuid. Includes status, " +
      "stage, founders, owner, source, sourceDirection, valuation, all whitelisted writable fields, " +
      "and the `extra` JSONB blob.",
    inputSchema: {
      dealId: z.string().describe("deal uuid"),
    },
  },
  async ({ dealId }) => callApi("GET", `/api/deals/${encodeURIComponent(dealId)}`)
);

// ============================================================
// Deals — write
// ============================================================

server.registerTool(
  "deal_create",
  {
    description:
      "Create a new pipeline deal. Source defaults to the caller's user record. " +
      "Owner assignment goes through the partner-approval queue (status: pending) " +
      "until a partner approves it via /partner/approvals.",
    inputSchema: {
      companyName: z.string(),
      description: z.string().optional().describe("one-liner: what they do"),
      website: z.string().optional(),
      founders: z.string().optional().describe("comma-separated names"),
      founderInfo: z.string().optional().describe("LinkedIn URLs / background blob"),
      stage: z
        .string()
        .optional()
        .describe("Pre-Seed | Seed | Series A | Series B | Series C+ | Stealth"),
      status: z
        .string()
        .optional()
        .describe(
          "Our Stage workflow position. Use Interested when we want to record/track before contact; use Outreached when we contacted/logged them and have no response/effective relationship; use Sourced only once there is a response, intro, meeting, or other real relationship signal."
        ),
      source: z.string().optional().describe("free-form sourced-by; exact team-member names also attach source_user_id"),
      dealOwner: z
        .string()
        .optional()
        .describe("owner override. Use an exact /api/field-options dealOwner value, a user email, or numeric user id."),
      sourceDirection: z
        .string()
        .optional()
        .describe("Separate direction tag: Inbound if the deal came into the firm; Outbound if Llama found/listed/reached out first; Unknown if unclear."),
      notes: z.string().optional(),
      location: z.string().optional(),
    },
  },
  async (args) => callApi("POST", "/api/deals/create", args)
);

server.registerTool(
  "deal_update",
  {
    description:
      "Update a single whitelisted field on a deal. Writable fields: status, theirStage, " +
      "notes, stage, dealOwner, source, sourceDirection, description, website, location, founders, " +
      "proposedAmount, roundSize, valuation, sector, subsector, foundedYear, leadInvestor, " +
      "investors. Logs a field_change event in deal_events.",
    inputSchema: {
      dealId: z.string(),
      field: z.string().describe("camelCase field name (see description for whitelist)"),
      value: z.union([z.string(), z.number(), z.null()]).describe("new value"),
    },
  },
  async ({ dealId, field, value }) =>
    callApi("POST", "/api/deals/update", { dealId, field, value })
);

// ============================================================
// Deal facts (research substrate + trust ladder)
// ============================================================

server.registerTool(
  "deal_ingest",
  {
    description:
      "Preferred write tool when one source yields multiple facts, or facts plus a Feed note. " +
      "Commits the packet atomically, canonicalizes fact categories, skips exact source-aware " +
      "duplicates, and is safe to retry with the same idempotencyKey. Use deal_fact_add only " +
      "for a genuinely single fact. Canonical categories: company_basics, team, product, market, " +
      "financials, fundraise, risk, milestone, meta.",
    inputSchema: {
      dealId: z.string(),
      idempotencyKey: z
        .string()
        .optional()
        .describe("Stable key for retries. If omitted, the server derives one from packet content."),
      source: z
        .object({
          kind: z.enum(["deck", "web", "meeting_note", "email", "human", "agent_inference"]).optional(),
          title: z.string().optional(),
          url: z.string().optional(),
          contentHash: z.string().optional(),
        })
        .optional(),
      facts: z
        .array(z.object({
          category: z.string(),
          claim: z.string(),
          source: z.string().optional(),
          sourceUrl: z.string().optional(),
          sourceKind: z.enum(["deck", "web", "meeting_note", "email", "human", "agent_inference"]).optional(),
          confidence: z.enum(["high", "medium", "low"]).optional(),
          attested: z.boolean().optional(),
        }))
        .max(50)
        .optional(),
      note: z.string().optional().describe("Opinion, impression, or context to add to the deal Feed."),
    },
  },
  async ({ dealId, ...packet }) => {
    // @core-api-operation POST /api/deals/{dealId}/ingest
    return callApi("POST", `/api/deals/${encodeURIComponent(dealId)}/ingest`, packet);
  }
);

server.registerTool(
  "deal_fact_list",
  {
    description:
      "List a deal's recorded facts (the research substrate). Each fact carries a " +
      "category, a claim, a source/sourceUrl, a confidence, and a trust rung (unverified → " +
      "agent-verified → human-vouched → endorsed) plus who/what recorded it.",
    inputSchema: {
      dealId: z.string(),
    },
  },
  async ({ dealId }) =>
    callApi("GET", `/api/deals/${encodeURIComponent(dealId)}/facts`)
);

server.registerTool(
  "deal_fact_add",
  {
    description:
      "Record a factual claim about a deal. RESPONSIBILITY: set `attested` honestly — " +
      "true ONLY if you actually verified the claim against its cited source (the fact " +
      "is then stored at trust level 'agent-verified'); false/omitted if you are relaying " +
      "something unconfirmed (stored 'unverified', which is the honest default). You CANNOT " +
      "mark a fact as human-confirmed — only a person can raise it to 'human-vouched'. " +
      "`confidence` is how certain the claim is; `attested` is whether YOU take responsibility " +
      "for having checked it. `source` is a human-readable provenance label; `sourceUrl` is a " +
      "canonical URL that round-trips as sourceUrl/source_url. Category is free text; common " +
      "values include founders | financials | product | market | team | company_basics | risk | fundraise | milestone | meta.",
    inputSchema: {
      dealId: z.string(),
      category: z.string(),
      claim: z.string(),
      source: z.string().optional().describe("where you found this (URL, 'deck p3', 'LinkedIn')"),
      sourceUrl: z.string().optional().describe("canonical URL for the evidence, if separate from source"),
      confidence: z.enum(["high", "medium", "low"]).optional(),
      attested: z
        .boolean()
        .optional()
        .describe("true → stored 'agent-verified'; false/omitted → 'unverified'. Answer honestly."),
    },
  },
  async ({ dealId, category, claim, source, sourceUrl, confidence, attested }) =>
    callApi("POST", `/api/deals/${encodeURIComponent(dealId)}/facts`, {
      category,
      claim,
      source: source ?? "",
      ...(sourceUrl ? { sourceUrl } : {}),
      confidence: confidence ?? "medium",
      attested: attested === true,
    })
);

server.registerTool(
  "deal_fact_verify",
  {
    description:
      "Verify a recorded fact. status='confirmed' vouches for it (raises to 'human-vouched'); " +
      "status='disputed' marks it contradicted. Trust-ladder guardrails apply server-side " +
      "(external-org callers are capped at 'unverified'; only Partners reach 'endorsed'). " +
      "Optionally pass correctedValue when disputing.",
    inputSchema: {
      dealId: z.string(),
      factId: z.union([z.string(), z.number()]),
      status: z.enum(["confirmed", "disputed"]),
      correctedValue: z.string().optional(),
    },
  },
  async ({ dealId, factId, status, correctedValue }) =>
    callApi(
      "PATCH",
      `/api/deals/${encodeURIComponent(dealId)}/facts/${encodeURIComponent(String(factId))}`,
      { status, ...(correctedValue !== undefined ? { correctedValue } : {}) }
    )
);

// ============================================================
// Brief blocks
// ============================================================

server.registerTool(
  "brief_blocks",
  {
    description:
      "List all brief blocks for a deal. Blocks are typed (text, link, embed, callout) " +
      "and ordered. Each has stable id, optional meta (locked, by_agent, sourceSection).",
    inputSchema: {
      dealId: z.string(),
    },
  },
  async ({ dealId }) =>
    callApi("GET", `/api/deals/${encodeURIComponent(dealId)}/blocks`)
);

server.registerTool(
  "deal_feed",
  {
    description:
      "The unified, time-sorted stream of every contribution to a deal — " +
      "facts + notes/discussion + legacy posts, merged at query time, newest first. " +
      "Shows contributions from ANYONE — a teammate, their AI assistant, or an " +
      "autonomous system agent; nothing is hidden. Each item carries `who` (the " +
      "accountable person, null only for principal-less system writes) and `agent` " +
      "(the assistant/system label when an AI did the writing, null when a human " +
      "typed it) so you can tell human-typed from assistant-drafted. The AI's " +
      "regenerable brief synthesis is NOT here (that's the Memo) — only " +
      "facts + discussion notes. Each item: kind (fact|note), ts, who, agent, " +
      "origin, text, and for facts: source + trust rung + category.",
    inputSchema: {
      dealId: z.string(),
    },
  },
  async ({ dealId }) =>
    callApi("GET", `/api/deals/${encodeURIComponent(dealId)}/feed`)
);

server.registerTool(
  "brief_add_text",
  {
    description:
      "Prepend a markdown text block to a deal brief. Supports markdown + mermaid diagrams.",
    inputSchema: {
      dealId: z.string(),
      heading: z.string().optional().describe("optional block heading"),
      body: z.string().describe("markdown body"),
    },
  },
  async ({ dealId, heading, body }) =>
    addBriefBlock(dealId, { type: "text", heading: heading ?? "", body })
);

server.registerTool(
  "brief_add_link",
  {
    description:
      "Prepend a link block to a deal brief. Server fetches og:image + title via /api/link-preview.",
    inputSchema: {
      dealId: z.string(),
      url: z.string(),
      label: z.string().optional().describe("optional human-readable label"),
    },
  },
  async ({ dealId, url, label }) =>
    addBriefBlock(dealId, { type: "link", url, label: label ?? "" })
);

server.registerTool(
  "brief_add_callout",
  {
    description:
      "Prepend a callout block to a deal brief. Use for emphasized insights or warnings.",
    inputSchema: {
      dealId: z.string(),
      tone: z.string().describe("insight | warning | info | success"),
      heading: z.string().optional(),
      body: z.string(),
    },
  },
  async ({ dealId, tone, heading, body }) =>
    addBriefBlock(dealId, { type: "callout", tone, heading: heading ?? "", body })
);

server.registerTool(
  "brief_edit",
  {
    description:
      "Edit an existing brief block in place. Pass only the fields you want to change " +
      "(heading/body/url/label/description/tone). Meta toggles: locked (protect from bulk " +
      "overwrite), hidden (fold), sourceSection (route watcher writes). Snapshots the prior " +
      "version to history (reversible via brief_restore_version).",
    inputSchema: {
      dealId: z.string(),
      blockId: z.string(),
      heading: z.string().optional(),
      body: z.string().optional(),
      url: z.string().optional(),
      label: z.string().optional(),
      description: z.string().optional(),
      tone: z.string().optional(),
      locked: z.boolean().optional(),
      hidden: z.boolean().optional(),
      sourceSection: z.string().optional(),
    },
  },
  async ({ dealId, blockId, heading, body, url, label, description, tone, locked, hidden, sourceSection }) => {
    const patch = {};
    for (const [k, v] of Object.entries({ heading, body, url, label, description, tone })) {
      if (v !== undefined) patch[k] = v;
    }
    const meta = {};
    if (locked !== undefined) meta.locked = locked;
    if (hidden !== undefined) meta.hidden = hidden;
    if (sourceSection !== undefined) meta.sourceSection = sourceSection;
    if (Object.keys(meta).length > 0) patch.meta = meta;
    return callApi(
      "PATCH",
      `/api/deals/${encodeURIComponent(dealId)}/blocks/${encodeURIComponent(blockId)}`,
      patch
    );
  }
);

server.registerTool(
  "brief_delete",
  {
    description:
      "Soft-delete a brief block (reversible via brief_restore). Locked blocks are refused.",
    inputSchema: { dealId: z.string(), blockId: z.string() },
  },
  async ({ dealId, blockId }) =>
    callApi("DELETE", `/api/deals/${encodeURIComponent(dealId)}/blocks/${encodeURIComponent(blockId)}`)
);

server.registerTool(
  "brief_restore",
  {
    description: "Restore a soft-deleted brief block.",
    inputSchema: { dealId: z.string(), blockId: z.string() },
  },
  async ({ dealId, blockId }) =>
    callApi("POST", `/api/deals/${encodeURIComponent(dealId)}/blocks/${encodeURIComponent(blockId)}/restore`)
);

server.registerTool(
  "brief_history",
  {
    description:
      "List the content-version history of a brief block (every overwrite is snapshotted). " +
      "Use the returned history id with brief_restore_version.",
    inputSchema: {
      dealId: z.string(),
      blockId: z.string(),
      limit: z.number().optional(),
    },
  },
  async ({ dealId, blockId, limit }) => {
    const qs = limit ? `?limit=${encodeURIComponent(String(limit))}` : "";
    return callApi(
      "GET",
      `/api/deals/${encodeURIComponent(dealId)}/blocks/${encodeURIComponent(blockId)}/history${qs}`
    );
  }
);

server.registerTool(
  "brief_restore_version",
  {
    description:
      "Restore a brief block to a specific historical version (find historyId via brief_history). " +
      "Itself reversible — the outgoing version is snapshotted before replacement.",
    inputSchema: {
      dealId: z.string(),
      blockId: z.string(),
      historyId: z.number(),
    },
  },
  async ({ dealId, blockId, historyId }) =>
    callApi(
      "POST",
      `/api/deals/${encodeURIComponent(dealId)}/blocks/${encodeURIComponent(blockId)}/history`,
      { history_id: historyId }
    )
);

// ============================================================
// Wiki (knowledge base)
// ============================================================

server.registerTool(
  "wiki_search",
  {
    description:
      "Search the Llama Ventures internal wiki — deal context, company profiles, " +
      "industry frameworks, partner-curated knowledge. Returns excerpts. " +
      "For full article content use `wiki_read`.",
    inputSchema: {
      q: z.string().describe("search query"),
    },
  },
  async ({ q }) => callApi("GET", `/api/wiki/search?q=${encodeURIComponent(q)}`)
);

server.registerTool(
  "wiki_read",
  {
    description:
      "Read a single wiki article from the configured Llama Command " +
      "deployment by exact slug. Returns title, frontmatter, full " +
      "markdown content, and rendered HTML.\n\n" +
      "USE THIS — DO NOT WebFetch — whenever the user gives you a " +
      "wiki URL whose path is `/wiki/<slug>`. Extract the slug from " +
      "the URL path and call this tool with it. WebFetch against the " +
      "browser URL goes through session-cookie auth — your agent " +
      "doesn't have one — so it will look like a permission denial " +
      "even though your token is fine.\n\n" +
      "If you only have a topic name, use `wiki_search` first to " +
      "find the slug.",
    inputSchema: {
      slug: z
        .string()
        .describe(
          "exact kebab-case slug — the last path segment of the wiki URL"
        ),
      lang: z
        .enum(["en", "zh"])
        .optional()
        .describe("article language (default 'en')"),
    },
  },
  async ({ slug, lang }) =>
    callApi(
      "GET",
      `/api/wiki/${encodeURIComponent(slug)}?lang=${lang === "zh" ? "zh" : "en"}`
    )
);

server.registerTool(
  "wiki_save",
  {
    description:
      "Create or update a wiki page — Llama's CROSS-DEAL / institutional " +
      "knowledge surface (sector landscape · market map · thesis · framework · " +
      "methodology · anything not tied to ONE specific deal). Renders at " +
      "/wiki/<slug>. " +
      "**Routing — decide BEFORE calling:** " +
      "(a) Deal-specific HTML (IC memo for X, dashboard for X) → use " +
      "`html_upload` instead, NOT this. " +
      "(b) Cross-deal / institutional (this tool) → /wiki/<slug>. " +
      "(c) Founder-facing public share → Netlify only when user explicitly " +
      "says so; Llama Command outranks Netlify for everything internal. " +
      "By default `content` is markdown with attribution blocks " +
      "(**[Name · YYYY-MM-DD · source · fact|opinion]**) for traceability. " +
      "Set `content_type: 'html'` to deploy a standalone HTML page as the " +
      "wiki entry (full-viewport sandboxed iframe takeover on /wiki/<slug>; " +
      "the HTML itself is the page — no wiki chrome). `sources` is a " +
      "separate citation list (URLs, doc names, or meeting references) — " +
      "at least one required; URLs inside `content` do not count. For HTML " +
      "asset bundles use the `llama wiki save --file ... --assets ...` CLI " +
      "path; MCP only supports single-file HTML.",
    inputSchema: {
      slug: z.string().describe("kebab-case slug"),
      title: z.string(),
      content: z
        .string()
        .describe(
          "body — markdown source by default, or raw HTML when content_type='html'"
        ),
      sources: z
        .array(z.string())
        .min(1)
        .describe(
          "citation list — URLs, doc names, or meeting references. At least one required."
        ),
      content_type: z
        .enum(["markdown", "html"])
        .optional()
        .describe(
          "'markdown' (default) renders via the wiki markdown pipeline. " +
            "'html' stores the body as a standalone HTML page (sandboxed iframe)."
        ),
    },
  },
  async ({ slug, title, content, sources, content_type }) =>
    callApi("POST", "/api/wiki/save", {
      slug,
      title,
      content,
      sources,
      ...(content_type ? { content_type } : {}),
    })
);

server.registerTool(
  "wiki_delete",
  {
    description:
      "Soft-delete a wiki page (reversible). The entry stops appearing in " +
      "reads / search / backlinks; for HTML entries the standalone page + " +
      "assets stop resolving too. Restore with wiki_restore. Use when the " +
      "user asks to remove / delete / retire a wiki entry.",
    inputSchema: {
      slug: z.string().describe("kebab-case slug"),
      lang: z.enum(["en", "zh"]).optional().describe("default: en"),
    },
  },
  async ({ slug, lang }) =>
    callApi(
      "DELETE",
      `/api/wiki/${encodeURIComponent(slug)}?lang=${lang === "zh" ? "zh" : "en"}`
    )
);

server.registerTool(
  "wiki_restore",
  {
    description:
      "Restore a soft-deleted wiki page (undo wiki_delete). Brings back the " +
      "entry + (for HTML entries) its standalone page and assets.",
    inputSchema: {
      slug: z.string().describe("kebab-case slug"),
      lang: z.enum(["en", "zh"]).optional().describe("default: en"),
    },
  },
  async ({ slug, lang }) =>
    callApi(
      "POST",
      `/api/wiki/${encodeURIComponent(slug)}/restore?lang=${lang === "zh" ? "zh" : "en"}`
    )
);

// ============================================================
// Timeline + posts
// ============================================================

server.registerTool(
  "timeline",
  {
    description:
      "Get the activity timeline for a deal — field changes, owner approvals, " +
      "brief edits, posts, watcher events. Append-only audit log.",
    inputSchema: {
      dealId: z.string(),
    },
  },
  async ({ dealId }) =>
    callApi("GET", `/api/deals/${encodeURIComponent(dealId)}/timeline`)
);

server.registerTool(
  "post",
  {
    description:
      "Post a message to a deal's timeline. Message can include @-mentions " +
      "(e.g. @<first-name> or @<email@llamaventures.vc>) — the system fires " +
      "email + inbox notifications to mentioned users.",
    inputSchema: {
      dealId: z.string(),
      message: z.string(),
    },
  },
  async ({ dealId, message }) =>
    callApi("POST", `/api/deals/${encodeURIComponent(dealId)}/posts`, { message })
);

// ============================================================
// Mentions / inbox
// ============================================================

server.registerTool(
  "mentions_list",
  {
    description:
      "List @-mentions. Default scope: unresolved mentions where the caller is the " +
      "recipient. Set everyone=true for team-wide visibility (mutual observability).",
    inputSchema: {
      everyone: z
        .boolean()
        .optional()
        .describe("if true, list all team mentions; otherwise just for the caller"),
      includeResolved: z
        .boolean()
        .optional()
        .describe("if true, also include already-resolved mentions"),
    },
  },
  async ({ everyone, includeResolved } = {}) => {
    const params = new URLSearchParams();
    if (everyone) params.set("everyone", "1");
    else params.set("for_me", "1");
    if (!includeResolved) params.set("unresolved", "1");
    return callApi("GET", `/api/mentions?${params}`);
  }
);

server.registerTool(
  "mentions_resolve",
  {
    description: "Mark an @-mention as resolved (clears it from the recipient's open cues).",
    inputSchema: { mentionId: z.union([z.string(), z.number()]) },
  },
  async ({ mentionId }) =>
    callApi("POST", `/api/mentions/${encodeURIComponent(String(mentionId))}/resolve`)
);

// ============================================================
// Brief refresh (signal-driven re-evaluation)
// ============================================================

server.registerTool(
  "deal_refresh_brief",
  {
    description:
      "Trigger a stale-section re-evaluation of a deal's brief. Pass force=true to bypass the " +
      "debounce. Returns a runId (or null if debounced / deal inactive).",
    inputSchema: {
      dealId: z.string(),
      force: z.boolean().optional(),
    },
  },
  async ({ dealId, force }) =>
    callApi(
      "POST",
      `/api/deals/${encodeURIComponent(dealId)}/refresh-brief${force ? "?force=1" : ""}`
    )
);

server.registerTool(
  "deal_agent_run",
  {
    description:
      "Run Llama Command's server-side Deal Agent inside a deal thread. " +
      "Use this when the user explicitly wants the service agent to execute " +
      "a deal-scoped task instead of the local MCP client doing the work.",
    inputSchema: {
      dealId: z.string().describe("deal uuid"),
      message: z.string().describe("task instruction for the server-side Deal Agent"),
      title: z.string().optional().describe("optional thread title; defaults to MCP agent run"),
    },
  },
  async ({ dealId, message, title }) =>
    runDealAgentTool({ dealId, message, title: title || "MCP agent run" })
);

server.registerTool(
  "deal_enrich",
  {
    description:
      "Run the Llama Command deal enrichment planner/trigger for one deal. " +
      "Default is dry-run: returns evidence plan, source plan, Monid budget/config " +
      "status, and planned writes without changing facts/links/memo. With " +
      "apply=true and executor=server_agent, this starts the server-side Deal " +
      "Agent unless harnessOnly=true. Set apply=true only when the user " +
      "explicitly wants the enrichment run recorded/applied. " +
      "generateMemo never defaults on; pass true only when the user explicitly asks " +
      "for Memo generation after enrichment.",
    inputSchema: {
      dealId: z.string().describe("deal uuid"),
      dryRun: z.boolean().optional().describe("default true unless apply=true"),
      apply: z.boolean().optional().describe("record/apply the enrichment intent server-side"),
      executor: z
        .enum(["server_agent", "external_agent", "planner"])
        .optional()
        .describe("who will execute the harness; server_agent starts Deal Agent when apply=true"),
      sources: z
        .array(z.enum(["website", "github", "linkedin", "yc", "launch", "web", "monid"]))
        .optional()
        .describe("source families to use; defaults to the standard enrichment set"),
      budgetCents: z
        .number()
        .int()
        .min(0)
        .max(500)
        .optional()
        .describe("Monid spend cap for this run, in cents; default is 50 when Monid is requested"),
      generateMemo: z
        .boolean()
        .optional()
        .describe("explicitly request memo regeneration after enrichment; default false"),
      harnessOnly: z
        .boolean()
        .optional()
        .describe("when true, return/apply the enrichment harness endpoint instead of starting Deal Agent"),
      message: z
        .string()
        .optional()
        .describe("optional override instruction for the server-side Deal Agent"),
    },
  },
  async ({ dealId, dryRun, apply, executor, sources, budgetCents, generateMemo, harnessOnly, message }) => {
    const effectiveExecutor = executor ?? "server_agent";
    if (apply === true && effectiveExecutor === "server_agent" && harnessOnly !== true) {
      return runDealAgentTool({
        dealId,
        title: "MCP enrichment",
        message: buildEnrichmentAgentMessage({ sources, budgetCents, generateMemo, message }),
      });
    }
    return callApi("POST", `/api/deals/${encodeURIComponent(dealId)}/enrich`, {
      dryRun,
      apply,
      executor: effectiveExecutor,
      sources,
      budgetCents,
      generateMemo,
    });
  }
);

// ============================================================
// External pitch (founder intake) — no Llama Command token required
// ============================================================
//
// These tools let an MCP-native agent (Claude Code / Cursor / OpenClaw /
// Codex / etc.) help its user pitch a company to Llama Ventures by relaying
// the conversation through our /api/external/* surface. True A2A: the
// founder's agent talks to ours, structured intake gets captured, and a
// 12-dimension verdict is returned.
//
// Anti-abuse rate limits are server-enforced. The MCP tools surface
// any server-side rejections as text back to the agent.

function asTextResult(text, isError = false) {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

server.registerTool(
  "pitch_start",
  {
    description:
      "Start a new pitch session with Llama Ventures' intake agent. Use this " +
      "when a founder (the user) wants to pitch their company to Llama. " +
      "Requires their name + email. Returns a session_id; the conversation " +
      "is then maintained via pitch_send_message until the agent finalizes. " +
      "Server-enforced rate limits apply (per-IP, per-email, per-session). " +
      "No Llama Command token needed.",
    inputSchema: {
      name: z.string().describe("the founder's full name (max 100 chars)"),
      email: z.string().describe("the founder's email (deliverable, not a disposable domain)"),
    },
  },
  async ({ name, email }) => {
    try {
      const session = await startExternalSession({ name, email });
      return asTextResult(
        JSON.stringify(
          {
            session_id: session.session_id,
            name: session.name,
            email: session.email,
            started_at: session.started_at,
            note: "Session active. Use pitch_send_message to relay the founder's pitch to Llama's intake agent. Use pitch_upload_file to attach decks / one-pagers. The intake agent will auto-finalize once it has enough signal.",
          },
          null,
          2
        )
      );
    } catch (err) {
      return asTextResult(`Error: ${err?.message ?? String(err)}`, true);
    }
  }
);

server.registerTool(
  "pitch_send_message",
  {
    description:
      "Relay a message from the founder to Llama Ventures' intake agent. " +
      "Returns the intake agent's reply. The intake agent will ask follow-up " +
      "questions, request files (use pitch_upload_file), and eventually " +
      "auto-finalize the pitch — at which point the response includes " +
      "`finalize_payload` with a confirmation_summary and a 12-dimension " +
      "verdict (overall green/yellow/red + per-dimension notes).",
    inputSchema: {
      message: z.string().describe("the founder's message (max 8000 chars)"),
    },
  },
  async ({ message }) => {
    try {
      const result = await sendExternalMessage(message);
      const out = {
        text: result.text,
        finalized: result.finalized,
        finalize_payload: result.finalize_payload,
      };
      return asTextResult(JSON.stringify(out, null, 2));
    } catch (err) {
      return asTextResult(`Error: ${err?.message ?? String(err)}`, true);
    }
  }
);

server.registerTool(
  "pitch_upload_file",
  {
    description:
      "Attach a file (deck, one-pager, deck PDF, screenshot, etc.) to the " +
      "active pitch session. Server allows pdf / pptx / ppt / docx / doc / " +
      "xlsx / xls / png / jpg / webp / heic / heif / txt / md, with " +
      "server-enforced size and per-session count limits. " +
      "Returns a drive_file_id; the intake agent will " +
      "pick the file up via list_uploaded_files / read_uploaded_file on its " +
      "next turn (so call pitch_send_message with a one-line note like " +
      "'I just uploaded our pitch deck' so the agent knows to look).",
    inputSchema: {
      path: z.string().describe("absolute or relative filesystem path to the file"),
    },
  },
  async ({ path: filePath }) => {
    try {
      const result = await uploadExternalFile(filePath);
      return asTextResult(JSON.stringify(result, null, 2));
    } catch (err) {
      return asTextResult(`Error: ${err?.message ?? String(err)}`, true);
    }
  }
);

server.registerTool(
  "pitch_status",
  {
    description:
      "Show the current pitch session state — session_id, started_at, idle " +
      "minutes, finalized flag. Useful when the agent isn't sure if a " +
      "session is still active.",
    inputSchema: {},
  },
  async () => {
    try {
      const status = getExternalSessionStatus();
      return asTextResult(JSON.stringify(status, null, 2));
    } catch (err) {
      return asTextResult(`Error: ${err?.message ?? String(err)}`, true);
    }
  }
);

server.registerTool(
  "pitch_finalize",
  {
    description:
      "Clear the local pitch session state. Note: this does not force the " +
      "server-side intake agent to finalize — the agent decides that on its " +
      "own once the pitch is sufficient. Use this for cleanup after a session " +
      "ends, or to abandon a session early. The server-side session will " +
      "naturally expire after the server's idle timeout.",
    inputSchema: {},
  },
  async () => {
    try {
      const before = getExternalSessionStatus();
      clearExternalSession();
      return asTextResult(
        JSON.stringify(
          {
            cleared: before.active,
            previous_session: before.active ? before : null,
            note: "Local pitch session state cleared. Server-side session may still be active until its idle timeout.",
          },
          null,
          2
        )
      );
    } catch (err) {
      return asTextResult(`Error: ${err?.message ?? String(err)}`, true);
    }
  }
);

// ============================================================
// Memo — long-form HTML investment memo (the Memo tab in the UI)
// ============================================================

server.registerTool(
  "memo_show",
  {
    description:
      "Fetch the current memo for a deal. Returns the envelope: memo " +
      "(html, version, source, updated_by, updated_at), mode " +
      "('composed' = server-generated, 'override' = hand-written), and " +
      "inflight (if a server-side regeneration is in progress). html " +
      "can be 50-100KB — be deliberate about including it in your reply.",
    inputSchema: {
      dealId: z.string().describe("deal uuid"),
    },
  },
  async ({ dealId }) =>
    callApi("GET", `/api/deals/${encodeURIComponent(dealId)}/memo`)
);

server.registerTool(
  "memo_regenerate",
  {
    description:
      "Trigger server-side regeneration of the deal memo. Synchronous: " +
      "returns the final result (version, model, duration_ms, degraded) " +
      "once the composer finishes. Typical duration 2-3 minutes. Use " +
      "tier='opus' for high-stakes deals (higher cost, deeper analysis). " +
      "Pass `instructions` to steer THIS regeneration (e.g. 'focus on team " +
      "risk', 'frame as a follow-on') — applied across all panels, never " +
      "overrides the facts or the verdict.",
    inputSchema: {
      dealId: z.string().describe("deal uuid"),
      tier: z
        .enum(["sonnet", "opus"])
        .optional()
        .describe("LLM tier (default: sonnet)"),
      instructions: z
        .string()
        .optional()
        .describe(
          "Free-text steering for this regeneration only, e.g. 'focus on team risk'. Applied to all panels; never overrides verified facts or the verdict anchor."
        ),
    },
  },
  async ({ dealId, tier, instructions }) =>
    callApi("POST", `/api/deals/${encodeURIComponent(dealId)}/memo`, {
      action: "regenerate",
      stream: false,
      model: tier ?? "sonnet",
      instructions: instructions || undefined,
    })
);

server.registerTool(
  "memo_save",
  {
    description:
      "Save hand-written HTML as a manual override for a deal's memo. " +
      "Manual overrides take precedence over auto-composed memos on " +
      "read. Pass the full HTML document including <!DOCTYPE html>, " +
      "<style>, and <body> — it's rendered as-is in a sandboxed iframe.",
    inputSchema: {
      dealId: z.string().describe("deal uuid"),
      html: z
        .string()
        .describe("full HTML document"),
    },
  },
  async ({ dealId, html }) =>
    callApi("PUT", `/api/deals/${encodeURIComponent(dealId)}/memo`, { html })
);

server.registerTool(
  "memo_reset",
  {
    description:
      "Reset memo state. Default drops only the manual override row " +
      "(next read falls back to the auto-composed version, if any). " +
      "Pass scope='all' to drop every version for the deal — destructive, " +
      "use sparingly.",
    inputSchema: {
      dealId: z.string().describe("deal uuid"),
      scope: z
        .enum(["override_only", "all"])
        .optional()
        .describe("default: override_only"),
    },
  },
  async ({ dealId, scope }) =>
    callApi("DELETE", `/api/deals/${encodeURIComponent(dealId)}/memo`, {
      scope: scope ?? "override_only",
    })
);

// ============================================================
// Deal page HTML — hand-authored sandboxed page per deal
// ============================================================
//
// Each deal has its own /deals/<id>/browse page that renders a
// hand-authored HTML in a sandboxed iframe (allow-scripts, no
// same-origin). Uploads from any caller (web UI, CLI, agent, MCP)
// create a new monotonic version + trigger SSE push so any open
// viewer refreshes in real time. Old versions are soft-deleted on
// replace and can be restored.

// All html_* tools take an optional documentSlug param. Default 'main'.
// Each deal can hold multiple named documents (different HTMLs); use
// html_docs_list to discover slugs.
const INLINE_HTML_UPLOAD_LIMIT = 50 * 1024;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_ASSET_BYTES = 50 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 100 * 1024 * 1024;

function htmlUrl(dealId, slug) {
  return `/api/deals/${encodeURIComponent(dealId)}/documents/${encodeURIComponent(slug ?? "main")}/html`;
}

function looksLikeHtml(html) {
  const head = String(html || "").trim().slice(0, 256).toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

function mimeForAsset(path) {
  const ext = (String(path).split(".").pop() || "").toLowerCase();
  return (
    {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
      svg: "image/svg+xml",
      ico: "image/x-icon",
      avif: "image/avif",
      css: "text/css",
      js: "text/javascript",
      json: "application/json",
      woff: "font/woff",
      woff2: "font/woff2",
      ttf: "font/ttf",
      otf: "font/otf",
      mp4: "video/mp4",
      webm: "video/webm",
      pdf: "application/pdf",
    }[ext] || "application/octet-stream"
  );
}

async function detectSiblingAssetsDir(filePath) {
  const { existsSync, statSync } = await import("node:fs");
  const { dirname, basename, extname, join } = await import("node:path");
  const dir = dirname(filePath);
  const stem = basename(filePath, extname(filePath));
  const candidates = [
    `${stem}_files`,
    `${stem} files`,
    `${basename(filePath)}_files`,
  ];
  for (const name of candidates) {
    const p = join(dir, name);
    if (existsSync(p) && statSync(p).isDirectory()) return p;
  }
  return null;
}

async function collectAssets(assetsRoot) {
  const { readFileSync, readdirSync, statSync } = await import("node:fs");
  const { join, relative, sep, basename } = await import("node:path");
  const rootStat = statSync(assetsRoot);
  if (!rootStat.isDirectory()) {
    throw new Error(`assetsDir must point to a directory: ${assetsRoot}`);
  }
  const collected = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const absPath = join(dir, name);
      const st = statSync(absPath);
      if (st.isDirectory()) {
        walk(absPath);
      } else if (st.isFile()) {
        const relPath = relative(assetsRoot, absPath).split(sep).join("/");
        collected.push({ absPath, relPath, bytes: st.size });
      }
    }
  };
  walk(assetsRoot);
  if (collected.length === 0) {
    throw new Error(`assetsDir is empty: ${assetsRoot}`);
  }
  const rootName = basename(assetsRoot);
  const looksLikeSavePageDir = /[_ ]files$/i.test(rootName);
  const finalPaths = looksLikeSavePageDir
    ? collected.map((c) => ({ ...c, relPath: `${rootName}/${c.relPath}` }))
    : collected;
  let totalBytes = 0;
  for (const item of finalPaths) {
    if (item.relPath.split("/").some((seg) => seg === "..")) {
      throw new Error(`asset path "${item.relPath}" contains "..", refused`);
    }
    if (item.bytes > MAX_ASSET_BYTES) {
      throw new Error(
        `asset "${item.relPath}" is ${item.bytes} bytes; cap is ${MAX_ASSET_BYTES}`,
      );
    }
    totalBytes += item.bytes;
    if (totalBytes > MAX_BUNDLE_BYTES) {
      throw new Error(`total asset bytes exceeds ${MAX_BUNDLE_BYTES}`);
    }
  }
  return {
    assets: finalPaths.map((item) => ({
      ...item,
      data: readFileSync(item.absPath),
      contentType: mimeForAsset(item.relPath),
    })),
    totalBytes,
  };
}

async function uploadHtmlFromFile({
  dealId,
  filePath,
  documentSlug,
  source = "agent",
  assetsDir,
  autoDetectAssets = true,
  verify = true,
  clientUploadId,
}) {
  const { readFileSync, statSync } = await import("node:fs");
  const st = statSync(filePath);
  if (!st.isFile()) throw new Error(`filePath must point to a file: ${filePath}`);
  const html = readFileSync(filePath, "utf8");
  if (!html.trim()) throw new Error("HTML body is empty.");
  const htmlBytes = Buffer.byteLength(html, "utf8");
  if (htmlBytes > MAX_HTML_BYTES) {
    throw new Error(
      `HTML body is ${(htmlBytes / 1024 / 1024).toFixed(2)} MB; cap is 5 MB.`,
    );
  }
  if (!looksLikeHtml(html)) {
    throw new Error("HTML must start with <!doctype html> or <html.");
  }

  let effectiveAssetsDir = assetsDir || null;
  if (!effectiveAssetsDir && autoDetectAssets !== false) {
    effectiveAssetsDir = await detectSiblingAssetsDir(filePath);
  }
  const uploadId = normalizeUploadId(clientUploadId) || newHtmlUploadId();

  let body;
  if (!effectiveAssetsDir) {
    body = await request("PUT", htmlUrl(dealId, documentSlug), {
      html,
      source,
      client_upload_id: uploadId,
    }, {
      headers: { "X-Llama-Upload-Id": uploadId },
    });
  } else {
    const { assets, totalBytes } = await collectAssets(effectiveAssetsDir);
    const form = new FormData();
    form.append("html", html);
    form.append("source", source);
    form.append("client_upload_id", uploadId);
    for (const asset of assets) {
      form.append(
        `asset:${asset.relPath}`,
        new Blob([asset.data], { type: asset.contentType }),
        asset.relPath,
      );
    }
    const headers = await getAuthHeaders();
    const res = await fetch(`${getBaseUrl()}${htmlUrl(dealId, documentSlug)}`, {
      method: "PUT",
      headers: { ...headers, "X-Llama-Upload-Id": uploadId },
      body: form,
    });
    body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        `HTTP ${res.status}: ${body?.error || JSON.stringify(body).slice(0, 300)}`,
      );
    }
    body = { ...body, asset_bytes: body.asset_bytes ?? totalBytes };
  }

  let verified = { ok: false, skipped: true };
  if (verify !== false) {
    const latest = await request("GET", htmlUrl(dealId, documentSlug));
    if (latest?.empty) throw new Error("verification failed: document came back empty after upload");
    if (body?.version != null && Number(latest.version) !== Number(body.version)) {
      throw new Error(`verification failed: expected version ${body.version}, got ${latest.version}`);
    }
    if (body?.bytes != null && latest.bytes != null && Number(latest.bytes) !== Number(body.bytes)) {
      throw new Error(`verification failed: expected ${body.bytes} bytes, got ${latest.bytes}`);
    }
    if (body?.sha256 && latest.sha256 && String(latest.sha256) !== String(body.sha256)) {
      throw new Error(`verification failed: expected sha256 ${body.sha256}, got ${latest.sha256}`);
    }
    verified = {
      ok: true,
      version: latest.version,
      bytes: latest.bytes,
      sha256: latest.sha256,
      created_at: latest.created_at,
    };
  }

  return {
    ok: true,
    document_slug: documentSlug || "main",
    version: body?.version,
    bytes: body?.bytes ?? verified.bytes ?? htmlBytes,
    sha256: body?.sha256 ?? verified.sha256,
    client_upload_id: body?.client_upload_id ?? uploadId,
    idempotent_replay: body?.idempotent_replay,
    asset_count: body?.asset_count,
    asset_bytes: body?.asset_bytes,
    assets_dir: effectiveAssetsDir,
    verified,
    viewer: `${getBaseUrl()}/deals/${encodeURIComponent(dealId)}/browse/${encodeURIComponent(documentSlug || "main")}`,
  };
}

server.registerTool(
  "html_show",
  {
    description:
      "Read the current hand-authored HTML 'deal page' for a deal. " +
      "Returns {empty: true} if no one has uploaded HTML yet, or " +
      "{empty: false, version, html, bytes, sha256, uploaded_by, source, " +
      "created_at}. The HTML can be 5-500KB — be deliberate about " +
      "including the body in your reply. Use html_versions if you " +
      "just want the version list without the body. Each deal can " +
      "have multiple named docs — pass documentSlug to target a " +
      "non-'main' one (use html_docs_list to discover them).",
    inputSchema: {
      dealId: z.string().describe("deal uuid"),
      documentSlug: z
        .string()
        .optional()
        .describe("default: 'main'. Use html_docs_list to discover slugs."),
    },
  },
  async ({ dealId, documentSlug }) =>
    callApi("GET", htmlUrl(dealId, documentSlug))
);

server.registerTool(
  "html_upload",
  {
    description:
      "Upload (PUT) a new HTML version for a SPECIFIC DEAL's /browse page " +
      "(deal-scoped artifact: IC memo for X · dashboard for X · 2×2 for X). " +
      "Renders at /deals/<id>/browse/<slug>. " +
      "**Routing — pick the right destination BEFORE calling this:** " +
      "(a) Deal-specific HTML (this tool) → /deals/<id>/browse/<slug>. " +
      "(b) Cross-deal / institutional / thesis / sector landscape → use " +
      "`wiki_save` with content_type='html' instead (/wiki/<slug>). " +
      "(c) Founder-facing public share link → escape to Netlify only when " +
      "the user explicitly says 'share with founder' / 'publish publicly'; " +
      "Llama Command outranks Netlify for everything internal. " +
      "Creates a NEW version row — the previous version is retained " +
      "and restorable. Triggers SSE push so any open viewer auto- " +
      "refreshes. Constraints: HTML body MUST start with " +
      "<!doctype html> or <html (case-insensitive); max 5 MB. Reliability guard: " +
      "this inline-string tool refuses bodies over 50KB; use html_upload_file " +
      "or `llama html publish --file` for memos/reports. ALWAYS " +
      "call html_show first if anything exists — replace only the " +
      "relevant section, don't lose unrelated content. Source defaults " +
      "to 'agent' for MCP-originated uploads. Pass documentSlug to " +
      "target a non-'main' doc — auto-creates the doc if it doesn't exist.",
    inputSchema: {
      dealId: z.string().describe("deal uuid"),
      html: z.string().describe("complete HTML document"),
      documentSlug: z
        .string()
        .optional()
        .describe("default: 'main'"),
      source: z
        .enum(["web", "cli", "agent"])
        .optional()
        .describe("default: agent"),
      clientUploadId: z.string().optional().describe("optional retry id; reuse the same value if retrying the same small inline upload"),
    },
  },
  async ({ dealId, html, documentSlug, source, clientUploadId }) => {
    const bytes = Buffer.byteLength(String(html || ""), "utf8");
    if (bytes > INLINE_HTML_UPLOAD_LIMIT) {
      return textResult(
        `Error: html_upload received ${(bytes / 1024).toFixed(1)} KB of inline HTML. ` +
          `For reliability, do not pass large HTML through MCP tool arguments. ` +
          `Use html_upload_file({ dealId, filePath, documentSlug }) or run ` +
          `\`llama html publish <deal-id-or-name> --file <path> --doc <slug>\` instead.`,
        true,
      );
    }
    let uploadId;
    try {
      uploadId = normalizeUploadId(clientUploadId) || newHtmlUploadId();
    } catch (err) {
      return textResult(`Error: ${err?.message ?? String(err)}`, true);
    }
    return callApi("PUT", htmlUrl(dealId, documentSlug), {
      html,
      source: source ?? "agent",
      client_upload_id: uploadId,
    }, {
      headers: { "X-Llama-Upload-Id": uploadId },
    });
  }
);

server.registerTool(
  "html_upload_file",
  {
    description:
      "Agent-safe HTML upload from a LOCAL FILE PATH. Use this instead " +
      "of html_upload for any substantial memo/report; it avoids moving " +
      "large HTML through the model/tool-call context. Reads filePath on " +
      "the machine running this MCP server, preflights size/HTML shape, " +
      "optionally auto-detects a sibling *_files asset folder, uploads, " +
      "then reads the document back to verify version/bytes/sha256. For a higher " +
      "level CLI flow that can resolve deal names and choose create/update, " +
      "run `llama html publish <deal-id-or-name> --file <path>`.",
    inputSchema: {
      dealId: z.string().describe("deal uuid"),
      filePath: z.string().describe("absolute or relative local filesystem path to the HTML file"),
      documentSlug: z.string().optional().describe("default: 'main'"),
      source: z.enum(["web", "cli", "agent"]).optional().describe("default: agent"),
      assetsDir: z.string().optional().describe("optional local directory of relative assets"),
      autoDetectAssets: z.boolean().optional().describe("default true; detects sibling *_files folders"),
      verify: z.boolean().optional().describe("default true; read-after-write verification"),
      clientUploadId: z.string().optional().describe("optional retry id; reuse the same value if retrying the same failed upload"),
    },
  },
  async ({ dealId, filePath, documentSlug, source, assetsDir, autoDetectAssets, verify, clientUploadId }) => {
    try {
      const result = await uploadHtmlFromFile({
        dealId,
        filePath,
        documentSlug,
        source: source ?? "agent",
        assetsDir,
        autoDetectAssets,
        verify,
        clientUploadId,
      });
      return jsonResult(result);
    } catch (err) {
      return textResult(`Error: ${err?.message ?? String(err)}`, true);
    }
  },
);

server.registerTool(
  "html_versions",
  {
    description:
      "List version history for a deal's /browse page HTML. Returns " +
      "an array of {version, bytes, sha256, uploaded_by, source, created_at, " +
      "deleted_at} — newest first, including soft-deleted versions. " +
      "Use to find a target version for html_restore.",
    inputSchema: {
      dealId: z.string().describe("deal uuid"),
      documentSlug: z.string().optional().describe("default: 'main'"),
    },
  },
  async ({ dealId, documentSlug }) =>
    callApi("GET", `${htmlUrl(dealId, documentSlug)}/history`)
);

server.registerTool(
  "html_restore",
  {
    description:
      "Restore an old HTML version by copying it forward as a new " +
      "version (so the latest pointer moves to the restored content). " +
      "Use html_versions first to discover the version number. " +
      "Triggers SSE push.",
    inputSchema: {
      dealId: z.string().describe("deal uuid"),
      version: z.number().int().positive().describe("version to restore"),
      documentSlug: z.string().optional().describe("default: 'main'"),
    },
  },
  async ({ dealId, version, documentSlug }) =>
    callApi("POST", `${htmlUrl(dealId, documentSlug)}/restore/${version}`)
);

server.registerTool(
  "html_docs_list",
  {
    description:
      "List all documents (HTML 'pages') on a deal. Each deal can " +
      "hold multiple — like a folder of files. Returns an array of " +
      "{slug, title, preview_url, created_by, latest_version, " +
      "latest_bytes, latest_uploaded_by, latest_updated_at}. The " +
      "'main' slug is the default doc; non-main slugs are explicit.",
    inputSchema: {
      dealId: z.string().describe("deal uuid"),
    },
  },
  async ({ dealId }) =>
    callApi("GET", `/api/deals/${encodeURIComponent(dealId)}/documents`)
);

server.registerTool(
  "html_docs_create",
  {
    description:
      "Create a NEW named document slot on a deal (metadata only — " +
      "upload HTML separately via html_upload with the same slug). " +
      "Slug must match /^[a-z0-9][a-z0-9_-]{0,63}$/ — lowercase alnum + " +
      "hyphen/underscore. Examples: 'ic-onepager', 'founder-brief', " +
      "'market-map'. Title is for display; defaults to the slug.",
    inputSchema: {
      dealId: z.string().describe("deal uuid"),
      slug: z.string().describe("URL-safe id, e.g. 'ic-onepager'"),
      title: z.string().optional().describe("display title; defaults to slug"),
    },
  },
  async ({ dealId, slug, title }) =>
    callApi("POST", `/api/deals/${encodeURIComponent(dealId)}/documents`, {
      slug,
      title: title ?? slug,
    })
);

server.registerTool(
  "html_docs_archive",
  {
    description:
      "Archive a non-'main' doc — hides it from the selection page. " +
      "HTML/asset versions are retained and the doc can be 'un-archived' " +
      "later (currently via direct DB or by ensureDealDocument). The " +
      "'main' doc cannot be archived (it's the default slot).",
    inputSchema: {
      dealId: z.string().describe("deal uuid"),
      slug: z.string().describe("slug to archive (must not be 'main')"),
    },
  },
  async ({ dealId, slug }) =>
    callApi(
      "DELETE",
      `/api/deals/${encodeURIComponent(dealId)}/documents/${encodeURIComponent(slug)}`
    )
);

server.registerTool(
  "html_upload_bundle",
  {
    description:
      "Legacy small inline upload for HTML + binary assets as one atomic version. " +
      "For substantial memos/reports or 'Save Page As Complete' exports, use " +
      "html_upload_file with filePath + assetsDir instead so large HTML/assets " +
      "do not move through the model/tool-call context. This inline bundle " +
      "tool refuses payloads over 50KB. The server stores HTML + each asset as " +
      "one transactional bundle (deal_browse_assets " +
      "table), rewrites the HTML refs to version-pinned URLs at " +
      "/api/deals/<id>/asset/<path>?v=N, and triggers SSE push. " +
      "Constraints: HTML <= 5 MB; each asset <= 50 MB; total bundle " +
      "<= 100 MB. Asset paths must match the relative refs in the HTML " +
      "(no leading './', no '..' segments).",
    inputSchema: {
      dealId: z.string().describe("deal uuid"),
      html: z.string().describe("complete HTML document"),
      assets: z
        .array(
          z.object({
            path: z
              .string()
              .describe(
                "relative path matching the HTML's src/href ref " +
                  "(e.g. 'images/cover.png' or 'Foo_files/img.jpg')",
              ),
            contentType: z
              .string()
              .describe("MIME type, e.g. 'image/jpeg', 'font/woff2'"),
            base64: z
              .string()
              .describe("base64-encoded file bytes (NO data:URI prefix)"),
          }),
        )
        .min(1)
        .describe("at least one asset (use html_upload if no assets)"),
      documentSlug: z
        .string()
        .optional()
        .describe("default: 'main'"),
      source: z
        .enum(["web", "cli", "agent"])
        .optional()
        .describe("default: agent"),
      clientUploadId: z.string().optional().describe("optional retry id; reuse the same value if retrying the same bundle upload"),
    },
  },
  async ({ dealId, html, assets, documentSlug, source, clientUploadId }) => {
    const inlineBytes =
      Buffer.byteLength(String(html || ""), "utf8") +
      assets.reduce((sum, a) => sum + Buffer.byteLength(String(a.base64 || ""), "utf8"), 0);
    if (inlineBytes > INLINE_HTML_UPLOAD_LIMIT) {
      return textResult(
        `Error: html_upload_bundle received ${(inlineBytes / 1024).toFixed(1)} KB of inline tool-call payload. ` +
          `For reliability, do not pass large HTML/assets through MCP arguments. ` +
          `Use html_upload_file({ dealId, filePath, documentSlug, assetsDir }) or run ` +
          `\`llama html publish <deal-id-or-name> --file <path> --assets <dir>\` instead.`,
        true,
      );
    }
    let uploadId;
    try {
      uploadId = normalizeUploadId(clientUploadId) || newHtmlUploadId();
    } catch (err) {
      return textResult(`Error: ${err?.message ?? String(err)}`, true);
    }
    const form = new FormData();
    form.append("html", html);
    form.append("source", source ?? "agent");
    form.append("client_upload_id", uploadId);
    for (const a of assets) {
      const bytes = Buffer.from(a.base64, "base64");
      form.append(
        `asset:${a.path}`,
        new Blob([bytes], { type: a.contentType || "application/octet-stream" }),
        a.path,
      );
    }
    const headers = await getAuthHeaders();
    const res = await fetch(`${getBaseUrl()}${htmlUrl(dealId, documentSlug)}`, {
      method: "PUT",
      headers: { ...headers, "X-Llama-Upload-Id": uploadId }, // let fetch set multipart Content-Type with boundary
      body: form,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        `HTTP ${res.status}: ${body?.error || JSON.stringify(body).slice(0, 300)}`,
      );
    }
    return body;
  },
);

server.registerTool(
  "html_reset",
  {
    description:
      "Soft-delete the latest HTML version for a deal. The /browse " +
      "page reverts to its empty state (drop / paste / CLI / agent " +
      "invitation). Old versions are retained and restorable via " +
      "html_restore.",
    inputSchema: {
      dealId: z.string().describe("deal uuid"),
      documentSlug: z.string().optional().describe("default: 'main'"),
    },
  },
  async ({ dealId, documentSlug }) =>
    callApi("DELETE", htmlUrl(dealId, documentSlug))
);

// ============================================================
// Prompts
// ============================================================
//
// MCP-native agents discover prompts via prompts/list — they can fetch
// and adopt them without any user-side prompt engineering.

server.registerPrompt(
  "agent_briefing",
  {
    description:
      "Onboard yourself as a Llama Ventures teammate. Returns the workflow " +
      "contract: identity, Pipeline First rule, content capture, autonomy " +
      "levels (L0/L1/L2/L3), communication style, error recovery, CLI/MCP " +
      "reference, and boundaries. Read this once, internalise it, operate " +
      "accordingly. Same content as `llama agent-onboard` from the CLI. " +
      "For the live private Llama OS skill library, call agent_bootstrap, " +
      "skills_search, and skills_read.",
  },
  async () => {
    // Gate the briefing behind authenticated Command runtime. The server-owned
    // /api/agent/briefing contract is canonical; bundled AGENT_BRIEFING.md is
    // only a rollout/offline fallback for authenticated users.
    const headers = await getAuthHeaders();
    let stub = null;
    let briefing = null;
    if (Object.keys(headers).length === 0) {
      stub =
        "Llama Ventures team onboarding requires credentials.\n\n" +
        "Team member: run `gcloud auth login` with your @llamaventures.vc " +
        "account, or mint a token at " +
        "https://command.llamaventures.vc/settings/tokens and run " +
        "`llama token set <llc_...>`. Then re-request this prompt.\n\n" +
        "Founder / external visitor: use the `pitch_*` tools — no token required.";
    } else {
      try {
        const params = new URLSearchParams({ clientVersion: PKG_VERSION });
        const body = await request("GET", `/api/agent/briefing?${params}`);
        briefing = body?.briefing || null;
      } catch (err) {
        const msg = err?.message || "";
        if (msg.includes("Error[UNAUTHORIZED]") || msg.includes("Error[NO_AUTH]")) {
          stub =
            "Llama Ventures team onboarding requires valid credentials. " +
            "Server rejected the credentials we sent. Re-mint at " +
            "https://command.llamaventures.vc/settings/tokens.";
        } else {
          briefing =
            "Warning: server agent briefing unavailable; using bundled fallback.\n\n" +
            readBriefing();
        }
      }
    }
    return {
      messages: [
        {
          role: "user",
          content: { type: "text", text: stub ?? briefing ?? readBriefing() },
        },
      ],
    };
  }
);

// ============================================================
// Boot
// ============================================================

const transport = new StdioServerTransport();
await server.connect(transport);
