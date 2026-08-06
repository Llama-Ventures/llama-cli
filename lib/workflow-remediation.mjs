export const WORKFLOW_REMEDIATION_PATH = "/api/admin/workflow-remediation";
export const WORKFLOW_REMEDIATION_GUARDS = [
  "intake.founder_identity",
  "intake.reason_why",
];

export function workflowRemediationBody(flags, requestId) {
  const dealId = typeof flags.deal === "string" ? flags.deal.trim() : "";
  const rawGuards = typeof flags.guard === "string" ? flags.guard : "";
  const guardKeys = [...new Set(
    rawGuards.split(",").map((value) => value.trim()).filter(Boolean),
  )];
  if (!dealId || guardKeys.length < 1 || guardKeys.length > 2 ||
    guardKeys.some((key) => !WORKFLOW_REMEDIATION_GUARDS.includes(key))) {
    throw new Error(
      "Usage: llama admin workflow remediate --deal <uuid> " +
      "--guard intake.reason_why[,intake.founder_identity] " +
      "[--apply --expected-revision <n> --reason \"...\"]",
    );
  }

  if (flags.apply !== true) {
    if (flags["expected-revision"] !== undefined || flags.reason !== undefined) {
      throw new Error("--expected-revision and --reason require --apply");
    }
    return { action: "preview", dealId, guardKeys };
  }

  const expectedRevision = Number(flags["expected-revision"]);
  const reason = typeof flags.reason === "string" ? flags.reason.trim() : "";
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0 || !reason) {
    throw new Error("--apply requires --expected-revision <n> from preview and --reason \"...\"");
  }
  if (typeof requestId !== "string" || !requestId) {
    throw new Error("workflow remediation apply requires a request ID");
  }
  return {
    action: "apply",
    dealId,
    guardKeys,
    expectedRevision,
    requestId,
    reason,
  };
}
