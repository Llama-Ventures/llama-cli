<p align="center">
  <img src="assets/llama-ventures-logo.svg" alt="Llama Ventures" width="280">
</p>

<h1 align="center">@llamaventures/cli</h1>

<p align="center">
  <strong>The Llama Ventures CLI &amp; MCP server.</strong><br/>
  One package, two binaries: <code>llama</code> — the CLI for humans and scripts —
  and <code>llama-mcp</code> — a stdio MCP server with 55 typed tools for any
  MCP-native agent. Both share the same auth chain, HTTP client, and error
  format, and talk to <a href="https://command.llamaventures.vc">command.llamaventures.vc</a>.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@llamaventures/cli"><img alt="npm" src="https://img.shields.io/npm/v/@llamaventures/cli?label=npm&color=cb3837&logo=npm&logoColor=white"></a>
  <a href="https://github.com/Llama-Ventures/llama-cli/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Llama-Ventures/llama-cli/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#authenticate">Authenticate</a> ·
  <a href="#integrate-your-ai-system">Integrate your AI</a> ·
  <a href="#cli">CLI</a> ·
  <a href="#mcp-server">MCP</a> ·
  <a href="#external-pitch--no-llama-account-required">External pitch</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

> **Public source for low-friction install — not an open-source product.**
> Most operations require a Llama Ventures team account (tokens are minted by
> the team admin at `/settings/tokens`). The one exception is the public
> [`pitch`](#external-pitch--no-llama-account-required) family.

## Install

```bash
npm i -g @llamaventures/cli    # Node 18+; also puts `llama-mcp` on your PATH
llama --version
llama version --json           # package, source commit, and pinned Core API contract
llama auth status              # round-trips against /api/me
```

## Authenticate

Credentials are tried in this order, on every call:

| # | Source | Best for |
|---|--------|----------|
| 1 | `llama auth login` (OAuth, OS keychain, auto-refresh) | **Recommended for everyone** |
| 2 | `gcloud auth print-identity-token` | Machines already wired with gcloud |
| 3 | `$LLAMA_TOKEN` env var | CI, sandboxed cloud agents |
| 4 | `~/.llama/token` (mode `0600`) | Long-lived PATs |
| 5 | `~/.llama-command/config.json` | v0.1 legacy — auto-migrates |

```bash
llama auth login          # browser sign-in; tokens auto-refresh, survive reboots
llama auth logout         # revokes server-side, clears local storage
llama token set llc_…     # PAT from /settings/tokens — validated before it lands on disk
llama auth status         # shows the resolved identity + active method
```

> **No account?** Ask your Llama Ventures contact — any email address can be
> granted a token.

## Integrate your AI system

This package is the **supported integration surface** for Llama Command. Wire
in-house agents and LLM apps through here — **not the raw HTTP API**: the
CLI/MCP layer owns the auth chain, the stable `Error[…]` contract, and
forward-compatibility ([SemVer](#stability)); raw API routes carry no such
promise.

1. **Credentials** — `llama auth login`, or a PAT via `llama token set` /
   `$LLAMA_TOKEN` for headless systems.
2. **Install** — `npm i -g @llamaventures/cli`.
3. **Wire it in** — MCP-native agents point at `llama-mcp`
   ([per-client config](#mcp-server)); anything else shells out to `llama …`.
4. **Onboard the agent** — run `llama agent-onboard` (or the MCP
   `agent_briefing` prompt) at session start. It returns the server-owned
   Agent Runtime Contract, always in sync with the live server.
5. **Verify** — `llama auth status`, then `llama deal search "<anything>"`.

## CLI

The CLI is the canonical interface — it handles auth, error formatting, and
schema forward-compatibility. Prefer it even from scripts.

```bash
llama deal search "acme ai"            # find deals (deal list takes the same filters)
llama deal show <dealId>
llama deal feed <dealId>               # every contribution, newest first
llama activity new-deals --since 24h   # recent deal creations
llama activity updated-deals --since 7d # meaningful updates grouped by deal
llama deal create "Acme AI" --source alex --deal-owner owner@llamaventures.vc --source-direction Outbound --status Interested
llama deal ingest <dealId> --file packet.json  # atomic multi-fact + optional Feed note; retry-safe
llama deal fact add <dealId> --category funding --claim "Raised a seed round" --source "deck p3" --source-url https://...
llama deal update <dealId> status Diligence
llama post <dealId> "note body"
llama post <dealId> "@name please respond" --cue  # only after explicit approval
llama brief add-text <dealId> --heading "..." --body "..."
llama wiki search "<query>"
llama wiki save <slug> --title "..." --content "..."
llama mentions
llama agent-onboard                    # server-owned agent workflow contract
```

Status vocabulary — `Interested`: tracked before any contact ·
`Outreached`: contacted, no response yet · `Sourced`: real relationship
signal exists. `sourceDirection` is separate: `Inbound` came to the firm,
`Outbound` we reached out first.

For a deck, meeting note, email, or research packet, prefer `deal ingest` over a
loop of `deal fact add` calls. The JSON object accepts `source`, up to 50
`facts`, an optional `note`, and an optional `idempotencyKey`. The server commits
the packet atomically, maps common category aliases into the canonical taxonomy,
and skips exact source-aware duplicates. `deal fact add` remains the simple path
for one fact.

Facts use `claim` for the fact text. `source` is a readable provenance label
and `sourceUrl` is the canonical evidence URL; both round-trip from the API.
For deal owners, use an exact `/api/field-options` `dealOwner` value, a user
email, or a numeric user id.

Run `llama --help` for the group index, `llama help all` for the full
reference (100+ commands). Deletes are soft and audit-logged everywhere.

### Error codes

| Prefix | Meaning | Recovery |
|--------|---------|----------|
| `Error[NO_AUTH]` | No credentials found | `llama auth login` or `llama token set` |
| `Error[UNAUTHORIZED]` | Server rejected the credentials | Token revoked / expired / wrong account |

The MCP server returns the same prefixes inside `isError: true` content.
Authenticated calls send bounded, content-redacted telemetry to Command.

## MCP server

`llama-mcp` is a stdio Model Context Protocol server exposing 55 typed tools
that mirror the most-used CLI surface. Every tool is named and scoped — there
is deliberately no generic API passthrough. Auth is identical to the CLI's
chain. For the exact live list, pipe `tools/list` through it:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"dev","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | llama-mcp
```

<details>
<summary><strong>Claude Desktop</strong></summary>

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{ "mcpServers": { "llama": { "command": "llama-mcp" } } }
```
</details>

<details>
<summary><strong>Claude Code</strong></summary>

```bash
claude mcp add llama -- llama-mcp
```
</details>

<details>
<summary><strong>Cursor / any stdio MCP client</strong></summary>

Point the client at the `llama-mcp` binary (`which llama-mcp`). Same JSON
shape as above; no protocol extensions, no transport flags.
</details>

> New agent? `llama agent-onboard` (CLI) or the `agent_briefing` prompt (MCP)
> pulls the server-owned workflow contract. The bundled
> [`AGENT_BRIEFING.md`](AGENT_BRIEFING.md) is a fallback copy only.

## External pitch — no Llama account required

Founders, EAs, and prospective hires can pitch without a token: the `pitch`
commands (and `pitch_*` MCP tools) talk to our public intake agent — the same
structured 12-dimension intake as the
[web version](https://command.llamaventures.vc/external-agent), driven from
your terminal or your own AI agent.

```bash
llama pitch start --name "Jane Doe" --email "jane@acme.ai"
llama pitch say "We're building an AI dev tool for X..."
llama pitch upload ./deck.pdf
llama pitch                     # interactive REPL
```

Server-enforced rate limits apply (per-IP, per-email, per-session).

## Stability

- **[SemVer](https://semver.org).** Renaming/removing a command → major;
  new tool/command/flag → minor; fixes → patch.
- **Public contract:** the wire format (Bearer / X-Llama-Token) and the
  `Error[…]` prefixes don't change inside a major version.
- **No raw-API passthrough, by design.** If a wrapper you need hasn't landed,
  open an issue instead of calling the HTTP API directly.

## Security

- Published via npm [Trusted Publishers](https://docs.npmjs.com/trusted-publishers)
  (OIDC) with `--provenance` — no npm token exists to leak.
- Zero runtime deps for the CLI; the MCP server depends only on
  `@modelcontextprotocol/sdk`, pinned exact.
- Branch protection, Dependabot, secret scanning, push protection enabled.
- Tokens: `~/.llama/token` mode `0600` locally; sha256 hashes server-side.

Report vulnerabilities privately via
[GitHub security advisories](https://github.com/Llama-Ventures/llama-cli/security/advisories/new)
— not public issues. See [`SECURITY.md`](SECURITY.md).

## Contributing

Internal tool maintained by Llama Ventures; team PRs welcome — see
[`CONTRIBUTING.md`](CONTRIBUTING.md). External: issues for doc gaps and broken
flows are welcome; to get your company in front of us, use the
[pitch path](#external-pitch--no-llama-account-required).

## License

[MIT](LICENSE) — © 2026 Llama Ventures, Inc.
