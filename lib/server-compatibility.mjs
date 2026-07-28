// Consume the compatibility policy returned by Llama Command.
//
// Unlike the npm-registry nudge, this path is intentionally NOT TTY-gated:
// coding agents and MCP hosts need to see the server's recommendation too.
// It remains safe for scripts because it writes only to stderr and shares the
// existing once-per-day update stamp with lib/version-check.mjs.

import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

const DEFAULT_STAMP_FILE = path.join(os.homedir(), ".llama", ".update-check");
const THROTTLE_MS = 24 * 60 * 60 * 1000;

function installedVersion() {
  try {
    const requireFromHere = createRequire(import.meta.url);
    return String(requireFromHere("../package.json").version || "unknown");
  } catch {
    return "unknown";
  }
}

function readHeader(headers, name) {
  if (typeof headers?.get === "function") return headers.get(name);
  if (!headers || typeof headers !== "object") return null;
  const match = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return match ? String(match[1]) : null;
}

export function parseServerCompatibility(headers) {
  const status = readHeader(headers, "x-llama-cli-status");
  if (!["ok", "stale", "unsupported", "unknown"].includes(status)) return null;
  return {
    status,
    recommendedVersion: readHeader(headers, "x-llama-cli-recommended-version"),
    minimumVersion: readHeader(headers, "x-llama-cli-minimum-version"),
    upgradeCommand:
      readHeader(headers, "x-llama-cli-upgrade-command") ||
      "npm i -g @llamaventures/cli@latest",
  };
}

function checkedRecently(stampFile, now) {
  try {
    const last = Number.parseInt(fs.readFileSync(stampFile, "utf8").trim(), 10);
    return Number.isFinite(last) && now - last < THROTTLE_MS;
  } catch {
    return false;
  }
}

function touchStamp(stampFile, now) {
  try {
    fs.mkdirSync(path.dirname(stampFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(stampFile, `${now}\n`, { mode: 0o600 });
  } catch {
    // Best-effort only. Compatibility hints must never break a command.
  }
}

export function formatServerCompatibilityNudge(policy, currentVersion = installedVersion()) {
  if (policy?.status !== "stale" || !policy.recommendedVersion) return null;
  return (
    `warning[CLI_UPDATE_RECOMMENDED]: Llama Command recommends ` +
    `@llamaventures/cli ${policy.recommendedVersion}; this client is ${currentVersion}. ` +
    `Upgrade: ${policy.upgradeCommand}`
  );
}

export function maybeNudgeServerCompatibility(headers, options = {}) {
  try {
    const env = options.env ?? process.env;
    if (env.LLAMA_NO_UPDATE_CHECK) return false;
    const policy = parseServerCompatibility(headers);
    const nudge = formatServerCompatibilityNudge(
      policy,
      options.currentVersion ?? installedVersion(),
    );
    if (!nudge) return false;
    const now = options.now ?? Date.now();
    const stampFile = options.stampFile ?? DEFAULT_STAMP_FILE;
    if (checkedRecently(stampFile, now)) return false;
    touchStamp(stampFile, now);
    const write = options.write ?? ((line) => process.stderr.write(`${line}\n`));
    write(nudge);
    return true;
  } catch {
    return false;
  }
}

export const SERVER_COMPATIBILITY_STAMP_FILE = DEFAULT_STAMP_FILE;
