export function workflowAuditPath(flags) {
  const deal = typeof flags.deal === "string" && flags.deal.trim()
    ? flags.deal.trim()
    : null;
  const all = flags.all === true;
  if ((!deal && !all) || (deal && all)) {
    throw new Error("Usage: llama admin workflow audit --deal <uuid> | --all");
  }
  const params = new URLSearchParams();
  if (deal) params.set("deal", deal);
  if (all) params.set("all", "true");
  return `/api/admin/workflow-audit?${params.toString()}`;
}
