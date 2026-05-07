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
      "report at https://github.com/SoujiOkita98/llama-cli/issues."
    );
  }
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

// Build the auth header set. If both Bearer and X-Llama-Token are available,
// send both — the server tries Bearer first and falls through to
// X-Llama-Token on verification failure.
export async function getAuthHeaders() {
  const headers = {};
  const bearer = await tryGcloudIdentityToken();
  if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
  const token = getToken();
  if (token) headers["X-Llama-Token"] = token;
  return headers;
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

export async function request(method, endpoint, body) {
  const authHeaders = await getAuthHeaders();
  if (Object.keys(authHeaders).length === 0) throw noAuthError();
  const res = await fetch(`${getBaseUrl()}${endpoint}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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
    throw new Error(message);
  }
  return data;
}

export function print(data) {
  if (typeof data === "string") {
    console.log(data);
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}
