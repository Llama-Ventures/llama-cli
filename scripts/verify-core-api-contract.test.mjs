import assert from "node:assert/strict";
import test from "node:test";

import { compareOperationInventory } from "./verify-core-api-contract.mjs";

test("operation inventory comparison detects missing and stale declarations", () => {
  const actual = [
    { method: "GET", path: "/api/occam/deals/{}/chat" },
    { method: "POST", path: "/api/occam/deals/commands" },
  ];
  const declared = [
    { method: "GET", path: "/api/occam/deals/{dealId}/chat" },
    { method: "GET", path: "/api/occam/deals/{dealId}" },
  ];
  assert.deepEqual(compareOperationInventory(actual, declared), {
    undeclared: ["POST /api/occam/deals/commands"],
    stale: ["GET /api/occam/deals/{}"],
  });
});

test("parameter names do not create false drift", () => {
  const actual = [{ method: "GET", path: "/api/wiki/{}" }];
  const declared = [{ method: "GET", path: "/api/wiki/{slug}" }];
  assert.deepEqual(compareOperationInventory(actual, declared), { undeclared: [], stale: [] });
});
