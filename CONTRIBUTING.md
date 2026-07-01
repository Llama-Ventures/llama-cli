# Contributing

Thanks for looking. This is an **internal tool** maintained by Llama Ventures
team members. Patches from teammates are welcome; outside contributions are
best limited to documentation fixes and broken-flow reports.

## Local dev loop

```bash
git clone https://github.com/Llama-Ventures/llama-cli.git
cd llama-cli
npm ci
node bin/llama.mjs --help        # CLI is ESM, runs straight from source
node --check bin/llama.mjs        # syntax check
node --check bin/llama-mcp.mjs    # syntax check
npm test                          # mock-backed CLI/MCP agent routing checks
```

To test the CLI end-to-end against your own credentials, point it at the
in-source binary instead of the globally installed one:

```bash
alias llama-dev="node $(pwd)/bin/llama.mjs"
llama-dev auth status
```

To smoke-test the MCP server (no client needed):

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"dev","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node bin/llama-mcp.mjs | head -200
```

You should see 52 named tools, including `deal_agent_run`, `deal_enrich`, the
5 `pitch_*`, and no generic API passthrough tool.

## Conventions

- **Zero deps for the CLI.** `bin/llama.mjs` and `lib/client.mjs` use only Node
  stdlib + native `fetch`. The MCP server may pull in
  `@modelcontextprotocol/sdk`; nothing else.
- **One auth chain, one HTTP client.** Anything new that talks to
  `command.llamaventures.vc` goes through `lib/client.mjs::request()`. Don't
  spawn a parallel auth path; if you need a new credential type, add it to the
  chain there.
- **Stable `Error[…]` prefixes.** `Error[NO_AUTH]` and `Error[UNAUTHORIZED]`
  are part of the public contract — agents pattern-match on them. New error
  classes need a new prefix; renaming an existing one is a major version bump.
- **CLI and MCP stay in lockstep.** Adding a new CLI command? Add the matching
  MCP tool in the same PR. The MCP server exposes only named, typed tools — no
  generic API passthrough — so every server endpoint that needs agent access
  gets its own typed wrapper.
- **No bundler, no build step.** The CLI ships as `.mjs` files that npm copies
  verbatim. `package.json::files` is the allowlist; CI re-verifies the tarball
  contents on every PR.
- **`AGENT_BRIEFING.md` is content, not chrome.** It's the behavioural contract
  for AI agents loading the package — terse, action-oriented, no fluff.
  Changes to it are reviewed for substance, not formatting.

## Submitting changes

1. Branch off `main`. Branch names are casual; prefer `<type>/<short-slug>`
   (e.g. `feat/pitch-rate-limit-message`, `fix/agent-onboard-redaction`).
2. Run the smoke commands above. CI on PR runs the same matrix on Node
   18/20/22 plus a tarball-contents allowlist check.
3. Open a PR. One commit per logical change is preferred but not enforced.
4. Update [`CHANGELOG.md`](CHANGELOG.md) under `[Unreleased]` if the change
   affects users (CLI / MCP surface, error format, auth, install).

## Releasing

Releases are cut from `main` via a GitHub Release. The
`.github/workflows/publish.yml` workflow then publishes to npm via
[Trusted Publishers](https://docs.npmjs.com/trusted-publishers) — no
`NPM_TOKEN` exists in repo secrets.

To cut a release:

```bash
# 1. Bump version + move CHANGELOG entries from [Unreleased] to the new tag
npm version <patch|minor|major>     # commits + tags
git push origin main --tags

# 2. Open https://github.com/Llama-Ventures/llama-cli/releases/new
#    Choose the tag, paste the CHANGELOG section, click "Publish release"
#    → publish.yml fires, OIDC handshake → npm publish --provenance --access public
```

The publish workflow asserts that `package.json::version` matches the release
tag (modulo a leading `v`). If they disagree, it fails fast — fix the
mismatch and re-cut the release.

## Security

Don't file public issues for security bugs. Report privately via
[GitHub security advisories](https://github.com/Llama-Ventures/llama-cli/security/advisories/new).
Full policy: [`SECURITY.md`](SECURITY.md).
