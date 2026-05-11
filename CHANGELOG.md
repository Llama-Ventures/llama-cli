# Changelog

All notable changes to `@llamaventures/cli` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project adheres to [Semantic Versioning](https://semver.org).

## [Unreleased]

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
  `/api/me` and *** that the caller isn't owner of.

## [1.1.0] — 2026-05-04

### Added
- **`llama-mcp` stdio MCP server**, distributed in the same npm package.
  Mirrors the most-used CLI surface as 15 typed tools plus the generic
  `llama_api` escape hatch (path must start with `/api/`). Same auth chain,
  same error prefixes — CLI and MCP cannot drift.
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

[Unreleased]: https://github.com/SoujiOkita98/llama-cli/compare/v1.2.2...HEAD
[1.2.2]: https://github.com/SoujiOkita98/llama-cli/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/SoujiOkita98/llama-cli/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/SoujiOkita98/llama-cli/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/SoujiOkita98/llama-cli/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/SoujiOkita98/llama-cli/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/SoujiOkita98/llama-cli/releases/tag/v1.0.0
