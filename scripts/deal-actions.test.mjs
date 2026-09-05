import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDealReadPath,
  buildDealSearchPath,
  compactDealWriteResult,
  ensureIdempotencyKey,
  prepareDealCommand,
  validateCommandOrigin,
  validateHumanSubjectiveView,
} from "../lib/deal-actions.mjs";

test("accepts a human subjective view only when it names the user and quotes them verbatim", () => {
  const origin = { kind: "user", originalUserUtterance: "Save this:  I think the founder has\nstrong product taste." };
  const valid = {
    operation: "information.put",
    dealId: "d",
    type: "human_subjective_view.people",
    value: {
      speaker: "Ada",
      rawText: "I think the founder has strong product taste.",
      summary: "Ada reads the founder as having strong product taste.",
    },
    origin,
  };
  assert.doesNotThrow(() => prepareDealCommand("write", valid));
  assert.throws(() => prepareDealCommand("write", { ...valid, value: { ...valid.value, speaker: undefined } }), /value\.speaker/);
  assert.throws(() => prepareDealCommand("write", { ...valid, value: { ...valid.value, rawText: undefined } }), /value\.rawText/);
  assert.throws(
    () => prepareDealCommand("write", { ...valid, value: { ...valid.value, rawText: "Founder has great taste." } }),
    /verbatim/,
  );
  assert.throws(() => prepareDealCommand("write", { ...valid, value: { ...valid.value, summary: undefined } }), /value\.summary/);
  assert.throws(
    () => prepareDealCommand("write", { ...valid, value: { ...valid.value, summary: " I think the founder has strong  product taste. " } }),
    /not repeat/,
  );
  assert.throws(() => prepareDealCommand("write", { ...valid, origin: { kind: "agent" } }), /originate from a user/);
  assert.throws(() => prepareDealCommand("write", { ...valid, type: "human_subjective_view" }), /exactly/);
  assert.throws(() => prepareDealCommand("write", { ...valid, type: "Human_Subjective_View.People" }), /exactly/);
});

test("refuses retired human view aliases and names the replacement", () => {
  for (const type of ["human_view", "human_view.people", "partner_view", "human_opinion", "Human_Statement"]) {
    assert.throws(
      () => validateHumanSubjectiveView({ type, value: {} }, { kind: "agent" }),
      /human_subjective_view\.people or human_subjective_view\.business/,
    );
  }
  assert.doesNotThrow(() => validateHumanSubjectiveView({ type: "founder_claim", value: { content: "x" } }, { kind: "agent" }));
});

test("applies the human subjective view rule to initial Information on create", () => {
  const origin = { kind: "user", originalUserUtterance: "The team feels strong." };
  const base = { companyName: "Example Co", origin };
  assert.throws(
    () => prepareDealCommand("create", {
      ...base,
      information: [{ type: "human_subjective_view.business", value: { speaker: "Ada", rawText: "The team is strong.", summary: "Ada: strong team." } }],
    }),
    /verbatim/,
  );
  assert.doesNotThrow(() => prepareDealCommand("create", {
    ...base,
    information: [{ type: "human_subjective_view.people", value: { speaker: "Ada", rawText: "The team feels strong.", summary: "Ada: strong team." } }],
  }));
});

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
