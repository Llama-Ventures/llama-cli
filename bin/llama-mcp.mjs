#!/usr/bin/env node

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  getAuthHeaders,
  readBriefing,
  request,
  setClientRuntime,
} from "../lib/client.mjs";
import {
  clearExternalSession,
  getExternalSessionStatus,
  sendExternalMessage,
  startExternalSession,
  uploadExternalFile,
} from "../lib/external.mjs";
import {
  buildDealReadPath,
  buildDealSearchPath,
  prepareDealCommand,
} from "../lib/deal-actions.mjs";

const requireFromHere = createRequire(import.meta.url);
const { version: PKG_VERSION } = requireFromHere("../package.json");
setClientRuntime({ client: "mcp" });

const server = new McpServer({ name: "llama-mcp", version: PKG_VERSION });

function textResult(text, isError = false) {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

async function callApi(method, path, body) {
  try {
    const result = await request(method, path, body);
    return textResult(typeof result === "string" ? result : JSON.stringify(result, null, 2));
  } catch (error) {
    return textResult(`Error: ${error?.message ?? String(error)}`, true);
  }
}

const originSchema = z.object({
  kind: z.enum(["user", "agent", "system"]),
  originalUserUtterance: z.string().min(1).optional(),
  originatingChatRecordId: z.string().uuid().optional(),
});

// Deal is deliberately a closed four-tool surface. Do not add split resource
// tools here: one more tool is one more branch every agent must reason about.
server.registerTool(
  "search_deals",
  {
    description: "Search compact Live Deal Page candidates. Always use this before creating a company.",
    inputSchema: {
      q: z.string().optional(),
      state: z.enum(["active", "archived", "trashed"]).optional(),
      limit: z.number().int().min(1).max(2000).optional(),
    },
  },
  // @core-api-operation GET /api/occam/deals
  async ({ q, state, limit } = {}) => callApi("GET", buildDealSearchPath(q, { state, limit })),
);

server.registerTool(
  "read_deal",
  {
    description: "Read one Deal. Live Page and its current private field contract are always returned; Information is memory and never updates Page automatically.",
    inputSchema: {
      dealId: z.string().min(1),
      detail: z.enum(["overview", "memory", "files", "conversation", "history", "all"]).optional(),
    },
  },
  // @core-api-operation GET /api/occam/deals/{dealId}
  async ({ dealId, detail }) => callApi("GET", buildDealReadPath(dealId, detail || "overview")),
);

server.registerTool(
  "create_deal",
  {
    description: "Create one Deal intent. Core owns Drive, initial resources, idempotency, and Events.",
    inputSchema: {
      companyName: z.string().min(1).max(240),
      companyKey: z.string().min(1).max(240).optional(),
      page: z.record(z.string(), z.any()).optional(),
      information: z.array(z.record(z.string(), z.any())).optional(),
      origin: originSchema,
      idempotencyKey: z.string().min(1).max(240).optional(),
    },
  },
  async (input) => callApi("POST", "/api/occam/deals/commands", prepareDealCommand("create", input)),
);

server.registerTool(
  "write_deal",
  {
    description: "The only Deal mutation tool: input.submit, information.put, page.patch, or artifact.put. All Page content fields are Agent-writable; author controls attribution, not permission. Use the read/bootstrap field contract and bilingual Page prose. page.patch is JSON Merge Patch: arrays replace whole arrays, so read-modify-write and preserve sibling slots.",
    inputSchema: {
      operation: z.enum(["input.submit", "information.put", "page.patch", "artifact.put"]),
      dealId: z.string().uuid(),
      patch: z.record(z.string(), z.any()).optional(),
      expectedRevision: z.number().int().nonnegative().optional(),
      informationId: z.string().uuid().optional(),
      type: z.string().min(1).max(120).optional(),
      labels: z.array(z.string()).optional(),
      subject: z.record(z.string(), z.any()).optional(),
      value: z.any().optional(),
      expectedVersion: z.number().int().positive().optional(),
      format: z.string().min(1).max(120).optional(),
      content: z.any().optional(),
      source: z.record(z.string(), z.any()).optional(),
      artifactId: z.string().uuid().optional(),
      kind: z.string().min(1).max(120).optional(),
      title: z.string().min(1).max(500).optional(),
      mimeType: z.string().min(1).max(240).optional(),
      contentBase64: z.string().min(1).optional(),
      storageKey: z.string().min(1).optional(),
      storageUrl: z.string().url().optional(),
      byteSize: z.number().int().nonnegative().optional(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
      metadata: z.record(z.string(), z.any()).optional(),
      origin: originSchema,
      idempotencyKey: z.string().min(1).max(240).optional(),
    },
  },
  async (input) => callApi("POST", "/api/occam/deals/commands", prepareDealCommand("write", input)),
);

server.registerTool(
  "auth_status",
  {
    description: "Verify Command credentials and current user identity.",
    inputSchema: {},
  },
  async () => {
    const headers = await getAuthHeaders();
    if (!Object.keys(headers).length) {
      return textResult(
        "Error[NO_AUTH]: run `llama auth login`, or save a valid llc_ token with `llama token set`.",
        true,
      );
    }
    return callApi("GET", "/api/me");
  },
);

server.registerTool(
  "agent_bootstrap",
  {
    description: "Mandatory before Llama work: fetch the authenticated two-part private Brain (Investment Framework V3 + Llama Command operating skill), the separate current Live Deal Page field contract, runtime contract, and visible Llama OS skills.",
    inputSchema: { limit: z.number().int().min(1).max(100).optional() },
  },
  async ({ limit } = {}) => {
    const params = new URLSearchParams({ clientVersion: PKG_VERSION });
    if (limit) params.set("limit", String(limit));
    return callApi("GET", `/api/agent/manifest?${params}`);
  },
);

server.registerTool(
  "skills_search",
  {
    description: "Search authenticated runtime skills; read only the relevant result.",
    inputSchema: { q: z.string().min(1), limit: z.number().int().min(1).max(100).optional() },
  },
  async ({ q, limit }) => {
    const params = new URLSearchParams({ q });
    if (limit) params.set("limit", String(limit));
    return callApi("GET", `/api/agent/skills?${params}`);
  },
);

server.registerTool(
  "skills_read",
  {
    description: "Read one authenticated runtime skill by slug.",
    inputSchema: { slug: z.string().min(1) },
  },
  async ({ slug }) => callApi("GET", `/api/agent/skills/${encodeURIComponent(slug)}`),
);

server.registerTool(
  "pref_list",
  {
    description: "List standing agent preferences.",
    inputSchema: { status: z.enum(["active", "proposed", "retired", "all"]).optional() },
  },
  async ({ status } = {}) => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    return callApi("GET", `/api/agent/preferences${params.size ? `?${params}` : ""}`);
  },
);

server.registerTool(
  "pref_add",
  {
    description: "Save a durable user or team preference; procedures belong in skills.",
    inputSchema: {
      key: z.string().min(1),
      content: z.string().min(1).max(280),
      scope: z.enum(["user", "team"]).optional(),
      evidence: z.string().optional(),
    },
  },
  async ({ key, content, scope, evidence }) =>
    callApi("POST", "/api/agent/preferences", { key, content, scope, evidence }),
);

server.registerTool(
  "pref_set_status",
  {
    description: "Activate or retire a standing preference.",
    inputSchema: { id: z.number().int().positive(), status: z.enum(["active", "retired"]) },
  },
  async ({ id, status }) => callApi("PATCH", `/api/agent/preferences/${id}`, { status }),
);

server.registerTool(
  "object_inspect",
  {
    description: "Explain a Command URL or object before guessing that it is broken.",
    inputSchema: {
      q: z.string().optional(),
      type: z.string().optional(),
      id: z.string().optional(),
      lang: z.enum(["en", "zh"]).optional(),
    },
  },
  async ({ q, type, id, lang } = {}) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (type) params.set("type", type);
    if (id) params.set("id", id);
    if (lang) params.set("lang", lang);
    return callApi("GET", `/api/agent/explain?${params}`);
  },
);

server.registerTool(
  "wiki_search",
  {
    description: "Search institutional knowledge in the internal Wiki.",
    inputSchema: { q: z.string().min(1) },
  },
  async ({ q }) => callApi("GET", `/api/wiki/search?q=${encodeURIComponent(q)}`),
);

server.registerTool(
  "wiki_read",
  {
    description: "Read one Wiki article by exact slug.",
    inputSchema: { slug: z.string().min(1), lang: z.enum(["en", "zh"]).optional() },
  },
  async ({ slug, lang }) =>
    callApi("GET", `/api/wiki/${encodeURIComponent(slug)}?lang=${lang === "zh" ? "zh" : "en"}`),
);

server.registerTool(
  "wiki_save",
  {
    description: "Create or update cross-Deal institutional knowledge, not Deal data.",
    inputSchema: {
      slug: z.string().min(1),
      title: z.string().min(1),
      content: z.string(),
      sources: z.array(z.string()).min(1),
      content_type: z.enum(["markdown", "html"]).optional(),
    },
  },
  async ({ slug, title, content, sources, content_type }) =>
    callApi("POST", "/api/wiki/save", { slug, title, content, sources, content_type }),
);

server.registerTool(
  "wiki_delete",
  {
    description: "Soft-delete a Wiki article.",
    inputSchema: { slug: z.string().min(1), lang: z.enum(["en", "zh"]).optional() },
  },
  async ({ slug, lang }) =>
    callApi("DELETE", `/api/wiki/${encodeURIComponent(slug)}?lang=${lang === "zh" ? "zh" : "en"}`),
);

server.registerTool(
  "wiki_restore",
  {
    description: "Restore a soft-deleted Wiki article.",
    inputSchema: { slug: z.string().min(1), lang: z.enum(["en", "zh"]).optional() },
  },
  async ({ slug, lang }) =>
    callApi("POST", `/api/wiki/${encodeURIComponent(slug)}/restore?lang=${lang === "zh" ? "zh" : "en"}`),
);

server.registerTool(
  "pitch_start",
  {
    description: "Start an external founder pitch session; no internal token required.",
    inputSchema: { name: z.string().min(1).max(100), email: z.string().email() },
  },
  async ({ name, email }) => {
    try {
      return textResult(JSON.stringify(await startExternalSession({ name, email }), null, 2));
    } catch (error) {
      return textResult(`Error: ${error?.message ?? String(error)}`, true);
    }
  },
);

server.registerTool(
  "pitch_send_message",
  {
    description: "Relay the founder's exact message to the external intake agent.",
    inputSchema: { message: z.string().min(1).max(8000) },
  },
  async ({ message }) => {
    try {
      return textResult(JSON.stringify(await sendExternalMessage(message), null, 2));
    } catch (error) {
      return textResult(`Error: ${error?.message ?? String(error)}`, true);
    }
  },
);

server.registerTool(
  "pitch_upload_file",
  {
    description: "Attach a local file to the active external pitch session.",
    inputSchema: { path: z.string().min(1) },
  },
  async ({ path }) => {
    try {
      return textResult(JSON.stringify(await uploadExternalFile(path), null, 2));
    } catch (error) {
      return textResult(`Error: ${error?.message ?? String(error)}`, true);
    }
  },
);

server.registerTool(
  "pitch_status",
  { description: "Inspect the active external pitch session.", inputSchema: {} },
  async () => textResult(JSON.stringify(getExternalSessionStatus(), null, 2)),
);

server.registerTool(
  "pitch_finalize",
  { description: "Clear local pitch session state after completion or abandonment.", inputSchema: {} },
  async () => {
    const before = getExternalSessionStatus();
    clearExternalSession();
    return textResult(JSON.stringify({ cleared: before.active, previous_session: before }, null, 2));
  },
);

server.registerPrompt(
  "agent_briefing",
  {
    description: "Mandatory before Llama work: fetch the authenticated two-part private Brain, the separate current Live Deal Page field contract, and runtime contract; bundled text is only an offline fallback.",
  },
  async () => {
    const headers = await getAuthHeaders();
    let text;
    if (!Object.keys(headers).length) {
      text = "Llama team onboarding requires credentials. Run `llama auth login`; external founders use pitch_* tools.";
    } else {
      try {
        const params = new URLSearchParams({ clientVersion: PKG_VERSION });
        const response = await request("GET", `/api/agent/briefing?${params}`);
        text = response?.briefing || readBriefing();
      } catch (error) {
        text = `Warning: live briefing unavailable (${error?.message ?? String(error)}).\n\n${readBriefing()}`;
      }
    }
    return { messages: [{ role: "user", content: { type: "text", text } }] };
  },
);

await server.connect(new StdioServerTransport());
