import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

function listMcpTools() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/llama-mcp.mjs"], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP tools/list timed out: ${stderr}`));
    }, 5000);
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const lines = stdout.split("\n");
      stdout = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
        }
        if (message.id === 2) {
          clearTimeout(timer);
          child.kill();
          resolve(message.result.tools);
        }
      }
    });
    child.on("error", reject);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "four-action-contract-test", version: "1" },
      },
    })}\n`);
  });
}

test("MCP publishes exactly four Deal tools", async () => {
  const names = (await listMcpTools()).map((tool) => tool.name);
  const dealTools = names.filter((name) =>
    ["search_deals", "read_deal", "create_deal", "write_deal"].includes(name),
  );
  assert.deepEqual(dealTools, ["search_deals", "read_deal", "create_deal", "write_deal"]);
});

test("MCP publishes Deal Memory as a separate two-tool domain", async () => {
  const tools = await listMcpTools();
  const memoryTools = tools.filter((tool) =>
    ["get_deal_memory", "update_deal_memory"].includes(tool.name),
  );
  assert.deepEqual(memoryTools.map((tool) => tool.name), [
    "get_deal_memory",
    "update_deal_memory",
  ]);
  const update = memoryTools[1];
  assert.match(memoryTools[0].description, /only 404 means no Story exists/);
  assert.match(update.description, /never append an update log/);
  assert.match(update.description, /would not materially improve/);
  assert.match(update.description, /stable uuid and created/);
  assert.match(update.description, /updated must strictly advance/);
  assert.match(update.description, /including a placeholder/);
  assert.deepEqual(update.inputSchema.required.sort(), ["dealId", "markdown"]);
  assert.equal(update.inputSchema.properties.expected_version.type, "string");
  assert.equal(update.inputSchema.properties.markdown.maxLength, 1_048_576);
});

test("MCP publishes progressive Page schema reads outside the Deal action surface", async () => {
  const tools = await listMcpTools();
  const pageSchema = tools.find((tool) => tool.name === "get_live_deal_page_schema");
  assert.ok(pageSchema, "get_live_deal_page_schema must be published");
  assert.match(pageSchema.description, /no selector for the compact index/);
  assert.match(pageSchema.description, /exact fields or one section/);
  assert.equal(pageSchema.inputSchema.properties.fields.type, "array");
  assert.equal(pageSchema.inputSchema.properties.fields.maxItems, 20);
  assert.equal(pageSchema.inputSchema.properties.section.type, "string");
  assert.equal(pageSchema.inputSchema.required, undefined);
});

test("MCP write_deal exposes four operation-specific payloads", async () => {
  const tools = await listMcpTools();
  const writeDeal = tools.find((tool) => tool.name === "write_deal");
  assert.ok(writeDeal, "write_deal must be published");
  const commandSchema = writeDeal.inputSchema.properties.command;
  const choices = commandSchema.oneOf || commandSchema.anyOf;
  assert.equal(choices?.length, 4, JSON.stringify(writeDeal.inputSchema));

  const byOperation = new Map(
    choices.map((choice) => [choice.properties.operation.const, choice]),
  );
  assert.deepEqual([...byOperation.keys()].sort(), [
    "artifact.put",
    "information.put",
    "input.submit",
    "page.patch",
  ]);
  assert.equal("source" in byOperation.get("information.put").properties, false);
  assert.equal("source" in byOperation.get("input.submit").properties, true);
  assert.equal("title" in byOperation.get("input.submit").properties, false);
  assert.equal("title" in byOperation.get("artifact.put").properties, true);
  assert.equal("storageKey" in byOperation.get("artifact.put").properties, true);
});
