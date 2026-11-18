import assert from "node:assert/strict";
import test from "node:test";
import { registerApiTools } from "../lib/mcp-api-tools.mjs";

const DEAL_ID = "8f84396f-4308-436f-b2d9-c235dea8dddb";

function capture() {
  const tools = new Map();
  const seen = [];
  const server = { registerTool: (name, spec, handler) => tools.set(name, { spec, handler }) };
  registerApiTools(server, {
    request: async (method, path, body) => { seen.push({ method, path, body }); return { linked: false, deal_id: DEAL_ID, portal: "portal" }; },
    version: "test",
  });
  return { tools, seen };
}

test("get_linked_portal_status is a read-only GET of the Core route for one Deal", async () => {
  const { tools, seen } = capture();
  const tool = tools.get("get_linked_portal_status");
  assert.ok(tool, "tool is registered");
  assert.deepEqual(Object.keys(tool.spec.inputSchema), ["dealId"]);
  const result = await tool.handler({ dealId: DEAL_ID });
  assert.deepEqual(seen, [{ method: "GET", path: `/api/linked-portal/${DEAL_ID}/status`, body: undefined }]);
  assert.match(result.content[0].text, /"linked": false/);
});

test("the tool description names no portal, URL or person (the package is public)", () => {
  const { tools } = capture();
  const text = tools.get("get_linked_portal_status").spec.description;
  assert.doesNotMatch(text, /dx|onrender|https?:\/\/|@/i);
});
