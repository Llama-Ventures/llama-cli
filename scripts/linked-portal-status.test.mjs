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

test("handoff_deal_to_linked_portal POSTs the user's terms to the Core handoff route", async () => {
  const { tools, seen } = capture();
  const tool = tools.get("handoff_deal_to_linked_portal");
  assert.ok(tool, "tool is registered");
  await tool.handler({ dealId: DEAL_ID, check_size: 200000, owner_email: "owner@example.test" });
  assert.deepEqual(seen, [{ method: "POST", path: `/api/linked-portal/${DEAL_ID}/handoff`, body: { check_size: 200000, owner_email: "owner@example.test" } }]);
  assert.doesNotMatch(tool.spec.description, /dx|onrender|https?:\/\//i);
  assert.match(tool.spec.description, /ask the user/i);
});

test("list_linked_portal_files is a read-only GET of the Core files route", async () => {
  const { tools, seen } = capture();
  const tool = tools.get("list_linked_portal_files");
  assert.ok(tool, "tool is registered");
  await tool.handler({ dealId: DEAL_ID });
  assert.deepEqual(seen, [{ method: "GET", path: `/api/linked-portal/${DEAL_ID}/files`, body: undefined }]);
  assert.doesNotMatch(tool.spec.description, /dx|onrender|https?:\/\/|@/i);
});

test("copy_linked_portal_files_to_deal sends only the approved upload ids and the user's words", async () => {
  const { tools, seen } = capture();
  const tool = tools.get("copy_linked_portal_files_to_deal");
  assert.ok(tool, "tool is registered");
  const ids = ["5c2f6a3e-8d1b-4f0a-9e7c-2b4d6f8a1c3e"];
  await tool.handler({ dealId: DEAL_ID, upload_ids: ids, original_user_utterance: "copy the cap table" });
  assert.deepEqual(seen, [{ method: "POST", path: `/api/linked-portal/${DEAL_ID}/files/copy`, body: { upload_ids: ids, original_user_utterance: "copy the cap table" } }]);
  assert.deepEqual(Object.keys(tool.spec.inputSchema).sort(), ["dealId", "original_user_utterance", "upload_ids"]);
  assert.match(tool.spec.description, /explicit yes/i);
  assert.doesNotMatch(tool.spec.description, /dx|onrender|https?:\/\/|@/i);
});
