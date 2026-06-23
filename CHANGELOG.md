# Changelog

All notable changes to `@llamaventures/cli` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project adheres to [Semantic Versioning](https://semver.org).

## [Unreleased]

## [1.17.0] - 2026-06-23

### Added
- **`llama html publish <deal-id-or-name> --file <path>`** — agent-safe
  HTML artifact publishing for deal pages. It resolves deal names, preflights
  file size/HTML shape, chooses a non-overwriting slug by default, auto-detects
  sibling `*_files` asset folders, uploads, and performs read-after-write
  verification before returning the viewer URL.
- **`html_upload_file` MCP tool** — file-path based HTML upload for MCP-native
  agents, including preflight checks, optional asset-folder upload, and
  read-after-write verification.

### Changed
- HTML publishing now sends a per-attempt `client_upload_id` and verifies the
  server copy by `sha256` when Command returns it. Retrying the same failed
  attempt with `--upload-id` avoids duplicate versions. JSON and multipart
  uploads also send the same id as `X-Llama-Upload-Id` so server logs and
  retry/debug paths can correlate the attempt.
- MCP `html_upload` now refuses inline HTML bodies over 50KB and instructs
  agents to use `html_upload_file` or `llama html publish --file`. This avoids
  moving large memos through model/tool-call context, the main reliability
  failure mode for long IC memos.
- MCP `html_upload_bundle` is now treated as a small inline fallback and refuses
  tool-call payloads over 50KB. Agents should use `html_upload_file` with
  `assetsDir` or `llama html publish --file --assets` for saved-page exports.
- `AGENT_BRIEFING.md` now teaches coding agents to use file-path based HTML
  publishing as the default Llama Command route.
- Top-level CLI help now routes deal-specific HTML artifacts to `llama html
  publish --file` instead of the lower-level upload command.
- Local-agent telemetry now redacts content payload fields such as `html`,
  `body`, `content`, `markdown`, `message`, and `text`, keeping only
  chars/bytes/sha256. Incident-sized memo uploads remain observable without
  storing memo text in the telemetry stream.

## [1.16.0] - 2026-06-22

### Added
- CLI and MCP requests now send bounded local-agent telemetry metadata to
  Llama Command: client kind/version, detected agent client, session id,
  normalized command, latency, status, sanitized args, result ids, and bounded
  result summaries.
- `llama eval good|bad --last` and `llama eval add "<query>" --expect ...`
  let agents and humans turn real search usage into Golden Query Eval
  feedback.
- MCP tool `record_eval_feedback` mirrors the CLI eval feedback path for
  MCP-native agents.

### Changed
- `llama agent-onboard` and MCP `agent_briefing` now prefer the authenticated
  Llama Command `/api/agent/briefing` runtime contract, with bundled
  `AGENT_BRIEFING.md` retained as fallback only.
- `llama agent bootstrap` and MCP `agent_bootstrap` now pass the local CLI
  version to Command so the server can return stale/ok CLI guidance as part of
  the agent contract.

## [1.15.1] — 2026-06-16

### Changed
- Documented the new `Outreached` Our Stage across CLI, MCP, and agent
  briefing surfaces. Agents should use `Outreached` for logged outreach
  without a response/effective relationship, and reserve `Sourced` for real
  relationship signals.
- Added `sourceDirection` / `--source-direction` guidance across CLI, MCP, and
  agent briefing surfaces. Use `Inbound` for deals that came into the firm and
  `Outbound` for companies Llama found/listed/reached out to first.

## [1.15.0] — 2026-06-15

### Added
- **`llama agent bootstrap`** — fetches the live Llama Command + Llama OS
  runtime manifest, including the authenticated skill bundle metadata and
  object-inspection contract.
- **`llama skills search|show`** — discovers and reads runtime Llama OS skills
  from Llama Command. The public npm package does not bundle private skill
  content; Command returns only what the authenticated token may see.
- **`llama explain <url-or-object>`** — asks Llama Command to explain URLs,
  deleted objects, 404s, and lifecycle history before an agent guesses that
  the system is broken.
- MCP parity tools: **`agent_bootstrap`**, **`skills_search`**,
  **`skills_read`**, and **`object_inspect`**.

### Changed
- `AGENT_BRIEFING.md` now teaches agents to use the authenticated runtime
  skill gateway instead of assuming a local private `llama-os` checkout.

## [1.14.1] — 2026-06-15

### Added
- **`llama deal agent run <dealId> --message "..."`** — starts Llama
  Command's server-side Deal Agent in a deal thread, so the service agent can
  execute deal-scoped work instead of the local CLI user doing it.
- **`deal_agent_run` MCP tool** — the same narrow server-agent trigger for
  MCP-native clients, without adding a generic API passthrough.

### Changed
- **`llama deal enrich <dealId> --apply --executor server_agent`** now starts
  the server-side Deal Agent unless `--harness-only` is supplied. Dry-runs and
  external-agent handoff prompts still use the enrichment harness endpoint.
- **`deal_enrich` MCP tool** now mirrors the same behavior with `harnessOnly`.

## [1.14.0] — 2026-06-15

### Added
- **`llama deal enrich <dealId>`** — fetch the Llama Command deal-enrichment
  harness for one deal. Defaults to dry-run and returns the evidence plan,
  source plan, Monid budget/config status, write contract, memo boundary, and
  agent handoff prompt without changing facts/links/memo.
- **`deal_enrich` MCP tool** — same contract for MCP-native agents. External
  agents can request `executor: "external_agent"` to receive guardrails and a
  handoff prompt; private Monid credentials stay on the Llama Command server.
- `--prompt` / `--handoff` on the CLI prints only the external-agent prompt.

### Notes
- Requires a Llama Command backend with `/api/deals/:dealId/enrich`.
- Memo generation never defaults on; pass `--memo` / `generateMemo: true` only
  when the user explicitly asks for post-enrichment Memo generation.

## [1.13.0] — 2026-06-11

### Added
- **`llama deal extra set <dealId> <key> <value>`** — patch one top-level key
  in `deals.extra` JSONB. System-admin only (server-gated, 403 otherwise).
  Value is parsed as JSON when possible, else stored as a string. Audited to
  `deal_events` as `field_change` with field `extra.<key>` — same
  from→to trail as any column write. First use case: correcting stale
  backfill provenance (`source_urls`, `identity_confidence`,
  `enrichment_holds`) left by a mismatched-company import.
- **`llama deal extra unset <dealId> <key>`** — delete the key (admin,
  audited the same way).
- Requires a Llama Command backend with the `extraKey` patch support on
  `POST /api/deals/update`.

### Fixed
- Help text: `deal update` writable-fields list now matches the server's
  `FIELD_TO_COLUMN` whitelist — added the missing `founderInfo`, `deckLink`,
  `folderUrl`, `agentActive`.

## [1.12.0] — 2026-06-09

### Added
- **`llama html link <dealId> --wiki <slug> [--lang en|zh] [--title "..."]`** —
  turn a deal's HTML document card into a live, read-only pointer to a wiki
  HTML article. One file, multiple entrances: the wiki stays the canonical
  home and the card renders the wiki's HTML. The deal-side slug defaults to
  the wiki slug and the title defaults to the wiki article's title. Uploads,
  restores, and resets against a linked card are refused by the backend (409)
  — edit the wiki source instead.
- **`llama html unlink <dealId> <slug>`** — revert a linked card back to a
  normal self-hosted document.
- **`llama html docs <dealId>`** now surfaces a `linked_wiki` field on linked
  cards (`{ slug, lang }`).
- All of the above require a Llama Command backend with wiki-linked document
  support.

## [1.11.0] — 2026-06-02

### Changed
- **`deal_feed` (MCP) description corrected.** It previously claimed to
  "exclude AI-generated content" — false, and it misled agents into telling
  users the feed filtered their AI's work. The feed shows *every* contribution
  (from a teammate, their AI assistant, or a system agent); each item now
  carries `who` (the accountable person) and `agent` (the assistant/system
  label, `null` when a human typed it), so human-typed and assistant-drafted
  are distinguishable. The AI's regenerable brief/persona synthesis stays in
  the Memo, not the feed.
- **Agent contract (`AGENT_BRIEFING`): read it back before claiming "saved".**
  A tool returning `ok` is not proof the content landed where the user looks —
  agents must run `llama deal feed <id>` and confirm the item appears before
  reporting success (the #1 failure is writing to the brief, which is
  Memo-only and not in the feed, then reporting success anyway). Authorship is
  automatic — CLI/MCP writes are recorded "via assistant" and can't be faked
  human; an agent's `--attested` caps at `agent-verified`, only a signed-in
  human vouches.

Pairs with the Llama Command server-side contribution-authorship change
(deployed 2026-06-02): the feed badges every item human-typed (✍️) vs
assistant-drafted (🤖) and enforces the AI trust ceiling.

## [1.10.0] — 2026-05-29

### Added
- **`llama memo regenerate --instructions "..."`** — steer a single memo
  regeneration (e.g. "focus on team risk", "frame as a follow-on"). The
  instruction is applied across the memo's narrative panels; it never
  overrides verified facts or the GREEN/YELLOW/RED verdict. Mirrored on the
  `memo_regenerate` MCP tool via a new optional `instructions` field.
  Requires a Llama Command backend with memo-steering support.

## [1.7.0] — 2026-05-23

### Added
- **`llama deal fact add --attested`** — the caller declares whether they
  verified the claim against its source. With `--attested` the fact is recorded
  as vouched; without it, it stays unverified (the honest default). You can't
  mark a fact as human-confirmed on someone's behalf — only a person can.
- **MCP parity with the CLI.** MCP-native agents now have the same surface as
  CLI users (35 → 49 tools): `deal_fact_list` / `deal_fact_add` (carries the
  same `attested` contract) / `deal_fact_verify`; `brief_edit` / `brief_delete`
  / `brief_restore` / `brief_history` / `brief_restore_version`;
  `mentions_resolve`; `skill_correction_list` / `add` / `delete`;
  `deal_refresh_brief` / `deal_refresh_persona`.

### Changed
- `AGENT_BRIEFING.md`: new boundary — don't vouch for facts you haven't checked.

> Note: the 1.6.0 / 1.6.1 changelog entries were never committed to `main`
> (the releases are tagged); reconcile from the pending docs edit when convenient.

## [1.5.0] — 2026-05-19

### Changed
- **`llama html upload` now requires explicit intent — no more silent
  overwrites.** Before: `llama html upload <dealId> --file <path>`
  silently appended a new version to slug `main`, even when the deal
  already had a different HTML artifact under that slug. After: the
  same bare command **refuses** if `main` already has content, naming
  the existing artifact and printing a two-line instruction
  (`--doc main` to update it, `--new --title "..."` to add alongside).
  The slug `main` still works as an auto-init default when the deal
  has no documents yet — only the silent-overwrite path is gone.

### Added
- **`--new` and `--title` flags on `llama html upload`.** Explicit
  "create a new artifact" intent.
  - `--new --doc <slug> --title "..."` — caller picks the slug.
  - `--new --title "Investment Thesis"` — CLI slugifies the title
    (`investment-thesis`). Collisions auto-resolve with `-2` / `-3`
    suffix and a stderr note.
  - Refuses (`--new --doc <slug>`) if the named slug already exists.
- **`--slug` as an alias for `--doc`.** When agents guess the wrong
  flag name (the DB column is `document_slug`, so `--slug` is a
  natural guess), the CLI now accepts it and prints a one-line
  `note: --slug accepted as alias for --doc.` This eliminates the
  exact silent-fall-through that caused the 1.4.4 incident.
- **Unknown-flag stderr warnings on `llama html *` handlers.**
  Mistyped `--out` / `--asssets` / `--doc-slug` etc. now print
  `warning: unknown flag --X (did you mean --Y?)` (Levenshtein-1
  matcher) to stderr. The command still proceeds — no breaking
  change for callers wrapping legacy flags.
- **`mode: 'created' | 'updated'`** field in `llama html upload`
  JSON output, so scripts can branch on whether the call created a
  new doc or appended a version.

### Hardened
- `llama html upload` pre-flights `GET /api/deals/<id>/documents` and
  uses the response to (a) detect existing slugs (b) refuse on the
  bare-default overwrite (c) auto-resolve title-slug collisions.
  Adds one extra round-trip per upload; cheap insurance.

### Migration notes
- `llama html upload <id> --file X` callers targeting an empty
  deal: **no change**, still works.
- `llama html upload <id> --file X` callers updating an existing
  `main` artifact: **must add `--doc main`**.
- Agents using the natural-language flow ("deploy to llama / 部署到
  llama command") via the deal agent or MCP tools: see the updated
  `AGENT_BRIEFING.md` and llama-os routing tables — the agent path
  now teaches "new vs update" upfront.

## [1.4.4] — 2026-05-19

### Changed
- **`AGENT_BRIEFING.md` — document native HTML deploy as the default.**
  After llama-command PR #81 shipped per-deal hand-authored HTML pages at
  `/deals/<id>/browse/<slug>` (sandboxed iframe, Postgres-backed), the
  agent briefing now teaches `llama html upload` as the default route
  when a user says "deploy to llama", "deploy to llama command",
  "部署到 llama command", or "put this HTML on the deal page". The
  Netlify path (`netlify-access-guard`) is preserved but explicitly
  narrowed to founder-facing / external share-link scenarios. Quick
  reference section now lists the full `llama html` surface
  (`upload`, `show`, `versions`, `restore`, `reset`).

## [1.4.0] — 2026-05-12

### Added
- **`llama memo` subcommands.** Closes the CLI/MCP gap on the Memo tab —
  long-form HTML investment memos previously only accessible through the
  web UI. Four verbs:
  - `llama memo show <dealId>` — fetch the current memo; default writes
    HTML to stdout (pipeable to a file or `open`), `--out <path>` writes
    to disk, `--json` returns the full envelope (memo + mode + inflight).
  - `llama memo regenerate <dealId> [--opus]` — trigger server-side
    regeneration; streams panel progress to stderr, prints final summary
    JSON to stdout.
  - `llama memo save <dealId> --file <path>` — upload hand-written HTML
    as a manual override.
  - `llama memo reset <dealId> [--all]` — drop the manual override
    (default) or every version (`--all`).
- **MCP `memo_*` tools.** Same surface as the CLI: `memo_show`,
  `memo_regenerate`, `memo_save`, `memo_reset`. `memo_regenerate` is
  synchronous (non-streaming) so the call returns the final result
  directly to the calling agent.

## [1.3.1] — 2026-05-12

### Changed
- **Documentation hygiene.** CHANGELOG backfilled for 1.2.3 and 1.2.4. Help text
  and READMEs now describe server-enforced rate limits generically instead of
  restating specific numbers. `package.json` description clarified.

### Added
- **Pre-publish identifier guard in CI.** Shape-based regex blocks `npm publish`
  if any internal-style slug accidentally slips into shipped files (`bin/`,
  `lib/`, root `.md`). Extend the pattern as new shapes surface.

## [1.3.0] — 2026-05-11

### Added
- **`llama auth login` — browser-based OAuth 2.1 sign-in.** PKCE + loopback
  flow against the Llama Command authorization server. Opens your browser,
  routes through Google sign-in (`@llamaventures.vc` only) + consent screen,
  redirects to a one-shot ephemeral `127.0.0.1:<port>/callback`, exchanges
  the code for an access + refresh token pair. Replaces the 4-step
  "mint at /settings/tokens → copy → paste → `llama token set`" path with a
  single command. Existing `llc_...` PATs and gcloud Bearer auth continue
  to work unchanged (priority order: OAuth → gcloud → `$LLAMA_TOKEN` →
  `~/.llama/token` → legacy).
- **`llama auth logout`** — RFC 7009 revoke at the AS + clear local
  storage. Falls back to gcloud / PAT cleanly afterward.
- **OS Keychain credential storage** via `@napi-rs/keyring` (macOS Keychain,
  Windows Credential Manager, Linux Secret Service). File backend at
  `~/.llama/oauth.json` (mode 0600) when no Keychain backend is available
  (Linux containers without libsecret, CI runners) — same posture
  `gcloud`/`gh`/`aws` ship with on Linux servers.
- **Auto-refresh on 401.** When an OAuth-bearing call returns 401, the CLI
  forces a refresh-token rotation under a cross-process file lock and
  retries once. Two shells refreshing simultaneously can't burn each other's
  refresh token.
- **`llama auth status` extended.** New `activeMethod` field (`oauth` /
  `gcloud-bearer` / `llama-token` / `none`) and `oauth` block showing
  storage backend, client_id, scope, expiry. Existing fields preserved.

### Changed
- Bearer header on outbound requests now prefers OAuth access token over
  gcloud identity token. Unchanged when no OAuth bundle exists.

### Notes
- Requires the Llama Command server to have `OAUTH_PROVIDER_ENABLED=true`
  set on Render. Until that flag flips, `llama auth login` will fail with
  a 404 on the OAuth endpoints — fall back to PATs in the meantime.
- Phase 2.5 (RFC 8628 device authorization grant for SSH/headless
  environments) lands in a follow-up; today's `auth login` requires a
  browser.

## [1.2.4] — 2026-05-08

### Added
- **`llama pitch finalize`** — founder-initiated wrap-up. Sends a sentinel
  that the intake agent recognizes as "call `finalize_intake` on this turn."
  Closes the gap where the founder is done but the agent keeps asking.

### Changed
- **Fetch timeouts on all three external API calls** — 60s on
  `/start-session`, 180s on `/chat`, 180s on `/upload`. Without these, a
  network hang froze the CLI indefinitely.
- **Help polish** — `pitch help` now mentions `pitch finalize` and the
  `LLAMA_API_URL` env override.

## [1.2.3] — 2026-05-08

### Security
- **Removed a generic MCP tool that proxied arbitrary internal API paths.**
  An unrestricted internal-API tool reachable from a prompt-injection-prone
  agent context is the wrong shape for a public package. Power users keep
  the `llama` CLI (40+ commands) for raw HTTP.

### Changed
- Scrubbed example identifiers from deal-list snippets (both READMEs).
- `zod` is now a direct dependency (was resolving via transitive hoist;
  would have broken under pnpm/yarn strict).
- MCP server reports the real package version in `serverInfo` (was
  hardcoded `"1.0.0"`).

### Fixed
- Operator-precedence bug in `bin/llama.mjs` token-set verify path that
  could TypeError on rare error paths.
- `llama --version` / `-v` / `version` now print the package version
  cleanly (exit 0).

## [1.2.2] — 2026-05-07

### Changed
- `llama pitch`: friendlier output for the upload + send paths (clearer quoting
  hint, cleaner error surface).

## [1.2.1] — 2026-05-07

### Fixed
- CI publish: bump runner Node 20 → 24 so npm 11.5+ is available — the older
  npm silently fails the OIDC handshake against npm Trusted Publishers and the
  registry treats the request as anonymous (404 on `PUT`).

## [1.2.0] — 2026-05-06

### Added
- **External pitch family.** `llama pitch start | say | upload | status | end`
  CLI commands plus 5 matching MCP tools (`pitch_start`, `pitch_send_message`,
  `pitch_upload_file`, `pitch_status`, `pitch_finalize`). Talks to
  `command.llamaventures.vc/external-agent` — no Llama token required, founder
  / EA / external use.

### Changed
- `agent_briefing` MCP prompt + `llama agent-onboard` CLI command now gate on
  `/api/me`; unauthenticated callers see a short bootstrap stub instead of
  the full workflow contract.

## [1.1.0] — 2026-05-04

### Added
- **`llama-mcp` stdio MCP server**, distributed in the same npm package.
  Mirrors the most-used CLI surface as a set of named, typed tools.
  Same auth chain, same error prefixes — CLI and MCP cannot drift.
- `llama agent-onboard` — re-prints the bundled `AGENT_BRIEFING.md` so any
  agent that just installed the package can self-onboard.

### Changed
- HTTP / auth / token helpers extracted into `lib/client.mjs` so CLI and MCP
  share one implementation.

## [1.0.1] — 2026-05-03

### Fixed
- `package.json`: stripped the `./` prefix from `bin` paths — npm 10 was
  silently dropping the binaries on global install for some setups.

## [1.0.0] — 2026-05-03

### Added
- Initial public release as `@llamaventures/cli` on npm.
- CLI surface: deals (CRUD + soft-delete + restore + trash), brief blocks
  (text / link / embed / callout, edit, history, restore-version), ownership
  (claim / nominate / approvals), timeline + posts, deal links, deal facts,
  collaborators, mentions inbox, skill corrections, wiki search/save, admin
  event feeds.
- Auth chain: `gcloud auth print-identity-token` → `$LLAMA_TOKEN` →
  `~/.llama/token` → legacy `~/.llama-command/config.json` (auto-migrates
  forward).
- Stable `Error[NO_AUTH]` and `Error[UNAUTHORIZED]` prefixes for agent pattern
  matching.
- Supply chain: published via npm Trusted Publishers (OIDC), every release
  signed with `--provenance`, CI matrix on Node 18 / 20 / 22.

### Migrated from
- The previous `llama-os/cli/` directory distributed via `npm link`. Existing
  team installs auto-upgrade on the next `bin/update-check` run; the legacy
  directory is kept as a soft fallback for the soak window and will be removed
  in a follow-up.

---

[Unreleased]: https://github.com/Llama-Ventures/llama-cli/compare/v1.17.0...HEAD
[1.17.0]: https://github.com/Llama-Ventures/llama-cli/compare/v1.16.0...v1.17.0
[1.16.0]: https://github.com/Llama-Ventures/llama-cli/compare/v1.15.1...v1.16.0
[1.15.1]: https://github.com/Llama-Ventures/llama-cli/compare/v1.15.0...v1.15.1
[1.15.0]: https://github.com/Llama-Ventures/llama-cli/compare/v1.14.1...v1.15.0
[1.14.1]: https://github.com/Llama-Ventures/llama-cli/compare/v1.14.0...v1.14.1
[1.14.0]: https://github.com/Llama-Ventures/llama-cli/compare/v1.13.0...v1.14.0
[1.13.0]: https://github.com/Llama-Ventures/llama-cli/compare/v1.12.0...v1.13.0
[1.12.0]: https://github.com/Llama-Ventures/llama-cli/compare/v1.11.0...v1.12.0
[1.11.0]: https://github.com/Llama-Ventures/llama-cli/compare/v1.10.0...v1.11.0
[1.10.0]: https://github.com/Llama-Ventures/llama-cli/compare/v1.7.0...v1.10.0
[1.7.0]: https://github.com/Llama-Ventures/llama-cli/compare/v1.5.0...v1.7.0
[1.5.0]: https://github.com/Llama-Ventures/llama-cli/compare/v1.4.4...v1.5.0
[1.4.4]: https://github.com/Llama-Ventures/llama-cli/compare/v1.4.0...v1.4.4
[1.4.0]: https://github.com/Llama-Ventures/llama-cli/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/Llama-Ventures/llama-cli/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/Llama-Ventures/llama-cli/compare/v1.2.4...v1.3.0
[1.2.4]: https://github.com/Llama-Ventures/llama-cli/compare/v1.2.3...v1.2.4
[1.2.3]: https://github.com/Llama-Ventures/llama-cli/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/Llama-Ventures/llama-cli/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/Llama-Ventures/llama-cli/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/Llama-Ventures/llama-cli/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Llama-Ventures/llama-cli/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/Llama-Ventures/llama-cli/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Llama-Ventures/llama-cli/releases/tag/v1.0.0
