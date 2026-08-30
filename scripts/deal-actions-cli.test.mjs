import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import test from "node:test";

function runCli(baseUrl, args, stdin = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/llama.mjs", ...args], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        LLAMA_API_URL: baseUrl,
        LLAMA_TOKEN: "llc_local_contract_test_token",
        NO_COLOR: "1",
      },
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

test("real CLI exposes exactly four Deal actions against the Core boundary", async (t) => {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    seen.push({ method: req.method, url: req.url, body });
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/agent/client-events") {
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.end(JSON.stringify({ ok: true, request: { method: req.method, url: req.url, body } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const search = await runCli(baseUrl, ["deal", "search", "Example", "--limit", "3"]);
  assert.equal(search.code, 0, search.stderr);
  assert.equal(JSON.parse(search.stdout).request.url, "/api/occam/deals?q=Example&limit=3");

  const read = await runCli(baseUrl, ["deal", "read", "deal-1", "--detail", "memory"]);
  assert.equal(read.code, 0, read.stderr);
  assert.equal(JSON.parse(read.stdout).request.url, "/api/occam/deals/deal-1?expand=information");

  const createInput = JSON.stringify({
    companyName: "Example Co",
    origin: { kind: "user", originalUserUtterance: "Please create Example Co." },
  });
  const create = await runCli(baseUrl, ["deal", "create", "--json", "-"], createInput);
  assert.equal(create.code, 0, create.stderr);
  const createBody = JSON.parse(create.stdout).request.body;
  assert.equal(createBody.operation, "deal.create");
  assert.match(createBody.idempotencyKey, /^cli:[0-9a-f]{40}$/);

  const writeInput = JSON.stringify({
    operation: "input.submit",
    dealId: "deal-1",
    content: "The exact input.",
    origin: { kind: "user", originalUserUtterance: "The exact input." },
  });
  const write = await runCli(baseUrl, ["deal", "write", "--json", "-"], writeInput);
  assert.equal(write.code, 0, write.stderr);
  const writeBody = JSON.parse(write.stdout).request.body;
  assert.equal(writeBody.operation, "input.submit");
  assert.equal(writeBody.origin.originalUserUtterance, "The exact input.");
  assert.ok(seen.some((entry) => entry.method === "POST" && entry.url === "/api/occam/deals/commands"));

  const requestsBeforeRetiredChecks = seen.length;
  for (const args of [
    ["deal", "show", "deal-1"],
    ["deal", "feed", "deal-1"],
    ["deal", "update", "deal-1", "notes", "legacy"],
    ["workflow", "show", "deal-1"],
    ["post", "deal-1", "legacy"],
    ["html", "show", "deal-1"],
  ]) {
    const retired = await runCli(baseUrl, args);
    assert.equal(retired.code, 1, `${args.join(" ")} unexpectedly succeeded`);
    assert.match(retired.stderr, /DEAL_COMMAND_RETIRED/);
  }
  assert.equal(seen.length, requestsBeforeRetiredChecks, "retired commands must fail before HTTP");

  const positionalCreate = await runCli(baseUrl, ["deal", "create", "Legacy Co"]);
  assert.equal(positionalCreate.code, 1);
  assert.match(positionalCreate.stderr, /--json <file\|-> is required/);
  assert.equal(seen.length, requestsBeforeRetiredChecks, "legacy create must fail before HTTP");
});
