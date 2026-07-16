#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const coreApiContract = JSON.parse(
  readFileSync(path.join(repoRoot, "contracts/core-api.json"), "utf8"),
);
assert.equal(
  packageJson.scripts?.["verify:release"],
  "npm test && npm run verify:artifact && node scripts/verify-tarball-clean.mjs",
  "CLI release gate must run tests, verify the packed artifact identity, and scan the publish surface",
);
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
const cliSource = readFileSync(path.join(repoRoot, "bin/llama.mjs"), "utf8");
assert.match(
  cliSource,
  /About ONE specific deal\? \.{8} llama html publish <deal-id-or-name> --file <path> --title "\.\.\."/,
  "top-level help must route deal-specific HTML to the agent-safe publish path",
);
assert.doesNotMatch(
  cliSource,
  /For deal-specific HTML use "llama html upload <dealId>"/,
  "wiki help must not route deal-specific HTML to the low-level upload path",
);
const calls = [];
let threadSeq = 0;
let eventSeq = 0;
const htmlDocs = new Map();

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function docsForDeal(dealId) {
  if (!htmlDocs.has(dealId)) htmlDocs.set(dealId, new Map());
  return htmlDocs.get(dealId);
}

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
        clientSourceSha: req.headers["x-llama-client-source-sha"] ?? null,
        apiContractVersion: req.headers["x-llama-api-contract-version"] ?? null,
        apiContractDigest: req.headers["x-llama-api-contract-digest"] ?? null,
        agentClient: req.headers["x-llama-agent-client"] ?? null,
        session: req.headers["x-llama-agent-session"] ?? null,
        command: req.headers["x-llama-command"] ?? null,
        uploadId: req.headers["x-llama-upload-id"] ?? null,
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
            detail: "Deleted by Alex Chen",
            url: "https://command.llamaventures.vc/wiki/missing-page",
          },
          lifecycle: [
            {
              action: "deleted",
              actor_label: "Alex Chen",
              created_at: "2026-06-15T19:02:00Z",
              reason: "user_deleted",
            },
          ],
        },
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/agent/activity") {
      writeJson(res, {
        ok: true,
        schema_version: "agent_activity.v1",
        kind: url.searchParams.get("kind") || "events",
        since: url.searchParams.get("since") || "24h",
        read_model: "activity_events",
        items: [
          {
            type: url.searchParams.get("kind") === "new_deals" ? "new_deal" : "updated_deal",
            deal_id: "deal-activity",
            company_name: "Activity AI",
            summary: "Activity AI was added to the pipeline.",
            url: "/deals/deal-activity/feed",
          },
        ],
        next_cursor: null,
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

    if (req.method === "GET" && url.pathname === "/api/deals") {
      writeJson(res, {
        deals: [
          {
            uuid: "deal-html",
            companyName: "Acme AI",
            founders: "Ada Founder",
            description: "mock deal for HTML upload tests",
          },
        ],
        total: 1,
        limit: Number(url.searchParams.get("limit") || 200),
        offset: 0,
      });
      return;
    }

    const docsMatch = url.pathname.match(/^\/api\/deals\/([^/]+)\/documents$/);
    if (docsMatch) {
      const dealId = decodeURIComponent(docsMatch[1]);
      if (dealId !== "deal-html") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "deal not found" }));
        return;
      }
      if (req.method === "GET") {
        const docs = Array.from(docsForDeal(dealId).entries()).map(([slug, doc]) => ({
          slug,
          title: doc.title,
          latest_version: doc.version ?? null,
          latest_updated_at: doc.version ? "2026-06-23T04:00:00Z" : null,
        }));
        writeJson(res, { documents: docs });
        return;
      }
      if (req.method === "POST") {
        const docs = docsForDeal(dealId);
        const slug = body?.slug;
        docs.set(slug, {
          ...(docs.get(slug) || {}),
          title: body?.title || slug,
        });
        writeJson(res, { ok: true, slug, title: body?.title || slug });
        return;
      }
    }

    const htmlMatch = url.pathname.match(/^\/api\/deals\/([^/]+)\/documents\/([^/]+)\/html$/);
    if (htmlMatch) {
      const dealId = decodeURIComponent(htmlMatch[1]);
      const slug = decodeURIComponent(htmlMatch[2]);
      const docs = docsForDeal(dealId);
      if (req.method === "PUT") {
        const html = typeof body?.html === "string" ? body.html : "";
        const previous = docs.get(slug) || { title: slug, version: 0 };
        const version = Number(previous.version || 0) + 1;
        const bytes = Buffer.byteLength(html, "utf8");
        const sha256 = sha256Hex(html);
        docs.set(slug, {
          ...previous,
          html,
          version,
          bytes,
          sha256,
          source: body?.source || "cli",
          client_upload_id: body?.client_upload_id || null,
        });
        writeJson(res, {
          ok: true,
          document_slug: slug,
          version,
          bytes,
          sha256,
          client_upload_id: body?.client_upload_id || null,
          idempotent_replay: false,
        });
        return;
      }
      if (req.method === "GET") {
        const doc = docs.get(slug);
        if (!doc?.html) {
          writeJson(res, { empty: true });
          return;
        }
        writeJson(res, {
          empty: false,
          document_slug: slug,
          version: doc.version,
          bytes: doc.bytes,
          sha256: doc.sha256,
          source: doc.source,
          created_at: "2026-06-23T04:00:00Z",
          html: doc.html,
        });
        return;
      }
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
  assert.equal(businessCalls()[0].headers.clientSourceSha, "local/unknown");
  assert.equal(businessCalls()[0].headers.apiContractVersion, coreApiContract.apiVersion);
  assert.equal(businessCalls()[0].headers.apiContractDigest, coreApiContract.sha256);

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
  assert.match(explainRun.stdout, /Deleted by Alex Chen/);
  assert.deepEqual(paths(), ["GET /api/agent/explain"]);
  assert.equal(businessCalls()[0].query.q, "https://command.llamaventures.vc/wiki/missing-page");

  resetCalls();
  const activityRun = await runCli(["activity", "new-deals", "--since", "24h", "--limit", "10"], baseUrl, homeDir);
  assert.match(activityRun.stdout, /Activity AI/);
  assert.deepEqual(paths(), ["GET /api/agent/activity"]);
  assert.equal(businessCalls()[0].query.kind, "new_deals");
  assert.equal(businessCalls()[0].query.since, "24h");
  assert.equal(businessCalls()[0].query.limit, "10");

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
  assert.equal(businessCalls()[0].body?.eventId, 7);
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

  const largeHtmlPath = path.join(homeDir, "full-memo.html");
  const largeHtml =
    "<!doctype html><html><head><title>Full Memo</title></head><body>" +
    `<p>${"agent-safe upload ".repeat(18000)}</p>` +
    "</body></html>";
  assert.ok(
    Buffer.byteLength(largeHtml, "utf8") > 252 * 1024,
    "routing test HTML must exceed the incident-sized 252KB memo",
  );
  await writeFile(largeHtmlPath, largeHtml);

  resetCalls();
  const publishRun = await runCli(
    [
      "html",
      "publish",
      "Acme AI",
      "--file",
      largeHtmlPath,
      "--title",
      "Full Memo",
      "--doc",
      "full-memo",
    ],
    baseUrl,
    homeDir,
  );
  const publishPayload = JSON.parse(publishRun.stdout);
  assert.equal(publishPayload.ok, true);
  assert.equal(publishPayload.deal_uuid, "deal-html");
  assert.equal(publishPayload.document_slug, "full-memo");
  assert.equal(publishPayload.verified?.ok, true);
  assert.match(publishPayload.client_upload_id, /^cli-[0-9a-f-]{36}$/);
  assert.match(publishPayload.sha256, /^[a-f0-9]{64}$/);
  assert.equal(publishPayload.verified?.sha256, publishPayload.sha256);
  assert.deepEqual(paths(), [
    "GET /api/deals/Acme%20AI/documents",
    "GET /api/deals",
    "GET /api/deals/deal-html/documents",
    "POST /api/deals/deal-html/documents",
    "PUT /api/deals/deal-html/documents/full-memo/html",
    "GET /api/deals/deal-html/documents/full-memo/html",
  ]);
  assert.equal(businessCalls()[4].body?.html, largeHtml);
  assert.equal(businessCalls()[4].body?.source, "cli");
  assert.equal(businessCalls()[4].body?.client_upload_id, publishPayload.client_upload_id);
  assert.equal(businessCalls()[4].headers.uploadId, publishPayload.client_upload_id);
  const publishTelemetry = telemetryCalls().find(
    (call) =>
      call.body?.method === "PUT" &&
      call.body?.endpoint === "/api/deals/deal-html/documents/full-memo/html",
  );
  assert.ok(publishTelemetry, "publish upload request must record telemetry");
  assert.equal(publishTelemetry.body?.args?.html?.redacted, true);
  assert.equal(publishTelemetry.body?.args?.html?.bytes, Buffer.byteLength(largeHtml, "utf8"));
  assert.equal(publishTelemetry.body?.args?.html?.sha256, sha256Hex(largeHtml));
  assert.doesNotMatch(
    JSON.stringify(telemetryCalls()),
    /agent-safe upload agent-safe upload agent-safe upload/,
    "telemetry must not contain raw memo HTML text",
  );

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
  const inlineGuard = await callMcpTool(
    "html_upload",
    {
      dealId: "deal-html",
      documentSlug: "inline-too-large",
      html: largeHtml,
    },
    baseUrl,
    homeDir,
  );
  assert.equal(inlineGuard.isError, true);
  assert.match(inlineGuard.content?.[0]?.text ?? "", /Use html_upload_file/);
  assert.deepEqual(paths(), []);

  resetCalls();
  const inlineBundleGuard = await callMcpTool(
    "html_upload_bundle",
    {
      dealId: "deal-html",
      documentSlug: "bundle-too-large",
      html: largeHtml,
      assets: [
        {
          path: "full-memo_files/cover.txt",
          contentType: "text/plain",
          base64: Buffer.from("asset").toString("base64"),
        },
      ],
    },
    baseUrl,
    homeDir,
  );
  assert.equal(inlineBundleGuard.isError, true);
  assert.match(inlineBundleGuard.content?.[0]?.text ?? "", /Use html_upload_file/);
  assert.deepEqual(paths(), []);

  resetCalls();
  const mcpFile = await callMcpTool(
    "html_upload_file",
    {
      dealId: "deal-html",
      documentSlug: "mcp-file",
      filePath: largeHtmlPath,
    },
    baseUrl,
    homeDir,
  );
  const mcpFilePayload = JSON.parse(mcpFile.content?.[0]?.text ?? "{}");
  assert.equal(mcpFilePayload.ok, true);
  assert.equal(mcpFilePayload.verified?.ok, true);
  assert.match(mcpFilePayload.client_upload_id, /^mcp-[0-9a-f-]{36}$/);
  assert.match(mcpFilePayload.sha256, /^[a-f0-9]{64}$/);
  assert.equal(mcpFilePayload.verified?.sha256, mcpFilePayload.sha256);
  assert.deepEqual(paths(), [
    "PUT /api/deals/deal-html/documents/mcp-file/html",
    "GET /api/deals/deal-html/documents/mcp-file/html",
  ]);
  assert.equal(businessCalls()[0].body?.client_upload_id, mcpFilePayload.client_upload_id);
  assert.equal(businessCalls()[0].headers.uploadId, mcpFilePayload.client_upload_id);
  const mcpFileTelemetry = telemetryCalls().find(
    (call) =>
      call.body?.method === "PUT" &&
      call.body?.endpoint === "/api/deals/deal-html/documents/mcp-file/html",
  );
  assert.ok(mcpFileTelemetry, "MCP file upload request must record telemetry");
  assert.equal(mcpFileTelemetry.body?.args?.html?.redacted, true);
  assert.equal(mcpFileTelemetry.body?.args?.html?.sha256, sha256Hex(largeHtml));

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

  resetCalls();
  const mcpActivity = await callMcpTool(
    "activity_query",
    { kind: "updated_deals", since: "7d", limit: 5 },
    baseUrl,
    homeDir,
  );
  const activityPayload = JSON.parse(mcpActivity.content?.[0]?.text ?? "{}");
  assert.equal(activityPayload.kind, "updated_deals");
  assert.deepEqual(paths(), ["GET /api/agent/activity"]);
  assert.equal(businessCalls()[0].query.kind, "updated_deals");
  assert.equal(businessCalls()[0].query.since, "7d");

  console.log("agent routing verification passed");
} finally {
  await close(server);
  await rm(homeDir, { recursive: true, force: true });
}
