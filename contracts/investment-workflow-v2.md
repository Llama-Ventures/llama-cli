# Investment Workflow V2 client contract

CLI and MCP treat `GET/POST /api/deals/{dealId}/workflow` as the only workflow
read/write surface. A write must first read the current revision, submit one
typed command with a unique request id, and display the canonical response.

Never add a client shortcut that writes `deals.status`,
`extra.investment_workflow_v2` snapshots, `extra.stage_gates`, or
`extra.stage4_gate`. Partner
decisions are always made by the authenticated Partner; admin capability does
not imply permission to impersonate a decision maker.

`workflow initialize` is the audited bootstrap command for legacy migration.
It persists the state returned by `workflow show` without advancing a stage or
resolving a guard. Never translate legacy approvals into V2 approvals silently.

Post-IC compatibility status is also owned by V2. Use `workflow
execution-status` / `workflow_update_execution_status` for Term Sheet, Verbal
Commit, and Invested; never reopen direct `deal update ... status` writes.
