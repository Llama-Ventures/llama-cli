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
          resolve(message.result.tools.map((tool) => tool.name));
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

test("MCP publishes exactly four Deal tools and no split legacy Deal tools", async () => {
  const names = await listMcpTools();
  const dealTools = names.filter((name) =>
    ["search_deals", "read_deal", "create_deal", "write_deal"].includes(name),
  );
  assert.deepEqual(dealTools, ["search_deals", "read_deal", "create_deal", "write_deal"]);

  const forbidden = names.filter((name) =>
    name.startsWith("deal_") ||
    name.startsWith("workflow_") ||
    name.startsWith("brief_") ||
    name.startsWith("html_") ||
    name.startsWith("memo_") ||
    ["activity_query", "timeline", "post", "mentions_list", "mentions_resolve"].includes(name),
  );
  assert.deepEqual(forbidden, []);
});
