# @llamaventures/cli

Llama Ventures team CLI + MCP server. Internal tool for
[command.llamaventures.vc](https://command.llamaventures.vc).

> Public source for ergonomic install. Not an open-source product —
> requires a Llama Ventures team account to actually do anything.

## Install

```bash
npm i -g @llamaventures/cli
```

Requires Node 18+.

## Authenticate

1. Sign in to https://command.llamaventures.vc
2. Visit `/settings/tokens`, click **Mint Token**
3. Save the `llc_…` value to `~/.llama/token` (mode 0600)
4. Verify:

```bash
llama auth status
```

A team member without an account: ask
[gavin@llamaventures.vc](mailto:gavin@llamaventures.vc) to mint one for you.

## Commands

```bash
llama deal search "<name>"
llama deal show <id>
llama brief blocks <id>
llama wiki search "<query>"
llama timeline <id>
# … and more — see `llama --help`
```

Full command reference will land in the v1.1 README.

## MCP server (coming in v1.1)

`llama-mcp` will ship in the same package as a stdio MCP server, usable
from Claude Code, Claude Desktop, Cursor, OpenClaw, Codex, and any other
MCP-native agent — no need to learn the CLI surface.

## Reporting security issues

Do **not** file public GitHub issues for security bugs.
Email [gavin@llamaventures.vc](mailto:gavin@llamaventures.vc) with details.
Response within ~5 push cycles best-effort.

## License

[MIT](./LICENSE).
