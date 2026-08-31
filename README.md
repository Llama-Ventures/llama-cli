# Llama Command CLI 2

The small authenticated agent interface for Llama Command.

CLI 2 replaces the split Deal command surface with exactly four actions. Core
owns database writes, Drive provisioning, audit Events, provenance, and
idempotency. Agents never touch PostgreSQL directly.

## Install or upgrade

```bash
npm i -g @llamaventures/cli@latest
llama --version
llama auth status
```

Llama Command requires CLI 2 for authenticated CLI/MCP requests. A 1.x client
receives `426 CLI_VERSION_UNSUPPORTED` with the upgrade command; it does not
fall back to legacy Deal APIs.

Authentication is discovered in this order:

1. OAuth credentials from `llama auth login`.
2. A local Google identity from `gcloud auth login`.
3. `LLAMA_TOKEN`.
4. `~/.llama/token`.

## Exactly four Deal actions

```bash
llama deal search "Acme" --limit 10
llama deal read <dealId> --detail overview
llama deal create --json create.json
llama deal write --json write.json
```

`read` is progressive:

```bash
llama deal read <dealId> --detail memory
llama deal read <dealId> --detail files
llama deal read <dealId> --detail conversation
llama deal read <dealId> --detail history
llama deal read <dealId> --detail all
```

The Live Deal Page is always returned. Expand only what the task needs.

### Create

```json
{
  "companyName": "Acme",
  "page": {
    "website": "https://example.com",
    "stage": "Diligence"
  },
  "information": [
    {
      "type": "traction.claim",
      "labels": ["founder_reported", "unverified"],
      "subject": {"company": "Acme"},
      "value": {"arrUsd": 320000}
    }
  ],
  "origin": {
    "kind": "user",
    "originalUserUtterance": "Acme says ARR is about $320k."
  }
}
```

```bash
llama deal create --json create.json
```

Core adds `operation: deal.create`, creates or reuses the Drive folder, writes
the initial Live Page and Information, and appends Events atomically.

### Write

`write` accepts only four operation choices:

- `input.submit` — preserve raw input in the Event Feed.
- `information.put` — add or update one structured memory unit.
- `page.patch` — update the human-visible Live Deal Page.
- `artifact.put` — add an immutable memo/HTML/source artifact.

When Page prose is human-visible, write one bilingual field value as
`{"en":"natural English","zh":"自然中文"}`. The Web language switch selects
the reader's version from the same Page revision. Keep language-neutral names,
enums, URLs, numbers, dates, and source IDs scalar. Information and raw Input
stay in their original language with provenance. The CLI rejects new scalar
Page prose and incomplete language pairs before they reach Core; historical
scalar prose remains readable.

Raw user input example:

```json
{
  "operation": "input.submit",
  "dealId": "<uuid>",
  "format": "text",
  "content": "the complete input",
  "source": {"kind": "meeting_note"},
  "origin": {
    "kind": "user",
    "originalUserUtterance": "the complete input"
  }
}
```

```bash
llama deal write --json write.json
```

For user-originated work, preserve the exact words in
`origin.originalUserUtterance` or reference the canonical
`origin.originatingChatRecordId`. An agent summary never replaces the source.

Chat and Event are system-owned. There is no caller-controlled Event append or
general Chat-forging operation.

## Five Deal resources

1. Live Deal Page — current human-visible state.
2. Deal Information — structured, labelled, provenance-linked agent memory.
3. Artifacts — immutable uploaded source material.
4. Chat Records — append-only group and human-agent conversation.
5. Deal Events — append-only, ordered, replayable history.

Fact, opinion, founder, status, archive, trash, memo section, and artifact kind
are labels or fields inside these resources, not extra tools or tables.

## MCP

Run the bundled stdio server:

```bash
llama-mcp
```

Its Deal surface is also exactly four tools:

- `search_deals`
- `read_deal`
- `create_deal`
- `write_deal`

Authentication, skill discovery, Wiki, admin audit, preferences, and external
pitch remain separate non-Deal domains.

## Agent bootstrap

```bash
llama agent bootstrap
llama skills search "<task>"
llama skills show <slug>
```

Agents should run `llama agent bootstrap` before Deal work. The command loads
the authenticated, server-owned private Brain: Investment Framework V3 for
thinking plus the Llama Command operating skill for working. It also loads the
separate current Live Deal Page field contract for writing. None of that private
content is shipped in this public package; CLI is only the tool and authenticated
transport.

The live server briefing is authoritative. The bundled
`AGENT_BRIEFING.md` is an offline fallback with the same four-action contract.

## Development

```bash
npm install
npm test
npm run verify:release
```

Release artifacts are source-SHA certified. Publishing to npm and changing the
production server's minimum version are separate, explicit release operations.
