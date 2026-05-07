#!/usr/bin/env node

// llama-mcp — stdio MCP server for Llama Command. Pairs with the `llama`
// CLI in the same package; both share auth + HTTP via lib/client.mjs.
//
// Wire into Claude Code / Cursor / Claude Desktop / OpenClaw via your
// agent's MCP config — see README for snippets. Auth is identical to the
// CLI: gcloud (preferred) → $LLAMA_TOKEN → ~/.llama/token.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getAuthHeaders, readBriefing, request } from "../lib/client.mjs";

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

const server = new McpServer({
  name: "llama-mcp",
  version: "1.0.0",
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
      "Append a markdown text block to a deal brief. Supports markdown + mermaid diagrams.",
    inputSchema: {
      dealId: z.string(),
      heading: z.string().optional().describe("optional block heading"),
      body: z.string().describe("markdown body"),
    },
  },
  async ({ dealId, heading, body }) =>
    callApi("POST", `/api/deals/${encodeURIComponent(dealId)}/blocks`, {
      type: "text",
      heading,
      body,
    })
);

server.registerTool(
  "brief_add_link",
  {
    description:
      "Append a link block to a deal brief. Server fetches og:image + title via /api/link-preview.",
    inputSchema: {
      dealId: z.string(),
      url: z.string(),
      label: z.string().optional().describe("optional human-readable label"),
    },
  },
  async ({ dealId, url, label }) =>
    callApi("POST", `/api/deals/${encodeURIComponent(dealId)}/blocks`, {
      type: "link",
      url,
      label,
    })
);

server.registerTool(
  "brief_add_callout",
  {
    description:
      "Append a callout block to a deal brief. Use for emphasized insights or warnings.",
    inputSchema: {
      dealId: z.string(),
      tone: z.string().describe("insight | warning | info | success"),
      heading: z.string().optional(),
      body: z.string(),
    },
  },
  async ({ dealId, tone, heading, body }) =>
    callApi("POST", `/api/deals/${encodeURIComponent(dealId)}/blocks`, {
      type: "callout",
      tone,
      heading,
      body,
    })
);

// ============================================================
// Wiki (knowledge base)
// ============================================================

server.registerTool(
  "wiki_search",
  {
    description:
      "Search the Llama Ventures internal wiki — deal context, company profiles, " +
      "industry frameworks, partner-curated knowledge.",
    inputSchema: {
      q: z.string().describe("search query"),
    },
  },
  async ({ q }) => callApi("GET", `/api/wiki/search?q=${encodeURIComponent(q)}`)
);

server.registerTool(
  "wiki_save",
  {
    description:
      "Create or update a wiki page. Content should be markdown with attribution " +
      "blocks (**[Name · YYYY-MM-DD · source · fact|opinion]**) for traceability.",
    inputSchema: {
      slug: z.string().describe("kebab-case slug"),
      title: z.string(),
      content: z.string().describe("markdown content"),
    },
  },
  async ({ slug, title, content }) =>
    callApi("POST", "/api/wiki/save", { slug, title, content })
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
      "Post a message to a deal's timeline. Message can include @-mentions (e.g. " +
      "@<persona>, @gavin@llamaventures.vc) — the system fires email + inbox notifications " +
      "to mentioned users.",
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
// Escape hatch
// ============================================================

server.registerTool(
  "llama_api",
  {
    description:
      "Generic Llama Command HTTP API passthrough. Use this for endpoints that " +
      "don't yet have a typed tool. Returns raw JSON. Path must start with /api/. " +
      "See https://github.com/SoujiOkita98/llama-cli for the wrapped tool list.",
    inputSchema: {
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
      path: z.string().describe("path starting with /api/"),
      body: z
        .any()
        .optional()
        .describe(
          "request body — only used on POST / PUT / PATCH; should be a JSON-serializable object"
        ),
    },
  },
  async ({ method, path, body }) => {
    if (typeof path !== "string" || !path.startsWith("/api/")) {
      return {
        content: [{ type: "text", text: "Error: path must start with /api/" }],
        isError: true,
      };
    }
    return callApi(method, path, body);
  }
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
  async () => ({
    messages: [
      {
        role: "user",
        content: { type: "text", text: readBriefing() },
      },
    ],
  })
);

// ============================================================
// Boot
// ============================================================

const transport = new StdioServerTransport();
await server.connect(transport);
