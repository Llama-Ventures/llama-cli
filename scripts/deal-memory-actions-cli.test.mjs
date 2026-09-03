import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import test from "node:test";

const DEAL_ID = "11111111-1111-4111-8111-111111111111";
const MARKDOWN = `---
deal_id: "${DEAL_ID}"
uuid: "22222222-2222-4222-8222-222222222222"
created: '2026-09-03T18:00:00.000Z'
updated: '2026-09-03T18:00:00.000Z'
---

# Acme 原样
`;

function runCli(baseUrl, args, stdin = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/llama.mjs", ...args], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        LLAMA_API_URL: baseUrl,
        LLAMA_TOKEN: "llc_local_memory_contract_test",
        LLAMA_NO_UPDATE_CHECK: "1",
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

test("real CLI reads and writes Deal Memory only through authenticated Core", async (t) => {
  const seen = [];
  const story = {
    deal_id: DEAL_ID,
    markdown: MARKDOWN,
    metadata: {
      deal_id: DEAL_ID,
      uuid: "22222222-2222-4222-8222-222222222222",
      created: "2026-09-03T18:00:00.000Z",
      updated: "2026-09-03T18:00:00.000Z",
    },
    version: '"etag-1"',
    object_version_id: "s3-version-1",
  };
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen.push({
      method: req.method,
      url: req.url,
      body: raw ? JSON.parse(raw) : null,
      token: req.headers["x-llama-token"],
    });
    res.setHeader("content-type", "application/json");
    if (req.method === "PUT" && seen.at(-1)?.body?.expected_version === '"stale"') {
      res.statusCode = 409;
      res.end(JSON.stringify({
        error: "Deal Story changed; read the current version before retrying",
        code: "VERSION_CONFLICT",
      }));
      return;
    }
    res.end(JSON.stringify(req.url === "/api/agent/client-events" ? { ok: true } : story));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const read = await runCli(baseUrl, ["memory", "read", DEAL_ID]);
  assert.equal(read.code, 0, read.stderr);
  assert.equal(JSON.parse(read.stdout).version, '"etag-1"');

  const raw = await runCli(baseUrl, ["memory", "read", DEAL_ID, "--raw"]);
  assert.equal(raw.code, 0, raw.stderr);
  assert.equal(raw.stdout, MARKDOWN);

  const write = await runCli(
    baseUrl,
    ["memory", "write", DEAL_ID, "--markdown", "-", "--expected-version", '"etag-1"'],
    MARKDOWN,
  );
  assert.equal(write.code, 0, write.stderr);

  const memoryCalls = seen.filter((entry) => entry.url === `/api/deal-memory/${DEAL_ID}/story`);
  assert.deepEqual(memoryCalls.map(({ method }) => method), ["GET", "GET", "PUT"]);
  assert.ok(memoryCalls.every(({ token }) => token === "llc_local_memory_contract_test"));
  assert.deepEqual(memoryCalls[2].body, {
    markdown: MARKDOWN,
    expected_version: '"etag-1"',
  });

  const stale = await runCli(
    baseUrl,
    ["memory", "write", DEAL_ID, "--markdown", "-", "--expected-version", '"stale"'],
    MARKDOWN,
  );
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /Error\[VERSION_CONFLICT\]/);
  assert.match(stale.stderr, /read the current version before retrying/);
});

test("invalid memory commands fail before HTTP", async () => {
  const result = await runCli("http://127.0.0.1:1", ["memory", "read", "not-a-uuid"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /valid deal UUID/);
});
