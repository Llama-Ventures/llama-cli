# @llamaventures/cli

Llama Ventures team CLI + MCP server for
[command.llamaventures.vc](https://command.llamaventures.vc).

> Public source for low-friction install. **Not an open-source product** —
> requires a Llama Ventures team account to do anything useful. See
> [Authenticate](#authenticate).

[![CI](https://github.com/SoujiOkita98/llama-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/SoujiOkita98/llama-cli/actions/workflows/ci.yml)

## What this ships

This npm package contains two binaries:

- **`llama`** — interactive CLI (humans + bash scripts). Zero deps, native fetch.
- **`llama-mcp`** — stdio [MCP](https://modelcontextprotocol.io) server (Claude Code, Claude Desktop, Cursor, OpenClaw, Codex, any MCP-native agent). Single dep: `@modelcontextprotocol/sdk`.

Both share the same auth chain and HTTP client, so behaviour stays in lockstep.

## Install

```bash
npm i -g @llamaventures/cli
```

Requires Node 18+ (uses native `fetch`).

## Authenticate

The CLI tries credentials in this order on every call:

1. **`gcloud auth print-identity-token`** → `Authorization: Bearer …` (zero config; recommended for team members)
2. **`$LLAMA_TOKEN` env var** → `X-Llama-Token` (preferred for CI / sandboxed agents)
3. **`~/.llama/token`** (single line, mode `0600`) → `X-Llama-Token`
4. **`~/.llama-command/config.json`** — legacy from CLI v0.1; auto-migrates to `~/.llama/token` on first read

If both Bearer and X-Llama-Token are present, both are sent. The server tries Bearer first; on verification failure it falls through to X-Llama-Token.

### Zero-config (recommended)

```bash
gcloud auth login          # one-time, pick your @llamaventures.vc account
llama auth status          # confirm — should show role + email
llama deal search acme-ai  # ready to go
```

### Manual token

For machines without `gcloud`, or for stable CI / agent setups:

1. Sign in to https://command.llamaventures.vc
2. Visit `/settings/tokens` → click **Mint Token**
3. Save the `llc_…` value to `~/.llama/token`:

   ```bash
   llama token set llc_paste_token_here
   # writes ~/.llama/token (mode 0600), round-trips against /api/me before saving
   ```

   Or set it as an env var (preferred for CI):

   ```bash
   export LLAMA_TOKEN=llc_paste_token_here
   ```

A team member without an account: ask
[gavin@llamaventures.vc](mailto:gavin@llamaventures.vc) to mint one for you (he can mint for any email; it auto-creates an inactive user row that he then activates).

## CLI command reference

```bash
# Auth diagnostics
llama auth status

# Token management
llama token set <llc_...> [--base https://command.llamaventures.vc]
llama token show

# Deals — read
llama deal search <query> [--founder ...] [--owner ...] [--status ...] [--stage ...] [--limit N]
llama deal list [--owner ...] [--status ...]
llama deal show <dealId>

# Deals — write
llama deal create "Company" --description "..." [--source ...] [--stage ...] [...]
llama deal update <dealId> <field> <value>
llama deal delete <dealId>                  # soft-delete (audit-logged)
llama deal restore <dealId>
llama deal trash                            # list soft-deleted

# Ownership
llama claim <dealId>                        # propose self
llama nominate <dealId> --user <userId>
llama nominations list
llama nominations decide <approvalId> accepted|declined
llama approvals list                        # partner queue
llama approvals decide <approvalId> approved|rejected [--note "..."]

# Timeline + posts
llama timeline <dealId>
llama post <dealId> "message" [--link url] [--link-name "name"]

# Brief blocks (ordered, typed: text | link | embed | callout)
llama brief blocks <dealId>
llama brief add-text    <dealId> --heading "..." --body "..."
llama brief add-link    <dealId> --url "..." --label "..." [--description "..."]
llama brief add-embed   <dealId> --url "..." [--label "..."]
llama brief add-callout <dealId> --tone insight|info|warning|success --heading "..." --body "..."
llama brief edit        <dealId> <blockId> [--heading ...] [--body ...] [--url ...] [--label ...] [--tone ...]
llama brief delete      <dealId> <blockId>            # soft
llama brief restore     <dealId> <blockId>
llama brief history     <dealId> <blockId> [--limit 50]
llama brief restore-version <dealId> <blockId> <historyId>

# Collaborators
llama deal collab list    <dealId>
llama deal collab add     <dealId> --user <userId|email>
llama deal collab remove  <dealId> --user <userId|email>
llama deal collab restore <dealId> --user <userId|email>

# Links (URLs attached to a deal — Netlify demos, Gamma decks, etc.)
llama deal link list    <dealId> [--include-deleted]
llama deal link add     <dealId> --url <url> [--label "..."]
llama deal link delete  <dealId> <linkId>
llama deal link restore <dealId> <linkId>

# Brief / persona refresh
llama deal refresh-brief   <dealId> [--force]
llama deal refresh-persona <dealId> <persona>

# Deal facts (AI / human-asserted, with verification)
llama deal fact list   <dealId>
llama deal fact add    <dealId> --category <cat> --claim "<text>" [--source <url>] [--confidence high|medium|low]
llama deal fact verify <dealId> <factId> --status confirmed|disputed [--corrected-value "..."]

# Mentions / inbox
llama mentions                              # my unresolved cues (default)
llama mentions list [--everyone] [--all]
llama mentions show <mentionId>
llama mentions resolve <mentionId>
llama mentions unread                       # badge count

# Skill corrections (persona-owner workflow)
llama skill-correction list <skill-slug> [--include-deleted]
llama skill-correction add <skill-slug> "<rule>" [--deal <uuid>] [--block <blockId>]
llama skill-correction delete <id>

# Wiki (knowledge base)
llama wiki search <query>
llama wiki read <slug>
llama wiki save <slug> --title "..." --content "..." [--sources "url1;url2"]

# Admin event feeds (system admin only)
llama admin auth-events  [--kind X] [--actor email] [--since 24h] [--limit 100]
llama admin deal-events  [--kind X] [--deal <uuid>] [--since 24h]
llama admin agent-events [--kind tool_call|loop_stalled] [--errors-only]
```

### Soft-delete

All deletes through this CLI are non-destructive: brief blocks, collaborators, deal links, and deals themselves use `deleted_at` markers. Default reads filter trashed rows out; pass `--include-deleted` on `deal link list` (or visit `/admin` for the broader trash view) to see them. Every removal and restore writes an audit-log entry.

## MCP server (`llama-mcp`)

The same package ships a stdio MCP server with **16 tools** mirroring the most-used CLI surface. Auth is identical — gcloud → `$LLAMA_TOKEN` → `~/.llama/token`. The server reuses `lib/client.mjs` so the CLI and MCP can never drift on transport or auth.

Tools registered:

```
auth_status              deal_search   deal_show
deal_create              deal_update
brief_blocks             brief_add_text  brief_add_link  brief_add_callout
wiki_search              wiki_save
timeline                 post
mentions_list
llama_api                # escape hatch — raw HTTP for endpoints not yet wrapped
```

`llama_api` is a generic passthrough modeled on the GitHub MCP server pattern: agents discover it via `tools/list` and use it for any endpoint not yet given a typed wrapper. Path must start with `/api/`.

### Wire into Claude Desktop / Claude Code

`~/.config/claude-desktop/claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "llama": {
      "command": "llama-mcp"
    }
  }
}
```

Restart Claude Desktop. The 16 tools appear under the 🛠️ menu.

### Wire into Cursor

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "llama": {
      "command": "llama-mcp"
    }
  }
}
```

### Wire into a Codex / OpenClaw / arbitrary stdio MCP client

Most clients accept a `command` + `args` config. Run `which llama-mcp` to find the binary path (`/usr/local/bin/llama-mcp` or `~/.npm-global/bin/llama-mcp`) and point the client at it. Any agent that speaks MCP over stdio works.

## Error codes (for agents)

CLI errors include a stable prefix so agents can pattern-match and recover:

- `Error[NO_AUTH]` — no credentials found. Direct the user to `gcloud auth login` or `llama token set`.
- `Error[UNAUTHORIZED]` — server rejected our credentials. Token revoked, expired, or wrong account selected in gcloud.

The MCP server returns the same errors as `isError: true` content with the same prefix.

## Versioning

Semver. Breaking changes to CLI command shape (renamed flags, removed commands) bump major. Adding a tool or flag bumps minor. Bug fixes bump patch.

The CLI prints its version under `llama --version`. MCP server reports the same version in its `serverInfo`.

## Reporting security issues

**Do not file public GitHub issues for security bugs.** Email
[gavin@llamaventures.vc](mailto:gavin@llamaventures.vc). See
[SECURITY.md](./SECURITY.md) for scope, response SLA, and the
supply-chain posture (Trusted Publishers + provenance + zero-deps CLI).

## License

[MIT](./LICENSE).
