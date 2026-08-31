import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDealReadPath,
  buildDealSearchPath,
  ensureIdempotencyKey,
  prepareDealCommand,
  validateCommandOrigin,
} from "../lib/deal-actions.mjs";

test("builds progressive Deal read and search paths", () => {
  assert.equal(buildDealSearchPath("Acme AI", { state: "active", limit: 5 }), "/api/occam/deals?q=Acme+AI&state=active&limit=5");
  assert.equal(buildDealReadPath("deal/id", "overview"), "/api/occam/deals/deal%2Fid");
  assert.equal(buildDealReadPath("deal-id", "all"), "/api/occam/deals/deal-id?expand=information,artifacts,chat,feed");
});

test("derives a stable idempotency key independent of object key order", () => {
  const first = ensureIdempotencyKey({ operation: "page.patch", dealId: "d", patch: { b: 2, a: 1 } });
  const second = ensureIdempotencyKey({ patch: { a: 1, b: 2 }, dealId: "d", operation: "page.patch" });
  assert.equal(first.idempotencyKey, second.idempotencyKey);
  assert.match(first.idempotencyKey, /^cli:[0-9a-f]{40}$/);
});

test("requires exact user provenance before any mutation", () => {
  assert.throws(
    () => validateCommandOrigin({ origin: { kind: "user" } }),
    /originalUserUtterance or origin\.originatingChatRecordId/,
  );
  assert.doesNotThrow(() => validateCommandOrigin({
    origin: { kind: "user", originalUserUtterance: "Please save this exactly." },
  }));
});

test("keeps create and write as a closed operation set", () => {
  const create = prepareDealCommand("create", {
    companyName: "Example Co",
    origin: { kind: "agent" },
  });
  assert.equal(create.operation, "deal.create");
  assert.throws(
    () => prepareDealCommand("write", { operation: "event.append", origin: { kind: "agent" } }),
    /write JSON operation must be/,
  );
});
