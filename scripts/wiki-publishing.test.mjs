import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const html = '<!doctype html><html><head><style>body{color:#222}</style></head><body><h1>研究</h1><script>window.chartData=[1,2,3]</script></body></html>';

function cli(env, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/llama.mjs", ...args], {
      env, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

test("Wiki CLI and MCP preserve complete HTML, language and explicit Markdown", async t => {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    if (req.url === "/api/wiki/save") seen.push(body);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, request: body, canonical_url: "/wiki/example?lang=zh", verified: true }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const env = {
    ...process.env,
    LLAMA_API_URL: `http://127.0.0.1:${server.address().port}`,
    LLAMA_TOKEN: "llc_local_wiki_test",
    LLAMA_NO_TELEMETRY: "1",
    LLAMA_NO_UPDATE_CHECK: "1",
  };
  const dir = await mkdtemp(path.join(os.tmpdir(), "llama-wiki-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "page.html");
  await writeFile(file, html);
  const saved = await cli(env, ["wiki", "save", "example", "--title", "Example", "--file", file, "--lang", "zh", "--sources", "https://example.com"]);
  assert.equal(saved.code, 0, saved.stderr);
  assert.equal(JSON.parse(saved.stdout).request.content, html);
  assert.equal(seen[0].content_type, "html");
  assert.equal(seen[0].lang, "zh");

  const markdown = await cli(env, ["wiki", "save", "example", "--title", "Example", "--content", "# Existing Markdown", "--content-type", "markdown", "--sources", "https://example.com"]);
  assert.equal(markdown.code, 0, markdown.stderr);
  assert.equal(seen[1].content_type, "markdown");
  assert.equal(seen[1].content, "# Existing Markdown");

  const client = new Client({ name: "wiki-publishing-test", version: "1" });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: ["bin/llama-mcp.mjs"], env, stderr: "pipe",
  }));
  const tools = await client.listTools();
  const saveTool = tools.tools.find(tool => tool.name === "wiki_save");
  assert.deepEqual(saveTool.inputSchema.properties.lang.enum, ["en", "zh"]);
  assert.deepEqual(saveTool.inputSchema.properties.content_type.enum, ["markdown", "html"]);
  assert.ok(!saveTool.inputSchema.required.includes("content_type"));
  const result = await client.callTool({ name: "wiki_save", arguments: {
    slug: "example", title: "Example", content: html,
    sources: ["https://example.com"], content_type: "html", lang: "zh",
  } });
  assert.ok(!result.isError);
  assert.deepEqual(seen[2], { slug: "example", title: "Example", content: html, sources: ["https://example.com"], content_type: "html", lang: "zh" });

  for (const args of [["help", "wiki"], ["wiki", "save", "--help"]]) {
    const help = await cli({ ...env, LLAMA_API_URL: "http://127.0.0.1:1", LLAMA_TOKEN: "" }, args);
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /Llama Wiki/);
    assert.match(help.stdout, /--file page\.html --content-type html/);
  }
  assert.equal(seen.length, 3);
});
