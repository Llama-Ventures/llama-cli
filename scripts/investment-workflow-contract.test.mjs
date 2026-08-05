import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const cli = readFileSync(new URL("../bin/llama.mjs", import.meta.url), "utf8");
const mcp = readFileSync(new URL("../bin/llama-mcp.mjs", import.meta.url), "utf8");

test("CLI exposes formal V2 commands and rejects direct status writes", () => {
  assert.match(cli, /area === "workflow"/);
  assert.match(cli, /workflow show <dealId>/);
  assert.match(cli, /workflow initialize <dealId>/);
  assert.match(cli, /workflow execution-status <dealId>/);
  assert.match(cli, /field === "status"[\s\S]+Direct status writes are retired/);
  assert.match(cli, /\["stage_gates", "stage4_gate"\][\s\S]+Legacy \$\{key\} is retired/);
});

test("MCP exposes typed workflow tools and rejects deal_update status", () => {
  for (const tool of [
    "workflow_show", "workflow_initialize", "workflow_request_partner_support",
    "workflow_decide_partner_support", "workflow_proceed",
    "workflow_resolve_guard", "workflow_control", "workflow_vote",
    "workflow_update_execution_status",
  ]) assert.match(mcp, new RegExp(`"${tool}"`));
  assert.match(mcp, /field === "status"[\s\S]+Direct status writes are retired/);
});
