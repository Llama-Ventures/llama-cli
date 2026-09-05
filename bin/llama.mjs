#!/usr/bin/env node

import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import readline from "node:readline";
import {
  formatErrorForDisplay,
  getAuthHeaders,
  getBaseUrl,
  getToken,
  print,
  readBriefing,
  readCanonicalToken,
  readLegacyConfig,
  request,
  structuredBootstrapManifest,
  tryGcloudIdentityToken,
  writeCanonicalToken,
  writeLegacyConfig,
} from "../lib/client.mjs";
import {
  clearExternalSession,
  EXTERNAL_SESSION_FILE,
  getExternalSessionStatus,
  readExternalSession,
  sendExternalMessage,
  startExternalSession,
  uploadExternalFile,
} from "../lib/external.mjs";
import { LLAMA_CLI_CLIENT_ID, pkceLoopbackFlow, revokeToken as revokeOAuthToken } from "../lib/oauth-flow.mjs";
import { deleteBundle, detectBackend, readBundle, writeBundle } from "../lib/oauth-storage.mjs";
import { getBuildInfo } from "../lib/build-info.mjs";
import { getUpdateNudge, maybeNudgeUpdate } from "../lib/version-check.mjs";
import {
  DEAL_ACTIONS,
  buildDealReadPath,
  buildDealSearchPath,
  compactDealWriteResult,
  prepareDealCommand,
  readJsonInput,
} from "../lib/deal-actions.mjs";
import {
  buildDealMemoryPath,
  readMarkdownInput,
} from "../lib/deal-memory-actions.mjs";
import { buildPageSchemaPath } from "../lib/page-schema.mjs";

const requireFromHere = createRequire(import.meta.url);
const { version: PKG_VERSION } = requireFromHere("../package.json");

const HELP_ROOT = `Llama Command CLI 2 — small authenticated tools for agents.

Deal has exactly four actions:
  llama deal search "<company or founder>" [--state active|archived|trashed] [--limit 10]
  llama deal read <dealId> [--detail overview|memory|files|conversation|history|all] [--limit N] [--before <event_seq>]
  llama deal create --json <file|->
  llama deal write --json <file|->

Here --detail memory means structured Deal Information, not Deal Memory.

Deal Memory is a separate sidecar domain through the same login:
  llama memory read <dealId> [--raw]
  llama memory write <dealId> --markdown <file|-> [--expected-version <version>]

Separate preserved domains:
  llama auth status|login|logout
  llama token set|show
  llama agent bootstrap
  llama page-schema list|read|section
  llama skills list|search|show
  llama pref list|add|approve|retire
  llama explain <url-or-object>
  llama wiki search|read|save|delete|restore
  llama admin auth-events|deal-events|agent-events
  llama pitch start|say|upload|status|finalize|end

Run \`llama help deal\` for the mutation contract.`;

const HELP_DEAL = `Llama Command CLI 2 — Deal contract

Exactly four actions:
  llama deal search [query] [--state active|archived|trashed] [--limit 10]
  llama deal read <dealId> [--detail overview|memory|files|conversation|history|all] [--limit N] [--before <event_seq>]
  llama deal create --json <file|->
  llama deal write --json <file|->

Before any Page write:
  llama agent bootstrap
  llama page-schema read <field> [field...]

The authenticated bootstrap contains the two-part private Llama Brain:
Investment Framework V3 plus the Llama Command operating skill. It also
contains a compact index of the current Page fields. Before page.patch, use
the separate page-schema command to read only the exact fields being changed,
or one section when necessary. CLI is the tool, not Brain. Information never
updates Page automatically. page.patch is JSON Merge Patch: objects merge,
null deletes, and arrays replace whole arrays, so read-modify-write complete
Page arrays and preserve sibling slots.

create JSON:
  {"companyName":"Acme","page":{},"information":[],"origin":{"kind":"user","originalUserUtterance":"..."}}

write JSON (CLI derives idempotencyKey when omitted):
  input.submit:    {"operation":"input.submit","dealId":"<uuid>","content":"<original input>","format":"text","source":{},"origin":{"kind":"user","originalUserUtterance":"..."}}
  information.put:{"operation":"information.put","dealId":"<uuid>","type":"founder_claim","labels":["founder-stated"],"subject":{"topic":"traction"},"value":{"content":"...","source":{"kind":"first_meeting_transcript"}},"origin":{"kind":"user","originalUserUtterance":"..."}}
  human judgment:  {"operation":"information.put","dealId":"<uuid>","type":"human_subjective_view.people","subject":{"topic":"founder_execution"},"value":{"speaker":"<Llama user>","rawText":"<the user's verbatim words>","summary":"<the agent's restatement>"},"origin":{"kind":"user","originalUserUtterance":"<complete user input; must contain rawText>"}}
  page.patch:      {"operation":"page.patch","dealId":"<uuid>","patch":{"description":{"en":"...","zh":"..."}},"origin":{"kind":"agent"}}
  artifact.put:    {"operation":"artifact.put","dealId":"<uuid>","kind":"deck","title":"deck.pdf","mimeType":"application/pdf","contentBase64":"<file bytes, base64>","origin":{"kind":"user","originalUserUtterance":"..."}}

artifact.put sends the bytes as contentBase64; Core stores them in the Deal's
own Drive folder and derives byteSize and sha256 itself. Do not supply a
folder, storage key or URL for a file you hold. Write the JSON to a file and
pass its path. Only an artifact that already lives elsewhere is referenced
with storageKey (+ optional storageUrl) plus byteSize and sha256 instead.

For Information, origin records who caused the write and preserves user words;
value.source records where the evidence came from.

human_subjective_view.people|business is a Llama user's own judgment about the
team or the deal. Subjective = the truth depends on who judges: a value or
comparative word with no benchmark, or a claim about someone's future behavior
or inner state. It requires value.speaker, value.rawText quoted verbatim from
origin.originalUserUtterance, and value.summary, the agent's own restatement of
those words; CLI and Core reject anything else. Other types are free.

Core owns Chat Records, append-only Deal Events, Drive provisioning, audit,
and idempotency. User-originated work must preserve exact wording in
origin.originalUserUtterance or reference origin.originatingChatRecordId.`;

const HELP_MEMORY = `Llama Deal Memory — one canonical Markdown Deal Story

  llama memory read <dealId> [--raw]
  llama memory write <dealId> --markdown <file|-> [--expected-version <version>]

Read returns the full JSON record, including its opaque version. --raw prints
only the exact Markdown. Always read before writing. If read returns a Story,
including an empty placeholder, pass its version with --expected-version. Only
a 404 means creation may omit the version; stale writes fail safely.

Write one coherent current Story: replace the complete document instead of
appending an update log. Do not restate Live Deal Page or Deal Information
fields. If the understanding would not materially improve, do not write.

The Markdown must have a non-empty body and YAML frontmatter containing:
  deal_id: the route Deal UUID; never changes
  uuid:     the Story UUID; never changes
  created:  ISO 8601 with offset; never changes
  updated:  ISO 8601 with offset; must strictly advance on every write

Use authorized evidence, preserve uncertainty, and never invent information.
llama deal read --detail memory reads structured Deal Information; it does not
read this Story.

This uses your existing Llama authentication. The CLI talks only to Command
Core and never receives Deal Memory service credentials or AWS access.`;

const HELP_PAGE_SCHEMA = `Llama Live Deal Page schema — progressive, read-only context

  llama page-schema list
  llama page-schema read <field> [field...]
  llama page-schema section <section>

Start with list. Before page.patch, read only the exact fields being changed;
use a section read only when the write genuinely spans that section. This is a
schema/field-prompt surface, not a fifth Deal action and not Page data.`;

function parseFlags(args, allowed = null) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      index += 1;
    }
  }
  if (allowed) {
    const unknown = Object.keys(flags).filter((key) => !allowed.includes(key));
    if (unknown.length) throw new Error(`Unknown flag(s): ${unknown.map((key) => `--${key}`).join(", ")}`);
  }
  return { flags, positional };
}

function usage(area) {
  console.log(
    area === "deal" ? HELP_DEAL :
    area === "memory" ? HELP_MEMORY :
    area === "page-schema" ? HELP_PAGE_SCHEMA :
    HELP_ROOT,
  );
}

function assertDealAction(area, action) {
  if (area === "deal" && !DEAL_ACTIONS.includes(action)) {
    throw new Error(
      `Unknown Deal action: ${action || "<missing>"}. ` +
      "Use search, read, create --json, or write --json.",
    );
  }
}

const RETIRED_TOP_LEVEL_COMMANDS = Object.freeze({
  brief: "llama deal write --json  (operation: page.patch)",
  fact: "llama deal write --json  (operation: information.put)",
  post: "llama deal write --json  (operation: input.submit)",
  timeline: "llama deal read <dealId> --detail history",
  html: "llama deal write --json  (operation: artifact.put)",
  memo: "llama deal write --json  (operation: artifact.put)",
  pipeline: "llama deal search|read|create|write",
});

function unknownCommandError(area, action) {
  const replacement = RETIRED_TOP_LEVEL_COMMANDS[area];
  if (replacement) {
    return new Error(
      `\`llama ${area}\` was retired in CLI 2.0.\n` +
      `  → Use: ${replacement}\n` +
      "  → Contract: llama agent bootstrap",
    );
  }
  return new Error(`Unknown command: llama ${[area, action].filter(Boolean).join(" ")}`);
}

function onboardingNoAuth() {
  return `Llama team onboarding requires credentials.

Run \`llama auth login\`, or mint a token in Llama Command and run
\`llama token set <llc_...>\`. External founders use \`llama pitch\`.`;
}

async function readTokenQuietly() {
  if (!process.stdin.isTTY) {
    let value = "";
    for await (const chunk of process.stdin) value += chunk;
    return value.trim().split(/\s+/)[0] || "";
  }
  process.stderr.write("Paste token (input hidden): ");
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", onData);
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (["\r", "\n", "\u0004"].includes(char)) {
          cleanup();
          process.stderr.write("\n");
          resolve(value.trim());
          return;
        }
        if (char === "\u0003") {
          cleanup();
          process.stderr.write("\n");
          reject(new Error("Aborted"));
          return;
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
  });
}

async function handlePitch(action, rest) {
  if (!action || ["help", "--help", "-h"].includes(action)) {
    console.log(`External founder pitch intake (no internal token required):
  llama pitch start --name "Jane Doe" --email "jane@acme.ai"
  llama pitch say 'We are building X'
  llama pitch upload ./deck.pdf
  llama pitch finalize
  llama pitch status
  llama pitch end
  llama pitch                         interactive session`);
    return;
  }
  if (action === "start") {
    const { flags } = parseFlags(rest, ["name", "email"]);
    if (typeof flags.name !== "string" || typeof flags.email !== "string") {
      throw new Error('Usage: llama pitch start --name "Jane Doe" --email "jane@acme.ai"');
    }
    const existing = readExternalSession();
    const status = existing ? getExternalSessionStatus() : null;
    if (existing && !existing.finalized && status?.active) {
      throw new Error("An active pitch session already exists. Continue it or run `llama pitch end`.");
    }
    print(await startExternalSession({ name: flags.name, email: flags.email }));
    return;
  }
  if (action === "say") {
    const message = rest.join(" ").trim();
    if (!message) throw new Error("Usage: llama pitch say <message>");
    const result = await sendExternalMessage(message);
    process.stdout.write(`${result.text}\n`);
    return;
  }
  if (action === "upload") {
    const { flags, positional } = parseFlags(rest, ["json"]);
    if (!positional[0]) throw new Error("Usage: llama pitch upload <file>");
    const result = await uploadExternalFile(positional[0]);
    if (flags.json) print(result);
    else console.log(`Uploaded ${result.filename} (${(result.size / 1024).toFixed(1)} KB).`);
    return;
  }
  if (action === "status") {
    print(getExternalSessionStatus());
    return;
  }
  if (action === "end") {
    const previous = readExternalSession();
    clearExternalSession();
    print({ ok: true, cleared: Boolean(previous), session_file: EXTERNAL_SESSION_FILE });
    return;
  }
  if (action === "finalize") {
    const session = readExternalSession();
    if (!session || session.finalized) throw new Error("No active unfinalized pitch session.");
    const result = await sendExternalMessage("[FOUNDER_FINALIZE_REQUEST]");
    process.stdout.write(`${result.text}\n`);
    return;
  }
  if (action === "repl") {
    await runPitchRepl();
    return;
  }
  throw new Error(`Unknown pitch subcommand: ${action}`);
}

async function runPitchRepl() {
  const session = readExternalSession();
  if (!session || session.finalized) throw new Error("Start an active pitch session first.");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });
  console.log("Connected to Llama Ventures intake agent. :q exits; :upload <path> attaches a file.");
  rl.prompt();
  rl.on("line", async (line) => {
    const input = line.trim();
    if ([":q", ":quit", ":exit"].includes(input)) return rl.close();
    try {
      if (input.startsWith(":upload ")) {
        const result = await uploadExternalFile(input.slice(8).trim());
        console.log(`uploaded: ${result.filename}`);
      } else if (input) {
        const result = await sendExternalMessage(input);
        console.log(`llama> ${result.text}`);
        if (result.finalized) return rl.close();
      }
    } catch (error) {
      console.error(`error: ${error.message}`);
    }
    rl.prompt();
  });
  await new Promise((resolve) => rl.on("close", resolve));
}

async function handleAuth(area, action, rest) {
  if (area === "token" && action === "set") {
    const { flags, positional } = parseFlags(rest, ["base", "skip-verify"]);
    const token = positional[0] ?? await readTokenQuietly();
    if (!/^llc_[0-9a-f]{32}$/i.test(token)) throw new Error("Expected a full llc_ token (llc_ + 32 hex chars).");
    if (flags.base && flags.base !== true) {
      writeLegacyConfig({ ...readLegacyConfig(), baseUrl: String(flags.base).replace(/\/$/, "") });
    }
    if (!flags["skip-verify"]) {
      const response = await fetch(`${getBaseUrl()}/api/me`, { headers: { "X-Llama-Token": token } });
      if (!response.ok) throw new Error(`Server rejected token (HTTP ${response.status}); not saved.`);
    }
    writeCanonicalToken(token);
    console.log("Saved token to ~/.llama/token (mode 0600).");
    return true;
  }
  if (area === "token" && action === "show") {
    const token = getToken();
    console.log(token ? `${token.slice(0, 8)}...${token.slice(-4)} @ ${getBaseUrl()}` : "No token set.");
    return true;
  }
  if (area === "auth" && action === "status") {
    const [oauth, bearer] = await Promise.all([readBundle(), tryGcloudIdentityToken()]);
    const token = getToken();
    let serverCheck = "skipped (no credentials)";
    if (oauth?.access_token || bearer || token) {
      try {
        const me = await request("GET", "/api/me");
        serverCheck = `ok — ${me?.email ?? "unknown"} (${me?.role ?? "unknown"})`;
      } catch (error) {
        serverCheck = `failed — ${error.message.split("\n")[0]}`;
      }
    }
    const oauthBackend = oauth ? await detectBackend() : null;
    print({
      baseUrl: getBaseUrl(),
      activeMethod: oauth?.access_token ? "oauth" : bearer ? "gcloud-bearer" : token ? "llama-token" : "none",
      oauth: oauth ? { storage: oauthBackend, scope: oauth.scope } : "absent",
      gcloudIdentityToken: bearer ? "present" : "absent",
      llamaToken: token ? `${token.slice(0, 8)}...${token.slice(-4)}` : "absent",
      llamaTokenSource: process.env.LLAMA_TOKEN ? "$LLAMA_TOKEN" : readCanonicalToken() ? "~/.llama/token" : null,
      serverCheck,
    });
    return true;
  }
  if (area === "auth" && action === "login") {
    const { flags } = parseFlags(rest, ["scope"]);
    const scope = typeof flags.scope === "string" ? flags.scope : "read write";
    const baseUrl = getBaseUrl();
    const bundle = await pkceLoopbackFlow({ baseUrl, scope, resource: baseUrl });
    const stored = await writeBundle({
      access_token: bundle.access_token,
      refresh_token: bundle.refresh_token,
      expires_at: Date.now() + (bundle.expires_in ?? 3600) * 1000,
      scope: bundle.scope,
      client_id: bundle.client_id,
      issuer: bundle.issuer,
      resource: bundle.resource,
      created_at: Date.now(),
    });
    print({ ok: true, client_id: LLAMA_CLI_CLIENT_ID, storage: stored.backend, scope: bundle.scope });
    return true;
  }
  if (area === "auth" && action === "logout") {
    const bundle = await readBundle();
    let revoked = false;
    if (bundle) {
      try {
        revoked = await revokeOAuthToken({
          baseUrl: bundle.issuer ?? getBaseUrl(),
          token: bundle.refresh_token,
          tokenTypeHint: "refresh_token",
        });
      } catch {
        revoked = false;
      }
      await deleteBundle();
    }
    print({ ok: true, message: "Local OAuth credentials cleared", serverRevoke: revoked });
    return true;
  }
  return false;
}

async function handleWiki(action, rest) {
  const { flags, positional } = parseFlags(rest);
  const slug = positional[0];
  if (action === "search") {
    const q = positional.join(" ").trim();
    if (!q) throw new Error("Usage: llama wiki search <query>");
    print(await request("GET", `/api/wiki/search?q=${encodeURIComponent(q)}`));
    return;
  }
  if (action === "read") {
    if (!slug) throw new Error("Usage: llama wiki read <slug> [--lang en|zh]");
    // @core-api-operation GET /api/wiki/{slug}
    print(await request("GET", `/api/wiki/${encodeURIComponent(slug)}?lang=${flags.lang === "zh" ? "zh" : "en"}`));
    return;
  }
  if (action === "save") {
    if (!slug || typeof flags.title !== "string" || typeof flags.sources !== "string") {
      throw new Error('Usage: llama wiki save <slug> --title "..." --content "..."|--file <path> --sources "url1;url2"');
    }
    if (flags.content && flags.file) throw new Error("Use either --content or --file, not both.");
    const content = flags.file ? await readFile(String(flags.file), "utf8") : flags.content;
    if (typeof content !== "string") throw new Error("Wiki save requires --content or --file.");
    const inferred = typeof flags.file === "string" && /\.html?$/i.test(flags.file) ? "html" : "markdown";
    print(await request("POST", "/api/wiki/save", {
      slug,
      title: flags.title,
      content,
      sources: flags.sources.split(/[;|]/).map((value) => value.trim()).filter(Boolean),
      type: flags.type,
      related: typeof flags.related === "string" ? flags.related.split(/[;|]/).map((value) => value.trim()).filter(Boolean) : undefined,
      lang: flags.lang === "zh" ? "zh" : "en",
      content_type: typeof flags["content-type"] === "string" ? flags["content-type"] : inferred,
    }));
    return;
  }
  if (["delete", "restore"].includes(action)) {
    if (!slug) throw new Error(`Usage: llama wiki ${action} <slug> [--lang en|zh]`);
    const lang = flags.lang === "zh" ? "zh" : "en";
    if (action === "delete") {
      // @core-api-operation DELETE /api/wiki/{slug}
      print(await request("DELETE", `/api/wiki/${encodeURIComponent(slug)}?lang=${lang}`));
    } else {
      // @core-api-operation POST /api/wiki/{slug}/restore
      print(await request("POST", `/api/wiki/${encodeURIComponent(slug)}/restore?lang=${lang}`));
    }
    return;
  }
  throw new Error("Wiki actions: search, read, save, delete, restore.");
}

async function main() {
  const [area, action, ...rest] = process.argv.slice(2);

  if (["--version", "-v", "version"].includes(area)) {
    if (["--json", "json"].includes(action)) print(getBuildInfo());
    else if (["--check", "check"].includes(action)) console.log(await getUpdateNudge() || `llama CLI ${PKG_VERSION} — up to date`);
    else console.log(PKG_VERSION);
    return;
  }
  if (!area || ["help", "--help", "-h"].includes(area)) {
    usage(area === "help" ? action : undefined);
    return;
  }
  if (["--help", "-h"].includes(action) || rest.some((value) => ["--help", "-h"].includes(value))) {
    usage(area);
    return;
  }

  assertDealAction(area, action);

  if (await handleAuth(area, action, rest)) return;

  if (area === "agent-onboard" || (area === "agent" && ["onboard", "briefing"].includes(action))) {
    const headers = await getAuthHeaders();
    if (!Object.keys(headers).length) {
      console.log(onboardingNoAuth());
      return;
    }
    try {
      const params = new URLSearchParams({ clientVersion: PKG_VERSION });
      params.set("page_schema", "progressive");
      const response = await request("GET", `/api/agent/briefing?${params}`);
      process.stdout.write(response?.briefing || readBriefing());
    } catch (error) {
      process.stderr.write(`warning: live briefing unavailable (${error.message}); using bundled fallback.\n`);
      process.stdout.write(readBriefing());
    }
    return;
  }

  if (area === "agent" && action === "bootstrap") {
    const { flags } = parseFlags(rest, ["json", "limit"]);
    const params = new URLSearchParams({ clientVersion: PKG_VERSION });
    params.set("page_schema", "progressive");
    if (flags.limit && flags.limit !== true) params.set("limit", String(flags.limit));
    const manifest = await request("GET", `/api/agent/manifest?${params}`);
    if (flags.json) print(structuredBootstrapManifest(manifest));
    else process.stdout.write(`${manifest.briefing || JSON.stringify(manifest, null, 2)}\n`);
    return;
  }

  if (area === "page-schema") {
    if (!action || action === "list") {
      if (rest.length) throw new Error("Usage: llama page-schema list");
      // @core-api-operation GET /api/agent/page-schema
      print(await request("GET", buildPageSchemaPath()));
      return;
    }
    if (action === "read") {
      if (!rest.length) throw new Error("Usage: llama page-schema read <field> [field...]");
      // @core-api-operation GET /api/agent/page-schema
      print(await request("GET", buildPageSchemaPath({ fields: rest })));
      return;
    }
    if (action === "section") {
      if (rest.length !== 1) throw new Error("Usage: llama page-schema section <section>");
      // @core-api-operation GET /api/agent/page-schema
      print(await request("GET", buildPageSchemaPath({ section: rest[0] })));
      return;
    }
    throw new Error("Page schema actions: list, read, section.");
  }

  if (area === "skills" || (area === "agent" && action === "skills")) {
    const sub = area === "skills" ? action : rest[0];
    const args = area === "skills" ? rest : rest.slice(1);
    const { flags, positional } = parseFlags(args, ["json", "limit"]);
    if (!sub || sub === "list") {
      const params = new URLSearchParams();
      if (flags.limit && flags.limit !== true) params.set("limit", String(flags.limit));
      print(await request("GET", `/api/agent/skills${params.size ? `?${params}` : ""}`));
      return;
    }
    if (sub === "search") {
      const q = positional.join(" ").trim();
      if (!q) throw new Error("Usage: llama skills search <query>");
      const params = new URLSearchParams({ q });
      if (flags.limit && flags.limit !== true) params.set("limit", String(flags.limit));
      print(await request("GET", `/api/agent/skills?${params}`));
      return;
    }
    if (["show", "read"].includes(sub)) {
      if (!positional[0]) throw new Error("Usage: llama skills show <slug>");
      const result = await request("GET", `/api/agent/skills/${encodeURIComponent(positional[0])}`);
      if (flags.json) print(result);
      else process.stdout.write(`${result.skill?.content || JSON.stringify(result, null, 2)}\n`);
      return;
    }
    throw new Error("Skills actions: list, search, show.");
  }

  if (["pref", "prefs", "preferences"].includes(area)) {
    if (!action || action === "list") {
      const { flags } = parseFlags(rest, ["status"]);
      const params = new URLSearchParams();
      if (flags.status && flags.status !== true) params.set("status", String(flags.status));
      print(await request("GET", `/api/agent/preferences${params.size ? `?${params}` : ""}`));
      return;
    }
    if (action === "add") {
      const { flags, positional } = parseFlags(rest, ["team", "evidence"]);
      const [key, ...contentParts] = positional;
      const content = contentParts.join(" ").trim();
      if (!key || !content) throw new Error('Usage: llama pref add <key> "<content>" [--team]');
      print(await request("POST", "/api/agent/preferences", {
        scope: flags.team ? "team" : "user",
        key,
        content,
        evidence: flags.evidence === true ? undefined : flags.evidence,
      }));
      return;
    }
    if (["approve", "retire"].includes(action)) {
      const id = Number(rest[0]);
      if (!Number.isInteger(id) || id <= 0) throw new Error(`Usage: llama pref ${action} <id>`);
      print(await request("PATCH", `/api/agent/preferences/${id}`, { status: action === "approve" ? "active" : "retired" }));
      return;
    }
    throw new Error("Preference actions: list, add, approve, retire.");
  }

  if (area === "explain" || (area === "agent" && action === "explain")) {
    const args = area === "explain" ? [action, ...rest].filter(Boolean) : rest;
    const { flags, positional } = parseFlags(args, ["json", "type", "id", "lang"]);
    const params = new URLSearchParams();
    if (positional.length) params.set("q", positional.join(" "));
    if (flags.type && flags.type !== true) params.set("type", String(flags.type));
    if (flags.id && flags.id !== true) params.set("id", String(flags.id));
    if (flags.lang === "zh") params.set("lang", "zh");
    if (!params.has("q") && !(params.has("type") && params.has("id"))) throw new Error("Usage: llama explain <url-or-object>");
    print(await request("GET", `/api/agent/explain?${params}`));
    return;
  }

  if (area === "pitch") {
    if (!action) await runPitchRepl();
    else await handlePitch(action, rest);
    return;
  }

  if (area === "deal" && action === "search") {
    const { flags, positional } = parseFlags(rest, ["state", "limit"]);
    // @core-api-operation GET /api/occam/deals
    print(await request("GET", buildDealSearchPath(positional.join(" ").trim(), flags)));
    return;
  }
  if (area === "deal" && action === "read") {
    const dealId = rest[0];
    const { flags } = parseFlags(rest.slice(1), ["detail", "limit", "before"]);
    // @core-api-operation GET /api/occam/deals/{dealId}
    print(await request("GET", buildDealReadPath(
      dealId,
      flags.detail === true ? "overview" : flags.detail || "overview",
      { limit: flags.limit === true ? undefined : flags.limit, before: flags.before === true ? undefined : flags.before },
    )));
    return;
  }
  if (area === "deal" && ["create", "write"].includes(action)) {
    const { flags } = parseFlags(rest, ["json"]);
    const input = await readJsonInput(flags.json);
    const command = prepareDealCommand(action, input);
    const response = await request("POST", "/api/occam/deals/commands", command);
    print(compactDealWriteResult(command, response));
    return;
  }

  if (area === "memory" && action === "read") {
    const { flags, positional } = parseFlags(rest, ["raw"]);
    const path = buildDealMemoryPath(positional[0]);
    // @core-api-operation GET /api/deal-memory/{dealId}/story
    const result = await request("GET", path);
    if (flags.raw) process.stdout.write(result.markdown);
    else print(result);
    return;
  }
  if (area === "memory" && action === "write") {
    const { flags, positional } = parseFlags(rest, ["markdown", "expected-version"]);
    const path = buildDealMemoryPath(positional[0]);
    const markdown = await readMarkdownInput(flags.markdown);
    // @core-api-operation PUT /api/deal-memory/{dealId}/story
    print(await request("PUT", path, {
      markdown,
      ...(typeof flags["expected-version"] === "string"
        ? { expected_version: flags["expected-version"] }
        : {}),
    }));
    return;
  }
  if (area === "memory") {
    throw new Error("Memory actions: read, write.");
  }

  if (area === "wiki") {
    await handleWiki(action, rest);
    return;
  }

  if (area === "admin") {
    const allowed = ["auth-events", "deal-events", "agent-events"];
    if (!allowed.includes(action)) throw new Error(`Admin actions: ${allowed.join(", ")}.`);
    const { flags } = parseFlags(rest);
    const params = new URLSearchParams();
    for (const key of ["kind", "actor", "subject", "since", "limit", "offset", "deal", "tool"]) {
      if (flags[key] && flags[key] !== true) params.set(key, String(flags[key]));
    }
    if (flags["agent-kind"] && flags["agent-kind"] !== true) params.set("agent_kind", String(flags["agent-kind"]));
    if (flags["errors-only"]) params.set("errors_only", "1");
    // @core-api-operation GET /api/admin/auth-events
    // @core-api-operation GET /api/admin/deal-events
    // @core-api-operation GET /api/admin/agent-events
    print(await request("GET", `/api/admin/${action}${params.size ? `?${params}` : ""}`));
    return;
  }

  throw unknownCommandError(area, action);
}

main()
  .then(() => maybeNudgeUpdate())
  .catch((error) => {
    console.error(formatErrorForDisplay(error));
    process.exit(1);
  });
