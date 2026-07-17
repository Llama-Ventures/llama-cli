import assert from "node:assert/strict";
import test from "node:test";

import { compareOperationInventory } from "./verify-core-api-contract.mjs";

test("operation inventory comparison detects missing and stale declarations", () => {
  const actual = [
    { method: "GET", path: "/api/deals/{}/facts" },
    { method: "PUT", path: "/api/deals/{}/founders" },
  ];
  const declared = [
    { method: "GET", path: "/api/deals/{dealId}/facts" },
    { method: "DELETE", path: "/api/deals/{dealId}" },
  ];
  assert.deepEqual(compareOperationInventory(actual, declared), {
    undeclared: ["PUT /api/deals/{}/founders"],
    stale: ["DELETE /api/deals/{}"],
  });
});

test("parameter names do not create false drift", () => {
  const actual = [{ method: "GET", path: "/api/wiki/{}" }];
  const declared = [{ method: "GET", path: "/api/wiki/{slug}" }];
  assert.deepEqual(compareOperationInventory(actual, declared), { undeclared: [], stale: [] });
});
