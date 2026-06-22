#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
assert.equal(
  existsSync(path.join(repoRoot, "docs/agent-skills.bundle.json")),
  false,
  "public llama-cli must not bundle private Llama OS skill content",
);
assert.equal(
  existsSync(path.join(repoRoot, "src/data/llama-os-skills.bundle.json")),
  false,
  "public llama-cli must not copy the Command-side skill mirror",
);
const calls = [];
let threadSeq = 0;
let eventSeq = 0;

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
    calls.push({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      body,
      headers: {
        client: req.headers["x-llama-client"] ?? null,
        clientVersion: req.headers["x-llama-client-version"] ?? null,
        agentClient: req.headers["x-llama-agent-client"] ?? null,
        session: req.headers["x-llama-agent-session"] ?? null,
        command: req.headers["x-llama-command"] ?? null,
      },
    });

    if (req.method === "POST" && url.pathname === "/api/agent/client-events") {
      eventSeq += 1;
      writeJson(res, {
        ok: true,
        eventId: eventSeq,
        candidateId: body?.command?.endsWith(".search") ? eventSeq + 1000 : null,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/agent/eval-feedback") {
      writeJson(res, {
        ok: true,
        candidate: {
          id: 42,
          source_event_id: body?.eventId ?? null,
          feedback: body?.action ?? null,
        },
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/agent/manifest") {
      writeJson(res, {
        ok: true,
        contract: {
          contract_version: "agent-contract.v1",
          cli: {
            client_version: url.searchParams.get("clientVersion"),
            status: "ok",
          },
        },
        briefing: "runtime briefing: use skills_search, skills_read, and object_inspect",
        llama_os: {
          visible_skill_count: 49,
          included_skill_count: Number(url.searchParams.get("limit") || 25),
        },
        skills: [
          {
            slug: "llama-command",
            description: "Llama Command runtime skill",
          },
        ],
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/agent/briefing") {
      writeJson(res, {
        ok: true,
        contract: {
          contract_version: "agent-contract.v1",
          cli: {
            client_version: url.searchParams.get("clientVersion"),
            status: "ok",
          },
        },
        briefing: "server-owned briefing: check CLI, use Pipeline First, prefer CLI/MCP",
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/agent/skills") {
      writeJson(res, {
        ok: true,
        q: url.searchParams.get("q"),
        count: 1,
        skills: [
          {
            slug: "llama-command",
            description: "Llama Command runtime skill",
          },
        ],
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/agent/skills/llama-command") {
      writeJson(res, {
        ok: true,
        skill: {
          slug: "llama-command",
          content: "---\nname: llama-command\n---\n# Llama Command runtime skill\n",
        },
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/agent/explain") {
      writeJson(res, {
        ok: true,
        result: {
          target: {
            objectType: "wiki_article",
            objectId: "missing-page",
            status: "deleted",
            title: "Missing Page",
            detail: "Deleted by Kevin Yu",
            url: "https://command.llamaventures.vc/wiki/missing-page",
          },
          lifecycle: [
            {
              action: "deleted",
              actor_label: "Kevin Yu",
              created_at: "2026-06-15T19:02:00Z",
              reason: "user_deleted",
            },
          ],
        },
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/wiki/search") {
      writeJson(res, [
        {
          slug: "llama-weekly-2026-06-16",
          title: "Llama Weekly 2026-06-16",
        },
      ]);
      return;
    }

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

function businessCalls() {
  return calls.filter((call) => call.path !== "/api/agent/client-events");
}

function telemetryCalls() {
  return calls.filter((call) => call.path === "/api/agent/client-events");
}

function paths() {
  return businessCalls().map((call) => `${call.method} ${call.path}`);
}

function assertNoEnrichCall() {
  assert.equal(
    businessCalls().some((call) => call.path.endsWith("/enrich")),
    false,
    `expected no /enrich call, got ${paths().join(", ")}`,
  );
}

function assertThreadRun({ title, messageIncludes }) {
  const relevant = businessCalls();
  assert.equal(relevant.length, 2, `expected thread create + SSE run, got ${paths().join(", ")}`);
  assert.match(relevant[0].path, /^\/api\/deals\/[^/]+\/threads$/);
  assert.equal(relevant[0].body?.title, title);
  assert.match(relevant[1].path, /^\/api\/deals\/[^/]+\/threads\/thread-1$/);
  for (const needle of messageIncludes) {
    assert.match(relevant[1].body?.message ?? "", new RegExp(escapeRegExp(needle)));
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
  const onboardRun = await runCli(["agent-onboard"], baseUrl, homeDir);
  assert.match(onboardRun.stdout, /server-owned briefing/);
  assert.deepEqual(paths(), ["GET /api/agent/briefing"]);
  assert.ok(businessCalls()[0].query.clientVersion, "agent-onboard passes clientVersion");
  assert.equal(telemetryCalls()[0].body?.command, "agent.briefing");
  assert.equal(telemetryCalls()[0].body?.client, "cli");
  assert.ok(telemetryCalls()[0].body?.sessionId, "telemetry includes an agent session id");
  assert.equal(businessCalls()[0].headers.command, "agent.briefing");

  resetCalls();
  const bootstrapRun = await runCli(["agent", "bootstrap", "--limit", "3"], baseUrl, homeDir);
  assert.match(bootstrapRun.stdout, /runtime briefing/);
  assert.deepEqual(paths(), ["GET /api/agent/manifest"]);
  assert.equal(businessCalls()[0].query.limit, "3");
  assert.ok(businessCalls()[0].query.clientVersion, "agent bootstrap passes clientVersion");

  resetCalls();
  const skillSearchRun = await runCli(["skills", "search", "pipeline", "--limit", "5"], baseUrl, homeDir);
  assert.match(skillSearchRun.stdout, /llama-command/);
  assert.deepEqual(paths(), ["GET /api/agent/skills"]);
  assert.equal(businessCalls()[0].query.q, "pipeline");
  assert.equal(businessCalls()[0].query.limit, "5");

  resetCalls();
  const skillShowRun = await runCli(["skills", "show", "llama-command"], baseUrl, homeDir);
  assert.match(skillShowRun.stdout, /# Llama Command runtime skill/);
  assert.deepEqual(paths(), ["GET /api/agent/skills/llama-command"]);

  resetCalls();
  const explainRun = await runCli(["explain", "https://command.llamaventures.vc/wiki/missing-page"], baseUrl, homeDir);
  assert.match(explainRun.stdout, /Status: deleted/);
  assert.match(explainRun.stdout, /Deleted by Kevin Yu/);
  assert.deepEqual(paths(), ["GET /api/agent/explain"]);
  assert.equal(businessCalls()[0].query.q, "https://command.llamaventures.vc/wiki/missing-page");

  resetCalls();
  const wikiRun = await runCli(["wiki", "search", "llama weekly"], baseUrl, homeDir);
  assert.match(wikiRun.stdout, /llama-weekly-2026-06-16/);
  assert.deepEqual(paths(), ["GET /api/wiki/search"]);
  assert.equal(telemetryCalls()[0].body?.command, "wiki.search");
  assert.equal(telemetryCalls()[0].body?.query, "llama weekly");

  resetCalls();
  const evalRun = await runCli(
    [
      "eval",
      "bad",
      "--last",
      "--reason",
      "missed dev weekly",
      "--expect",
      "wiki:llamaos-weekly-2026-06-17",
    ],
    baseUrl,
    homeDir,
  );
  assert.match(evalRun.stdout, /"feedback": "bad"/);
  assert.deepEqual(paths(), ["POST /api/agent/eval-feedback"]);
  assert.equal(businessCalls()[0].body?.action, "bad");
  assert.equal(businessCalls()[0].body?.eventId, 6);
  assert.equal(businessCalls()[0].body?.expected?.wikiSlugs?.[0], "llamaos-weekly-2026-06-17");

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
  assert.equal(businessCalls()[0].body?.apply, true);
  assert.equal(businessCalls()[0].body?.dryRun, false);
  assert.equal(businessCalls()[0].body?.executor, "server_agent");

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

  resetCalls();
  const mcpBootstrap = await callMcpTool("agent_bootstrap", { limit: 2 }, baseUrl, homeDir);
  const bootstrapPayload = JSON.parse(mcpBootstrap.content?.[0]?.text ?? "{}");
  assert.equal(bootstrapPayload.ok, true);
  assert.deepEqual(paths(), ["GET /api/agent/manifest"]);
  assert.equal(businessCalls()[0].query.limit, "2");
  assert.ok(businessCalls()[0].query.clientVersion, "mcp agent_bootstrap passes clientVersion");
  assert.equal(telemetryCalls()[0].body?.client, "mcp");

  resetCalls();
  const mcpSkills = await callMcpTool("skills_search", { q: "command", limit: 4 }, baseUrl, homeDir);
  const skillsPayload = JSON.parse(mcpSkills.content?.[0]?.text ?? "{}");
  assert.equal(skillsPayload.skills?.[0]?.slug, "llama-command");
  assert.deepEqual(paths(), ["GET /api/agent/skills"]);
  assert.equal(businessCalls()[0].query.q, "command");

  resetCalls();
  const mcpSkillRead = await callMcpTool("skills_read", { slug: "llama-command" }, baseUrl, homeDir);
  const skillPayload = JSON.parse(mcpSkillRead.content?.[0]?.text ?? "{}");
  assert.match(skillPayload.skill?.content ?? "", /# Llama Command runtime skill/);
  assert.deepEqual(paths(), ["GET /api/agent/skills/llama-command"]);

  resetCalls();
  const mcpInspect = await callMcpTool(
    "object_inspect",
    { q: "https://command.llamaventures.vc/wiki/missing-page" },
    baseUrl,
    homeDir,
  );
  const inspectPayload = JSON.parse(mcpInspect.content?.[0]?.text ?? "{}");
  assert.equal(inspectPayload.result?.target?.status, "deleted");
  assert.deepEqual(paths(), ["GET /api/agent/explain"]);

  console.log("agent routing verification passed");
} finally {
  await close(server);
  await rm(homeDir, { recursive: true, force: true });
}
