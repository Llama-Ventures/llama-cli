<p align="center">
  <img src="assets/llama-ventures-logo.svg" alt="Llama Ventures" width="280">
</p>

<h1 align="center">@llamaventures/cli</h1>

<p align="center">
  <strong>The Llama Ventures CLI &amp; MCP server.</strong><br/>
  One <code>npm install</code>, one auth chain, two interfaces — humans and AI agents
  talk to <a href="https://command.llamaventures.vc">command.llamaventures.vc</a>
  through the same client.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@llamaventures/cli"><img alt="npm" src="https://img.shields.io/npm/v/@llamaventures/cli?label=npm&color=cb3837&logo=npm&logoColor=white"></a>
  <a href="https://github.com/Llama-Ventures/llama-cli/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Llama-Ventures/llama-cli/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://docs.npmjs.com/trusted-publishers"><img alt="Provenance" src="https://img.shields.io/badge/provenance-signed-2e8b57?logo=npm"></a>
  <a href="https://nodejs.org/"><img alt="Node" src="https://img.shields.io/node/v/@llamaventures/cli?color=339933&logo=nodedotjs&logoColor=white"></a>
  <a href="https://modelcontextprotocol.io"><img alt="MCP 2024-11-05" src="https://img.shields.io/badge/MCP-2024--11--05-7d3aed"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#authenticate">Authenticate</a> ·
  <a href="#cli-tour">CLI</a> ·
  <a href="#mcp-server">MCP</a> ·
  <a href="#external-pitch-no-llama-account-required">External pitch</a> ·
  <a href="AGENT_BRIEFING.md">Agent briefing</a> ·
  <a href="SECURITY.md">Security</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

> **Public source for low-friction install. Not an open-source product.**
> Most operations require a Llama Ventures team account
> ([gavin@llamaventures.vc](mailto:gavin@llamaventures.vc) mints tokens). The one
> exception is the **public `pitch`** family — see
> [External pitch](#external-pitch-no-llama-account-required).

---

## What's in the box

```
@llamaventures/cli
├── bin/llama          interactive CLI for humans + bash
└── bin/llama-mcp      stdio MCP server, 20 tools — for any MCP-native agent
```

Both binaries share `lib/client.mjs` — the **same** auth chain, **same** HTTP
client, **same** error format. CLI and MCP can never drift on transport or
identity. Zero runtime dependencies for the CLI itself; the bundled MCP
server depends only on `@modelcontextprotocol/sdk` (Anthropic-maintained,
pinned exact).

```mermaid
flowchart LR
  Human([🧑‍💻 Human])           --> CLI[bin/llama<br/>argv parser]
  Agent([🤖 MCP-native agent]) --> MCP[bin/llama-mcp<br/>stdio JSON-RPC]
  CLI  --> Client[lib/client.mjs<br/>auth · fetch · errors]
  MCP  --> Client
  Client -- HTTPS --> API[(command.llamaventures.vc)]
  classDef src fill:#dcfce7,stroke:#166534,color:#14532d
  classDef edge fill:#dbeafe,stroke:#1e40af,color:#1e3a8a
  class Human,Agent edge
  class CLI,MCP,Client src
```

---

## Install

```bash
npm i -g @llamaventures/cli
```

Requires **Node 18+** (uses native `fetch` and ESM). CI runs the matrix on 18 / 20 / 22.

Verify:

```bash
llama --version
llama auth status     # round-trips against /api/me
```

The same install puts `llama-mcp` on your `PATH` for the MCP server — no second package.

> **Upgrading from `npm link`?** The CLI used to live in the `llama-os/cli/`
> directory and was distributed via `npm link`. As of CLI v1.x it ships as
> `@llamaventures/cli`. Run `npm i -g @llamaventures/cli@latest`; the legacy
> directory keeps working during the soak window but is no longer the source
> of truth. See [`llama-os/cli/DEPRECATED.md`](https://github.com/SoujiOkita98/llama-os/blob/main/cli/DEPRECATED.md).

---

## Authenticate

The client tries credentials **in this order**, on every call:

| # | Source | Header sent | Best for |
|---|--------|-------------|----------|
| 1 | `llama auth login` (OAuth 2.1, OS Keychain) | `Authorization: Bearer …` | **Recommended for everyone.** One-shot browser login; tokens auto-refresh and survive reboots. |
| 2 | `gcloud auth print-identity-token` | `Authorization: Bearer …` | Workstations with gcloud already wired (zero config) |
| 3 | `$LLAMA_TOKEN` env var | `X-Llama-Token` | CI runners, sandboxed cloud agents |
| 4 | `~/.llama/token` (mode `0600`) | `X-Llama-Token` | Persistent local install (legacy PATs) |
| 5 | `~/.llama-command/config.json` | `X-Llama-Token` | CLI v0.1 — auto-migrates to `~/.llama/token` |

If both Bearer and X-Llama-Token are present, both are sent — the server tries
Bearer first and falls through to X-Llama-Token on verification failure.
Inspect the resolved identity any time with `llama auth status`.

### Browser sign-in — recommended

```bash
llama auth login           # opens browser → Google sign-in → consent → done
llama auth status          # → activeMethod=oauth, scope, identity
llama deal search acme-ai  # ready
```

`llama auth login` runs an OAuth 2.1 PKCE + RFC 8252 loopback flow against
`https://command.llamaventures.vc`, exchanges the code for an access + refresh
token pair, and stores them in the OS Keychain (macOS Keychain / Windows
Credential Manager / Linux Secret Service via [`@napi-rs/keyring`](https://www.npmjs.com/package/@napi-rs/keyring)).
Linux containers without libsecret use a 0600-mode file at `~/.llama/oauth.json`
— same posture `gcloud` / `gh` / `aws` ship with on Linux servers. Refresh
tokens rotate transparently when the access token nears expiry; a cross-process
file lock prevents two shells from burning each other's refresh during
concurrent calls.

`llama auth logout` revokes server-side via RFC 7009 and clears local storage.

### gcloud — for machines already wired with `gcloud auth login`

```bash
gcloud auth login          # one-time; pick your @llamaventures.vc account
llama auth status          # → role + email
llama deal search acme-ai  # ready
```

### Long-lived PAT — for CI / unattended environments

1. Sign in to https://command.llamaventures.vc.
2. Open `/settings/tokens` → **Mint Token**.
3. Save the `llc_…` value:

   ```bash
   llama token set llc_paste_token_here
   #  → writes ~/.llama/token (mode 0600)
   #  → round-trips /api/me before saving — bad token never lands on disk
   ```

   Or, in CI / one-shot environments:

   ```bash
   export LLAMA_TOKEN=llc_paste_token_here
   ```

> **Don't have an account?** Email
> [gavin@llamaventures.vc](mailto:gavin@llamaventures.vc). Any email — including
> non-`@llamaventures.vc` — can be granted a token; the system admin
> mints it via `/settings/tokens`. Token first-use auto-creates the user row.

---

## CLI tour

The CLI is the canonical interface. The HTTP API beneath it is stable, but the
CLI handles auth, error formatting, and forward-compatibility across server
schema changes — **prefer the CLI even from inside scripts.**

```bash
# Auth + tokens
llama auth status
llama token set <llc_...>
llama token show

# Pipeline — read
llama deal search "acme ai"
llama deal list --owner alex --status Diligence
llama deal show <dealId>

# Pipeline — write
llama deal create "Acme AI" --description "..." --source Gavin
llama deal update <dealId> status Diligence
llama deal delete  <dealId>     # soft (audit-logged)
llama deal restore <dealId>

# Deal Brief — ordered, typed blocks (text · link · embed · callout)
llama brief blocks       <dealId>
llama brief add-text     <dealId> --heading "..." --body "..."
llama brief add-link     <dealId> --url "..." --label "..."
llama brief add-callout  <dealId> --tone insight --heading "..." --body "..."
llama brief edit         <dealId> <blockId> [--heading ...] [--body ...]
llama brief history      <dealId> <blockId>

# Ownership + approvals
llama claim       <dealId>
llama nominate    <dealId> --user <userId>
llama approvals   list
llama approvals   decide <approvalId> approved --note "..."

# Timeline + posts
llama timeline <dealId>
llama post     <dealId> "message body" [--link url]

# Wiki
llama wiki search "<query>"
llama wiki read   <slug> [--lang en|zh]
# Markdown entry:
llama wiki save <slug> --title "..." --content "..." --sources "url1;url2"
# HTML entry — standalone page at /wiki/<slug> (full-viewport sandboxed iframe):
llama wiki save <slug> --title "..." --file page.html --sources "..." [--content-type html]
# Delete / restore (soft, reversible):
llama wiki delete  <slug> [--lang en|zh]
llama wiki restore <slug> [--lang en|zh]

# Mentions inbox
llama mentions
llama mentions resolve <mentionId>
```

Run `llama --help` for the full surface (~40 commands across deals, briefs,
ownership, timeline, facts, wiki, mentions, skill corrections, and admin event
feeds). Soft-delete is the default everywhere — every removal is reversible
and audit-logged via `deal_events`.

### Error codes — for agents

The CLI's stderr exit messages start with stable, parseable prefixes:

| Prefix | Meaning | Recovery |
|--------|---------|----------|
| `Error[NO_AUTH]` | No credentials found anywhere | `gcloud auth login` **or** `llama token set` |
| `Error[UNAUTHORIZED]` | Server rejected the credentials we sent | Token may be revoked / expired / wrong gcloud account |

The MCP server returns the same prefixes inside `isError: true` content so
agents can pattern-match without parsing prose.

---

## MCP server

The bundled `llama-mcp` is a **stdio Model Context Protocol** server exposing
**19 typed tools** that mirror the most-used CLI surface. Every tool is named
and scoped — there is no generic API passthrough, by design (a public-package
escape hatch reachable from a prompt-injectable agent context is exactly the
shape we want to avoid).

```
auth_status

deal_search            deal_show
deal_create            deal_update

brief_blocks           brief_add_text
brief_add_link         brief_add_callout

timeline               post

wiki_search            wiki_save
wiki_delete            wiki_restore

mentions_list

pitch_start            pitch_send_message
pitch_upload_file      pitch_status
pitch_finalize
```

Auth is identical to the CLI's chain (gcloud → `$LLAMA_TOKEN` → `~/.llama/token`).
The `agent_briefing` MCP **prompt** also returns
[`AGENT_BRIEFING.md`](AGENT_BRIEFING.md) verbatim, so any new agent loading the
server can self-onboard without leaving the protocol.

### Wire into your agent

<details open>
<summary><strong>Claude Desktop</strong> (macOS path shown — Linux/Windows differ)</summary>

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "llama": { "command": "llama-mcp" }
  }
}
```

Restart Claude Desktop. Tools appear under the 🛠️ menu.
</details>

<details>
<summary><strong>Claude Code</strong></summary>

```bash
claude mcp add llama -- llama-mcp
```

Or edit `~/.claude/claude.json` directly — same JSON shape as Desktop.
</details>

<details>
<summary><strong>Cursor</strong></summary>

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "llama": { "command": "llama-mcp" }
  }
}
```
</details>

<details>
<summary><strong>OpenCode / OpenClaw / Codex / arbitrary stdio MCP client</strong></summary>

Most clients accept a `command` + `args` pair. Locate the binary
(`which llama-mcp` → typically `/usr/local/bin/llama-mcp` or
`~/.npm-global/bin/llama-mcp`) and point the client at it. No protocol
extensions, no transport flags.
</details>

> If you're new and want the agent to onboard itself, run
> `llama agent-onboard` from the CLI or fetch the `agent_briefing` prompt from
> the MCP server. It's the workflow contract — autonomy levels, attribution
> grammar, error recovery, anti-pollution rules.

---

## External pitch — no Llama account required

If you're a **founder pitching us, an EA, or a prospective hire** without a
Llama Command token, the CLI ships a `pitch` command family (and the parallel
`pitch_*` MCP tools) that talks to our public intake agent at
[command.llamaventures.vc/external-agent](https://command.llamaventures.vc/external-agent).
Same conversation, same structured 12-dimension verdict — driven from your
terminal or your own AI agent.

```bash
llama pitch start --name "Jane Doe" --email "jane@acme.ai"
llama pitch say "We're building an AI dev tool for X..."
llama pitch upload ./deck.pdf
llama pitch                       # interactive REPL
```

Server-enforced rate limits apply (per-IP, per-email, per-session). If you
hit a limit, the CLI surfaces the server's response message.

This is genuine **agent-to-agent**: your AI helps you tell the story, our
intake agent extracts the structured fields and produces the verdict.

---

## Stability

- **Versioning:** [SemVer](https://semver.org). Renaming or removing a CLI
  command bumps **major**. Adding a tool, command, or flag bumps minor.
  Bugfixes bump patch. The CLI prints `--version`; the MCP server reports
  the same value in its `serverInfo`.
- **Backwards compatibility:** The wire format (Bearer / X-Llama-Token) and
  the `Error[…]` prefixes are part of the public contract and won't change
  inside a major version.
- **Server schema drift:** When the API gains an endpoint, the CLI / MCP gain
  a typed wrapper in the next minor release. While you wait, the `llama` CLI
  itself ships the full `llama` command surface (40+ commands) — use it for
  ad-hoc HTTP work that the MCP doesn't yet wrap.

See [`CHANGELOG.md`](CHANGELOG.md) for the per-version log.

---

## Security

- **`@llamaventures/cli` is published via npm
  [Trusted Publishers](https://docs.npmjs.com/trusted-publishers)** — no
  `NPM_TOKEN` lives in repo secrets. Each release ships with `--provenance`
  (sigstore-signed); the npm registry shows a **Provenance** badge traceable
  to the exact GitHub Action workflow + commit.
- **Minimal dependency tree.** The CLI is zero-deps. The MCP server depends
  only on `@modelcontextprotocol/sdk`, pinned exact.
- **Branch protection** on `main`; Dependabot, secret scanning, and
  push-protection are enabled.
- **Tokens:** stored locally at `~/.llama/token` mode `0600`. Server-side they
  are stored as sha256 hashes — plaintext only ever exists in the user's
  possession.

Reporting a vulnerability: see [`SECURITY.md`](SECURITY.md). **Do not** file
public GitHub issues for security bugs.

---

## Contributing

This is an internal tool maintained by Llama Ventures. PRs from team members
are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md) for the local dev loop,
release flow (Trusted Publishers + GitHub Releases), and the conventions we
follow (zero-deps, lockstep CLI/MCP, stable `Error[…]` prefixes).

External contributions: feel free to open issues for documentation gaps or
broken flows. Feature requests for non-team workflows are best directed at
the [external pitch path](#external-pitch-no-llama-account-required) instead.

---

## License

[MIT](LICENSE) — © 2026 Llama Ventures, Inc.
