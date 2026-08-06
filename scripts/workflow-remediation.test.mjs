import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKFLOW_REMEDIATION_PATH,
  workflowRemediationBody,
} from "../lib/workflow-remediation.mjs";

test("builds a preview by default", () => {
  assert.equal(WORKFLOW_REMEDIATION_PATH, "/api/admin/workflow-remediation");
  assert.deepEqual(workflowRemediationBody({
    deal: " deal-1 ",
    guard: "intake.reason_why,intake.founder_identity",
  }), {
    action: "preview",
    dealId: "deal-1",
    guardKeys: ["intake.reason_why", "intake.founder_identity"],
  });
});

test("requires a preview revision and reason to apply", () => {
  assert.deepEqual(workflowRemediationBody({
    deal: "deal-1",
    guard: "intake.reason_why",
    apply: true,
    "expected-revision": "9",
    reason: "Confirmed missing canonical Reason Why.",
  }, "cli-repair-1"), {
    action: "apply",
    dealId: "deal-1",
    guardKeys: ["intake.reason_why"],
    expectedRevision: 9,
    requestId: "cli-repair-1",
    reason: "Confirmed missing canonical Reason Why.",
  });
  assert.throws(() => workflowRemediationBody({
    deal: "deal-1",
    guard: "intake.reason_why",
    apply: true,
    reason: "Missing revision.",
  }, "cli-repair-2"), /expected-revision/);
});

test("rejects bulk, unknown, and accidental apply inputs", () => {
  assert.throws(() => workflowRemediationBody({
    deal: "deal-1",
    guard: "readiness.people.backstory",
  }), /Usage/);
  assert.throws(() => workflowRemediationBody({
    deal: "deal-1",
    guard: "intake.reason_why",
    reason: "No apply flag.",
  }), /require --apply/);
  assert.throws(() => workflowRemediationBody({
    guard: "intake.reason_why",
  }), /Usage/);
});
