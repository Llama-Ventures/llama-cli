// The API-backed Llama tool catalog, independent of transport and of how the
// caller authenticates. The stdio server (bin/llama-mcp.mjs) passes the local
// HTTP client; a remote MCP endpoint hosted by Llama Command passes its own
// in-process request function. Nothing here may touch local credentials,
// local files, or process state: tools that need those stay in bin/.

import { z } from "zod";
import { buildArtifactReadPath, buildWikiReadPath } from "./content-read.mjs";
import {
  buildDealReadPath,
  buildDealSearchPath,
  verifyDealSearchResult,
  informationReadFilter,
  verifyInformationReadResult,
  compactDealWriteResult,
  prepareDealCommand,
} from "./deal-actions.mjs";
import { buildDealMemoryPath } from "./deal-memory-actions.mjs";
import { buildPageSchemaPath, MAX_PAGE_SCHEMA_FIELDS } from "./page-schema.mjs";

export function textResult(text, isError = false) {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

/** The manifest also carries a rendered duplicate of itself; tools return the structured half. */
export function structuredBootstrapManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return manifest;
  }
  const { briefing: _renderedDuplicate, ...structured } = manifest;
  return structured;
}

export const originSchema = z.object({
  kind: z.enum(["user", "agent", "system"]),
  originalUserUtterance: z.string().min(1).optional(),
  originatingChatRecordId: z.string().uuid().optional(),
});

export const writeDealCommandSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("input.submit"),
    dealId: z.string().uuid(),
    format: z.string().min(1).max(120).optional(),
    content: z.any(),
    source: z.record(z.string(), z.any()).optional(),
    origin: originSchema,
    idempotencyKey: z.string().min(1).max(240).optional(),
  }).strict(),
  z.object({
    operation: z.literal("information.put"),
    dealId: z.string().uuid(),
    informationId: z.string().uuid().optional(),
    type: z.string().min(1).max(120),
    labels: z.array(z.string()).optional(),
    subject: z.record(z.string(), z.any()).optional(),
    value: z.any(),
    expectedVersion: z.number().int().positive().optional(),
    origin: originSchema,
    idempotencyKey: z.string().min(1).max(240).optional(),
  }).strict(),
  z.object({
    operation: z.literal("page.patch"),
    dealId: z.string().uuid(),
    patch: z.record(z.string(), z.any()),
    expectedRevision: z.number().int().nonnegative().optional(),
    origin: originSchema,
    idempotencyKey: z.string().min(1).max(240).optional(),
  }).strict(),
  z.object({
    operation: z.literal("artifact.put"),
    dealId: z.string().uuid(),
    artifactId: z.string().uuid().optional().describe("Reuse the existing ID to append a complete file version, including on rename. Omit for a new document without a title collision, or explicitly use a fresh UUID for a distinct same-name source."),
    kind: z.string().min(1).max(120),
    title: z.string().min(1).max(500),
    mimeType: z.string().min(1).max(240),
    contentBase64: z.string().min(1).optional(),
    storageKey: z.string().min(1).optional(),
    storageUrl: z.string().url().optional(),
    byteSize: z.number().int().nonnegative().optional(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    metadata: z.record(z.string(), z.any()).optional(),
    origin: originSchema,
    idempotencyKey: z.string().min(1).max(240).optional(),
  }).strict(),
]);

/**
 * Register the API-backed tools on an MCP server.
 *
 * @param server   an McpServer
 * @param deps.request      async (method, path, body) => parsed JSON; throws on failure
 * @param deps.formatError  (error) => string shown to the agent
 * @param deps.version      client version reported to bootstrap
 * @param deps.only         optional list of tool names; others are not registered
 */
export function registerApiTools(server, { request, formatError, version, only } = {}) {
  if (typeof request !== "function") throw new Error("registerApiTools requires a request function");
  const describeError = formatError ?? ((error) => `Error: ${error?.message ?? String(error)}`);
  const formatErrorForDisplay = describeError;
  const allowed = only ? new Set(only) : null;
  const registerTool = (name, ...rest) => {
    if (allowed && !allowed.has(name)) return;
    server.registerTool(name, ...rest);
  };

  async function callApi(method, path, body, transform = (value) => value) {
    try {
      const result = transform(await request(method, path, body));
      return textResult(typeof result === "string" ? result : JSON.stringify(result, null, 2));
    } catch (error) {
      return textResult(describeError(error), true);
    }
  }


  // Deal is deliberately a closed four-tool surface. Do not add split resource
  // tools here: one more tool is one more branch every agent must reason about.
  registerTool(
    "search_deals",
    {
      description: "Search current Deal metadata by company name/key, description, sector/subsector or founder name in either stored language. Use short keywords; matching is a case-insensitive literal substring, not semantic search. Combine q with sector/status/state/limit, or use sector alone for category discovery. status filters by exact pipeline status (e.g. [\"Invested\"]); to list every invested Deal use status [\"Invested\"] with limit 200 and order by investmentDate/markedInvestedAt, instead of guessing from names. Sector filters before limit and requires a supporting Core server. Exact names rank first. Inspect searchMatch fields and search.has_more; truncated results are not exhaustive. On zero matches, try broader or alternative wording before concluding no Deal exists. Read candidates to verify specific categories and claims. Always search before creating a company.",
      inputSchema: {
        q: z.string().optional(),
        sector: z.string().trim().min(1).max(200).optional(),
        status: z.array(z.string().min(1).max(60)).min(1).max(10).optional(),
        state: z.enum(["active", "archived", "trashed"]).optional(),
        limit: z.number().int().min(1).max(2000).optional(),
      },
    },
    // @core-api-operation GET /api/occam/deals
    async ({ q, sector, status, state, limit } = {}) => callApi(
      "GET", buildDealSearchPath(q, { sector, status, state, limit }), undefined,
      (result) => verifyDealSearchResult(result, { sector, status }),
    ),
  );

  registerTool(
    "read_deal",
    {
      description: "Read one Deal. Live Page is current human-visible state; Information is memory and never updates Page automatically. Read Information selectively with informationIds (full values, up to 50), informationTypes, and/or informationQuery (literal text; returns match.snippets, and values over 8,000 characters as { omitted, chars }: then read that id). Prefer these over detail=memory, which returns up to ~2 MB. Use artifactId to read original source text with page/paragraph anchors. Continue with nextOffset and source.sha256. Page field semantics come from agent_bootstrap, not every Deal read.",
      inputSchema: {
        dealId: z.string().min(1),
        detail: z.enum(["overview", "memory", "files", "conversation", "history", "all"]).optional(),
        artifactId: z.string().uuid().optional(),
        version: z.number().int().min(1).optional(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(50000).optional(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        informationIds: z.array(z.string().uuid()).min(1).max(50).optional(),
        informationTypes: z.array(z.string().min(1).max(120)).min(1).max(20).optional(),
        informationQuery: z.string().min(2).max(200).optional(),
      },
    },
    async ({ dealId, detail, artifactId, informationIds, informationTypes, informationQuery, ...options }) => {
      const filter = informationReadFilter({ ids: informationIds, types: informationTypes, q: informationQuery });
      if (artifactId) {
        if (detail) throw new Error("Use artifactId or detail, not both");
        if (filter) throw new Error("Use artifactId or information filters, not both");
        // @core-api-operation GET /api/occam/deals/{dealId}/artifacts/{artifactId}
        return callApi("GET", buildArtifactReadPath(dealId, artifactId, options));
      }
      if (Object.values(options).some(value => value !== undefined)) throw new Error("Content options require artifactId");
      // @core-api-operation GET /api/occam/deals/{dealId}
      return callApi("GET", buildDealReadPath(dealId, detail || "overview", filter), undefined,
        (result) => verifyInformationReadResult(result, filter));
    },
  );

  registerTool(
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

  registerTool(
    "write_deal",
    {
      description: "The only Deal mutation tool. Pass one command: input.submit, information.put, page.patch, or artifact.put. A file or HTML about one company belongs here as artifact.put; standalone knowledge not tied to one company belongs in wiki_save. Before artifact.put, read Deal files: reuse artifactId for a revision; a same-kind/title collision without an ID returns OCCAM_CONFLICT. Titles are candidates, not identity. Select the intended existing ID from the request/content, or explicitly generate a fresh UUID for a distinct same-name source. Send complete revised bytes, preserve applicable metadata, and verify the ID/version. Core hosts text/html in Command; do not mirror HTML to Drive or require a Drive link. Non-HTML source files, including original transcripts and recordings, go to Drive through artifact.put. Keep source-file bodies out of Input, Information, Page and metadata; save extracted facts and summaries with source references and preserve the user request. page.patch does not edit file bytes. All Page content fields are Agent-writable; author controls attribution, not permission. Before page.patch, use get_live_deal_page_schema for the exact fields being changed and write bilingual Page prose. page.patch is JSON Merge Patch: arrays replace whole arrays, so read-modify-write and preserve sibling slots. A Llama user's own judgment is human_subjective_view.people or human_subjective_view.business and must carry value.speaker, value.rawText quoted verbatim from origin.originalUserUtterance, and value.summary (the agent's restatement); it is rejected otherwise.",
      // MCP SDK 1.30 only publishes object schemas at the tool root. Nesting one
      // command preserves the real discriminated union instead of flattening four
      // incompatible operations into false affordances.
      inputSchema: { command: writeDealCommandSchema },
    },
    async ({ command }) => callApi(
      "POST",
      "/api/occam/deals/commands",
      prepareDealCommand("write", command),
      (result) => compactDealWriteResult(command, result),
    ),
  );

  // Deal Memory is a separate sidecar domain. These do not add an Occam Deal
  // business resource or widen the deliberately closed four-tool Deal surface.
  registerTool(
    "get_deal_memory",
    {
      description: "Read the complete canonical Markdown Deal Story and its opaque concurrency version. A returned placeholder is an existing Story whose version is required for a write; only 404 means no Story exists.",
      inputSchema: { dealId: z.string().uuid() },
    },
    // @core-api-operation GET /api/deal-memory/{dealId}/story
    async ({ dealId }) => callApi("GET", buildDealMemoryPath(dealId)),
  );

  registerTool(
    "update_deal_memory",
    {
      description: "Replace the complete Markdown Deal Story with one coherent current understanding; never append an update log, restate Live Deal Page/Deal Information fields, or write when understanding would not materially improve. Frontmatter must contain matching deal_id plus stable uuid and created timestamps; updated must strictly advance. Pass the version from get_deal_memory for every returned Story, including a placeholder; only 404 permits creation without expected_version.",
      inputSchema: {
        dealId: z.string().uuid(),
        markdown: z.string().min(1).max(1_048_576),
        expected_version: z.string().min(1).optional(),
      },
    },
    // @core-api-operation PUT /api/deal-memory/{dealId}/story
    async ({ dealId, markdown, expected_version }) => callApi(
      "PUT",
      buildDealMemoryPath(dealId),
      { markdown, ...(expected_version ? { expected_version } : {}) },
    ),
  );

  registerTool(
    "agent_bootstrap",
    {
      description: "Mandatory before Llama work: fetch the authenticated two-part private Brain (Investment Framework V3 + Llama Command operating skill), a compact Live Deal Page schema index, runtime contract including Wiki publishing guidance, and visible Llama OS skills. Read exact Page fields separately with get_live_deal_page_schema.",
      inputSchema: { limit: z.number().int().min(1).max(100).optional() },
    },
    async ({ limit } = {}) => {
      const params = new URLSearchParams({ clientVersion: version });
      params.set("page_schema", "progressive");
      if (limit) params.set("limit", String(limit));
      try {
        const result = await request("GET", `/api/agent/manifest?${params}`);
        return textResult(JSON.stringify(structuredBootstrapManifest(result), null, 2));
      } catch (error) {
        return textResult(formatErrorForDisplay(error), true);
      }
    },
  );

  registerTool(
    "get_live_deal_page_schema",
    {
      description: "Read the Live Deal Page schema progressively. Call with no selector for the compact index; before page.patch, request only exact fields or one section. This is read-only context, not a fifth Deal action.",
      inputSchema: {
        fields: z.array(z.string().min(1)).min(1).max(MAX_PAGE_SCHEMA_FIELDS).optional(),
        section: z.string().min(1).optional(),
      },
    },
    async ({ fields, section } = {}) => {
      try {
        // @core-api-operation GET /api/agent/page-schema
        return await callApi("GET", buildPageSchemaPath({ fields, section }));
      } catch (error) {
        return textResult(formatErrorForDisplay(error), true);
      }
    },
  );

  registerTool(
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

  registerTool(
    "skills_read",
    {
      description: "Read one authenticated runtime skill by slug.",
      inputSchema: { slug: z.string().min(1) },
    },
    async ({ slug }) => callApi("GET", `/api/agent/skills/${encodeURIComponent(slug)}`),
  );

  registerTool(
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

  registerTool(
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

  registerTool(
    "pref_set_status",
    {
      description: "Activate or retire a standing preference.",
      inputSchema: { id: z.number().int().positive(), status: z.enum(["active", "retired"]) },
    },
    async ({ id, status }) => callApi("PATCH", `/api/agent/preferences/${id}`, { status }),
  );

  registerTool(
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

  registerTool(
    "wiki_search",
    {
      description: "Search institutional knowledge in the internal Wiki.",
      inputSchema: { q: z.string().min(1) },
    },
    async ({ q }) => callApi("GET", `/api/wiki/search?q=${encodeURIComponent(q)}`),
  );

  registerTool(
    "wiki_read",
    {
      description: "Read one Wiki article. format=text extracts its original upload or page body. attachment follows an ID listed in attachments. Continuations require offset and sha256.",
      inputSchema: {
        slug: z.string().min(1), lang: z.enum(["en", "zh"]).optional(),
        format: z.literal("text").optional(), attachment: z.string().optional(),
        offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(50000).optional(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      },
    },
    // @core-api-operation GET /api/wiki/{slug}
    async ({ slug, ...options }) => callApi("GET", buildWikiReadPath(slug, options)),
  );

  registerTool(
    "wiki_save",
    {
      description: "Publish institutional knowledge when authorized. For knowledge not tied to one company; a file or HTML about one company is a Deal Artifact (write_deal artifact.put), unless the user names the Wiki. Follow agent_bootstrap contract.wiki_publishing. New pages default to complete self-contained HTML with embedded rendering assets and full report content/interactions; set content_type=html. Honor explicit Markdown requests. Read the same slug/lang before edits and preserve its format unless conversion is authorized. Verify the receipt, canonical page and interactions before reporting completion.",
      inputSchema: {
        slug: z.string().min(1),
        title: z.string().min(1),
        content: z.string().describe("Complete page source. For HTML, include the full document and embedded rendering dependencies."),
        sources: z.array(z.string()).min(1),
        content_type: z.enum(["markdown", "html"]).optional().describe("Set html for HTML publications. Use markdown for an explicit Markdown request or an existing Markdown article."),
        lang: z.enum(["en", "zh"]).optional().describe("Article language; Core defaults to en when omitted."),
      },
    },
    async ({ slug, title, content, sources, content_type, lang }) =>
      callApi("POST", "/api/wiki/save", { slug, title, content, sources, content_type, lang }),
  );

  registerTool(
    "wiki_delete",
    {
      description: "Soft-delete a Wiki article.",
      inputSchema: { slug: z.string().min(1), lang: z.enum(["en", "zh"]).optional() },
    },
    async ({ slug, lang }) =>
      callApi("DELETE", `/api/wiki/${encodeURIComponent(slug)}?lang=${lang === "zh" ? "zh" : "en"}`),
  );

  registerTool(
    "wiki_restore",
    {
      description: "Restore a soft-deleted Wiki article.",
      inputSchema: { slug: z.string().min(1), lang: z.enum(["en", "zh"]).optional() },
    },
    async ({ slug, lang }) =>
      callApi("POST", `/api/wiki/${encodeURIComponent(slug)}/restore?lang=${lang === "zh" ? "zh" : "en"}`),
  );
}
