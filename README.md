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
- `artifact.put` — create a file or append an immutable version by reusing its `artifactId`.

Read Deal files before uploading revisions. Reuse the existing `artifactId`
even when renaming; send complete revised bytes and preserve applicable metadata.
Omitting the ID creates a new file only when no current same-kind/title candidate
exists. On `409 OCCAM_CONFLICT`, read the candidates and select the intended ID;
for a genuinely distinct same-name source, explicitly supply a fresh UUID.
Titles are not document identities. `page.patch` does not edit file bytes.
Verify the intended ID/version and preserve old source links.

When Page prose is human-visible, write one bilingual field value as
`{"en":"natural English","zh":"自然中文"}`. The Web language switch selects
the reader's version from the same Page revision. Keep language-neutral names,
enums, URLs, numbers, dates, and source IDs scalar. Information and raw Input
stay in their original language with provenance. Core rejects new scalar Page
prose according to its private Page contract; the public CLI catches malformed
half-localized pairs without maintaining a second field whitelist. Historical
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

## Deal Memory sidecar

Deal Memory is a separate domain alongside the five-resource Deal model. Each
deal can have one canonical, human-readable Markdown Deal Story:

```bash
llama memory read <dealId>
llama memory read <dealId> --raw
llama memory write <dealId> --markdown deal-story.md
llama memory write <dealId> --markdown deal-story.md --expected-version '"etag-from-read"'
```

Always read before writing. If `read` returns any Story, including an empty
placeholder, pass its opaque `version`; only a `404` means creation may omit
`--expected-version`. A stale value fails instead of losing a concurrent edit.
Rewrite the complete document as one coherent current understanding rather than
appending an update log. Do not restate Live Deal Page or Deal Information
fields, and do not write when the understanding would not materially improve.

The Markdown needs a non-empty body and YAML frontmatter with `deal_id`, `uuid`,
`created`, and `updated`. The first three values never change; `updated` must be
an ISO 8601 timestamp with an offset and strictly advance on every write. This
uses the same `llama auth login` identity. CLI calls the authenticated Command
Core adapter only—it has no sidecar URL, service token, S3 credentials, or
direct database access.

`llama deal read --detail memory` still means structured Deal Information.
`llama memory read` means the separate accumulated Markdown Deal Story.

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
pitch remain separate non-Deal domains. Deal Memory likewise has two separate
MCP tools, `get_deal_memory` and `update_deal_memory`; it does not add a fifth
Occam Deal tool. `get_live_deal_page_schema` progressively reads the Page
schema index, exact fields, or one section; it is read-only context rather than
a fifth Deal action.

## Agent bootstrap

```bash
llama agent bootstrap
llama skills search "<task>"
llama skills show <slug>
```

Agents should run `llama agent bootstrap` before Deal work. The command loads
the authenticated, server-owned private Brain: Investment Framework V3 for
thinking plus the Llama Command operating skill for working. It also loads a
compact index of the current Live Deal Page fields. Before `page.patch`, use
`llama page-schema read <field> [field...]` to load only the exact field
contracts being changed, or `llama page-schema section <section>` when the
write genuinely spans a section. None of that private content is shipped in
this public package; CLI is only the tool and authenticated transport.

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

### Read original source content

Use `llama deal read <dealId> --artifact <artifactId>` to read a listed file's text,
source hash and page/paragraph anchors. Use `llama wiki read <slug> --format text`
for a Wiki page or its original uploaded document. `--attachment <referenceId>`
follows a supported reference listed by the Wiki read. Long reads return
`nextOffset`; continue with `--offset N --sha256 HASH`. `--output <file>` downloads
and hash-verifies the original bytes without overwriting a local file.

These options require a Core version with source-content reads. Scanned PDFs
may require OCR; no-text, missing files, unsupported formats and denied storage
are explicit outcomes, not evidence that a memo has been read. MCP exposes the
same text reads inside `read_deal` and `wiki_read`.

## UX friction feedback

Report obstacles encountered by a user, agent or both, including tasks that
succeeded after confusion or unnecessary steps. Two fields are enough:

```bash
llama feedback submit --title "Confusing empty response" --body "Expected source text, but the successful response was empty." --experienced-by agent
llama feedback submit --file feedback.json
llama feedback show <feedback-id>
llama help feedback
```

`--file -` reads JSON from stdin. Optional `details` fields: expected, steps,
impact, workaround, suggestion. `experienced_by` defaults to both. The CLI adds
its version/build, OS/Node and available agent identity; MCP captures its
initialized host name/version. `--agent-name`, `--agent-version`, `--model` (or
`LLAMA_AGENT_CLIENT`, `LLAMA_AGENT_VERSION`, `LLAMA_AGENT_MODEL`) are explicit
reports. Missing versions stay absent; installed programs are never executed
to guess a running host version. Automatic metadata describes the submitting
process; retrospective reports can explicitly supply historical environment
and `occurred_at` through JSON.

Keep the returned `submission_id` for identical retries (`--submission-id`).
One report per obstacle per task. `--request-id` is optional and must refer to
that task and reporter; no global last-command association is inferred. Do not
include secrets, raw command arguments, environment dumps, full transcripts or
file contents. Known credential patterns are redacted, not a guarantee that
arbitrary text is secret-free. Submission failures are explicit and must not
block the original task or trigger recursive feedback. Calls use a 15-second
fetch budget and refuse redirects. Requires Core API 5.9.0, existing login and
write scope; receipt reads require read scope and only return your own reports.
MCP provides `feedback_submit` and `feedback_show` with the same behavior.
