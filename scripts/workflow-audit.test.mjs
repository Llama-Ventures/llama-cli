import assert from "node:assert/strict";
import test from "node:test";
import { workflowAuditPath } from "../lib/workflow-audit.mjs";

test("builds single-deal and all-deal workflow audit paths", () => {
  assert.equal(
    workflowAuditPath({ deal: "deal-1" }),
    "/api/admin/workflow-audit?deal=deal-1",
  );
  assert.equal(
    workflowAuditPath({ all: true }),
    "/api/admin/workflow-audit?all=true",
  );
});

test("requires exactly one workflow audit scope", () => {
  assert.throws(() => workflowAuditPath({}), /--deal <uuid> \| --all/);
  assert.throws(
    () => workflowAuditPath({ deal: "deal-1", all: true }),
    /--deal <uuid> \| --all/,
  );
});
