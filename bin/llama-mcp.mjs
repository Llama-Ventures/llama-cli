#!/usr/bin/env node

// llama-mcp — stdio MCP server for Llama Command. Pairs with the `llama`
// CLI in the same package; both share auth + HTTP via lib/client.mjs.
//
// Wire into Claude Code / Cursor / Claude Desktop / OpenClaw via your
// agent's MCP config — see README for snippets. Auth is identical to the
// CLI: gcloud (preferred) → $LLAMA_TOKEN → ~/.llama/token.

import { createRequire } from "module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getAuthHeaders, readBriefing, request } from "../lib/client.mjs";

const requireFromHere = createRequire(import.meta.url);
const { version: PKG_VERSION } = requireFromHere("../package.json");
import {
  clearExternalSession,
  getExternalSessionStatus,
  sendExternalMessage,
  startExternalSession,
  uploadExternalFile,
} from "../lib/external.mjs";

// Wrap a request() call into the MCP CallToolResult shape. Catches errors
// (NO_AUTH / 401 / 5xx / network) and surfaces them as `isError: true`
// content so the calling agent sees a clean error string instead of the
// MCP transport closing.
async function callApi(method, path, body) {
  try {
    const result = await request(method, path, body);
    const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    return { content: [{ type: "text", text }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err?.message ?? String(err)}` }],
      isError: true,
    };
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

// ============================================================
// Deals — read
// ============================================================

server.registerTool(
  "deal_search",
  {
    description:
      "Search the Llama Ventures deal pipeline. Fuzzy match on company name, " +
      "founders, description, founder info, notes, deal owner, source, and location. " +
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
          "exact match on 'Our Stage' (Sourced, First Meeting, Diligence, Partner Meeting, Term Sheet, Invested, Passed, Stalled, Future, Unknown)"
        ),
      theirStage: z.string().optional().describe("exact match on 'Their Stage'"),
      stage: z
        .string()
        .optional()
        .describe(
          "exact match on Round (Pre-Seed, Seed, Series A, Series B, Series C+, Stealth)"
        ),
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
      "stage, founders, owner, source, valuation, all whitelisted writable fields, " +
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
      status: z.string().optional().describe("Our Stage workflow position"),
      source: z.string().optional().describe("free-form sourced-by; recommend nominating a user"),
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
      "notes, stage, dealOwner, source, description, website, location, founders, " +
      "proposedAmount, roundSize, valuation. Logs a field_change event in deal_events.",
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
      "tier='opus' for high-stakes deals (higher cost, deeper analysis).",
    inputSchema: {
      dealId: z.string().describe("deal uuid"),
      tier: z
        .enum(["sonnet", "opus"])
        .optional()
        .describe("LLM tier (default: sonnet)"),
    },
  },
  async ({ dealId, tier }) =>
    callApi("POST", `/api/deals/${encodeURIComponent(dealId)}/memo`, {
      action: "regenerate",
      stream: false,
      model: tier ?? "sonnet",
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
function htmlUrl(dealId, slug) {
  return `/api/deals/${encodeURIComponent(dealId)}/documents/${encodeURIComponent(slug ?? "main")}/html`;
}

server.registerTool(
  "html_show",
  {
    description:
      "Read the current hand-authored HTML 'deal page' for a deal. " +
      "Returns {empty: true} if no one has uploaded HTML yet, or " +
      "{empty: false, version, html, bytes, uploaded_by, source, " +
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
      "<!doctype html> or <html (case-insensitive); max 5 MB. ALWAYS " +
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
    },
  },
  async ({ dealId, html, documentSlug, source }) =>
    callApi("PUT", htmlUrl(dealId, documentSlug), {
      html,
      source: source ?? "agent",
    })
);

server.registerTool(
  "html_versions",
  {
    description:
      "List version history for a deal's /browse page HTML. Returns " +
      "an array of {version, bytes, uploaded_by, source, created_at, " +
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
      "Upload HTML + binary assets as one atomic version. Use this " +
      "INSTEAD of html_upload when the HTML references local images / " +
      "fonts / CSS files via relative src=/href= attributes (typical " +
      "of 'Save Page As Complete' exports). The server stores HTML + " +
      "each asset as one transactional bundle (deal_browse_assets " +
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
    },
  },
  async ({ dealId, html, assets, documentSlug, source }) => {
    const form = new FormData();
    form.append("html", html);
    form.append("source", source ?? "agent");
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
      headers, // let fetch set multipart Content-Type with boundary
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
      "accordingly. Same content as `llama agent-onboard` from the CLI.",
  },
  async () => {
    // Gate the briefing behind a /api/me check so unauthenticated MCP
    // clients can't harvest internal workflow / command surface just by
    // requesting the prompt. Mirrors the CLI gate in bin/llama.mjs.
    const headers = await getAuthHeaders();
    let stub = null;
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
        await request("GET", "/api/me");
      } catch (err) {
        stub =
          "Llama Ventures team onboarding requires valid credentials. " +
          "Server rejected the credentials we sent. Re-mint at " +
          "https://command.llamaventures.vc/settings/tokens.";
      }
    }
    return {
      messages: [
        {
          role: "user",
          content: { type: "text", text: stub ?? readBriefing() },
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
