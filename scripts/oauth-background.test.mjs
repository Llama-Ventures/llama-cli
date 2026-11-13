import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { liveLogin, readPending, runLoginListener, startOrResumeLogin } from "../lib/oauth-background.mjs";

const BASE = "https://command.example.test";
const tmpPending = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llama-login-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "oauth-pending.json");
};
const bundle = { access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "read write", client_id: "llama-cli-official", resource: BASE, issuer: BASE };
/** A flow that publishes its link, then finishes when `settle` is called. */
function controllableFlow() {
  let settle;
  const finished = new Promise((resolve, reject) => { settle = { approve: () => resolve(bundle), fail: (message) => reject(new Error(message)) }; });
  return { flow: async ({ launchBrowser }) => { launchBrowser(`${BASE}/api/oauth/authorize?state=s`); return finished; }, settle: () => settle };
}
const quiet = { log: () => {}, launchBrowser: () => {} };

test("the listener publishes the link, then stores credentials and records success without any token in the file", async (t) => {
  const pendingPath = tmpPending(t);
  const stored = [];
  const { flow, settle } = controllableFlow();
  const running = runLoginListener({ baseUrl: BASE, scope: "read write", pendingPath, flow, storeBundle: async (b) => { stored.push(b); return { backend: "file" }; } });
  const waiting = readPending(pendingPath);
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.pid, process.pid);
  assert.ok(liveLogin(waiting, BASE));
  settle().approve();
  await running;
  const done = readPending(pendingPath);
  assert.equal(done.status, "done");
  assert.equal(done.storage, "file");
  assert.equal(stored[0].refresh_token, "rt");
  assert.doesNotMatch(fs.readFileSync(pendingPath, "utf8"), /"at"|"rt"|access_token|refresh_token|verifier/);
  assert.equal(fs.statSync(pendingPath).mode & 0o777, 0o600);
});

test("login waits for the helper and returns its result", async (t) => {
  const pendingPath = tmpPending(t);
  const { flow, settle } = controllableFlow();
  const opened = [];
  const spawnListener = () => { void runLoginListener({ baseUrl: BASE, scope: "read write", pendingPath, flow, storeBundle: async () => ({ backend: "keychain" }) }); };
  const login = startOrResumeLogin({ baseUrl: BASE, scope: "read write", pendingPath, spawnListener, log: () => {}, launchBrowser: (url) => { opened.push(url); settle().approve(); } });
  assert.deepEqual(await login, { ok: true, storage: "keychain", scope: "read write", client_id: "llama-cli-official", resumed: false });
  assert.equal(opened.length, 1);
  assert.equal(readPending(pendingPath), null, "a claimed result is cleared");
});

test("a second login picks up the one already waiting instead of starting another", async (t) => {
  const pendingPath = tmpPending(t);
  const { flow, settle } = controllableFlow();
  let spawned = 0;
  const spawnListener = () => { spawned += 1; void runLoginListener({ baseUrl: BASE, scope: "read write", pendingPath, flow, storeBundle: async () => ({ backend: "file" }) }); };
  // First command gives up early, as if an agent tool killed it.
  await assert.rejects(startOrResumeLogin({ baseUrl: BASE, scope: "read write", pendingPath, spawnListener, waitMs: 50, ...quiet }), /OAUTH_STILL_WAITING/);
  assert.equal(readPending(pendingPath).status, "waiting", "the login is still open");
  const lines = [];
  const second = startOrResumeLogin({ baseUrl: BASE, scope: "read write", pendingPath, spawnListener, log: (line) => lines.push(line), launchBrowser: () => assert.fail("must not open a second browser tab") });
  await new Promise((resolve) => setTimeout(resolve, 50));
  settle().approve();
  assert.equal((await second).resumed, true);
  assert.equal(spawned, 1);
  assert.match(lines.join("\n"), /already waiting for approval/);
});

test("an approval that landed while no command was waiting is claimed by the next login", async (t) => {
  const pendingPath = tmpPending(t);
  const { flow, settle } = controllableFlow();
  const listener = runLoginListener({ baseUrl: BASE, scope: "read write", pendingPath, flow, storeBundle: async () => ({ backend: "file" }) });
  settle().approve();
  await listener;
  const result = await startOrResumeLogin({ baseUrl: BASE, scope: "read write", pendingPath, spawnListener: () => assert.fail("must not start a new login"), ...quiet });
  assert.equal(result.ok, true);
  assert.equal(result.resumed, true);
});

test("a denial reaches the waiting command as the real reason", async (t) => {
  const pendingPath = tmpPending(t);
  const { flow, settle } = controllableFlow();
  const spawnListener = () => { void runLoginListener({ baseUrl: BASE, scope: "read write", pendingPath, flow, storeBundle: async () => assert.fail("must not store") }); };
  const login = startOrResumeLogin({ baseUrl: BASE, scope: "read write", pendingPath, spawnListener, log: () => {}, launchBrowser: () => settle().fail("Error[OAUTH_DENIED]: access_denied — User denied the authorization request") });
  await assert.rejects(login, /OAUTH_DENIED/);
  assert.equal(readPending(pendingPath), null);
});

test("a login left by a dead helper, an expired one, or one for another server is not resumed", () => {
  const now = Date.now();
  const waiting = { status: "waiting", base_url: BASE, pid: process.pid, expires_at: now + 60_000, url: "u" };
  assert.equal(liveLogin(waiting, BASE, now), true);
  assert.equal(liveLogin({ ...waiting, pid: 2 ** 30 }, BASE, now), false);
  assert.equal(liveLogin({ ...waiting, expires_at: now - 1 }, BASE, now), false);
  assert.equal(liveLogin(waiting, "https://other.example.test", now), false);
  assert.equal(liveLogin({ ...waiting, status: "done" }, BASE, now), false);
  assert.equal(liveLogin(null, BASE, now), false);
});
