#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const calls = [];
let threadSeq = 0;

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function writeJson(res, data) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function writeSse(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const events = [
    { tool_use: { name: "read_typed_factual_layer" } },
    { tool_result: { name: "read_typed_factual_layer", ok: true, summary: "ok" } },
    { text: "agent done" },
  ];
  for (const event of events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
}

const server = createServer(async (req, res) => {
  try {
    const body = await readJson(req);
    const url = new URL(req.url, "http://localhost");
    calls.push({ method: req.method, path: url.pathname, body });

    if (req.method === "POST" && /^\/api\/deals\/[^/]+\/threads$/.test(url.pathname)) {
      threadSeq += 1;
      writeJson(res, { id: `thread-${threadSeq}` });
      return;
    }

    if (req.method === "POST" && /^\/api\/deals\/[^/]+\/threads\/[^/]+$/.test(url.pathname)) {
      writeSse(res);
      return;
    }

    if (req.method === "POST" && /^\/api\/deals\/[^/]+\/enrich$/.test(url.pathname)) {
      writeJson(res, {
        ok: true,
        agentHarness: {
          handoffPrompt: "mock handoff prompt",
          systemInjection: "mock system injection",
        },
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Unexpected route ${req.method} ${url.pathname}` }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err?.message ?? String(err) }));
  }
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function childEnv(baseUrl, homeDir) {
  return {
    ...process.env,
    HOME: homeDir,
    LLAMA_API_URL: baseUrl,
    LLAMA_TOKEN: "llc_mock_agent_routing",
    PATH: "/usr/bin:/bin",
  };
}

function resetCalls() {
  calls.length = 0;
  threadSeq = 0;
}

function paths() {
  return calls.map((call) => `${call.method} ${call.path}`);
}

function assertNoEnrichCall() {
  assert.equal(
    calls.some((call) => call.path.endsWith("/enrich")),
    false,
    `expected no /enrich call, got ${paths().join(", ")}`,
  );
}

function assertThreadRun({ title, messageIncludes }) {
  assert.equal(calls.length, 2, `expected thread create + SSE run, got ${paths().join(", ")}`);
  assert.match(calls[0].path, /^\/api\/deals\/[^/]+\/threads$/);
  assert.equal(calls[0].body?.title, title);
  assert.match(calls[1].path, /^\/api\/deals\/[^/]+\/threads\/thread-1$/);
  for (const needle of messageIncludes) {
    assert.match(calls[1].body?.message ?? "", new RegExp(escapeRegExp(needle)));
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function runCli(args, baseUrl, homeDir) {
  const child = spawn(process.execPath, ["bin/llama.mjs", ...args], {
    cwd: repoRoot,
    env: childEnv(baseUrl, homeDir),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0, `CLI failed (${code})\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
  return { stdout, stderr };
}

async function callMcpTool(name, args, baseUrl, homeDir) {
  const child = spawn(process.execPath, ["bin/llama-mcp.mjs"], {
    cwd: repoRoot,
    env: childEnv(baseUrl, homeDir),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let buffer = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out waiting for MCP response\nSTDERR:\n${stderr}`));
    }, 8000);

    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 2) {
          clearTimeout(timeout);
          child.kill();
          resolve(msg);
        }
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    child.stdin.write(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "routing-test", version: "1" },
          },
        }),
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      ].join("\n") + "\n",
    );
  });

  assert.ok(!result.error, `MCP returned error: ${JSON.stringify(result.error)}`);
  return result.result;
}

await listen(server);
const address = server.address();
const baseUrl = `http://${address.address}:${address.port}`;
const homeDir = await mkdtemp(path.join(os.tmpdir(), "llama-cli-routing-"));

try {
  resetCalls();
  const enrichRun = await runCli(
    [
      "deal",
      "enrich",
      "deal-cli",
      "--apply",
      "--executor",
      "server_agent",
      "--sources",
      "website,monid",
      "--budget-cents",
      "12",
    ],
    baseUrl,
    homeDir,
  );
  assert.match(enrichRun.stdout, /agent done/);
  assertNoEnrichCall();
  assertThreadRun({
    title: "CLI enrichment",
    messageIncludes: ["website, monid", "12 cents", "upsert_typed_fact"],
  });

  resetCalls();
  await runCli(
    ["deal", "enrich", "deal-cli", "--apply", "--executor", "server_agent", "--harness-only"],
    baseUrl,
    homeDir,
  );
  assert.deepEqual(paths(), ["POST /api/deals/deal-cli/enrich"]);
  assert.equal(calls[0].body?.apply, true);
  assert.equal(calls[0].body?.dryRun, false);
  assert.equal(calls[0].body?.executor, "server_agent");

  resetCalls();
  const agentRun = await runCli(
    ["deal", "agent", "run", "deal-cli", "--message", "custom server task"],
    baseUrl,
    homeDir,
  );
  assert.match(agentRun.stdout, /agent done/);
  assertNoEnrichCall();
  assertThreadRun({
    title: "CLI agent run",
    messageIncludes: ["custom server task"],
  });

  resetCalls();
  const mcpResult = await callMcpTool(
    "deal_enrich",
    {
      dealId: "deal-mcp",
      apply: true,
      executor: "server_agent",
      sources: ["web", "monid"],
      budgetCents: 7,
    },
    baseUrl,
    homeDir,
  );
  assertNoEnrichCall();
  assertThreadRun({
    title: "MCP enrichment",
    messageIncludes: ["web, monid", "7 cents", "upsert_typed_fact"],
  });
  const payload = JSON.parse(mcpResult.content?.[0]?.text ?? "{}");
  assert.equal(payload.ok, true);
  assert.equal(payload.threadId, "thread-1");
  assert.equal(payload.text, "agent done");

  console.log("agent routing verification passed");
} finally {
  await close(server);
  await rm(homeDir, { recursive: true, force: true });
}
