import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Readable } from "node:stream";
import { prepareFeedback, readFeedbackInput } from "../lib/feedback.mjs";
const id = "11111111-1111-4111-8111-111111111111";
const report = { submission_id: id, title: "Confusing empty response", body: "The task required a workaround", experienced_by: "agent" };

test("feedback environment preserves provenance, redacts known secrets and rejects arbitrary diagnostics", () => {
  const value = prepareFeedback({ ...report, body: "Bearer synthetic-value\napi_key=synthetic-other", environment: { agent_version: "7.8.9", model: "synthetic-model" } }, { name: "synthetic-host", version: "1.2.3" });
  assert.equal(value.environment.agent_name, "synthetic-host");
  assert.equal(value.environment.agent_name_source, "host");
  assert.equal(value.environment.agent_version, "7.8.9");
  assert.equal(value.environment.agent_version_source, "reported");
  assert.equal(value.environment.model_source, "reported");
  assert.ok(value.environment.cli_version); assert.ok(value.environment.node_version);
  assert.doesNotMatch(JSON.stringify(value), /synthetic-value|synthetic-other/);
  assert.equal(value.environment.request_id, undefined);
  assert.throws(() => prepareFeedback({ ...report, environment: { raw_environment: { SECRET: "private" } } }), /Unknown/);
  assert.throws(() => prepareFeedback({ ...report, reporter_user_id: 12 }), /Unknown/);
  assert.throws(() => prepareFeedback({ ...report, experienced_by: "system" }), /experienced_by/);
  assert.throws(() => prepareFeedback({ ...report, body: "x".repeat(8001) }), /8000/);
  assert.throws(() => prepareFeedback({ ...report, occurred_at: "yesterday" }), /ISO/);
});

async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), "llama-feedback-"));
  const seen = []; let mode = "ok";
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    seen.push({ method: req.method, url: req.url, body, token: req.headers["x-llama-token"] });
    res.setHeader("Content-Type", "application/json");
    if (mode === "fail") { res.writeHead(503); res.end(JSON.stringify({ error: "Feedback unavailable" })); return; }
    if (mode === "redirect") { res.writeHead(307, { Location: "/unexpected" }); res.end(); return; }
    res.writeHead(req.method === "POST" ? 201 : 200);
    res.end(JSON.stringify({ feedback: { id, status: "open", ...body }, ...(body ? { replayed: false } : {}) }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true }); });
  const env = { ...process.env, HOME: home, LLAMA_API_URL: `http://127.0.0.1:${server.address().port}`, LLAMA_TOKEN: "llc_synthetic_feedback_test", LLAMA_NO_UPDATE_CHECK: "1", LLAMA_AGENT_CLIENT: "unknown" };
  delete env.LLAMA_AGENT_VERSION; delete env.LLAMA_AGENT_MODEL;
  const cli = (args, stdin = "") => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/llama.mjs", ...args], { cwd: new URL("..", import.meta.url), env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
    child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr })); child.stdin.end(stdin);
  });
  return { seen, cli, env, mode: value => { mode = value; } };
}
test("real CLI submits flags/JSON, reads receipts, and emits no feedback telemetry", async t => {
  const f = await fixture(t);
  const args = ["feedback", "submit", "--title", report.title, "--body", report.body, "--experienced-by", "agent", "--submission-id", id];
  const first = await f.cli(args); assert.equal(first.code, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).feedback.status, "open");
  const second = await f.cli(args); assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(f.seen[0].body, f.seen[1].body, "same explicit submission ID can replay without fresh timestamps");
  assert.equal(f.seen[0].body.environment.agent_version, undefined, "never guess installed agent versions");
  const json = await f.cli(["feedback", "submit", "--file", "-"], JSON.stringify(report)); assert.equal(json.code, 0, json.stderr);
  const read = await f.cli(["feedback", "show", id]); assert.equal(read.code, 0, read.stderr);
  assert.equal(f.seen.length, 4); assert.ok(f.seen.every(r => r.token === "llc_synthetic_feedback_test"));
  assert.ok(f.seen.every(r => r.url.startsWith("/api/feedback")));
  const count = f.seen.length;
  assert.equal((await f.cli(["feedback", "submit", "--title", "missing-body"])).code, 1);
  assert.equal((await f.cli(["feedback", "show", "not-a-uuid"])).code, 1);
  assert.equal(f.seen.length, count, "invalid input never sends HTTP");
});
test("feedback failures return a reusable ID and never redirect or recursively report", async t => {
  const f = await fixture(t);
  f.mode("fail"); const failed = await f.cli(["feedback", "submit", "--title", report.title, "--body", report.body]);
  assert.equal(failed.code, 1); assert.equal(failed.stdout, "");
  assert.match(failed.stderr, /FEEDBACK_NOT_CONFIRMED/); assert.match(failed.stderr, /submission_id=[0-9a-f-]{36}/);
  assert.equal(f.seen.length, 1);
  f.mode("redirect"); const redirected = await f.cli(["feedback", "submit", "--file", "-"], JSON.stringify(report));
  assert.equal(redirected.code, 1); assert.equal(f.seen.length, 2);
});
test("real MCP exposes typed feedback tools and captures initialized host version", async t => {
  const f = await fixture(t);
  const transport = new StdioClientTransport({ command: process.execPath, args: ["bin/llama-mcp.mjs"], cwd: new URL("..", import.meta.url).pathname, env: f.env, stderr: "pipe" });
  const client = new Client({ name: "synthetic-coding-agent", version: "9.8.7" });
  await client.connect(transport); t.after(() => client.close());
  const tools = await client.listTools();
  const tool = tools.tools.find(t => t.name === "feedback_submit");
  assert.deepEqual(tool.inputSchema.required, ["title", "body"]);
  assert.ok(tools.tools.some(t => t.name === "feedback_show"));
  const result = await client.callTool({ name: "feedback_submit", arguments: report });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0].body.environment.surface, "mcp");
  assert.equal(f.seen[0].body.environment.agent_name, "synthetic-coding-agent");
  assert.equal(f.seen[0].body.environment.agent_version, "9.8.7");
  assert.equal(f.seen[0].body.environment.agent_version_source, "host");
  f.mode("fail"); const failed = await client.callTool({ name: "feedback_submit", arguments: report });
  assert.equal(failed.isError, true); assert.match(failed.content[0].text, /FEEDBACK_NOT_CONFIRMED/);
});

test("feedback JSON input is bounded before parsing", async () => {
  await assert.rejects(readFeedbackInput("-", Readable.from(["x".repeat(32769)])), /32 KiB/);
  await assert.rejects(readFeedbackInput("-", Readable.from(["{invalid"])), /valid JSON/);
});
