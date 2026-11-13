// Browser login that survives the command that started it.
//
// The loopback flow needs something listening on 127.0.0.1 at the moment the
// person clicks Approve. When `llama auth login` itself was that listener, a
// closed terminal, a slow approval, or an agent tool that kills commands after
// a couple of minutes left the browser pointing at a dead port.
//
// So the listener is a small detached helper process. `llama auth login`
// starts it, shows the link, and waits; if the command is killed the helper
// keeps listening, finishes the login when the person approves, and stores
// the credentials. Running `llama auth login` again picks the same login up
// instead of starting a second one.
//
// The helper's state lives in ~/.llama/oauth-pending.json (0600). It holds the
// sign-in link and a status, never a token or the PKCE verifier.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { openBrowser, pkceLoopbackFlow } from "./oauth-flow.mjs";
import { writeBundle } from "./oauth-storage.mjs";

export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
/** How long a finished result stays claimable by the next `llama auth login`. */
const RESULT_TTL_MS = 10 * 60 * 1000;
const POLL_MS = 400;

export function defaultPendingPath() {
  return path.join(os.homedir(), ".llama", "oauth-pending.json");
}

export function readPending(pendingPath = defaultPendingPath()) {
  try {
    return JSON.parse(fs.readFileSync(pendingPath, "utf8"));
  } catch {
    return null;
  }
}

function writePending(pendingPath, state) {
  fs.mkdirSync(path.dirname(pendingPath), { recursive: true, mode: 0o700 });
  const tmp = `${pendingPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, pendingPath);
}

export function clearPending(pendingPath = defaultPendingPath()) {
  try { fs.unlinkSync(pendingPath); } catch { /* not present */ }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** A login someone can still approve: same server, helper alive, inside its window. */
export function liveLogin(pending, baseUrl, now = Date.now()) {
  return Boolean(
    pending && pending.status === "waiting" && pending.base_url === baseUrl &&
    now < pending.expires_at && processAlive(pending.pid),
  );
}

/**
 * The helper process body: listen, finish the login, store credentials.
 * Everything it learns is written to the pending file for whoever asks next.
 */
export async function runLoginListener({
  baseUrl, scope, pendingPath = defaultPendingPath(), storeBundle = writeBundle, windowMs = LOGIN_WINDOW_MS, flow = pkceLoopbackFlow,
}) {
  const started = Date.now();
  const base = { pid: process.pid, base_url: baseUrl, scope, started_at: started, expires_at: started + windowMs };
  try {
    const bundle = await flow({
      baseUrl, scope, resource: baseUrl, timeoutMs: windowMs, quiet: true,
      launchBrowser: (url) => writePending(pendingPath, { ...base, status: "waiting", url }),
    });
    const stored = await storeBundle({
      access_token: bundle.access_token,
      refresh_token: bundle.refresh_token,
      expires_at: Date.now() + (bundle.expires_in ?? 3600) * 1000,
      scope: bundle.scope,
      client_id: bundle.client_id,
      issuer: bundle.issuer,
      resource: bundle.resource,
      created_at: Date.now(),
    });
    writePending(pendingPath, { ...base, status: "done", finished_at: Date.now(), storage: stored.backend, scope: bundle.scope, client_id: bundle.client_id });
  } catch (error) {
    writePending(pendingPath, { ...base, status: "error", finished_at: Date.now(), error: String(error?.message ?? error) });
  }
}

function spawnDetachedListener({ cliEntry, scope }) {
  const child = spawn(process.execPath, [cliEntry, "auth", "login-listener", "--scope", scope], {
    detached: true, stdio: "ignore", windowsHide: true, env: process.env,
  });
  child.on("error", () => {});
  child.unref();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Start a browser login, or pick up the one already in progress, and wait.
 *
 * Returns { ok, storage, scope, client_id, resumed } on success. Throws the
 * login's own error (denied, timed out) when it failed. If the caller is
 * killed while waiting, nothing is lost: run it again.
 */
export async function startOrResumeLogin({
  baseUrl, scope, cliEntry, pendingPath = defaultPendingPath(), waitMs = LOGIN_WINDOW_MS,
  spawnListener = spawnDetachedListener, launchBrowser = openBrowser, log = (line) => console.error(line), now = () => Date.now(),
}) {
  let pending = readPending(pendingPath);

  // A login that finished after the previous command stopped waiting.
  if (pending?.base_url === baseUrl && pending.status === "done" && now() - pending.finished_at < RESULT_TTL_MS) {
    clearPending(pendingPath);
    return { ok: true, storage: pending.storage, scope: pending.scope, client_id: pending.client_id, resumed: true };
  }

  const resumed = liveLogin(pending, baseUrl, now());
  if (resumed) {
    const minutes = Math.max(1, Math.round((pending.expires_at - now()) / 60000));
    log(`A sign-in is already waiting for approval (about ${minutes} min left). Approve it in the browser:`);
    log(`  ${pending.url}`);
    log("If you already clicked Approve and saw an error page, reload that tab.");
  } else {
    clearPending(pendingPath);
    spawnListener({ cliEntry, scope, baseUrl, pendingPath });
    const deadline = now() + 15_000;
    while (now() < deadline) {
      pending = readPending(pendingPath);
      if (pending && pending.base_url === baseUrl && pending.status !== undefined) break;
      await sleep(100);
    }
    if (!pending || pending.status === undefined) {
      throw new Error("Error[OAUTH_LISTENER_FAILED]: could not start the sign-in listener. Re-run `llama auth login`.");
    }
    if (pending.status === "waiting") {
      // LLAMA_NO_BROWSER=1: print the link only (SSH, agents, a browser on another machine's profile).
      const openIt = !process.env.LLAMA_NO_BROWSER;
      log(openIt ? `Opening browser to ${baseUrl} for sign-in...` : `Open this link to sign in to ${baseUrl}:`);
      log(openIt ? `(If the browser does not open, visit this URL manually:\n  ${pending.url}\n)` : `  ${pending.url}`);
      log("This sign-in stays open for 15 minutes even if this command stops; run `llama auth login` again to pick it up.");
      if (openIt) launchBrowser(pending.url);
    }
  }

  const waitUntil = now() + waitMs;
  while (now() < waitUntil) {
    pending = readPending(pendingPath);
    if (pending?.status === "done") {
      clearPending(pendingPath);
      return { ok: true, storage: pending.storage, scope: pending.scope, client_id: pending.client_id, resumed };
    }
    if (pending?.status === "error") {
      clearPending(pendingPath);
      throw new Error(pending.error);
    }
    if (!pending || (pending.status === "waiting" && !liveLogin(pending, baseUrl, now()))) {
      clearPending(pendingPath);
      throw new Error("Error[OAUTH_TIMEOUT]: the sign-in was not approved in time. Re-run `llama auth login`.");
    }
    await sleep(POLL_MS);
  }
  throw new Error("Error[OAUTH_STILL_WAITING]: still waiting for approval in the browser. Run `llama auth login` again to keep waiting.");
}
