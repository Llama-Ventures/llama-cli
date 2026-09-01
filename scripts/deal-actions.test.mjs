import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDealReadPath,
  buildDealSearchPath,
  compactDealWriteResult,
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

test("rejects half-localized Page content before it reaches Core", () => {
  const base = {
    operation: "page.patch",
    dealId: "11111111-1111-4111-8111-111111111111",
    origin: { kind: "agent" },
  };
  assert.doesNotThrow(() => prepareDealCommand("write", {
    ...base,
    patch: { description: { en: "Field service workflow", zh: "现场服务工作流" } },
  }));
  assert.throws(
    () => prepareDealCommand("write", {
      ...base,
      patch: { description: { zh: "只有中文" } },
    }),
    /non-empty en and zh/,
  );
});

test("leaves private Page field semantics to Core while rejecting broken localized pairs", () => {
  const base = {
    operation: "page.patch",
    dealId: "11111111-1111-4111-8111-111111111111",
    origin: { kind: "agent" },
  };
  assert.doesNotThrow(() => prepareDealCommand("write", {
    ...base,
    patch: {
      businessRead: {
        experience: { testedBy: "Gavin", judgmentChanged: "untested" },
      },
    },
  }));
  assert.doesNotThrow(() => prepareDealCommand("write", {
    ...base,
    patch: {
      description: { en: "Field workflow", zh: "现场工作流" },
      stage: "Seed",
      website: "https://example.test",
      foundersJson: [{ name: "Maya Chen", role: { en: "Founder", zh: "创始人" } }],
      manualTags: ["seed", "workflow"],
    },
  }));
});

test("compacts page.patch success into a revision receipt plus targeted read-back", () => {
  const command = {
    operation: "page.patch",
    dealId: "11111111-1111-4111-8111-111111111111",
    patch: { description: { en: "Field workflow", zh: "现场工作流" }, businessRead: {} },
  };
  const response = {
    ok: true,
    result: {
      idempotent: false,
      page: {
        id: command.dealId,
        revision: 7,
        updatedAt: "2026-08-31T20:00:00.000Z",
        page: { notes: "a very large Page body" },
      },
    },
  };
  assert.deepEqual(compactDealWriteResult(command, response), {
    ok: true,
    result: {
      idempotent: false,
      page: {
        id: command.dealId,
        revision: 7,
        updatedAt: "2026-08-31T20:00:00.000Z",
      },
      verify: {
        dealId: command.dealId,
        fields: ["description", "businessRead"],
        command: `llama deal read ${command.dealId}`,
      },
    },
  });
});
