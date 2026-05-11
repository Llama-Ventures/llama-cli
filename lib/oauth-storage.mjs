// OAuth credential storage for the Llama CLI.
//
// Persists the access_token / refresh_token / expires_at bundle returned
// by the Llama Command authorization server. Two backends, in order:
//
//   1. OS Keychain via @napi-rs/keyring — macOS Keychain, Windows
//      Credential Manager, Linux Secret Service (libsecret). Industry
//      standard for desktop CLIs (gh, gcloud, Azure SDK).
//
//   2. Plain file `~/.llama/oauth.json` mode 0600 — used when the
//      Keychain backend isn't available (Linux container with no
//      libsecret, headless CI runner). Same posture as the existing
//      `~/.llama/token` for PATs, and the same posture gh/gcloud/aws
//      ship with on Linux servers.
//
// Cross-process lock: the refresh-token rotation contract requires that
// two shells refreshing simultaneously don't burn each other's refresh
// token. We coordinate via atomic O_CREAT|O_EXCL on `~/.llama/oauth.lock`
// with a short retry window, and after acquiring re-read the credentials
// in case the other shell already refreshed.

import fs from "fs";
import os from "os";
import path from "path";

const SERVICE = "com.llamaventures.cli";
const ACCOUNT = "oauth";

const STORE_DIR = path.join(os.homedir(), ".llama");
const FILE_PATH = path.join(STORE_DIR, "oauth.json");
const LOCK_PATH = path.join(STORE_DIR, "oauth.lock");

// ============================================================
// Keychain backend (lazy-loaded — keep startup fast)
// ============================================================

let _keychainEntry = null;
let _keychainTried = false;

async function getKeychainEntry() {
  if (_keychainTried) return _keychainEntry;
  _keychainTried = true;
  try {
    const { Entry } = await import("@napi-rs/keyring");
    _keychainEntry = new Entry(SERVICE, ACCOUNT);
    // Probe — if the platform backend is missing (e.g. Linux without
    // libsecret), the Entry methods throw on first use. Surface that
    // here so callers route to the file backend.
    try {
      _keychainEntry.getPassword();
    } catch (err) {
      const msg = String(err?.message ?? err);
      // "no entry" / "not found" is fine — backend works, just empty.
      // Any other error means the backend itself is unavailable.
      if (!/no entry|not found|no such/i.test(msg)) {
        _keychainEntry = null;
      }
    }
  } catch {
    _keychainEntry = null;
  }
  return _keychainEntry;
}

// ============================================================
// Bundle shape
// ============================================================

/**
 * @typedef {Object} OAuthBundle
 * @property {string} access_token
 * @property {string} refresh_token
 * @property {number} expires_at         absolute ms epoch when access_token expires
 * @property {string} scope              space-separated, OAuth wire format
 * @property {string} client_id          which AS client minted this bundle
 * @property {string} issuer             AS issuer URL — bundle is bound to it
 * @property {string} resource           RFC 8707 audience the access_token is for
 * @property {number} created_at         ms epoch when bundle was first stored
 */

// ============================================================
// Read / write / delete
// ============================================================

export async function readBundle() {
  const entry = await getKeychainEntry();
  if (entry) {
    try {
      const raw = entry.getPassword();
      if (raw) return JSON.parse(raw);
    } catch {
      // fall through to file
    }
  }
  try {
    const raw = fs.readFileSync(FILE_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function writeBundle(bundle) {
  const json = JSON.stringify(bundle);
  const entry = await getKeychainEntry();
  if (entry) {
    try {
      entry.setPassword(json);
      // Best-effort cleanup: if a stale plaintext file exists from a
      // pre-Keychain install, remove it so we don't have two copies of
      // the credential drifting.
      try { fs.unlinkSync(FILE_PATH); } catch { /* not present */ }
      return { backend: "keychain" };
    } catch {
      // fall through to file
    }
  }
  fs.mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(FILE_PATH, `${json}\n`, { mode: 0o600 });
  fs.chmodSync(FILE_PATH, 0o600);
  return { backend: "file" };
}

export async function deleteBundle() {
  const entry = await getKeychainEntry();
  if (entry) {
    try { entry.deletePassword(); } catch { /* may not be present */ }
  }
  try { fs.unlinkSync(FILE_PATH); } catch { /* may not be present */ }
}

export async function detectBackend() {
  const entry = await getKeychainEntry();
  return entry ? "keychain" : "file";
}

// ============================================================
// Cross-process lock
// ============================================================
//
// Refresh rotation requires that only ONE process at a time exchange
// the current refresh token. Without a lock, two CLI invocations racing
// on token expiry would both POST /oauth/token; the first wins, the
// second gets `invalid_grant` (because the first already rotated), and
// the user sees a confusing failure.
//
// Pattern: atomic O_CREAT | O_EXCL on a sentinel file. If we get the
// fd, we own the lock; on EEXIST, another process owns it — wait briefly
// and retry. After acquiring, ALWAYS re-read the bundle from storage in
// case the other process has refreshed in the meantime (then we don't
// need to refresh ourselves).

const LOCK_RETRY_MS = 100;
const LOCK_TIMEOUT_MS = 5_000;

export async function withRefreshLock(fn) {
  fs.mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
  const start = Date.now();
  let fd;
  while (true) {
    try {
      fd = fs.openSync(LOCK_PATH, "wx", 0o600);
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // Stale lock cleanup: if the lock file is older than the timeout,
      // the holding process likely crashed. Remove and retry.
      try {
        const stat = fs.statSync(LOCK_PATH);
        if (Date.now() - stat.mtimeMs > LOCK_TIMEOUT_MS) {
          fs.unlinkSync(LOCK_PATH);
          continue;
        }
      } catch { /* lock disappeared between EEXIST and stat — fine */ }
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error(
          "Error[OAUTH_LOCK_TIMEOUT]: Could not acquire OAuth refresh lock at " +
          LOCK_PATH + ". Another `llama` process may be hung. Remove the " +
          "lock file manually if you're sure no other CLI is running."
        );
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
  try {
    return await fn();
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.unlinkSync(LOCK_PATH); } catch { /* already gone */ }
  }
}
