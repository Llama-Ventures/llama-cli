import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import test from "node:test";

function runCli(baseUrl, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/llama.mjs", ...args], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        LLAMA_API_URL: baseUrl,
        LLAMA_TOKEN: "llc_local_page_schema_test",
        LLAMA_NO_UPDATE_CHECK: "1",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("real CLI progressively reads the Page schema through authenticated Core", async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    seen.push({
      method: req.method,
      path: url.pathname,
      fields: url.searchParams.getAll("field"),
      section: url.searchParams.get("section"),
      token: req.headers["x-llama-token"],
    });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, mode: seen.length === 1 ? "index" : "selection" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  for (const args of [
    ["page-schema", "list"],
    ["page-schema", "read", "description", "foundersJson.founders"],
    ["page-schema", "section", "people"],
  ]) {
    const result = await runCli(baseUrl, args);
    assert.equal(result.code, 0, result.stderr);
  }

  const pageCalls = seen.filter(({ path }) => path === "/api/agent/page-schema");
  assert.deepEqual(
    pageCalls.map(({ method, path, fields, section }) => ({ method, path, fields, section })),
    [
      { method: "GET", path: "/api/agent/page-schema", fields: [], section: null },
      {
        method: "GET",
        path: "/api/agent/page-schema",
        fields: ["description", "foundersJson.founders"],
        section: null,
      },
      { method: "GET", path: "/api/agent/page-schema", fields: [], section: "people" },
    ],
  );
  assert.ok(pageCalls.every(({ token }) => token === "llc_local_page_schema_test"));

  const beforeInvalid = seen.length;
  for (const args of [
    ["page-schema", "read"],
    ["page-schema", "section", "people", "market"],
    ["page-schema", "everything"],
    ["page-schema", "read", ...Array.from({ length: 21 }, (_, i) => `field-${i}`)],
  ]) {
    const result = await runCli(baseUrl, args);
    assert.equal(result.code, 1, `${args.join(" ")} unexpectedly succeeded`);
  }
  assert.equal(seen.length, beforeInvalid, "invalid selectors must fail before HTTP");
});

test("Page schema help teaches progressive disclosure", async () => {
  const result = await runCli("http://127.0.0.1:1", ["help", "page-schema"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Start with list/);
  assert.match(result.stdout, /read only the exact fields/);
  assert.match(result.stdout, /section read only when/);
  assert.match(result.stdout, /not a fifth Deal action/);
});
