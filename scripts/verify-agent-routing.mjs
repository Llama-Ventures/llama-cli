#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const coreApiContract = JSON.parse(readFileSync(path.join(repoRoot, "contracts/core-api.json"), "utf8"));

assert.equal(packageJson.version, "2.1.1");
assert.equal(
  packageJson.scripts?.["verify:release"],
  "npm test && npm run verify:artifact && node scripts/verify-tarball-clean.mjs",
);
assert.equal(existsSync(path.join(repoRoot, "docs/agent-skills.bundle.json")), false);
assert.equal(existsSync(path.join(repoRoot, "src/data/llama-os-skills.bundle.json")), false);

const calls = [];

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : null;
}

function json(res, value) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const body = await readJson(req);
  calls.push({
    method: req.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
    body,
    headers: {
      client: req.headers["x-llama-client"],
      version: req.headers["x-llama-client-version"],
      capabilities: req.headers["x-llama-client-capabilities"],
      apiVersion: req.headers["x-llama-api-contract-version"],
      apiDigest: req.headers["x-llama-api-contract-digest"],
    },
  });

  if (url.pathname === "/api/agent/client-events") return json(res, { ok: true, eventId: calls.length });
  if (url.pathname === "/api/agent/briefing") {
    return json(res, { ok: true, briefing: "server-owned CLI 2 four-action briefing" });
  }
  if (url.pathname === "/api/agent/manifest") {
    return json(res, { ok: true, briefing: "runtime CLI 2 manifest", skills: [] });
  }
  if (url.pathname === "/api/agent/skills") {
    return json(res, { ok: true, skills: [{ slug: "llama-command", description: "four actions" }] });
  }
  if (url.pathname === "/api/agent/skills/llama-command") {
    return json(res, { ok: true, skill: { slug: "llama-command", content: "# Four-action runtime skill" } });
  }
  if (url.pathname === "/api/wiki/search") return json(res, { results: [{ slug: "example" }] });
  if (url.pathname === "/api/occam/deals" && req.method === "GET") {
    return json(res, { deals: [{ id: "11111111-1111-4111-8111-111111111111", companyName: "Acme" }] });
  }
  if (url.pathname === "/api/occam/deals/11111111-1111-4111-8111-111111111111") {
    return json(res, { page: { companyName: "Acme" } });
  }
  if (url.pathname === "/api/occam/deals/commands" && req.method === "POST") {
    return json(res, { ok: true, result: { operation: body.operation, idempotencyKey: body.idempotencyKey } });
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

function childEnv(baseUrl, homeDir) {
  return {
    ...process.env,
    HOME: homeDir,
    LLAMA_API_URL: baseUrl,
    LLAMA_TOKEN: "llc_local_routing_test_token",
    LLAMA_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
  };
}

function runCli(args, baseUrl, homeDir, stdin = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/llama.mjs", ...args], {
      cwd: repoRoot,
      env: childEnv(baseUrl, homeDir),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const homeDir = await mkdtemp(path.join(os.tmpdir(), "llama-cli2-routing-"));

try {
  const onboard = await runCli(["agent-onboard"], baseUrl, homeDir);
  assert.equal(onboard.code, 0, onboard.stderr);
  assert.match(onboard.stdout, /four-action briefing/);

  const bootstrap = await runCli(["agent", "bootstrap"], baseUrl, homeDir);
  assert.equal(bootstrap.code, 0, bootstrap.stderr);
  assert.match(bootstrap.stdout, /CLI 2 manifest/);

  const skills = await runCli(["skills", "show", "llama-command"], baseUrl, homeDir);
  assert.equal(skills.code, 0, skills.stderr);
  assert.match(skills.stdout, /Four-action runtime skill/);

  const search = await runCli(["deal", "search", "Acme", "--limit", "3"], baseUrl, homeDir);
  assert.equal(search.code, 0, search.stderr);
  assert.match(search.stdout, /Acme/);

  const read = await runCli(
    ["deal", "read", "11111111-1111-4111-8111-111111111111"],
    baseUrl,
    homeDir,
  );
  assert.equal(read.code, 0, read.stderr);
  assert.match(read.stdout, /Acme/);

  const createJson = JSON.stringify({
    companyName: "New Co",
    origin: { kind: "user", originalUserUtterance: "Please create New Co." },
  });
  const create = await runCli(["deal", "create", "--json", "-"], baseUrl, homeDir, createJson);
  assert.equal(create.code, 0, create.stderr);
  assert.match(create.stdout, /deal\.create/);

  const writeJson = JSON.stringify({
    operation: "input.submit",
    dealId: "11111111-1111-4111-8111-111111111111",
    content: "exact words",
    origin: { kind: "user", originalUserUtterance: "exact words" },
  });
  const write = await runCli(["deal", "write", "--json", "-"], baseUrl, homeDir, writeJson);
  assert.equal(write.code, 0, write.stderr);
  assert.match(write.stdout, /input\.submit/);

  const business = calls.filter((call) => call.path !== "/api/agent/client-events");
  for (const call of business) {
    assert.equal(call.headers.version, "2.1.1");
    assert.equal(call.headers.capabilities, "core.read.v1,occam.deal.v1");
    assert.equal(call.headers.apiVersion, coreApiContract.apiVersion);
    assert.equal(call.headers.apiDigest, coreApiContract.sha256);
  }

  const countBeforeInvalid = calls.length;
  const retiredBrief = await runCli(["brief", "add-text", "x"], baseUrl, homeDir);
  assert.equal(retiredBrief.code, 1);
  assert.match(retiredBrief.stderr, /`llama brief` was retired in CLI 2\.0/);
  assert.match(retiredBrief.stderr, /operation: page\.patch/);
  assert.match(retiredBrief.stderr, /llama agent bootstrap/);
  for (const args of [
    ["deal", "unsupported", "x"],
    ["unsupported", "command"],
  ]) {
    const result = await runCli(args, baseUrl, homeDir);
    assert.equal(result.code, 1, `${args.join(" ")} unexpectedly succeeded`);
    assert.match(result.stderr, /Unknown/);
  }
  assert.equal(calls.length, countBeforeInvalid, "invalid commands must not emit HTTP or telemetry");

  const help = await runCli(["help", "deal"], baseUrl, homeDir);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Exactly four actions/);
  assert.match(help.stdout, /agent bootstrap/);
  assert.match(help.stdout, /arrays replace whole arrays/);
  console.log("PASS CLI 2 routing: four Deal actions, capability headers, live briefing, and pre-HTTP invalid-command fences");
} finally {
  server.close();
  await rm(homeDir, { recursive: true, force: true });
}
