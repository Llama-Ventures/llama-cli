# Security Policy

## Reporting security issues

**Do not file public GitHub issues for security bugs.** A public issue
gives an attacker a head-start before we can patch.

Instead, email [**gavin@llamaventures.vc**](mailto:gavin@llamaventures.vc)
with:

- A short description of the issue
- Steps to reproduce
- Expected vs. actual behavior
- The CLI version (`npm ls -g @llamaventures/cli`)
- Any other context that helps us reproduce

We aim to acknowledge within ~5 push cycles (best effort), patch
promptly, and credit the reporter (if desired) once the fix ships.
We do not run a public bug bounty program.

## Scope

In scope:

- Authentication / authorization bypass in the CLI client
- Token handling vulnerabilities (logging, transmission, storage)
- Supply-chain attacks against the npm package or its dependencies
- Anything that lets an unauthorized party execute Llama Command
  operations as another team member

Out of scope (still report; lower urgency):

- Bugs in third-party services we depend on (Google Cloud, npm,
  Anthropic, etc.)
- Issues only reproducible against a fork or a modified version of
  this CLI

Server-side bugs (`command.llamaventures.vc`) are governed separately;
report through the same channel.

## Supply-chain posture

This package follows current best practice:

- **`@llamaventures/cli` is published via npm
  [Trusted Publishers](https://docs.npmjs.com/trusted-publishers)** —
  no `NPM_TOKEN` is stored in CI secrets; the GitHub Action exchanges
  an OIDC token at publish time.
- **All releases ship with `--provenance`** (sigstore-signed). The
  npm registry shows a "Provenance" badge on each version, traceable
  to the exact commit + GitHub Action workflow that built it.
- **Minimal dependency tree.** The CLI itself is zero-deps; the
  bundled MCP server depends only on
  `@modelcontextprotocol/sdk` (Anthropic-maintained, pinned exact).
- **Branch protection** on `main` prevents force-push and deletion;
  Dependabot, secret scanning, and push-protection are enabled.

## Disclosure

We coordinate disclosure when a fix lands. Once a patched version
ships, we publish a security advisory on this repo and notify
affected users via the team's internal channels.
