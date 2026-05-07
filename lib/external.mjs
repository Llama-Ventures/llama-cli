// External-agent client for @llamaventures/cli.
//
// Talks to /api/external/* endpoints (founder pitch intake) — no Llama
// token required. Session is bootstrapped via PoW + email/name + cookie;
// subsequent calls reuse the cookie persisted to ~/.llama/external-session.json.
//
// All anti-abuse (PoW age, per-IP/email rate limits, disposable-domain block,
// global daily caps, message/token caps, idle timeout) is enforced server-side.
// CLI is a bug-for-bug equivalent of the web /external-agent flow — no extra
// trust given.

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { getBaseUrl } from "./client.mjs";

const SESSION_DIR = path.join(os.homedir(), ".llama");
const SESSION_FILE = path.join(SESSION_DIR, "external-session.json");

// Server-side proof-of-work prefix. Must agree with
// llama-command/src/lib/external-pow-client.ts. ~65k iterations average on
// commodity hardware (~50–500ms in node).
const POW_DIFFICULTY_PREFIX = "0000";

// Server requires ts_rendered to be at least 3s old (anti-replay). We
// backdate by 4s when computing PoW so the request lands inside the
// validity window without waiting.
const POW_BACKDATE_MS = 4_000;

// ============================================================
// Session state — ~/.llama/external-session.json
// ============================================================

export function readExternalSession() {
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
  } catch {
    return null;
  }
}

export function writeExternalSession(session) {
  fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });
  fs.chmodSync(SESSION_FILE, 0o600);
}

export function clearExternalSession() {
  try {
    fs.unlinkSync(SESSION_FILE);
  } catch {
    // already gone — fine
  }
}

// ============================================================
// Proof-of-Work
// ============================================================

function solvePoW(tsRendered, maxIterations = 1_000_000) {
  let nonce = 0;
  while (nonce < maxIterations) {
    const hash = crypto
      .createHash("sha256")
      .update(`${tsRendered}:${nonce}`)
      .digest("hex");
    if (hash.startsWith(POW_DIFFICULTY_PREFIX)) return String(nonce);
    nonce++;
  }
  throw new Error("Could not find proof-of-work nonce within iteration budget.");
}

// ============================================================
// Start session
// ============================================================

export async function startExternalSession({ name, email }) {
  if (!name || typeof name !== "string" || name.length > 100) {
    throw new Error("name is required (max 100 chars)");
  }
  if (!email || typeof email !== "string") {
    throw new Error("email is required");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("email format invalid");
  }

  const tsRendered = Date.now() - POW_BACKDATE_MS;
  const powNonce = solvePoW(tsRendered);

  const res = await fetch(`${getBaseUrl()}/api/external/start-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      email,
      ts_rendered: tsRendered,
      hp_field: "",
      pow_nonce: powNonce,
      user_agent: "@llamaventures/cli",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    // Generic server message — could be PoW fail / disposable email /
    // rate limit / global cap. Server intentionally hides which gate caught.
    throw new Error(
      `Could not start session (HTTP ${res.status}). ${text.slice(0, 200)}\n` +
      `  Common causes: rate limit (5 sessions/IP/day, 3/email/day), ` +
      `disposable email domain blocked, or global daily cap reached.`
    );
  }

  const data = await res.json();
  if (!data?.session_id) {
    throw new Error("start-session response missing session_id");
  }

  const session = {
    session_id: data.session_id,
    name,
    email,
    started_at: new Date().toISOString(),
    last_active_at: new Date().toISOString(),
    finalized: false,
  };
  writeExternalSession(session);
  return session;
}

// ============================================================
// Send message — SSE streaming
// ============================================================

/**
 * Parse SSE events from a fetch ReadableStream. Yields parsed event objects
 * as they arrive. Buffers partial frames across chunks.
 */
async function* readSseEvents(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      // Flush any trailing data
      if (buffer.trim()) {
        const event = parseSseFrame(buffer);
        if (event) yield event;
      }
      return;
    }
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by \n\n
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const event = parseSseFrame(frame);
      if (event) yield event;
    }
  }
}

function parseSseFrame(frame) {
  const dataLines = frame
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.replace(/^data:\s?/, ""));
  if (dataLines.length === 0) return null;
  const payload = dataLines.join("\n");
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/**
 * Send a message to the external intake agent. Returns a result object
 * with the collected reply text and finalization state.
 *
 * If `onChunk` is provided, it's called with each text chunk as it arrives
 * (for streaming output to terminal). Returns the same final result.
 */
export async function sendExternalMessage(message, { attachments, onChunk } = {}) {
  const session = readExternalSession();
  if (!session) {
    throw new Error(
      "No active pitch session. Run `llama pitch start --name \"...\" --email \"...\"` first."
    );
  }
  if (session.finalized) {
    throw new Error(
      "This pitch session is finalized. Run `llama pitch end` to clear it, then `pitch start` for a new one."
    );
  }

  const res = await fetch(`${getBaseUrl()}/api/external/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `external_session=${session.session_id}`,
    },
    body: JSON.stringify({
      message,
      ...(attachments ? { attachments } : {}),
    }),
  });

  if (!res.ok) {
    if (res.status === 401) {
      clearExternalSession();
      throw new Error(
        "Session expired or invalid. Run `llama pitch start ...` to start a new one."
      );
    }
    if (res.status === 429) {
      // Cap reached — server has already finalized the session row.
      session.finalized = true;
      writeExternalSession(session);
      throw new Error(
        "Session cap reached (message or token limit). The server has finalized this session. " +
          "Run `llama pitch end` to clear local state, then `pitch start` for a new pitch."
      );
    }
    if (res.status === 503) {
      throw new Error(
        "Llama Ventures intake is at daily capacity — please retry tomorrow."
      );
    }
    const text = await res.text();
    throw new Error(`chat failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }

  const collectedText = [];
  let finalized = false;
  let finalizePayload = null;
  let streamError = null;

  for await (const event of readSseEvents(res.body)) {
    if (typeof event.text === "string") {
      collectedText.push(event.text);
      if (typeof onChunk === "function") onChunk(event.text);
    }
    if (event.finalize === true) {
      finalized = true;
      finalizePayload = event.payload ?? null;
    }
    if (event.error) {
      streamError = event.error;
    }
    // event.done === true → stream end; outer loop exits naturally
  }

  // Persist updated state
  session.last_active_at = new Date().toISOString();
  if (finalized) session.finalized = true;
  writeExternalSession(session);

  if (streamError) {
    throw new Error(`server-side error during chat: ${streamError}`);
  }

  return {
    text: collectedText.join(""),
    finalized,
    finalize_payload: finalizePayload,
  };
}

// ============================================================
// Upload file
// ============================================================

const ALLOWED_MIME_BY_EXT = {
  ".pdf": "application/pdf",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".ppt": "application/vnd.ms-powerpoint",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".txt": "text/plain",
  ".md": "text/markdown",
};

function guessMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  return ALLOWED_MIME_BY_EXT[ext] || "application/octet-stream";
}

export async function uploadExternalFile(filePath) {
  const session = readExternalSession();
  if (!session) {
    throw new Error(
      "No active pitch session. Run `llama pitch start ...` first."
    );
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const fileData = fs.readFileSync(filePath);
  const filename = path.basename(filePath);
  const mimetype = guessMimeType(filename);

  if (mimetype === "application/octet-stream") {
    throw new Error(
      `File extension not in server allowlist. Supported: ${Object.keys(
        ALLOWED_MIME_BY_EXT
      ).join(", ")}`
    );
  }

  const formData = new FormData();
  const blob = new Blob([fileData], { type: mimetype });
  formData.append("file", blob, filename);

  const res = await fetch(`${getBaseUrl()}/api/external/upload`, {
    method: "POST",
    headers: { Cookie: `external_session=${session.session_id}` },
    body: formData,
  });

  if (!res.ok) {
    if (res.status === 413) {
      throw new Error("File too large (max 50 MB).");
    }
    if (res.status === 415) {
      throw new Error(`MIME type "${mimetype}" not in server allowlist.`);
    }
    if (res.status === 429) {
      throw new Error("Upload cap reached (10 files per session).");
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        "Session expired or inactive. Run `llama pitch start ...` to start a new one."
      );
    }
    const text = await res.text();
    throw new Error(`upload failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }

  return await res.json();
}

// ============================================================
// Status
// ============================================================

export function getExternalSessionStatus() {
  const session = readExternalSession();
  if (!session) {
    return { active: false };
  }
  const idleMs = Date.now() - new Date(session.last_active_at).getTime();
  const idleMin = Math.floor(idleMs / 60000);
  return {
    active: !session.finalized && idleMin < 30,
    session_id: session.session_id,
    name: session.name,
    email: session.email,
    started_at: session.started_at,
    last_active_at: session.last_active_at,
    idle_minutes: idleMin,
    expired: idleMin >= 30,
    finalized: session.finalized || false,
  };
}

export const EXTERNAL_SESSION_FILE = SESSION_FILE;
