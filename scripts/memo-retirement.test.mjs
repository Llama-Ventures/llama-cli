import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("CLI keeps Memo read-only and enrichment cannot request generation", () => {
  const cli = read("bin/llama.mjs");
  assert.match(cli, /Memo \(read-only/);
  assert.match(cli, /llama memo show <dealId>/);
  assert.doesNotMatch(cli, /llama memo (?:regenerate|save|reset)/);
  assert.doesNotMatch(cli, /generateMemo/);
  assert.doesNotMatch(cli, /"generate-memo"/);
});

test("MCP exposes only memo_show and no enrichment generation flag", () => {
  const mcp = read("bin/llama-mcp.mjs");
  assert.match(mcp, /"memo_show"/);
  assert.doesNotMatch(mcp, /"memo_(?:regenerate|save|reset)"/);
  assert.doesNotMatch(mcp, /generateMemo/);
});

test("Core operation inventory retains only the Memo read", () => {
  const inventory = JSON.parse(read("contracts/required-operations.json"));
  const memoOperations = inventory.requiredOperations.filter(
    (operation) => operation.path === "/api/deals/{dealId}/memo",
  );
  assert.deepEqual(memoOperations, [
    { method: "GET", path: "/api/deals/{dealId}/memo" },
  ]);
});
