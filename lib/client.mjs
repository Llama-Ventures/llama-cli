// Shared HTTP / auth / token helpers for @llamaventures/cli.
//
// Used by:
//   - bin/llama.mjs    — the CLI command surface
//   - bin/llama-mcp.mjs — the MCP server (forthcoming, v1.1)
//
// Zero deps. Lazy I/O — importing this module performs no network or
// filesystem work; everything happens at first call.

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { execFile as _execFile } from "child_process";
import { promisify } from "util";
import { createHash, randomUUID } from "crypto";
import { getBuildInfo } from "./build-info.mjs";

const execFile = promisify(_execFile);

// Package root — the directory that contains package.json. Used to locate
// bundled assets (AGENT_BRIEFING.md, etc.) regardless of where the CLI
// runs from. lib/client.mjs sits one level deep, so go up one.
export const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

/**
 * Read the bundled AGENT_BRIEFING.md and return it as a string.
 * Used by both `llama agent-onboard` (CLI) and the `agent_briefing` MCP
 * prompt — single source of truth.
 */
export function readBriefing() {
  const briefingPath = path.join(PACKAGE_ROOT, "AGENT_BRIEFING.md");
  try {
    return fs.readFileSync(briefingPath, "utf8");
  } catch {
    return (
      "AGENT_BRIEFING.md not found at " +
      briefingPath +
      ". This shouldn't happen in a published @llamaventures/cli install — " +
      "report at https://github.com/Llama-Ventures/llama-cli/issues."
    );
  }
}

let packageVersionCache = null;

export function getPackageVersion() {
  if (packageVersionCache) return packageVersionCache;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
    packageVersionCache = String(pkg.version || "unknown");
  } catch {
    packageVersionCache = "unknown";
  }
  return packageVersionCache;
}

// Canonical entrypoint. `llama-command.onrender.com` also serves the API
// but its NextAuth callback URL doesn't match, so browser login (needed
// to mint a token at /settings/tokens) fails there with a server-config
// error. Always default to canonical — override with $LLAMA_API_URL only
// if testing.
export const DEFAULT_BASE_URL = "https://command.llamaventures.vc";

// Canonical token location (single line, mode 0600). Aligns with the
// agent-discovery convention.
export const TOKEN_DIR = path.join(os.homedir(), ".llama");
export const TOKEN_FILE = path.join(TOKEN_DIR, "token");
export const AGENT_SESSION_FILE = path.join(TOKEN_DIR, "agent-session.json");

// Legacy location used by CLI v0.1. Read for back-compat (silent migrate
// to canonical on first use); never written for the token, but still the
// home of the rarely-set `baseUrl` override.
export const LEGACY_DIR = path.join(os.homedir(), ".llama-command");
export const LEGACY_FILE = path.join(LEGACY_DIR, "config.json");

export function readLegacyConfig() {
  try {
    return JSON.parse(fs.readFileSync(LEGACY_FILE, "utf8"));
  } catch {
    return {};
  }
}

export function writeLegacyConfig(config) {
  fs.mkdirSync(LEGACY_DIR, { recursive: true });
  fs.writeFileSync(LEGACY_FILE, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(LEGACY_FILE, 0o600);
}

function migrateLegacyTokenIfNeeded(token) {
  if (fs.existsSync(TOKEN_FILE)) return;
  try {
    fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
    fs.chmodSync(TOKEN_FILE, 0o600);
  } catch {
    // Migration is best-effort; the env var / legacy fallback still works.
  }
}

export function readCanonicalToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

export function writeCanonicalToken(token) {
  fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  fs.chmodSync(TOKEN_FILE, 0o600);
}

export function getBaseUrl() {
  return (process.env.LLAMA_API_URL || readLegacyConfig().baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
}

export function getToken() {
  // 1. env var — preferred for CI, cloud agents, sandboxed runners
  if (process.env.LLAMA_TOKEN) return process.env.LLAMA_TOKEN;

  // 2. canonical file
  const canonical = readCanonicalToken();
  if (canonical) return canonical;

  // 3. legacy fallback — silently migrate forward so future invocations
  //    use the canonical path even if the user never re-runs `token set`.
  const legacy = readLegacyConfig().token;
  if (legacy) {
    migrateLegacyTokenIfNeeded(legacy);
    return legacy;
  }

  return "";
}

let runtimeClient = "cli";
let runtimeAgentClient = null;

export function setClientRuntime(opts = {}) {
  if (opts.client) runtimeClient = String(opts.client);
  if (opts.agentClient) runtimeAgentClient = String(opts.agentClient);
}

function detectAgentClient() {
  if (runtimeAgentClient) return runtimeAgentClient;
  if (process.env.LLAMA_AGENT_CLIENT) return process.env.LLAMA_AGENT_CLIENT;
  if (process.env.CODEX_SANDBOX || process.env.CODEX_CLI || process.env.OPENAI_CODEX) return "codex";
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE || process.env.CLAUDE_CODE_ENTRYPOINT) {
    return "claude-code";
  }
  if (process.env.CURSOR_AGENT || process.env.CURSOR_TRACE_ID) return "cursor";
  return "unknown";
}

export function readAgentSession() {
  try {
    return JSON.parse(fs.readFileSync(AGENT_SESSION_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeAgentSession(session) {
  try {
    fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(AGENT_SESSION_FILE, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(AGENT_SESSION_FILE, 0o600);
  } catch {
    // Telemetry state is best-effort. Never break the actual CLI command.
  }
}

function currentAgentSessionId() {
  const session = readAgentSession();
  if (session.sessionId) return session.sessionId;
  const created = {
    sessionId: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  writeAgentSession(created);
  return created.sessionId;
}

export function getLastAgentEvent() {
  const session = readAgentSession();
  return session.lastEventId ? session : null;
}

function rememberAgentEvent(event) {
  if (!event?.eventId) return;
  const session = {
    ...readAgentSession(),
    sessionId: event.sessionId || currentAgentSessionId(),
    lastEventId: event.eventId,
    lastCommand: event.command ?? null,
    lastQuery: event.query ?? null,
    lastSurface: event.surface ?? null,
    lastRecordedAt: new Date().toISOString(),
  };
  writeAgentSession(session);
}

function agentClientHeaders(command) {
  const build = getBuildInfo();
  return {
    "X-Llama-Client": runtimeClient,
    "X-Llama-Client-Version": getPackageVersion(),
    "X-Llama-Client-Source-Sha": build.sourceSha,
    "X-Llama-API-Contract-Version": build.coreApiContract.apiVersion,
    "X-Llama-API-Contract-Digest": build.coreApiContract.sha256,
    "X-Llama-Agent-Client": detectAgentClient(),
    "X-Llama-Agent-Session": currentAgentSessionId(),
    "X-Llama-Command": command || "unknown",
  };
}

const SECRET_KEY_RE = /(token|secret|password|authorization|cookie|api[_-]?key|keychain|jwt)/i;
const CONTENT_PAYLOAD_KEY_RE = /(^|_)(html|body|content|markdown|message|text)$/i;

function truncateText(text, max = 2000) {
  return text.length > max ? `${text.slice(0, max)}...[truncated]` : text;
}

function summarizePayloadText(value) {
  const text = String(value ?? "");
  return {
    redacted: true,
    type: "text_payload",
    chars: text.length,
    bytes: Buffer.byteLength(text, "utf8"),
    sha256: createHash("sha256").update(text).digest("hex"),
  };
}

function sanitizeTelemetryValue(value, depth = 0, keyHint = "") {
  if (depth > 4) return "[max-depth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return CONTENT_PAYLOAD_KEY_RE.test(keyHint)
      ? summarizePayloadText(value)
      : truncateText(value);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeTelemetryValue(item, depth + 1, keyHint));
  }
  if (typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value).slice(0, 40)) {
      out[key] = SECRET_KEY_RE.test(key) ? "[redacted]" : sanitizeTelemetryValue(val, depth + 1, key);
    }
    return out;
  }
  return String(value);
}

function parseEndpoint(endpoint) {
  try {
    return new URL(endpoint, "https://command.llamaventures.vc");
  } catch {
    return null;
  }
}

function endpointArgs(endpoint, body) {
  const args = {};
  const url = parseEndpoint(endpoint);
  if (url) {
    for (const [key, value] of url.searchParams.entries()) args[key] = value;
  }
  if (body && typeof body === "object" && !Array.isArray(body)) {
    Object.assign(args, body);
  }
  return sanitizeTelemetryValue(args);
}

function inferCommand(method, endpoint) {
  const url = parseEndpoint(endpoint);
  const pathname = url?.pathname || endpoint.split("?")[0] || "";
  const verb = String(method || "GET").toUpperCase();
  if (pathname === "/api/agent/client-events") return "telemetry.record";
  if (pathname === "/api/agent/eval-feedback") return "eval.feedback";
  if (pathname === "/api/wiki/search") return "wiki.search";
  if (pathname === "/api/wiki/save") return "wiki.save";
  if (/^\/api\/wiki\/[^/]+$/.test(pathname)) return verb === "GET" ? "wiki.read" : "wiki.write";
  if (pathname === "/api/deals") return verb === "GET" ? "deal.search" : "deal.write";
  if (pathname === "/api/deals/create") return "deal.create";
  if (pathname === "/api/deals/update") return "deal.update";
  if (/^\/api\/deals\/[^/]+\/ingest$/.test(pathname)) return "deal.ingest";
  if (/^\/api\/deals\/[^/]+\/threads\/[^/]+$/.test(pathname)) return "deal.agent.run";
  if (/^\/api\/deals\/[^/]+\/threads$/.test(pathname)) return "deal.thread.create";
  if (/^\/api\/deals\/[^/]+\/facts/.test(pathname)) return verb === "GET" ? "deal.fact.list" : "deal.fact.write";
  if (/^\/api\/deals\/[^/]+\/posts$/.test(pathname)) return "deal.post";
  if (/^\/api\/deals\/[^/]+\/blocks/.test(pathname)) return verb === "GET" ? "brief.blocks" : "brief.write";
  if (/^\/api\/deals\/[^/]+$/.test(pathname)) return verb === "GET" ? "deal.show" : "deal.write";
  if (pathname === "/api/me") return "auth.status";
  if (pathname.startsWith("/api/agent/skills")) return "skills.read";
  if (pathname === "/api/agent/manifest") return "agent.bootstrap";
  if (pathname === "/api/agent/briefing") return "agent.briefing";
  return `${verb.toLowerCase()} ${pathname || endpoint}`;
}

function queryForCommand(command, args) {
  if (!command.endsWith(".search")) return null;
  return args?.q || args?.search || args?.query || null;
}

function summarizeResultIds(data) {
  const result = {};
  const topDeals = [];
  const topWiki = [];

  const collectDeal = (deal) => {
    const id = deal?.uuid || deal?.id || deal?.dealId || deal?.deal_uuid;
    if (!id) return;
    topDeals.push({ id, name: deal.companyName || deal.company_name || deal.name || null });
  };
  const collectWiki = (item) => {
    if (!item?.slug) return;
    topWiki.push({ slug: item.slug, title: item.title || null });
  };

  if (Array.isArray(data)) {
    for (const item of data.slice(0, 20)) {
      collectDeal(item);
      collectWiki(item);
    }
    result.resultCount = data.length;
  } else if (data && typeof data === "object") {
    const deals = Array.isArray(data.deals) ? data.deals : [];
    const articles = Array.isArray(data.articles) ? data.articles : [];
    const results = Array.isArray(data.results) ? data.results : [];
    for (const deal of deals.slice(0, 20)) collectDeal(deal);
    for (const item of [...articles, ...results].slice(0, 20)) collectWiki(item);
    if (typeof data.total === "number") result.total = data.total;
    if (deals.length) result.resultCount = deals.length;
    if (articles.length || results.length) result.resultCount = articles.length + results.length;
  }

  if (topDeals.length) result.deals = topDeals;
  if (topWiki.length) result.wiki = topWiki;
  return result;
}

function summarizeResult(data) {
  if (data === null || data === undefined) return null;
  if (Array.isArray(data)) return `${data.length} result(s)`;
  if (typeof data === "object") {
    if (Array.isArray(data.deals)) return `${data.deals.length} deal result(s); total=${data.total ?? "unknown"}`;
    if (Array.isArray(data.results)) return `${data.results.length} result(s)`;
    if (data.ok !== undefined) return `ok=${Boolean(data.ok)}`;
  }
  return truncateText(typeof data === "string" ? data : JSON.stringify(sanitizeTelemetryValue(data)), 2000);
}

function shouldSkipTelemetry(endpoint) {
  if (process.env.LLAMA_TELEMETRY === "0") return true;
  const pathname = parseEndpoint(endpoint)?.pathname || endpoint;
  return pathname === "/api/agent/client-events" || pathname === "/api/agent/eval-feedback";
}

async function recordClientTelemetry({
  authHeaders,
  method,
  endpoint,
  body,
  command,
  status,
  httpStatus,
  latencyMs,
  data,
  errorMessage,
}) {
  if (shouldSkipTelemetry(endpoint)) return;
  const args = endpointArgs(endpoint, body);
  const sessionId = currentAgentSessionId();
  const payload = {
    client: runtimeClient,
    clientVersion: getPackageVersion(),
    agentClient: detectAgentClient(),
    sessionId,
    command,
    method: String(method || "GET").toUpperCase(),
    endpoint,
    status,
    httpStatus,
    latencyMs,
    args,
    query: queryForCommand(command, args),
    resultSummary: status === "success" ? summarizeResult(data) : null,
    resultIds: status === "success" ? summarizeResultIds(data) : {},
    errorMessage: errorMessage ? truncateText(String(errorMessage), 2000) : null,
  };
  try {
    const res = await fetch(`${getBaseUrl()}/api/agent/client-events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...agentClientHeaders("telemetry.record"),
        ...authHeaders,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return;
    const recorded = await res.json().catch(() => null);
    rememberAgentEvent({
      ...recorded,
      sessionId,
      command,
      query: payload.query,
      surface: command.startsWith("deal.") ? "deal" : command.startsWith("wiki.") ? "wiki" : null,
    });
  } catch {
    // Best-effort by design. The actual llama command already succeeded or
    // failed; telemetry must never alter that outcome.
  }
}

// Try `gcloud auth print-identity-token`. Returns the JWT or null. Zero-config
// win for any team member who has gcloud + their @llamaventures.vc account
// already set up — the server's Bearer auth path verifies and auto-creates
// the user row.
export async function tryGcloudIdentityToken() {
  try {
    const { stdout } = await execFile("gcloud", ["auth", "print-identity-token"], { timeout: 4000 });
    const t = String(stdout).trim();
    // Crude JWT shape check (header.payload.signature). Avoids passing
    // junk like "ERROR: ..." to the server when gcloud misbehaves.
    return t && t.split(".").length === 3 ? t : null;
  } catch {
    return null;
  }
}

// Build the auth header set. Priority order (server tries them in this
// order too and falls through on failure):
//
//   1. OAuth access token from Keychain (`llama auth login`) — Bearer
//      header. Auto-refreshes if near expiry. Highest priority because
//      it's scope-aware + revocable.
//   2. gcloud identity token — Bearer header. Falls back if no OAuth.
//   3. X-Llama-Token PAT — sent alongside whatever Bearer was set, so
//      server's authenticate() can fall through on Bearer-verify failure.
export async function getAuthHeaders() {
  const headers = {};
  // Lazy import — keeps zero-OAuth call paths fast and avoids loading
  // @napi-rs/keyring's native binding when the user isn't using OAuth.
  let oauthAccess = null;
  try {
    const { getValidAccessToken } = await import("./oauth-refresh.mjs");
    oauthAccess = await getValidAccessToken();
  } catch {
    // OAuth modules failed to load (e.g. keyring native binding missing
    // on this platform) — fall through to gcloud / PAT silently.
  }
  if (oauthAccess) {
    headers["Authorization"] = `Bearer ${oauthAccess}`;
  } else {
    const bearer = await tryGcloudIdentityToken();
    if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
  }
  const token = getToken();
  if (token) headers["X-Llama-Token"] = token;
  return headers;
}

/**
 * Was the Bearer header on this request set from an OAuth access token?
 * `request()` uses this to decide whether a 401 should trigger a
 * refresh-and-retry-once path (only meaningful when we sent an OAuth
 * token; gcloud / PAT 401s should NOT retry blindly).
 */
async function bearerCameFromOAuth() {
  try {
    const { readBundle } = await import("./oauth-storage.mjs");
    const bundle = await readBundle();
    return Boolean(bundle?.access_token);
  } catch {
    return false;
  }
}

// Structured no-credential error. Format is stable so agents can pattern-match
// `Error[NO_AUTH]` and trigger a recovery flow.
function noAuthError() {
  return new Error(
    "Error[NO_AUTH]: No Llama Command credentials found.\n" +
    "\n" +
    "  Llama Ventures team member?\n" +
    "    Quickest: run `gcloud auth login` with your @llamaventures.vc account.\n" +
    "    Or: get a token at https://command.llamaventures.vc/settings/tokens, then\n" +
    "      llama token set <llc_...>      (saved to ~/.llama/token)\n" +
    "      or set $LLAMA_TOKEN in your shell env.\n" +
    "\n" +
    "  Founder or external visitor (no Llama account)?\n" +
    "    Run `llama pitch start --name \"Your Name\" --email \"you@company.com\"`\n" +
    "    to chat with our intake agent — no token required."
  );
}

// Structured 401 error after a request was attempted. Means the credentials
// we sent were rejected (revoked / expired / wrong account).
function unauthorizedError() {
  return new Error(
    "Error[UNAUTHORIZED]: Server rejected our credentials.\n" +
    "  If using gcloud: confirm `gcloud config get account` shows your @llamaventures.vc address.\n" +
    "  If using X-Llama-Token: the token may be revoked. Regenerate at\n" +
    "    https://command.llamaventures.vc/settings/tokens and run `llama token set <llc_...>`."
  );
}

export async function request(method, endpoint, body, opts = {}) {
  return requestWithRetry(method, endpoint, body, opts, /* allowRetry */ true);
}

export async function requestSse(method, endpoint, body, opts = {}) {
  return requestSseWithRetry(method, endpoint, body, opts, /* allowRetry */ true);
}

function apiResponseError(data, status) {
  const message =
    typeof data === "object" && data?.error ? data.error : `HTTP ${status}`;
  if (data?.code !== "MENTION_APPROVAL_REQUIRED") {
    const error = new Error(message);
    if (typeof data?.code === "string") error.code = data.code;
    error.details = data;
    return error;
  }
  const recipients = Array.isArray(data?.cue?.recipients)
    ? data.cue.recipients
        .map((recipient) => {
          const name = recipient?.name || `user ${recipient?.user_id ?? "unknown"}`;
          return recipient?.intent ? `${name} (${recipient.intent})` : name;
        })
        .join(", ")
    : "unknown";
  const channels = Array.isArray(data?.cue?.channels)
    ? data.cue.channels.join(" + ")
    : "inbox + email";
  const error = new Error(
    `Error[MENTION_APPROVAL_REQUIRED]: ${message}\n` +
    `Recipients: ${recipients}\n` +
    `Channels: ${channels}\n` +
    "Ask the user for explicit permission, then retry the exact write with --cue (CLI) or cueAuthorized=true (MCP).",
  );
  error.code = data.code;
  error.details = data;
  return error;
}

async function requestWithRetry(method, endpoint, body, opts, allowRetry) {
  const authHeaders = await getAuthHeaders();
  if (Object.keys(authHeaders).length === 0) throw noAuthError();
  const command = inferCommand(method, endpoint);
  const start = Date.now();
  const res = await fetch(`${getBaseUrl()}${endpoint}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...agentClientHeaders(command),
      ...authHeaders,
      ...(opts.headers || {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // 401 + we sent an OAuth Bearer + this is the first attempt → try a
  // forced refresh once. Covers two cases: (a) clock skew between client
  // and server pushed us past expiry mid-request, (b) server-side
  // revocation occurred between the client cache and now. Either way,
  // the refresh either succeeds (we retry once with the new access
  // token) or fails (refresh token also dead — bubble UNAUTHORIZED).
  if (res.status === 401 && allowRetry && (await bearerCameFromOAuth())) {
    let refreshed = null;
    try {
      const { forceRefresh } = await import("./oauth-refresh.mjs");
      refreshed = await forceRefresh();
    } catch {
      refreshed = null;
    }
    if (refreshed) {
      return requestWithRetry(method, endpoint, body, opts, /* allowRetry */ false);
    }
    throw unauthorizedError();
  }

  if (res.status === 401) throw unauthorizedError();

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const message = typeof data === "object" && data?.error ? data.error : `HTTP ${res.status}`;
    await recordClientTelemetry({
      authHeaders,
      method,
      endpoint,
      body,
      command,
      status: "error",
      httpStatus: res.status,
      latencyMs: Date.now() - start,
      data: null,
      errorMessage: message,
    });
    throw apiResponseError(data, res.status);
  }
  await recordClientTelemetry({
    authHeaders,
    method,
    endpoint,
    body,
    command,
    status: "success",
    httpStatus: res.status,
    latencyMs: Date.now() - start,
    data,
    errorMessage: null,
  });
  return data;
}

async function requestSseWithRetry(method, endpoint, body, opts, allowRetry) {
  const authHeaders = await getAuthHeaders();
  if (Object.keys(authHeaders).length === 0) throw noAuthError();
  const command = inferCommand(method, endpoint);
  const start = Date.now();
  const res = await fetch(`${getBaseUrl()}${endpoint}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...agentClientHeaders(command),
      ...authHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401 && allowRetry && (await bearerCameFromOAuth())) {
    let refreshed = null;
    try {
      const { forceRefresh } = await import("./oauth-refresh.mjs");
      refreshed = await forceRefresh();
    } catch {
      refreshed = null;
    }
    if (refreshed) {
      return requestSseWithRetry(method, endpoint, body, opts, /* allowRetry */ false);
    }
    throw unauthorizedError();
  }

  if (res.status === 401) throw unauthorizedError();

  if (!res.ok) {
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    const message = typeof data === "object" && data?.error ? data.error : `HTTP ${res.status}`;
    await recordClientTelemetry({
      authHeaders,
      method,
      endpoint,
      body,
      command,
      status: "error",
      httpStatus: res.status,
      latencyMs: Date.now() - start,
      data: null,
      errorMessage: message,
    });
    throw new Error(message);
  }

  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let text = "";
  let buf = "";
  if (!reader) return { text, events };

  const handleFrame = (frame) => {
    const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
    if (!dataLine) return;
    let event;
    try {
      event = JSON.parse(dataLine.slice(6));
    } catch {
      return;
    }
    events.push(event);
    opts.onEvent?.(event);
    if (event.text) text += event.text;
    if (event.error) throw new Error(String(event.error));
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() || "";
    for (const frame of frames) handleFrame(frame);
  }
  if (buf.trim()) handleFrame(buf);
  await recordClientTelemetry({
    authHeaders,
    method,
    endpoint,
    body,
    command,
    status: "success",
    httpStatus: res.status,
    latencyMs: Date.now() - start,
    data: { ok: true, textLength: text.length, events: events.length },
    errorMessage: null,
  });
  return { text, events };
}

export function print(data) {
  if (typeof data === "string") {
    console.log(data);
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}
