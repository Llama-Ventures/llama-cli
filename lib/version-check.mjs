// Soft update nudge for @llamaventures/cli.
//
// Philosophy: minimal friction. We NEVER block a command and we NEVER spam.
// The npm registry is the source of truth for "latest published", so we
// query it directly — no llama-command changes, nothing to keep in sync.
//
// Friction controls, all of which must pass before we print anything:
//   1. TTY-gated   — only nudge an interactive human (process.stdout.isTTY).
//                    MCP server / piped output / CI → silent, so agents and
//                    scripts never see noise that could corrupt parsed output.
//   2. Throttled   — at most once per 24h, tracked by a timestamp file.
//   3. stderr only — the nudge never touches stdout, so `llama ... | jq` etc
//                    stay clean even in the rare case it does print.
//   4. Best-effort — every error path (offline, registry down, parse fail) is
//                    swallowed. A nudge must never break or delay a command.

import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { TOKEN_DIR } from "./client.mjs";

const REGISTRY_URL = "https://registry.npmjs.org/@llamaventures/cli/latest";
const STAMP_FILE = path.join(TOKEN_DIR, ".update-check");
const THROTTLE_MS = 24 * 60 * 60 * 1000; // once per day
const FETCH_TIMEOUT_MS = 2000;

function installedVersion() {
  try {
    const requireFromHere = createRequire(import.meta.url);
    return requireFromHere("../package.json").version;
  } catch {
    return null;
  }
}

// Compare two semver strings. Returns true if `latest` is strictly newer than
// `current`. Pre-release tags are ignored (we only ship plain x.y.z).
function isNewer(latest, current) {
  const a = String(latest).split(".").map((n) => parseInt(n, 10));
  const b = String(current).split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

function checkedRecently() {
  try {
    const last = parseInt(fs.readFileSync(STAMP_FILE, "utf8").trim(), 10);
    return Number.isFinite(last) && Date.now() - last < THROTTLE_MS;
  } catch {
    return false;
  }
}

function touchStamp() {
  try {
    fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(STAMP_FILE, `${Date.now()}\n`, { mode: 0o600 });
  } catch {
    // Best-effort. If we can't write the stamp we may nudge again tomorrow —
    // harmless. Never throw.
  }
}

async function fetchLatest() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // The /latest convenience endpoint returns full JSON under the default
    // Accept. (The abbreviated "vnd.npm.install-v1+json" metadata type is only
    // valid on the full packument endpoint — it 406s here.)
    const res = await fetch(REGISTRY_URL, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.version === "string" ? data.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compute the nudge line without any side effects (no TTY/throttle gating).
 * Returns the one-line string if an upgrade is available, else null. Used by
 * the explicit `llama version --check` command so an agent can surface it.
 */
export async function getUpdateNudge() {
  const current = installedVersion();
  if (!current) return null;
  const latest = await fetchLatest();
  if (!latest || !isNewer(latest, current)) return null;
  return `⬆ llama CLI ${current} → ${latest} available · npm i -g @llamaventures/cli@latest`;
}

/**
 * Fire-and-forget soft nudge for interactive humans. Safe to call without
 * awaiting; resolves to true if it printed a nudge, false otherwise. Honors
 * all four friction controls above. Set $LLAMA_NO_UPDATE_CHECK=1 to disable.
 */
export async function maybeNudgeUpdate() {
  try {
    if (process.env.LLAMA_NO_UPDATE_CHECK) return false;
    if (!process.stdout.isTTY) return false; // humans only
    if (checkedRecently()) return false;
    touchStamp(); // stamp before the network call so a slow/failed check still throttles
    const nudge = await getUpdateNudge();
    if (!nudge) return false;
    process.stderr.write(`${nudge}\n`);
    return true;
  } catch {
    return false;
  }
}
