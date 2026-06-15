#!/usr/bin/env node

import readline from "readline";
import {
  DEFAULT_BASE_URL,
  LEGACY_DIR,
  LEGACY_FILE,
  TOKEN_DIR,
  TOKEN_FILE,
  getAuthHeaders,
  getBaseUrl,
  getToken,
  print,
  readBriefing,
  readCanonicalToken,
  readLegacyConfig,
  request,
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
import { maybeNudgeUpdate, getUpdateNudge } from "../lib/version-check.mjs";

function parseFlags(args, knownFlags = null) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (!next || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(arg);
    }
  }
  // Opt-in unknown-flag warning. Handlers that pass a `knownFlags` array
  // get a stderr nudge when they see typos like `--slug` for `--doc`.
  // Don't reject — agents wrap legacy options, breaking them silently is
  // worse than a one-line warning.
  if (Array.isArray(knownFlags)) {
    const known = new Set(knownFlags);
    for (const key of Object.keys(flags)) {
      if (!known.has(key)) {
        const suggestion = closestKnownFlag(key, knownFlags);
        process.stderr.write(
          suggestion
            ? `warning: unknown flag --${key} (did you mean --${suggestion}?)\n`
            : `warning: unknown flag --${key}\n`,
        );
      }
    }
  }
  return { flags, positional };
}

function closestKnownFlag(input, candidates) {
  let best = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const d = levenshtein(input, c);
    const tolerance = Math.max(2, Math.floor(c.length / 3));
    if (d < bestScore && d <= tolerance) {
      best = c;
      bestScore = d;
    }
  }
  return best;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array(n + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j - 1], dp[j]);
      prev = tmp;
    }
  }
  return dp[n];
}

// Slug shape used by deal_documents.slug (matches server-side SLUG_RE).
function isValidDocSlug(s) {
  return typeof s === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(s);
}

// Best-effort title → slug. Strips diacritics, lowercases, collapses
// non-alnum to single hyphens, trims, caps at 64. Returns null if the
// result wouldn't pass `isValidDocSlug` (caller must then require --doc).
function slugifyTitle(title) {
  if (typeof title !== "string") return null;
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!slug || !/^[a-z0-9]/.test(slug)) return null;
  return slug;
}

// Client-side fuzzy match — used as a fallback when the server hasn't yet
// shipped the search/filter API (Fix B, 2026-04-25). Once the server
// returns the `{deals,total,limit,offset}` envelope, this path is never
// taken.
function clientSideMatch(deal, filters) {
  const incl = (haystack, needle) =>
    !!haystack && String(haystack).toLowerCase().includes(needle.toLowerCase());
  const eq = (haystack, needle) =>
    String(haystack ?? "").toLowerCase() === String(needle).toLowerCase();

  if (filters.q) {
    const fields = [
      deal.companyName, deal.founders, deal.founderInfo,
      deal.description, deal.notes, deal.dealOwner,
      deal.source, deal.location,
    ];
    if (!fields.some((f) => incl(f, filters.q))) return false;
  }
  if (filters.companyName && !incl(deal.companyName, filters.companyName)) return false;
  if (filters.founder && !(incl(deal.founders, filters.founder) || incl(deal.founderInfo, filters.founder))) return false;
  if (filters.owner && !incl(deal.dealOwner, filters.owner)) return false;
  if (filters.status && !eq(deal.status, filters.status)) return false;
  if (filters.theirStage && !eq(deal.theirStage, filters.theirStage)) return false;
  if (filters.stage && !eq(deal.stage, filters.stage)) return false;
  return true;
}

// Build the `?...` query string for /api/deals from CLI flags + positional q.
function buildDealsQuery(q, flags) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  for (const key of ["companyName", "founder", "owner", "status", "theirStage", "stage", "limit", "offset"]) {
    if (flags[key] !== undefined && flags[key] !== true) {
      params.set(key, String(flags[key]));
    }
  }
  return params;
}

// Hit /api/deals with the given filters. Handles both response shapes:
//   - bare array (old API or no params) → client-side filter, return envelope
//   - {deals,total,limit,offset} (new API) → return as-is
async function searchDeals(q, flags) {
  const params = buildDealsQuery(q, flags);
  const qs = params.toString();
  const result = await request("GET", `/api/deals${qs ? `?${qs}` : ""}`);

  if (Array.isArray(result)) {
    // Fix B not deployed yet, OR no params sent. Filter locally so the
    // CLI behavior is consistent regardless of server version.
    const filters = {
      q,
      companyName: flags.companyName,
      founder: flags.founder,
      owner: flags.owner,
      status: flags.status,
      theirStage: flags.theirStage,
      stage: flags.stage,
    };
    const filtered = result.filter((d) => clientSideMatch(d, filters));
    const limit = Number(flags.limit) > 0 ? Number(flags.limit) : 200;
    const offset = Number(flags.offset) > 0 ? Number(flags.offset) : 0;
    return {
      deals: filtered.slice(offset, offset + limit),
      total: filtered.length,
      limit,
      offset,
      _source: "client-filter",
    };
  }
  return result;
}

const HELP_FULL = `Llama Command CLI

Agent onboarding (run once on first install):
  llama agent-onboard                  # print AGENT_BRIEFING.md — the workflow contract for AI agents

External pitch — talk to Llama Ventures' intake agent (no token required):
  llama pitch start --name "Jane Doe" --email "jane@acme.ai"
  llama pitch say "We're building X..."   # single message, prints reply
  llama pitch upload ./deck.pdf           # attach a file
  llama pitch                             # interactive REPL (existing session)
  llama pitch status                      # session info
  llama pitch end                         # clear local session

Setup:
  llama auth status                    # show current credentials + verify with server
  llama token set <llc_token> [--base https://command.llamaventures.vc]
  llama token show

Zero-config: if you've already run \`gcloud auth login\` with your
@llamaventures.vc account, you don't need to set anything — the CLI
auto-detects \`gcloud auth print-identity-token\` and uses Bearer auth.
Manually-set \`llc_\` tokens are used as a fallback.

Deals:
  llama deal create "Company" --source <name> --description "..." --website https://...
  llama deal show <dealId>
  llama deal feed <dealId>                                     # every contribution (facts + notes), human-typed or assistant-drafted, newest first
  llama deal update <dealId> <field> <value>
      Writable fields: status, theirStage, stage, notes, dealOwner, source,
      description, website, location, founders, founderInfo, proposedAmount,
      roundSize, valuation, deckLink, folderUrl, sector, subsector,
      foundedYear, leadInvestor, investors, agentActive.
      e.g.  llama deal update <dealId> website https://acme.ai
            llama deal update <dealId> sector "Developer Tools"
            llama deal update <dealId> foundedYear 2024
            llama deal update <dealId> leadInvestor "Acme Capital"
  llama deal enrich <dealId> [--dry-run] [--apply] [--executor server_agent|external_agent|planner]
                            [--sources website,github,linkedin,yc,monid] [--budget-cents 50]
                            [--memo] [--prompt]                # evidence harness + server-side enrichment trigger
  llama deal extra set <dealId> <key> <value>        # system-admin only
      Patch one top-level key in deals.extra JSONB. Value is parsed as
      JSON when possible ('{"a":1}', 'true', '3'), else stored as a
      string. Audited to deal_events as field_change "extra.<key>".
  llama deal extra unset <dealId> <key>              # delete the key (admin)
  llama deal search <query> [--founder name] [--owner <user-key>] [--status Diligence]
                            [--theirStage Raising] [--stage Seed]
                            [--limit 200] [--offset 0]
  llama deal list [--owner ...] [--status ...] [...same flags as search]

Collaborators (besides owner — attribution candidates, no approval):
  llama deal collab list <dealId>
  llama deal collab add <dealId> --user <userId|email>
  llama deal collab remove <dealId> --user <userId|email>     # soft-delete
  llama deal collab restore <dealId> --user <userId|email>

Soft-delete:
  All UI/CLI deletes are soft. Real delete = direct DB only. Each
  removal/restore writes a deal_events row so the timeline records who
  did what when. Trash views via ?include_deleted=1 on read endpoints.

Brief blocks (text/link/embed/callout):
  llama brief blocks <dealId>                      # list (excludes trashed)
  llama brief block <dealId> <blockId>             # fetch single block (with body)
  llama brief delete <dealId> <blockId>            # soft-delete
  llama brief restore <dealId> <blockId>

Deal links (separate from brief link blocks — these live in deal_links):
  llama deal link list <dealId> [--include-deleted]
  llama deal link add <dealId> --url <url> [--label "..."]
  llama deal link delete <dealId> <linkId>          # soft-delete
  llama deal link restore <dealId> <linkId>

Ownership:
  llama claim <dealId>                                       # propose self as owner
  llama nominate <dealId> --user <userId>                    # partner nominates someone else
  llama nominations list                                     # pending nominations for me
  llama nominations decide <approvalId> accepted|declined    # accept/decline a nomination

Approvals (partner queue — self-claim approvals):
  llama approvals list
  llama approvals decide <approvalId> approved|rejected [--note "..."]

Timeline / Posts:
  llama timeline <dealId>                                    # full unified feed
  llama post <dealId> "message body" [--link url] [--link-name "name"]

Brief blocks:
  llama brief blocks <dealId>                                  # list current block array
  llama brief block <dealId> <blockId>                         # fetch one block's body (manifest in 'llama deal show')
  llama brief add-text <dealId> --heading "..." --body "..."
  llama brief add-link <dealId> --url "..." --label "..." [--description "..."]
  llama brief add-embed <dealId> --url "..." [--label "..."]
  llama brief add-callout <dealId> --tone insight|info|warning|success --heading "..." --body "..."
  llama brief edit <dealId> <blockId> [--heading ...] [--body ...] [--url ...] [--label ...] [--tone ...]
                          [--source-section <key>] [--lock|--unlock] [--hide|--unhide]
  llama brief delete <dealId> <blockId>
  llama brief history <dealId> <blockId> [--limit 50]            # prior versions of this block (newest first)
  llama brief restore-version <dealId> <blockId> <historyId>      # restore from a history entry; the outgoing
                                                                  # version is itself snapshotted (reversible)

  Common flags on every add-*:
    --source-section <key>   Target a structured section (team, highlights, recommendation,
                             <persona>_analysis, ...). Without this, blocks land in "_other"
                             at the bottom of the TOC. AI writers want this.
    --reply-to <blockId>     Make the block a reply to <blockId>. Snapshots parent's heading
                             + 200-char excerpt into meta so the back-link survives parent
                             edits/deletes. Renders as an amber strip with a jump-link.
    --position top|bottom    Where to insert. Default: top (matches UI behavior since
                             2026-05-03). Use bottom for batched writes that need to
                             preserve insertion order.

Brief / persona refresh + agent-run revert:
  llama deal refresh-brief <dealId> [--force]                  # re-eval stale sections
                                                                # --force = every unlocked watcher-managed section
  llama deal refresh-persona <dealId> <persona-key>            # server validates persona key
  llama deal revert-run <dealId> <runId> --section <key>       # legacy 4-section model only
                                                                # section: company|team|highlights|recommendation

Deal soft-delete / restore / trash list:
  llama deal delete <dealId>                                   # soft (audit-logged via deal_events)
  llama deal restore <dealId>                                  # ⚠ session-only on server today (token → 401)
  llama deal trash                                             # list deleted deals

Deal facts (AI-extracted or human-asserted, with verification):
  llama deal fact list <dealId>                                # ⚠ session-only on server today
  llama deal fact add <dealId> --category <cat> --claim "<text>" [--source <url>] [--confidence high|medium|low] [--attested]
  llama deal fact verify <dealId> <factId> --status confirmed|disputed [--corrected-value "..."]

Skill corrections (persona-owner pushback — read by persona-watcher):
  llama skill-correction list <skill-slug> [--include-deleted]
  llama skill-correction add <skill-slug> "<correction text>" [--deal <uuid>] [--block <blockId>]
  llama skill-correction delete <id>
  Server enforces persona owner OR system admin on POST/DELETE; GET is open.
  External personas (owner_email=null) are admin-only for write.

Mentions / Inbox:
  llama mentions                                       # default: my unresolved cues
  llama mentions list [--everyone] [--all]             # --everyone = team-wide; --all = include resolved
  llama mentions show <mentionId>                      # full row
  llama mentions resolve <mentionId>                   # mark thread resolved (idempotent)
  llama mentions unread                                # just the badge count

Where does this HTML / thesis / artifact go?
  About ONE specific deal? ........ llama html upload <dealId> --new --title "..." --file <path>
                                      (renders at /deals/<id>/browse/<slug>; see "Deal page HTML" below)
  Cross-deal / institutional? ..... llama wiki save <slug> --title "..." --file <path>.html --sources "..."
                                      (renders at /wiki/<slug>; see "Wiki" below)
  Founder-facing public share? .... Netlify (with netlify-access-guard skill), only when user explicitly
                                      says "share publicly". Llama Command outranks Netlify for everything
                                      internal — don't reach for Netlify by default.

Wiki:
  llama wiki search <query>
  llama wiki read <slug>
  Markdown entry (default):
    llama wiki save <slug> --title "..." --content "..." --sources "url1;url2" [--type company] [--related "A;B"]
  HTML entry — standalone HTML page at /wiki/<slug> (full-viewport sandboxed iframe):
    llama wiki save <slug> --title "..." --file path.html --sources "..." [--content-type html]
      (.html / .htm extension auto-implies content_type=html)
      Native comments + working in-page (#) links are added automatically — just upload self-contained HTML.
  ➜ Use Wiki when the artifact is NOT tied to one specific deal — sector landscape, market map,
    thesis, framework, methodology. For deal-specific HTML use "llama html upload <dealId>" instead.
  Delete / restore (soft — reversible):
    llama wiki delete <slug> [--lang en|zh]
    llama wiki restore <slug> [--lang en|zh]

Memo (long-form HTML investment memo — Memo tab in the UI):
  llama memo show <dealId> [--out <path>] [--json]          # default: html → stdout (pipeable to file / browser)
  llama memo regenerate <dealId> [--opus] [--instructions "..."]  # --instructions steers THIS run (e.g. "focus on team risk"); progress → stderr
  llama memo save <dealId> --file <path>                     # paste a hand-written HTML as manual override
  llama memo reset <dealId> [--all]                          # default drops manual override; --all drops every version

Deal page HTML (hand-authored sandboxed pages on /deals/<id>/browse/<slug>):
  ➜ Use this for DEAL-SPECIFIC artifacts: IC memo for X, dashboard for X, 2×2 for X.
    For cross-deal / institutional pages (sector landscape, market map, thesis) use
    "llama wiki save <slug> --file ..." instead — see "Wiki" above.
  Each deal can host many HTML artifacts (IC report, dashboard, market map, …).
  Each one has a stable slug. UPLOAD must declare intent — update an existing
  artifact or add a new one — to avoid silent overwrites.

  List existing artifacts:
    llama html docs <dealId>                                  # who-has-what
    llama html docs create <dealId> <slug> [--title "..."]    # pre-create a slot
    llama html docs archive <dealId> <slug>                   # soft-archive (browse hides)

  Link a card to a wiki article (one file, multiple entrances — the wiki
  stays canonical, the deal card is a live, read-only pointer):
    llama html link <dealId> --wiki <slug> [--lang en|zh] [--title "..."]
    llama html unlink <dealId> <slug>                         # revert to a normal self-hosted doc

  Update an EXISTING artifact (slug must exist):
    llama html upload <dealId> --doc <slug> --file <path> [--assets DIR]

  Add a NEW artifact (slug must NOT already exist):
    llama html upload <dealId> --new --title "..." --file <path> [--doc <slug>] [--assets DIR]
      (omit --doc → CLI slugifies the title; appends -2 / -3 on collision)

  Default (no --doc, no --new) targets slug 'main' but REFUSES if 'main'
  already has content — pass --doc main or --new --title "..." explicitly.

  llama html show <dealId> [--doc <slug>] [--out <path>] [--json]   # default: current html → stdout
  llama html versions <dealId> [--doc <slug>]                       # list version history
  llama html restore <dealId> <version> [--doc <slug>]              # promote an old version to new latest
  llama html reset <dealId> [--doc <slug>]                          # soft-delete latest; /browse reverts to empty

  Caps: HTML 5 MB, each asset 50 MB, total bundle 100 MB. Every write
  triggers SSE push — any browser viewing /deals/<id>/browse refreshes
  automatically. Same write path as the in-app deal agent's
  update_deal_browse_html tool and the MCP html_upload_bundle tool.

Admin (system admin only — server returns 403 for non-admin tokens):
  llama admin auth-events  [--kind X] [--actor email] [--subject email] [--since 24h|7d|30d|<ISO>] [--limit 100]
  llama admin deal-events  [--kind X] [--actor email] [--deal <uuid>] [--since 24h] [--limit 100]
  llama admin agent-events [--kind tool_call|loop_stalled|max_turns_reached] [--agent-kind deal|secretary|main|inbox]
                           [--actor email] [--tool name] [--deal <uuid>] [--errors-only] [--since 24h] [--limit 100]

  Same data as the /admin web console tabs (Auth events / Deal Activity / Agent Activity)
  but scriptable. Pipe through jq / grep for monitoring & forensics.

Token discovery (in order):
  1. $LLAMA_TOKEN env var
  2. ~/.llama/token (canonical, single line)
  3. ~/.llama-command/config.json (legacy v0.1 — auto-migrated forward on first read)

Env:
  LLAMA_TOKEN    token override
  LLAMA_API_URL  API base URL override
`;

// ── Progressive help (Constitution §1) ──
// Default `llama` / `llama --help` prints a SHORT root: the command groups +
// a few starters. Drill into one group with `llama help <area>` (or
// `llama <area> --help`); `llama help all` prints the full reference above.
const HELP_ROOT = `Llama Command CLI — the \`llama\` command for the Llama Ventures workbench.

Common:
  llama deal search "<name>"        find a deal in the pipeline
  llama deal show <dealId>          full deal record
  llama deal feed <dealId>          every contribution (facts + notes), newest first
  llama post <dealId> "..."         add a note to a deal
  llama agent-onboard               print the AI-agent workflow contract

Command groups — run \`llama help <group>\` for that group's commands:
  deal        create · show · feed · update · enrich · search · collaborators · links · delete
  brief       brief blocks: list · add · edit · history · refresh
  facts       deal facts + skill corrections (the sourced, trust-rated layer)
  timeline    timeline · posts · mentions
  wiki        cross-deal knowledge entries (markdown or HTML)
  memo        long-form HTML investment memo
  html        deal-specific HTML artifacts (/deals/<id>/browse/<slug>)
  pitch       external founder intake (no token needed)
  ownership   claim · nominate · approvals
  admin       audit events (system admin only)
  auth        setup · tokens · auth status

  llama help all     the full command reference (everything at once)

Auth: if you've run \`gcloud auth login\` with your @llamaventures.vc account,
the CLI auto-detects it — no token needed (\`llc_\` tokens are a fallback).`;

// Area → which top-level sections of HELP_FULL belong to it.
const HELP_AREA_MATCH = {
  deal: [/^Deals/, /^Collaborators/, /^Soft-delete/, /^Deal links/, /^Deal soft-delete/],
  brief: [/^Brief blocks/, /^Brief \/ persona/],
  facts: [/^Deal facts/, /^Skill corrections/],
  timeline: [/^Timeline/, /^Mentions/],
  wiki: [/^Wiki/, /^Where does this HTML/],
  memo: [/^Memo/],
  html: [/^Deal page HTML/],
  pitch: [/^External pitch/],
  ownership: [/^Ownership/, /^Approvals/],
  admin: [/^Admin/],
  auth: [/^Setup/, /^Zero-config/, /^Token discovery/, /^Env/],
};

// Slice HELP_FULL into sections: a top-level (non-indented) header line plus
// the indented/blank lines that follow it, until the next header.
function helpSections() {
  const out = [];
  let cur = null;
  for (const line of HELP_FULL.split("\n")) {
    if (/^[A-Za-z]/.test(line)) {
      cur = { head: line, lines: [line] };
      out.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  return out;
}

function usage(area) {
  if (area === "all") {
    console.log(HELP_FULL);
    return;
  }
  const matchers = area && HELP_AREA_MATCH[area];
  if (matchers) {
    const blocks = helpSections()
      .filter((s) => matchers.some((re) => re.test(s.head)))
      .map((s) => s.lines.join("\n").replace(/\s+$/, ""));
    if (blocks.length) {
      console.log(blocks.join("\n\n"));
      return;
    }
  }
  console.log(HELP_ROOT);
}

// ============================================================
// `llama pitch` family — external founder-pitch intake
// ============================================================
//
// No Llama Command token required. Bootstraps a session against
// /api/external/* via PoW + cookie. Subcommands:
//
//   llama pitch                   → REPL (requires existing session)
//   llama pitch start --name X --email Y
//   llama pitch say "<msg>"
//   llama pitch upload <path>
//   llama pitch status
//   llama pitch end

async function handlePitch(action, rest) {
  if (!action || action === "help" || action === "--help" || action === "-h") {
    console.log(`Llama Ventures pitch intake — chat with our intake agent (no token required).

Setup:
  llama pitch start --name "Your Name" --email "you@company.com"

Single message (non-interactive):
  llama pitch say 'We have $8k MRR and 5 design partners'

  ⚠ Tip: wrap pitch text in SINGLE quotes ('...') if it contains
  characters like $, \`, or !. Double quotes let the shell expand
  variables — e.g. "$8k MRR" becomes "k MRR" because $8 is empty.
  Interactive REPL (\`llama pitch\`) doesn't have this problem.

Upload a file (deck / pitch / one-pager):
  llama pitch upload ./deck.pdf

Interactive REPL (requires existing session):
  llama pitch

Wrap up the pitch (asks the agent to call finalize_intake immediately):
  llama pitch finalize       # use when you're done — agent stops asking

Inspect / clean up:
  llama pitch status         # session id, idle minutes, finalized?
  llama pitch end            # clear local session state

Caps:
  Server-enforced per-IP / per-email / per-session rate limits apply.
  The CLI surfaces server messages if a limit is hit.

Environment:
  LLAMA_API_URL              override base URL (dev: http://localhost:3000)
`);
    return;
  }

  if (action === "start") {
    const { flags } = parseFlags(rest);
    if (!flags.name || !flags.email) {
      throw new Error(
        "pitch start: --name and --email are required.\n" +
          "  Example: llama pitch start --name \"Jane Doe\" --email \"jane@acme.ai\""
      );
    }
    const existing = readExternalSession();
    if (existing && !existing.finalized) {
      const status = getExternalSessionStatus();
      if (status.active) {
        throw new Error(
          `An active pitch session already exists (started ${existing.started_at}, idle ${status.idle_minutes}min).\n` +
            `  Run \`llama pitch end\` to clear it, or \`llama pitch say "..."\` to continue.`
        );
      }
    }
    process.stderr.write("Computing proof-of-work + opening session...\n");
    const session = await startExternalSession({
      name: String(flags.name),
      email: String(flags.email),
    });
    print({
      session_id: session.session_id,
      name: session.name,
      email: session.email,
      started_at: session.started_at,
      hint: 'Now run `llama pitch say "..."` to chat, or just `llama pitch` for interactive REPL.',
    });
    return;
  }

  if (action === "say") {
    const message = rest.join(" ").trim();
    if (!message) {
      throw new Error('pitch say: message required. Example: llama pitch say "We\'re building X"');
    }
    const result = await sendExternalMessage(message);
    process.stdout.write(result.text + "\n");
    if (result.finalized) {
      process.stderr.write("\n--- Pitch session finalized by the agent ---\n");
      if (result.finalize_payload) {
        process.stderr.write(JSON.stringify(result.finalize_payload, null, 2) + "\n");
      }
    }
    return;
  }

  if (action === "upload") {
    const { flags, positional } = parseFlags(rest);
    const filePath = positional[0];
    if (!filePath) {
      throw new Error("pitch upload: file path required. Example: llama pitch upload ./deck.pdf");
    }
    process.stderr.write(`Uploading ${filePath}...\n`);
    const result = await uploadExternalFile(filePath);
    if (flags.json) {
      print(result);
    } else {
      // Friendly default — drop server-internal fields (drive_file_id /
      // sha256 / file_id). Founders just want "did it work + what does
      // the agent do next." Pass --json for the full payload.
      const sizeKb = (result.size / 1024).toFixed(1);
      console.log(`✓ Uploaded ${result.filename} (${sizeKb} KB).`);
      console.log(`  The intake agent can now reference this file in your pitch.`);
    }
    return;
  }

  if (action === "status") {
    print(getExternalSessionStatus());
    return;
  }

  if (action === "end") {
    const had = readExternalSession();
    clearExternalSession();
    print({
      ok: true,
      cleared: !!had,
      session_file: EXTERNAL_SESSION_FILE,
      note: had
        ? "Local session state cleared. Server-side session may still be active until idle timeout."
        : "No local session was active.",
    });
    return;
  }

  if (action === "finalize") {
    // Founder-initiated finalize: send a sentinel token in the chat
    // stream that the system prompt recognizes as "wrap up now." The
    // intake agent calls finalize_intake on this turn with whatever
    // fields are recorded — no extra questions, no confirmation prompt.
    // Local session is left as-is; on next read its `finalized=true`
    // reflects the server's status.
    const session = readExternalSession();
    if (!session) {
      throw new Error(
        "No active pitch session. Run `llama pitch start --name \"...\" --email \"...\"` first."
      );
    }
    if (session.finalized) {
      throw new Error(
        "This pitch session is already finalized. Run `llama pitch end` to clear local state."
      );
    }
    process.stderr.write("Asking the agent to wrap up...\n");
    const result = await sendExternalMessage("[FOUNDER_FINALIZE_REQUEST]");
    process.stdout.write(result.text + "\n");
    if (result.finalized) {
      process.stderr.write("\n--- Pitch session finalized ---\n");
      if (result.finalize_payload) {
        process.stderr.write(JSON.stringify(result.finalize_payload, null, 2) + "\n");
      }
    } else {
      process.stderr.write(
        "\n⚠ Agent did not call finalize_intake on this turn. " +
        "Try `llama pitch finalize` once more, or `llama pitch end` to abandon.\n"
      );
    }
    return;
  }

  // No action → REPL mode (requires existing session)
  if (action === undefined || (rest.length === 0 && !["start", "say", "upload", "status", "end", "finalize"].includes(action))) {
    // Treat any unknown bare action as "join existing session in REPL mode"
    const session = readExternalSession();
    if (!session) {
      throw new Error(
        "No active pitch session. Start one with:\n" +
          '  llama pitch start --name "Your Name" --email "you@company.com"'
      );
    }
    if (session.finalized) {
      throw new Error(
        "This pitch session is finalized. Run `llama pitch end` then `pitch start` for a new one."
      );
    }
    await runPitchRepl();
    return;
  }

  throw new Error(`Unknown pitch subcommand: ${action}. Run \`llama pitch help\` for the full list.`);
}

async function runPitchRepl() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "you> ",
  });

  console.log("Connected to Llama Ventures intake agent. Type your pitch — :q to exit, :upload <path> to attach a file.");
  console.log("");

  const send = async (msg) => {
    process.stdout.write("\nllama> ");
    let buffered = "";
    const result = await sendExternalMessage(msg, {
      onChunk: (chunk) => {
        process.stdout.write(chunk);
        buffered += chunk;
      },
    });
    if (!buffered) process.stdout.write(result.text);
    process.stdout.write("\n\n");
    if (result.finalized) {
      console.log("--- Pitch session finalized ---");
      if (result.finalize_payload) {
        console.log(JSON.stringify(result.finalize_payload, null, 2));
      }
      rl.close();
      return true;
    }
    return false;
  };

  rl.prompt();
  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (trimmed === ":q" || trimmed === ":quit" || trimmed === ":exit") {
      rl.close();
      return;
    }
    if (trimmed.startsWith(":upload ")) {
      const filePath = trimmed.slice(8).trim();
      try {
        process.stdout.write("uploading...\n");
        const result = await uploadExternalFile(filePath);
        console.log(`uploaded: ${result.filename} (${result.drive_file_id})`);
      } catch (err) {
        console.error("upload error:", err.message);
      }
      rl.prompt();
      return;
    }
    if (!trimmed) {
      rl.prompt();
      return;
    }
    try {
      const finalized = await send(trimmed);
      if (finalized) return;
    } catch (err) {
      console.error("error:", err.message);
    }
    rl.prompt();
  });

  await new Promise((resolve) => rl.on("close", resolve));
}

async function main() {
  const [area, action, ...rest] = process.argv.slice(2);
  if (area === "--version" || area === "-v" || area === "version") {
    const { createRequire } = await import("module");
    const requireFromHere = createRequire(import.meta.url);
    const { version } = requireFromHere("../package.json");
    // `llama version --check` — explicitly check npm for a newer release and
    // print the upgrade line (or "up to date"). Lets an agent surface the
    // nudge on demand, separate from the throttled, TTY-gated auto-nudge.
    if (action === "--check" || action === "check") {
      const nudge = await getUpdateNudge();
      console.log(nudge || `llama CLI ${version} — up to date`);
      return;
    }
    console.log(version);
    return;
  }
  if (!area || area === "help" || area === "--help" || area === "-h") {
    usage(area === "help" ? action : undefined);
    return;
  }
  // `llama <area> --help` / `-h` → just that group's commands
  if (action === "--help" || action === "-h") {
    usage(area);
    return;
  }
  // `llama <area> <action> --help` (e.g. `brief add-text --help`). Without this
  // short-circuit, "--help" falls through to the action handler, where rest[0]
  // can be read as a positional (e.g. dealId="--help") and trigger a REAL write.
  // Catch --help/-h anywhere in the sub-command args and print group help first.
  if (rest.includes("--help") || rest.includes("-h")) {
    usage(area);
    return;
  }

  // `llama agent-onboard` — print the bundled AGENT_BRIEFING.md so an AI
  // agent reads it once and internalises the Llama Ventures workflow
  // contract. Same content the `agent_briefing` MCP prompt returns.
  // Also: `llama agent onboard` (two-word form) for symmetry.
  //
  // Gated behind /api/me — without valid credentials we print a short
  // bootstrap stub instead. Stops unauthenticated callers from harvesting
  // internal command surface / workflow conventions just by running the
  // public CLI.
  if (
    area === "agent-onboard" ||
    (area === "agent" && (action === "onboard" || action === "briefing"))
  ) {
    const headers = await getAuthHeaders();
    if (Object.keys(headers).length === 0) {
      console.log(
`Llama Ventures team onboarding requires credentials.

Team member?
  - Run \`gcloud auth login\` with your @llamaventures.vc account, OR
  - Mint a token at https://command.llamaventures.vc/settings/tokens
    then \`llama token set <llc_...>\`.
  Re-run \`llama agent-onboard\` after — the workflow contract will print.

Founder or external visitor (no Llama account)?
  Run \`llama pitch start --name "Your Name" --email "you@company.com"\`
  to chat with our intake agent — no token required.`
      );
      return;
    }
    try {
      await request("GET", "/api/me");
    } catch (e) {
      const msg = e?.message || "";
      if (msg.includes("Error[UNAUTHORIZED]") || msg.includes("Error[NO_AUTH]")) {
        console.log(
`Llama Ventures team onboarding requires valid credentials.

Server rejected the credentials we sent. Re-mint at
https://command.llamaventures.vc/settings/tokens, run
\`llama token set <llc_...>\`, then re-run \`llama agent-onboard\`.`
        );
        process.exitCode = 1;
        return;
      }
      throw e;
    }
    process.stdout.write(readBriefing());
    return;
  }

  // `llama pitch ...` — external founder-pitch family. No Llama token
  // required; bootstraps a session against /api/external/* via PoW + cookie.
  // See lib/external.mjs and AGENT_BRIEFING.md for the full surface.
  if (area === "pitch") {
    await handlePitch(action, rest);
    return;
  }

  if (area === "token" && action === "set") {
    const { flags, positional } = parseFlags(rest);
    const token = positional[0];
    if (!token?.startsWith("llc_")) throw new Error("Expected a token starting with llc_");
    if (token.length !== 36) {
      throw new Error(
        `Token has length ${token.length}; expected 36 (llc_ + 32 hex chars).\n` +
        `  This usually means you copied the masked preview ("llc_xxxx…yyyy") from\n` +
        `  the token list instead of the full string from the mint response.\n` +
        `  Re-mint at https://command.llamaventures.vc/settings/tokens and use the\n` +
        `  Copy button — it captures the full value.`
      );
    }
    if (flags.base) {
      // baseUrl still lives in legacy config — rarely overridden. Keep the
      // file there so we don't introduce a second config surface.
      const legacy = readLegacyConfig();
      legacy.baseUrl = String(flags.base).replace(/\/$/, "");
      writeLegacyConfig(legacy);
    }
    // Round-trip the token against /api/me before persisting. Catches the
    // pasted-preview / wrong-token / wrong-host cases at "set" time instead
    // of letting them fester until the next CLI call (or worse, a CI run).
    // --skip-verify is an escape hatch for offline / pre-deploy testing.
    if (!flags["skip-verify"]) {
      try {
        const res = await fetch(`${getBaseUrl()}/api/me`, {
          headers: { "X-Llama-Token": token },
        });
        if (res.status === 401 || res.status === 403) {
          const body = await res.text();
          throw new Error(
            `Server rejected this token (HTTP ${res.status}). Not saving.\n` +
            `  Response: ${body.slice(0, 200)}\n` +
            `  Base URL: ${getBaseUrl()}\n` +
            `  Re-check that you copied the full token from the mint dialog\n` +
            `  ("Shown once") and not the masked preview from the list view.\n` +
            `  Override with --skip-verify if you know the server is unreachable.`
          );
        }
        if (!res.ok) {
          throw new Error(`Verify call failed: HTTP ${res.status}. Not saving.`);
        }
      } catch (e) {
        if (e instanceof Error && (e.message.startsWith("Server rejected") || e.message.startsWith("Verify call failed"))) {
          throw e;
        }
        // Network / DNS failure — surface but let the user override.
        throw new Error(
          `Could not reach ${getBaseUrl()} to verify token: ${e.message}\n` +
          `  Add --skip-verify if you want to save anyway.`
        );
      }
    }
    writeCanonicalToken(token);
    console.log(`Saved token to ~/.llama/token (mode 0600).`);
    console.log(`Base URL: ${getBaseUrl()}`);
    if (!flags["skip-verify"]) console.log(`Verified against ${getBaseUrl()}/api/me — token works.`);
    return;
  }

  if (area === "token" && action === "show") {
    const token = getToken();
    if (!token) {
      console.log("No token set.");
      return;
    }
    console.log(`${token.slice(0, 8)}...${token.slice(-4)} @ ${getBaseUrl()}`);
    return;
  }

  // Self-diagnosis for agents and humans — what credentials do we have, and
  // are they accepted by the server right now? Designed so an agent can
  // parse the output and decide whether to drive a recovery flow.
  if (area === "auth" && action === "status") {
    const bearer = await tryGcloudIdentityToken();
    const token = getToken();
    const tokenSrc = process.env.LLAMA_TOKEN
      ? "$LLAMA_TOKEN"
      : readCanonicalToken()
        ? "~/.llama/token"
        : readLegacyConfig().token
          ? "~/.llama-command/config.json (legacy)"
          : null;

    const oauthBundle = await readBundle();
    const oauthBackend = oauthBundle ? await detectBackend() : null;

    let serverCheck = "skipped (no credentials)";
    if (oauthBundle?.access_token || bearer || token) {
      try {
        const me = await request("GET", "/api/me");
        serverCheck = `ok — authenticated as ${me?.email ?? "unknown"} (role: ${me?.role ?? "unknown"})`;
      } catch (e) {
        serverCheck = `failed — ${e.message.split("\n")[0]}`;
      }
    }

    const out = {
      baseUrl: getBaseUrl(),
      activeMethod: oauthBundle?.access_token
        ? "oauth"
        : bearer
          ? "gcloud-bearer"
          : token
            ? "llama-token"
            : "none",
      oauth: oauthBundle
        ? {
            storage: oauthBackend,
            client_id: oauthBundle.client_id,
            scope: oauthBundle.scope,
            issuer: oauthBundle.issuer,
            expires_in_seconds: Math.max(0, Math.round((oauthBundle.expires_at - Date.now()) / 1000)),
          }
        : "absent (run `llama auth login`)",
      gcloudIdentityToken: bearer ? "present" : "absent",
      llamaToken: token ? `${token.slice(0, 8)}...${token.slice(-4)}` : "absent",
      llamaTokenSource: tokenSrc,
      serverCheck,
    };
    print(out);
    return;
  }

  // ============================================================
  // auth login — PKCE + loopback browser flow
  // ============================================================
  if (area === "auth" && action === "login") {
    const { flags } = parseFlags(rest);
    const requestedScope = typeof flags.scope === "string" && flags.scope.trim()
      ? flags.scope.trim()
      : "read write";
    const baseUrl = getBaseUrl();
    const resource = baseUrl; // general API audience (oauthApiResource on the server)

    console.error(`Signing in to ${baseUrl} as Llama CLI (client_id=${LLAMA_CLI_CLIENT_ID})...`);
    const bundle = await pkceLoopbackFlow({ baseUrl, scope: requestedScope, resource });
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

    // Verify by hitting /api/me with the new token.
    let identity = "(unable to verify — /api/me did not respond)";
    try {
      const me = await request("GET", "/api/me");
      identity = `${me?.email ?? "unknown"} (role: ${me?.role ?? "unknown"})`;
    } catch (e) {
      identity = `verification failed: ${e.message.split("\n")[0]}`;
    }

    print({
      ok: true,
      message: "Signed in",
      identity,
      storage: stored.backend,
      scope: bundle.scope,
      expires_in_seconds: bundle.expires_in,
    });
    return;
  }

  // ============================================================
  // auth logout — revoke + clear local
  // ============================================================
  if (area === "auth" && action === "logout") {
    const bundle = await readBundle();
    if (!bundle) {
      print({ ok: true, message: "No OAuth credentials to clear" });
      return;
    }
    let revoked = false;
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
    print({
      ok: true,
      message: "Signed out — local credentials cleared",
      serverRevoke: revoked ? "succeeded" : "failed (server unreachable or token already invalid; local state cleared anyway)",
    });
    return;
  }

  if (area === "deal" && action === "create") {
    const { flags, positional } = parseFlags(rest);
    const companyName = positional.join(" ").trim();
    if (!companyName) throw new Error("Usage: llama deal create \"Company\" [--source Name]");
    const body = {
      companyName,
      source: flags.source,
      description: flags.description,
      website: flags.website,
      notes: flags.notes,
      status: flags.status,
      theirStage: flags["their-stage"],
      stage: flags.stage,
      proposedAmount: flags["proposed-amount"],
      roundSize: flags["round-size"],
      valuation: flags.valuation,
      founders: flags.founders,
      location: flags.location,
    };
    print(await request("POST", "/api/deals/create", body));
    return;
  }

  if (area === "deal" && action === "show") {
    const dealId = rest[0];
    if (!dealId) throw new Error("Usage: llama deal show <dealId>");
    print(await request("GET", `/api/deals/${encodeURIComponent(dealId)}/command-center`));
    return;
  }

  if (area === "deal" && action === "feed") {
    const dealId = rest[0];
    if (!dealId) throw new Error("Usage: llama deal feed <dealId>");
    print(await request("GET", `/api/deals/${encodeURIComponent(dealId)}/feed`));
    return;
  }

  if (area === "deal" && action === "update") {
    const [dealId, field, ...valueParts] = rest;
    const value = valueParts.join(" ");
    if (!dealId || !field) throw new Error("Usage: llama deal update <dealId> <field> <value>");
    print(await request("POST", "/api/deals/update", { dealId, field, value }));
    return;
  }

  // ----- deals.extra JSONB patches (system-admin only, server-gated) -----
  // Same endpoint as `deal update`, but `extraKey` instead of `field`.
  // Server patches one top-level key via jsonb_set and audits the change
  // to deal_events as field_change with field "extra.<key>". value=null
  // deletes the key.
  if (area === "deal" && action === "extra") {
    const sub = rest[0];
    const dealId = rest[1];
    const key = rest[2];
    if (sub === "set") {
      const raw = rest.slice(3).join(" ");
      if (!dealId || !key || !raw) {
        throw new Error(
          "Usage: llama deal extra set <dealId> <key> <value>  (value parsed as JSON when possible, else stored as string)"
        );
      }
      let value;
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
      print(await request("POST", "/api/deals/update", { dealId, extraKey: key, value }));
      return;
    }
    if (sub === "unset") {
      if (!dealId || !key) throw new Error("Usage: llama deal extra unset <dealId> <key>");
      print(await request("POST", "/api/deals/update", { dealId, extraKey: key, value: null }));
      return;
    }
    throw new Error("Usage: llama deal extra set|unset <dealId> <key> [value]");
  }

  if (area === "deal" && action === "search") {
    const { flags, positional } = parseFlags(rest);
    const q = positional.join(" ").trim();
    if (!q && Object.keys(flags).length === 0) {
      throw new Error(
        `Usage: llama deal search <query> [--founder ...] [--owner ...] [--status ...] [--stage ...] [--limit N]`
      );
    }
    print(await searchDeals(q, flags));
    return;
  }

  if (area === "deal" && action === "list") {
    const { flags } = parseFlags(rest);
    print(await searchDeals("", flags));
    return;
  }

  // ----- Deal enrichment: evidence plan + server-side enrichment trigger -----
  // The server owns Monid credentials and all write/audit behavior. CLI only
  // passes intent; default is dry-run so agents can inspect the harness before
  // creating facts/links or touching memo state.
  if (area === "deal" && action === "enrich") {
    const dealId = rest[0];
    if (!dealId) {
      throw new Error(
        "Usage: llama deal enrich <dealId> [--dry-run] [--apply] " +
        "[--executor server_agent|external_agent|planner] " +
        "[--sources website,github,linkedin,yc,monid] [--budget-cents 50] [--memo] [--prompt]"
      );
    }
    const { flags } = parseFlags(rest.slice(1), [
      "dry-run",
      "apply",
      "executor",
      "sources",
      "budget-cents",
      "memo",
      "generate-memo",
      "prompt",
      "handoff",
    ]);
    const sources =
      flags.sources && flags.sources !== true
        ? String(flags.sources)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
    const budgetCents =
      flags["budget-cents"] !== undefined && flags["budget-cents"] !== true
        ? Number(flags["budget-cents"])
        : undefined;

    const result = await request(
      "POST",
      `/api/deals/${encodeURIComponent(dealId)}/enrich`,
      {
        dryRun: flags.apply === true ? false : true,
        apply: flags.apply === true,
        executor: flags.executor && flags.executor !== true ? String(flags.executor) : undefined,
        sources,
        budgetCents,
        generateMemo: flags.memo === true || flags["generate-memo"] === true,
      }
    );
    if (flags.prompt === true || flags.handoff === true) {
      print(result?.agentHarness?.handoffPrompt || result?.agentHarness?.systemInjection || "");
    } else {
      print(result);
    }
    return;
  }

  // ----- Collaborators (deal team — non-owner contributors) -----
  // Accepts --user as numeric id OR @llamaventures.vc email; emails are
  // resolved to id via /api/users so the CLI matches how the web picker
  // works (you don't need to memorize ids).
  if (area === "deal" && action === "collab") {
    const sub = rest[0];
    const dealId = rest[1];
    const { flags } = parseFlags(rest.slice(2));

    if (!sub || !dealId) {
      throw new Error(
        "Usage: llama deal collab list|add|remove <dealId> [--user <userId|email>]"
      );
    }

    if (sub === "list") {
      print(await request("GET", `/api/deals/${encodeURIComponent(dealId)}/collaborators`));
      return;
    }

    if (sub !== "add" && sub !== "remove" && sub !== "restore") {
      throw new Error(`Unknown collab sub-command "${sub}". Use list, add, remove, or restore.`);
    }

    if (!flags.user) {
      throw new Error(`Usage: llama deal collab ${sub} <dealId> --user <userId|email>`);
    }

    let userId = Number(flags.user);
    if (!Number.isFinite(userId)) {
      const email = String(flags.user).toLowerCase();
      const usersPayload = await request("GET", "/api/users");
      const list = Array.isArray(usersPayload) ? usersPayload : usersPayload.users ?? [];
      const match = list.find((u) => String(u.email).toLowerCase() === email);
      if (!match) throw new Error(`No active user with email "${flags.user}"`);
      userId = match.id;
    }

    if (sub === "add") {
      print(await request(
        "POST",
        `/api/deals/${encodeURIComponent(dealId)}/collaborators`,
        { userId }
      ));
    } else if (sub === "remove") {
      print(await request(
        "DELETE",
        `/api/deals/${encodeURIComponent(dealId)}/collaborators/${userId}`
      ));
    } else {
      print(await request(
        "POST",
        `/api/deals/${encodeURIComponent(dealId)}/collaborators/${userId}/restore`
      ));
    }
    return;
  }

  // ----- Deal links (URLs attached to a deal — separate from brief link blocks) -----
  // Soft-delete: removal sets deleted_at, restore clears it. List excludes
  // trashed by default; pass --include-deleted to see them.
  if (area === "deal" && action === "link") {
    const sub = rest[0];
    const dealId = rest[1];
    if (!sub || !dealId) {
      throw new Error(
        "Usage: llama deal link list|add|delete|restore <dealId> [...flags|<linkId>]"
      );
    }

    if (sub === "list") {
      const { flags } = parseFlags(rest.slice(2));
      const qs = flags["include-deleted"] ? "?include_deleted=1" : "";
      print(await request("GET", `/api/deals/${encodeURIComponent(dealId)}/links${qs}`));
      return;
    }

    if (sub === "add") {
      const { flags } = parseFlags(rest.slice(2));
      if (!flags.url) throw new Error("Usage: llama deal link add <dealId> --url <url> [--label \"...\"]");
      print(await request(
        "POST",
        `/api/deals/${encodeURIComponent(dealId)}/links`,
        { url: String(flags.url), label: flags.label ? String(flags.label) : "" }
      ));
      return;
    }

    if (sub === "delete" || sub === "restore") {
      const linkId = rest[2];
      if (!linkId) throw new Error(`Usage: llama deal link ${sub} <dealId> <linkId>`);
      const path = `/api/deals/${encodeURIComponent(dealId)}/links/${encodeURIComponent(linkId)}`;
      print(await request(
        sub === "delete" ? "DELETE" : "POST",
        sub === "delete" ? path : `${path}/restore`
      ));
      return;
    }

    throw new Error(`Unknown link sub-command "${sub}". Use list, add, delete, or restore.`);
  }

  // ----- Deal soft-delete / restore / trash list -----
  // Server side: DELETE /api/deals/:id uses authenticate() (token works).
  // POST /restore currently uses session-only auth() — known asymmetry,
  // pending server fix to swap to authenticate() for parity.
  if (area === "deal" && action === "delete") {
    const dealId = rest[0];
    if (!dealId) throw new Error("Usage: llama deal delete <dealId>");
    print(await request("DELETE", `/api/deals/${encodeURIComponent(dealId)}`));
    return;
  }

  if (area === "deal" && action === "restore") {
    const dealId = rest[0];
    if (!dealId) throw new Error("Usage: llama deal restore <dealId>");
    // NOTE: server uses session-only auth() today — token callers get 401
    // until server is updated. CLI surface is forward-compatible.
    print(await request("POST", `/api/deals/${encodeURIComponent(dealId)}/restore`));
    return;
  }

  if (area === "deal" && action === "trash") {
    print(await request("GET", "/api/deals/deleted"));
    return;
  }

  // ----- Deal facts (AI-extracted or human-asserted, with verification) -----
  // NOTE: server routes currently use session-only auth() — token-only
  // callers will get 401 until /api/deals/:id/facts and
  // /api/deals/:id/facts/:factId switch to authenticate(). CLI surface
  // is forward-compatible.
  if (area === "deal" && action === "fact") {
    const sub = rest[0];
    const dealId = rest[1];
    const { flags } = parseFlags(rest.slice(2));

    if (!sub || !dealId) {
      throw new Error("Usage: llama deal fact list|add|verify <dealId> [...]");
    }

    if (sub === "list") {
      print(await request("GET", `/api/deals/${encodeURIComponent(dealId)}/facts`));
      return;
    }

    if (sub === "add") {
      if (!flags.category || !flags.claim) {
        throw new Error(
          `Usage: llama deal fact add <dealId> --category <cat> --claim "<text>" ` +
          `[--source <url>] [--confidence high|medium|low] [--attested]`
        );
      }
      // --attested: the caller takes responsibility that this is accurate
      // (verified against the source). With it, the fact is recorded as
      // vouched; without it, it stays unverified. Declare honestly.
      print(await request("POST", `/api/deals/${encodeURIComponent(dealId)}/facts`, {
        category: String(flags.category),
        claim: String(flags.claim),
        source: flags.source ? String(flags.source) : "",
        confidence: flags.confidence ? String(flags.confidence) : "medium",
        attested: flags.attested === true,
      }));
      return;
    }

    if (sub === "verify") {
      const factId = rest[2];
      if (!factId) {
        throw new Error(
          `Usage: llama deal fact verify <dealId> <factId> ` +
          `--status confirmed|disputed [--corrected-value "..."]`
        );
      }
      if (!flags.status || !["confirmed", "disputed"].includes(String(flags.status))) {
        throw new Error("--status must be 'confirmed' or 'disputed'");
      }
      const body = { status: String(flags.status) };
      if (flags["corrected-value"] !== undefined && flags["corrected-value"] !== true) {
        body.correctedValue = String(flags["corrected-value"]);
      }
      print(await request(
        "PATCH",
        `/api/deals/${encodeURIComponent(dealId)}/facts/${encodeURIComponent(factId)}`,
        body
      ));
      return;
    }

    throw new Error(`Unknown fact sub-command "${sub}". Use list, add, or verify.`);
  }

  // ----- Brief refresh: trigger stale-section re-eval watcher run -----
  // Server only fires for unlocked sections that are stale per the
  // freshness policy; --force runs every unlocked watcher-managed section.
  if (area === "deal" && action === "refresh-brief") {
    const { flags } = parseFlags(rest);
    const dealId = rest[0];
    if (!dealId) throw new Error("Usage: llama deal refresh-brief <dealId> [--force]");
    const qs = flags.force ? "?force=true" : "";
    print(await request("POST", `/api/deals/${encodeURIComponent(dealId)}/refresh-brief${qs}`));
    return;
  }

  // ----- Persona refresh: re-run a single persona-watcher -----
  // Persona keys are validated server-side. Returns runId or null
  // (debounced / deal inactive). Used by /admin and the per-block
  // "重新生成" flow.
  if (area === "deal" && action === "refresh-persona") {
    const dealId = rest[0];
    const persona = rest[1];
    if (!dealId || !persona) {
      throw new Error(`Usage: llama deal refresh-persona <dealId> <persona-key>`);
    }
    print(await request(
      "POST",
      `/api/deals/${encodeURIComponent(dealId)}/refresh-persona`,
      { persona }
    ));
    return;
  }

  // ----- Agent-run revert (legacy 4-section brief model) -----
  // Reverts a single section to the `before` value snapshotted by the
  // watcher run. Does NOT re-fire the watcher (intentional: human action).
  // Logs `brief_reverted` in deal_events. Section keys are the legacy
  // top-level sections, not block ids.
  if (area === "deal" && action === "revert-run") {
    const { flags } = parseFlags(rest);
    const dealId = rest[0];
    const runId = rest[1];
    const valid = ["company", "team", "highlights", "recommendation"];
    if (!dealId || !runId || !flags.section) {
      throw new Error(
        `Usage: llama deal revert-run <dealId> <runId> --section ${valid.join("|")}`
      );
    }
    if (!valid.includes(String(flags.section))) {
      throw new Error(`--section must be one of ${valid.join(", ")}`);
    }
    print(await request(
      "POST",
      `/api/deals/${encodeURIComponent(dealId)}/agent-runs/${encodeURIComponent(runId)}/revert`,
      { section: String(flags.section) }
    ));
    return;
  }

  if (area === "approvals" && action === "list") {
    print(await request("GET", "/api/partner/approvals"));
    return;
  }

  if (area === "approvals" && action === "decide") {
    const { flags, positional } = parseFlags(rest);
    const approvalId = Number(positional[0]);
    const decision = positional[1];
    if (!Number.isFinite(approvalId) || !["approved", "rejected"].includes(decision)) {
      throw new Error("Usage: llama approvals decide <approvalId> approved|rejected [--note ...]");
    }
    print(await request("POST", "/api/partner/approvals", {
      approvalId,
      decision,
      note: flags.note || "",
    }));
    return;
  }

  // ----- Ownership: self-claim -----
  if (area === "claim") {
    const dealId = action; // second positional
    if (!dealId) throw new Error("Usage: llama claim <dealId>");
    const me = await request("GET", "/api/me");
    print(await request(
      "POST",
      `/api/deals/${encodeURIComponent(dealId)}/propose-owner`,
      { userId: me.id }
    ));
    return;
  }

  // ----- Ownership: partner nominates someone else -----
  if (area === "nominate") {
    const dealId = action;
    const { flags } = parseFlags(rest);
    const userId = Number(flags.user);
    if (!dealId || !Number.isFinite(userId)) {
      throw new Error("Usage: llama nominate <dealId> --user <userId>");
    }
    print(await request(
      "POST",
      `/api/deals/${encodeURIComponent(dealId)}/propose-owner`,
      { userId }
    ));
    return;
  }

  // ----- Nominations inbox (for the nominee) -----
  if (area === "nominations" && action === "list") {
    print(await request("GET", "/api/me/nominations"));
    return;
  }
  if (area === "nominations" && action === "decide") {
    const approvalId = Number(rest[0]);
    const decision = rest[1];
    if (!Number.isFinite(approvalId) || !["accepted", "declined"].includes(decision)) {
      throw new Error("Usage: llama nominations decide <approvalId> accepted|declined");
    }
    print(await request("POST", `/api/nominations/${approvalId}`, { decision }));
    return;
  }

  // ----- Timeline -----
  if (area === "timeline") {
    const dealId = action;
    if (!dealId) throw new Error("Usage: llama timeline <dealId>");
    print(await request("GET", `/api/deals/${encodeURIComponent(dealId)}/timeline`));
    return;
  }

  // ----- Post to timeline -----
  if (area === "post") {
    const dealId = action;
    const { flags, positional } = parseFlags(rest);
    const body = positional[0];
    if (!dealId || !body) {
      throw new Error(`Usage: llama post <dealId> "message body" [--link url] [--link-name "name"]`);
    }
    const attachments = flags.link
      ? [{ url: String(flags.link), name: flags["link-name"] ? String(flags["link-name"]) : String(flags.link) }]
      : [];
    print(await request(
      "POST",
      `/api/deals/${encodeURIComponent(dealId)}/posts`,
      { body, attachments }
    ));
    return;
  }

  // ----- Wiki: search -----
  if (area === "wiki" && action === "search") {
    const { positional } = parseFlags(rest);
    const q = positional.join(" ").trim();
    if (!q) throw new Error("Usage: llama wiki search <query>");
    print(await request("GET", `/api/wiki/search?q=${encodeURIComponent(q)}`));
    return;
  }

  // ----- Wiki: read a single article (EN by default) -----
  // Hits /api/wiki/<slug> directly. Earlier versions did a fuzzy
  // /api/wiki/search call and filtered for an exact slug match — that
  // missed any article whose slug-as-string didn't appear in title or
  // content (e.g. a slug like "foo-bar" against an article titled "Foo Bar"),
  // so a real article would print as "not found" even though it existed.
  if (area === "wiki" && action === "read") {
    const { flags, positional } = parseFlags(rest);
    const slug = positional[0];
    if (!slug) throw new Error("Usage: llama wiki read <slug> [--lang en|zh]");
    const lang = flags.lang === "zh" ? "zh" : "en";
    const path = `/api/wiki/${encodeURIComponent(slug)}?lang=${lang}`;
    print(await request("GET", path));
    return;
  }

  // ----- Wiki: save (create or update) -----
  // Two body modes:
  //   --content "..."  inline markdown OR raw HTML (string)
  //   --file <path>    read body from a file; if .html/.htm,
  //                    content_type auto-detects to 'html'
  // --content-type <markdown|html> overrides auto-detect.
  // Refuses content_type mismatch on existing entries (server-side check;
  // CLI surfaces the server error verbatim).
  if (area === "wiki" && action === "save") {
    const { flags, positional } = parseFlags(rest);
    const slug = positional[0];
    const title = flags.title;
    const inlineContent = flags.content;
    const filePath = flags.file;
    const sourcesRaw = flags.sources;
    if (!slug || !title || !sourcesRaw || (!inlineContent && !filePath)) {
      throw new Error(
        `Usage:
  llama wiki save <slug> --title "..." --content "..." --sources "url1;url2" [--type company] [--related "A;B"] [--lang en|zh] [--content-type markdown|html]
or
  llama wiki save <slug> --title "..." --file path/to/article.{md,html} --sources "url1;url2" [--type company] [--related "A;B"] [--lang en|zh] [--content-type markdown|html]

Pass either --content (inline) or --file (read from disk). With --file, content_type auto-detects from extension (.html/.htm → html, else markdown). Use --content-type to override.

Routing — is this the right command?
  ✓ Cross-deal / institutional knowledge (sector landscape, market map, thesis, framework, methodology)
      → YES, you're in the right place.
  ✗ Deal-specific HTML (IC memo for X, dashboard for X, 2×2 for one company)
      → use \`llama html upload <dealId> --new --title "..." --file <path>\` instead.
  ✗ Founder-facing public share link
      → escape to Netlify only when the user explicitly says "share publicly" / "give it to the founder";
        Llama Command outranks Netlify for everything internal.`
      );
    }
    if (inlineContent && filePath) {
      throw new Error("Pass either --content OR --file, not both.");
    }
    // Read body — either inline or from file.
    let body;
    let inferredType = "markdown";
    if (filePath) {
      const { readFileSync } = await import("fs");
      body = readFileSync(String(filePath), "utf-8");
      const lower = String(filePath).toLowerCase();
      if (lower.endsWith(".html") || lower.endsWith(".htm")) {
        inferredType = "html";
      }
    } else {
      body = String(inlineContent);
    }
    // Determine content_type: explicit flag wins over file-extension inference.
    let contentType = inferredType;
    if (flags["content-type"]) {
      const v = String(flags["content-type"]).toLowerCase();
      if (v !== "markdown" && v !== "html") {
        throw new Error(`--content-type must be 'markdown' or 'html', got "${v}"`);
      }
      contentType = v;
    }
    const splitCsv = (v) => String(v).split(/[;|]/).map((s) => s.trim()).filter(Boolean);
    const payload = {
      slug,
      title: String(title),
      content: body,
      sources: splitCsv(sourcesRaw),
      type: flags.type ? String(flags.type) : undefined,
      related: flags.related ? splitCsv(flags.related) : undefined,
      lang: flags.lang === "zh" ? "zh" : "en",
      status: flags.status ? String(flags.status) : undefined,
      content_type: contentType,
    };
    print(await request("POST", "/api/wiki/save", payload));
    return;
  }

  // ----- Wiki: delete (soft) / restore -----
  // Soft-delete (CONSTITUTION §8 reversible). For HTML entries the
  // sentinel deal_browse_html body + assets are soft-deleted too;
  // `llama wiki restore <slug>` brings it all back.
  if (area === "wiki" && (action === "delete" || action === "restore")) {
    const { flags, positional } = parseFlags(rest);
    const slug = positional[0];
    if (!slug) throw new Error(`Usage: llama wiki ${action} <slug> [--lang en|zh]`);
    const lang = flags.lang === "zh" ? "zh" : "en";
    const qs = `?lang=${lang}`;
    if (action === "delete") {
      print(await request("DELETE", `/api/wiki/${encodeURIComponent(slug)}${qs}`));
    } else {
      print(await request("POST", `/api/wiki/${encodeURIComponent(slug)}/restore${qs}`));
    }
    return;
  }

  // ----- Brief blocks: list / add-* / edit / delete -----
  // The block-based deal brief stores an ordered array of typed blocks
  // (text / link / embed / callout) per deal. These commands wrap the
  // /api/deals/:id/blocks{,/:id} endpoints. To add a block we read +
  // append + PUT (two roundtrips); single-block edit + delete have
  // dedicated PATCH/DELETE endpoints.
  if (area === "brief" && action === "blocks") {
    const dealId = rest[0];
    if (!dealId) throw new Error("Usage: llama brief blocks <dealId>");
    print(await request("GET", `/api/deals/${encodeURIComponent(dealId)}/blocks`));
    return;
  }

  // Per-block read — pairs with the manifest returned by /command-center
  // (i.e. `llama deal show`). Agent flow: read manifest → pick blocks
  // by id → fetch only those bodies, instead of pulling the full array.
  if (area === "brief" && action === "block") {
    const dealId = rest[0];
    const blockId = rest[1];
    if (!dealId || !blockId) throw new Error("Usage: llama brief block <dealId> <blockId>");
    print(await request(
      "GET",
      `/api/deals/${encodeURIComponent(dealId)}/blocks/${encodeURIComponent(blockId)}`
    ));
    return;
  }

  if (area === "brief" && action?.startsWith("add-")) {
    const type = action.slice(4); // "add-text" → "text"
    if (!["text", "link", "embed", "callout"].includes(type)) {
      throw new Error(`Unknown block type "${type}". Use add-text, add-link, add-embed, or add-callout.`);
    }
    const { flags } = parseFlags(rest);
    const dealId = rest[0];
    if (!dealId) throw new Error(`Usage: llama brief add-${type} <dealId> [...flags]`);

    const id = (typeof crypto !== "undefined" && "randomUUID" in crypto)
      ? crypto.randomUUID()
      : `b_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const meta = { updated_at: new Date().toISOString(), updated_by: "cli", by_agent: false };

    // --source-section <key>: target a structured section (e.g. team /
    // highlights / <persona>_analysis). Without this, blocks land in the
    // "_other" group at the bottom of the TOC. AI writers want this
    // virtually always — without it they cannot contribute to existing
    // structured sections.
    if (flags["source-section"]) {
      meta.sourceSection = String(flags["source-section"]);
    }

    // --reply-to <blockId>: snapshot the parent block's heading + a
    // 200-char excerpt into meta so the back-link survives parent edits
    // or deletion. CLI only — replies are always text in the UI; allow
    // any add-* type here for symmetry but the UI only renders the
    // back-link on text + callout blocks today.
    let cur = null;
    if (flags["reply-to"]) {
      const replyTo = String(flags["reply-to"]);
      cur = await request("GET", `/api/deals/${encodeURIComponent(dealId)}/blocks`);
      const parent = (cur.blocks ?? []).find((b) => b.id === replyTo);
      if (!parent) throw new Error(`--reply-to: block ${replyTo} not found on deal ${dealId}`);
      meta.reply_to = parent.id;
      // heading: text/callout → heading; link/embed → label; fallback "(untitled block)"
      meta.reply_to_heading =
        parent.heading || parent.label || "(untitled block)";
      // excerpt: text/callout → heading + body; link → label + description; embed → label
      const excerptParts =
        parent.type === "text" || parent.type === "callout"
          ? [parent.heading, parent.body]
          : parent.type === "link"
            ? [parent.label, parent.description]
            : [parent.label];
      const excerpt = excerptParts.filter(Boolean).join("\n\n").slice(0, 200);
      meta.reply_to_excerpt = excerpt;
    }

    let block;
    if (type === "text") {
      block = { id, type, heading: flags.heading ? String(flags.heading) : "", body: flags.body ? String(flags.body) : "", meta };
    } else if (type === "link") {
      if (!flags.url || !flags.label) throw new Error("add-link requires --url and --label");
      block = { id, type, url: String(flags.url), label: String(flags.label), description: flags.description ? String(flags.description) : undefined, meta };
    } else if (type === "embed") {
      if (!flags.url) throw new Error("add-embed requires --url");
      block = { id, type, url: String(flags.url), label: flags.label ? String(flags.label) : undefined, meta };
    } else {
      block = { id, type, tone: flags.tone ? String(flags.tone) : "insight", heading: flags.heading ? String(flags.heading) : "", body: flags.body ? String(flags.body) : "", meta };
    }

    // --position top|bottom (default: top). Top matches the UI behavior
    // changed 2026-05-03 — newly added blocks land at the top of the
    // brief so the writer (or reader) sees the contribution without
    // scrolling. Pass `--position bottom` to append, e.g. for batched
    // AI writes that should preserve insertion order.
    const position = flags.position ? String(flags.position) : "top";
    if (position !== "top" && position !== "bottom") {
      throw new Error(`--position must be "top" or "bottom" (got "${position}")`);
    }

    if (!cur) cur = await request("GET", `/api/deals/${encodeURIComponent(dealId)}/blocks`);
    const existing = cur.blocks ?? [];
    const next = position === "top" ? [block, ...existing] : [...existing, block];
    print(await request("PUT", `/api/deals/${encodeURIComponent(dealId)}/blocks`, { blocks: next }));
    console.log(`Created block ${id}`);
    return;
  }

  if (area === "brief" && action === "edit") {
    const { flags } = parseFlags(rest);
    const dealId = rest[0];
    const blockId = rest[1];
    if (!dealId || !blockId) {
      throw new Error("Usage: llama brief edit <dealId> <blockId> [--heading ...] [--body ...] [--url ...] [--label ...] [--description ...] [--tone ...] [--source-section ...] [--lock|--unlock] [--hide|--unhide]");
    }
    const patch = {};
    for (const k of ["heading", "body", "url", "label", "description", "tone"]) {
      if (flags[k] !== undefined && flags[k] !== true) patch[k] = String(flags[k]);
    }

    // Meta toggles. The PATCH endpoint accepts a meta object that gets
    // merged with the existing block.meta server-side, so we only need
    // to send the keys we want to change. lock/hide flags are pure
    // toggles (no value); source-section takes a key.
    const metaPatch = {};
    if (flags.lock === true) metaPatch.locked = true;
    if (flags.unlock === true) metaPatch.locked = false;
    if (flags.hide === true) metaPatch.hidden = true;
    if (flags.unhide === true) metaPatch.hidden = false;
    if (flags["source-section"] !== undefined && flags["source-section"] !== true) {
      metaPatch.sourceSection = String(flags["source-section"]);
    }
    if (Object.keys(metaPatch).length > 0) patch.meta = metaPatch;

    if (Object.keys(patch).length === 0) throw new Error("at least one field flag required");
    print(await request("PATCH", `/api/deals/${encodeURIComponent(dealId)}/blocks/${encodeURIComponent(blockId)}`, patch));
    return;
  }

  if (area === "brief" && action === "delete") {
    const dealId = rest[0];
    const blockId = rest[1];
    if (!dealId || !blockId) throw new Error("Usage: llama brief delete <dealId> <blockId>");
    print(await request("DELETE", `/api/deals/${encodeURIComponent(dealId)}/blocks/${encodeURIComponent(blockId)}`));
    return;
  }

  if (area === "brief" && action === "restore") {
    const dealId = rest[0];
    const blockId = rest[1];
    if (!dealId || !blockId) throw new Error("Usage: llama brief restore <dealId> <blockId>");
    print(await request(
      "POST",
      `/api/deals/${encodeURIComponent(dealId)}/blocks/${encodeURIComponent(blockId)}/restore`
    ));
    return;
  }

  // Per-block content history (Wikipedia model — every overwrite snapshots
  // the prev full block JSON). Two sub-actions: list versions, and restore
  // a specific version. Restore is itself reversible — when you restore
  // version N, the OUTGOING version (the one being replaced) gets snapshotted
  // into history, so undoing a wrong restore is one more `restore-version`
  // call away.
  if (area === "brief" && action === "history") {
    const { flags } = parseFlags(rest);
    const dealId = rest[0];
    const blockId = rest[1];
    if (!dealId || !blockId) {
      throw new Error("Usage: llama brief history <dealId> <blockId> [--limit 50]");
    }
    const params = new URLSearchParams();
    if (flags.limit) params.set("limit", String(flags.limit));
    const qs = params.toString() ? `?${params.toString()}` : "";
    print(await request(
      "GET",
      `/api/deals/${encodeURIComponent(dealId)}/blocks/${encodeURIComponent(blockId)}/history${qs}`
    ));
    return;
  }

  if (area === "brief" && action === "restore-version") {
    const dealId = rest[0];
    const blockId = rest[1];
    const historyId = rest[2];
    if (!dealId || !blockId || !historyId) {
      throw new Error("Usage: llama brief restore-version <dealId> <blockId> <historyId>\n" +
        "  Find <historyId> via `llama brief history <dealId> <blockId>`");
    }
    const idNum = Number(historyId);
    if (!Number.isFinite(idNum)) throw new Error(`<historyId> must be a number, got "${historyId}"`);
    print(await request(
      "POST",
      `/api/deals/${encodeURIComponent(dealId)}/blocks/${encodeURIComponent(blockId)}/history`,
      { history_id: idNum }
    ));
    return;
  }

  // ----- Admin (system admin only) -----
  // System-admin gated commands — server enforces via isSystemAdmin()
  // checking LLAMA_COMMAND_ADMIN_EMAILS env. Non-admin tokens get 403.
  // CLI doesn't pre-check; if you can't run these, ask the system admin
  // to mint you an admin token (rare — most ops should never need this surface).
  //
  // The three event feeds map 1:1 to the /admin web console tabs:
  //   - auth-events  : signin / token / impersonation audit (security)
  //   - deal-events  : every field/owner/brief change cross-deal (business)
  //   - agent-events : every AI tool call / loop_stalled / max_turns (AI ops)
  if (area === "admin") {
    const sub = action;
    const valid = ["auth-events", "deal-events", "agent-events"];
    if (!valid.includes(sub)) {
      throw new Error(
        `Unknown admin sub-command "${sub || ""}". Use: ${valid.join(", ")}`
      );
    }
    const { flags } = parseFlags(rest);
    const params = new URLSearchParams();
    // Common filters across all three.
    if (flags.kind) params.set("kind", String(flags.kind));
    if (flags.actor) params.set("actor", String(flags.actor));
    if (flags.subject) params.set("subject", String(flags.subject));
    if (flags.since) params.set("since", String(flags.since));
    if (flags.limit) params.set("limit", String(flags.limit));
    if (flags.offset) params.set("offset", String(flags.offset));
    // Per-feed extras.
    if (sub === "deal-events" && flags.deal) params.set("deal", String(flags.deal));
    if (sub === "agent-events") {
      if (flags["agent-kind"]) params.set("agent_kind", String(flags["agent-kind"]));
      if (flags.tool) params.set("tool", String(flags.tool));
      if (flags.deal) params.set("deal", String(flags.deal));
      if (flags["errors-only"]) params.set("errors_only", "1");
    }
    const qs = params.toString() ? `?${params.toString()}` : "";
    print(await request("GET", `/api/admin/${sub}${qs}`));
    return;
  }

  // ----- Mentions / Inbox -----
  // Server stores @-cues parsed out of brief blocks and posts in the
  // `deal_mentions` table. UNIQUE per (source_kind, source_id, user)
  // means re-saving a block that already cued someone won't re-fire
  // the email; resolution is mutual-observability (anyone can mark a
  // thread resolved, we record who).
  //
  // The CLI has no direct create — to "mention someone", write
  // `@FirstName` (or `@email@llamaventures.vc`) inside a brief block
  // body or a deal post. Hooks server-side do the rest.
  if (area === "mentions") {
    const sub = action || "list";
    if (sub === "list" || sub === undefined) {
      const { flags } = parseFlags(rest);
      const params = new URLSearchParams();
      if (flags.everyone) params.set("everyone", "1");
      else params.set("for_me", "1");
      if (!flags.all) params.set("unresolved", "1");
      print(await request("GET", `/api/mentions?${params.toString()}`));
      return;
    }
    if (sub === "show") {
      const id = rest[0];
      if (!id) throw new Error("Usage: llama mentions show <mentionId>");
      // No dedicated single-row endpoint — fetch all and filter. Cheap
      // (mentions table is small) and avoids a roundtrip endpoint.
      const data = await request("GET", "/api/mentions?everyone=1");
      const row = (data.mentions ?? []).find((m) => String(m.id) === String(id));
      if (!row) throw new Error(`mention ${id} not found`);
      print(row);
      return;
    }
    if (sub === "resolve") {
      const id = rest[0];
      if (!id) throw new Error("Usage: llama mentions resolve <mentionId>");
      print(await request("POST", `/api/mentions/${encodeURIComponent(id)}/resolve`));
      return;
    }
    if (sub === "unread") {
      print(await request("GET", "/api/mentions/unread-count"));
      return;
    }
    throw new Error(`Unknown mentions subcommand "${sub}". Use: list / show / resolve / unread.`);
  }

  // ----- Skill corrections (persona-owner pushback workflow) -----
  // Persona owners (or system admins) record long-term rules each
  // persona-DD skill must obey. Read by the persona-watcher and prepended
  // to the system prompt at run time. Soft-delete is non-cascading —
  // deleting a row does NOT auto-fire watcher; the next natural run
  // (manual / stale_re_eval) just stops including the deleted rule.
  //
  // Permissions enforced server-side: only the persona owner (per
  // PERSONA_SKILLS in src/lib/persona-skills.ts) or a system admin can
  // POST or DELETE. Anyone can GET. External personas (owner_email=null)
  // are admin-only for write.
  if (area === "skill-correction") {
    const sub = action;

    if (sub === "list") {
      const skillSlug = rest[0];
      if (!skillSlug) {
        throw new Error("Usage: llama skill-correction list <skill-slug> [--include-deleted]");
      }
      const { flags } = parseFlags(rest.slice(1));
      const params = new URLSearchParams({ skill: skillSlug });
      if (flags["include-deleted"]) params.set("include_deleted", "1");
      print(await request("GET", `/api/skill-corrections?${params.toString()}`));
      return;
    }

    if (sub === "add") {
      const { flags, positional } = parseFlags(rest);
      const skillSlug = positional[0];
      const correctionText = positional.slice(1).join(" ").trim();
      if (!skillSlug || !correctionText) {
        throw new Error(
          `Usage: llama skill-correction add <skill-slug> "<correction text>" ` +
          `[--deal <uuid>] [--block <blockId>]`
        );
      }
      print(await request("POST", "/api/skill-corrections", {
        skill_slug: skillSlug,
        correction_text: correctionText,
        triggered_in_deal_uuid: flags.deal ? String(flags.deal) : null,
        triggered_in_block_id: flags.block ? String(flags.block) : null,
      }));
      return;
    }

    if (sub === "delete") {
      const id = rest[0];
      if (!id) throw new Error("Usage: llama skill-correction delete <id>");
      print(await request("DELETE", `/api/skill-corrections/${encodeURIComponent(id)}`));
      return;
    }

    throw new Error(
      `Unknown skill-correction subcommand "${sub || ""}". Use: list / add / delete.`
    );
  }

  // ----- Memo (long-form HTML investment memo) -----
  // The Memo tab in the deal page renders HTML stored in deal_memos.
  // Two sources of memo content:
  //   - composed: generated by the server-side memo composer on demand
  //   - manual:   a hand-written HTML you paste in
  // Manual always beats composed on read; reset to drop the manual row
  // and fall back to the composed one.
  if (area === "memo") {
    const sub = action;

    // show — fetch the current memo. Default: print HTML to stdout
    // (pipeable to file or browser). --out writes to a path. --json
    // returns the full envelope (memo + mode + inflight info).
    if (sub === "show") {
      const dealId = rest[0];
      if (!dealId) {
        throw new Error("Usage: llama memo show <dealId> [--out <path>] [--json]");
      }
      const { flags } = parseFlags(rest.slice(1));
      const data = await request(
        "GET",
        `/api/deals/${encodeURIComponent(dealId)}/memo`
      );
      if (flags.json) {
        print(data);
        return;
      }
      const html = data?.memo?.html;
      if (!html) {
        if (data?.requires_compose) {
          throw new Error(
            "No memo for this deal yet — run `llama memo regenerate <dealId>` to compose one."
          );
        }
        throw new Error("Memo response missing html field.");
      }
      if (flags.out) {
        const { writeFileSync } = await import("fs");
        writeFileSync(String(flags.out), html);
        console.error(`Wrote ${html.length} bytes → ${flags.out}`);
        return;
      }
      // Stdout — supports `llama memo show <id> > memo.html` and piping
      // to e.g. `open -f -a Safari` for quick preview.
      process.stdout.write(html);
      return;
    }

    // regenerate — kick off the server-side composer. Streams panel
    // progress events to stderr so you can see live status; prints
    // final summary JSON (version, model, duration) to stdout.
    if (sub === "regenerate") {
      const dealId = rest[0];
      if (!dealId) {
        throw new Error(
          'Usage: llama memo regenerate <dealId> [--opus] [--instructions "..."]'
        );
      }
      const { flags } = parseFlags(rest.slice(1));
      const tier = flags.opus ? "opus" : "sonnet";
      const authHeaders = await getAuthHeaders();
      if (Object.keys(authHeaders).length === 0) {
        throw new Error(
          "Not authenticated. Run `gcloud auth login` or `llama token set <llc_...>` first."
        );
      }
      const res = await fetch(
        `${getBaseUrl()}/api/deals/${encodeURIComponent(dealId)}/memo`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({
            action: "regenerate",
            stream: true,
            model: tier,
            instructions: flags.instructions
              ? String(flags.instructions)
              : undefined,
          }),
        }
      );
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let doneEvent = null;
      const startedAt = Date.now();
      const progress = { done: 0, total: 12, placeholders: 0, retries: 0 };

      while (true) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          let event;
          try {
            event = JSON.parse(dataLine.replace(/^data:\s?/, ""));
          } catch {
            continue;
          }
          const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
          const phase = event.phase || "?";
          if (phase === "panel_done") {
            progress.done = event.panels_completed ?? progress.done + 1;
            progress.total = event.panels_total ?? progress.total;
            if (event.status === "placeholder") progress.placeholders += 1;
            if (event.status === "retry-recovered") progress.retries += 1;
            const mark =
              event.status === "ok"
                ? "✓"
                : event.status === "retry-recovered"
                  ? "↻"
                  : "⚠";
            console.error(
              `${elapsed}s  ${mark} ${event.panel} [${progress.done}/${progress.total}]`
            );
          } else if (phase === "anchor_done") {
            console.error(
              `${elapsed}s  anchor → ${event.verdict_label || event.verdict}`
            );
          } else if (phase === "assembling") {
            console.error(`${elapsed}s  assembling…`);
          } else if (phase === "done") {
            doneEvent = event;
          } else if (phase === "error") {
            throw new Error(`Memo composer error: ${event.error}`);
          }
        }
      }

      if (!doneEvent) {
        throw new Error("Stream ended without 'done' event.");
      }
      print({
        ok: true,
        version: doneEvent.version,
        degraded: doneEvent.degraded,
        model: doneEvent.model,
        duration_ms: doneEvent.duration_ms,
        placeholders: progress.placeholders,
        retries: progress.retries,
      });
      return;
    }

    // save — upload hand-written HTML as a manual override.
    if (sub === "save") {
      const { flags } = parseFlags(rest);
      const dealId = rest[0];
      if (!dealId || !flags.file) {
        throw new Error("Usage: llama memo save <dealId> --file <path>");
      }
      const { readFileSync } = await import("fs");
      const html = readFileSync(String(flags.file), "utf-8");
      if (!html.trim()) throw new Error(`File ${flags.file} is empty.`);
      print(
        await request(
          "PUT",
          `/api/deals/${encodeURIComponent(dealId)}/memo`,
          { html }
        )
      );
      return;
    }

    // reset — default drops only the manual override (next read returns
    // the composed row, if any); --all drops every version for this deal.
    if (sub === "reset") {
      const dealId = rest[0];
      if (!dealId) {
        throw new Error("Usage: llama memo reset <dealId> [--all]");
      }
      const { flags } = parseFlags(rest.slice(1));
      print(
        await request(
          "DELETE",
          `/api/deals/${encodeURIComponent(dealId)}/memo`,
          { scope: flags.all ? "all" : "override_only" }
        )
      );
      return;
    }

    throw new Error(
      `Unknown memo subcommand "${sub || ""}". Use: show / regenerate / save / reset.`
    );
  }

  // ============================================================
  // `llama html` family — per-deal hand-authored HTML "deal page"
  // ============================================================
  //
  // Each deal can have its own HTML browse view (sandboxed iframe).
  // Upload via this CLI, or directly via the web UI's drag-drop / paste,
  // or by the in-app deal agent via the update_deal_browse_html tool.
  // Every upload creates a new monotonic version; old versions are
  // soft-deleted on replace and can be restored.
  //
  //   llama html show <dealId> [--out PATH] [--json]
  //   llama html upload <dealId> --file PATH [--source cli|web|agent]
  //   llama html versions <dealId>
  //   llama html restore <dealId> <version>
  //   llama html reset <dealId>
  if (area === "html") {
    const sub = action;

    // --doc <slug> selects which named document on the deal (default 'main').
    // Slugs match /^[a-z0-9][a-z0-9_-]{0,63}$/. Use `llama html docs <dealId>`
    // to list available slugs.
    function htmlEndpoint(dealId, slug) {
      return `/api/deals/${encodeURIComponent(dealId)}/documents/${encodeURIComponent(slug)}/html`;
    }

    // Surface a clean `linked_wiki` field on linked docs so the listing
    // reads as "this card points at wiki/<slug>" rather than exposing the
    // raw source_wiki_* columns. Non-linked docs are returned unchanged.
    function withLinkedWiki(data) {
      if (!data || !Array.isArray(data.documents)) return data;
      return {
        ...data,
        documents: data.documents.map((d) =>
          d && d.source_wiki_slug
            ? {
                ...d,
                linked_wiki: {
                  slug: d.source_wiki_slug,
                  lang: d.source_wiki_lang || "en",
                },
              }
            : d,
        ),
      };
    }

    // docs — list / create / archive documents on a deal.
    //
    // Forms:
    //   llama html docs <dealId>                      # list
    //   llama html docs list <dealId>                 # list (explicit)
    //   llama html docs create <dealId> <slug> [--title "..."]
    //   llama html docs archive <dealId> <slug>
    if (sub === "docs") {
      const docSub = rest[0];
      const isExplicitSubcommand =
        docSub === "list" ||
        docSub === "create" ||
        docSub === "archive";
      if (!isExplicitSubcommand) {
        // First positional is the dealId (the common "just list" case).
        const dealId = rest[0];
        if (!dealId) {
          throw new Error(
            "Usage: llama html docs <dealId>\n" +
              "       llama html docs create <dealId> <slug> --title \"...\"\n" +
              "       llama html docs archive <dealId> <slug>",
          );
        }
        const data = await request(
          "GET",
          `/api/deals/${encodeURIComponent(dealId)}/documents`,
        );
        print(withLinkedWiki(data));
        return;
      }
      if (docSub === "list") {
        const dealId = rest[1];
        if (!dealId) {
          throw new Error("Usage: llama html docs list <dealId>");
        }
        const data = await request(
          "GET",
          `/api/deals/${encodeURIComponent(dealId)}/documents`,
        );
        print(withLinkedWiki(data));
        return;
      }
      if (docSub === "create") {
        const dealId = rest[1];
        const slug = rest[2];
        if (!dealId || !slug) {
          throw new Error(
            "Usage: llama html docs create <dealId> <slug> [--title \"...\"]",
          );
        }
        const { flags } = parseFlags(rest.slice(3));
        const title = flags.title ? String(flags.title) : slug;
        const data = await request(
          "POST",
          `/api/deals/${encodeURIComponent(dealId)}/documents`,
          { slug, title },
        );
        print(data);
        return;
      }
      if (docSub === "archive") {
        const dealId = rest[1];
        const slug = rest[2];
        if (!dealId || !slug) {
          throw new Error("Usage: llama html docs archive <dealId> <slug>");
        }
        const data = await request(
          "DELETE",
          `/api/deals/${encodeURIComponent(dealId)}/documents/${encodeURIComponent(slug)}`,
        );
        print(data);
        return;
      }
      throw new Error(
        `Unknown html docs subcommand "${docSub}". Use: list / create / archive.`,
      );
    }

    // link — turn a deal doc card into a live, read-only pointer to a wiki
    // HTML article. "One file, multiple entrances": the wiki stays the
    // canonical home, the card just renders the wiki's HTML. Edits go to
    // the wiki source; uploads to a linked slug are refused server-side.
    //
    //   llama html link <dealId> --wiki <slug> [--lang en|zh] [--title "..."]
    //
    // Default deal-side slug = the wiki slug. Default title = the wiki
    // article's title (fetched from `llama wiki read`).
    if (sub === "link") {
      const dealId = rest[0];
      const { flags } = parseFlags(rest.slice(1), ["wiki", "lang", "title", "slug"]);
      const wikiSlug =
        typeof flags.wiki === "string" && flags.wiki.trim()
          ? flags.wiki.trim()
          : null;
      if (!dealId || !wikiSlug) {
        throw new Error(
          "Usage: llama html link <dealId> --wiki <slug> [--lang en|zh] [--title \"...\"]",
        );
      }
      const lang = flags.lang === "zh" ? "zh" : "en";
      // Deal-side slug defaults to the wiki slug; --slug overrides.
      const dealSlug =
        typeof flags.slug === "string" && flags.slug.trim()
          ? flags.slug.trim()
          : wikiSlug;
      // Title defaults to the wiki article's title.
      let title =
        typeof flags.title === "string" && flags.title.trim()
          ? flags.title.trim()
          : null;
      if (!title) {
        try {
          const article = await request(
            "GET",
            `/api/wiki/${encodeURIComponent(wikiSlug)}?lang=${lang}`,
          );
          title = article?.frontmatter?.title || wikiSlug;
        } catch {
          // Fall back to the slug as the title; the server still validates
          // that the wiki article exists + is HTML on the POST below.
          title = wikiSlug;
        }
      }
      const data = await request(
        "POST",
        `/api/deals/${encodeURIComponent(dealId)}/documents`,
        {
          slug: dealSlug,
          title,
          source_wiki_slug: wikiSlug,
          source_wiki_lang: lang,
        },
      );
      print(data);
      return;
    }

    // unlink — revert a linked card back to a normal self-hosted doc.
    //   llama html unlink <dealId> <slug>
    if (sub === "unlink") {
      const dealId = rest[0];
      const slug = rest[1];
      if (!dealId || !slug) {
        throw new Error("Usage: llama html unlink <dealId> <slug>");
      }
      const data = await request(
        "PATCH",
        `/api/deals/${encodeURIComponent(dealId)}/documents/${encodeURIComponent(slug)}`,
        { source_wiki_slug: null },
      );
      print(data);
      return;
    }

    // show — fetch the current HTML. Default: print to stdout (pipeable).
    if (sub === "show") {
      const dealId = rest[0];
      if (!dealId) {
        throw new Error("Usage: llama html show <dealId> [--doc SLUG] [--out PATH] [--json]");
      }
      const { flags } = parseFlags(rest.slice(1));
      const slug = typeof flags.doc === "string" && flags.doc.trim() ? flags.doc.trim() : "main";
      const data = await request("GET", htmlEndpoint(dealId, slug));
      if (flags.json) {
        print(data);
        return;
      }
      if (data?.empty) {
        throw new Error(
          `No HTML uploaded for deal ${dealId} yet. Upload via \`llama html upload\`, the web UI, or have the deal agent write it.`,
        );
      }
      const html = data?.html;
      if (typeof html !== "string") {
        throw new Error("browse-html response missing html field.");
      }
      if (flags.out) {
        const { writeFileSync } = await import("fs");
        writeFileSync(String(flags.out), html);
        console.error(
          `Wrote ${html.length} bytes (v${data.version}) → ${flags.out}`,
        );
        return;
      }
      // Stdout — supports `llama html show <id> > page.html` and piping
      // to e.g. `open -f -a Safari` for quick preview.
      process.stdout.write(html);
      return;
    }

    // upload — PUT a new version. Reads HTML from --file or stdin. With
    // --assets <dir>, walks the folder, packages as a multipart bundle,
    // and the server stores HTML + per-asset BYTEA rows atomically
    // (deal_browse_assets table). Perfect for "Save Page As Complete"
    // exports — the sibling `_files/` folder maps 1-to-1 to assets.
    if (sub === "upload") {
      const dealId = rest[0];
      if (!dealId) {
        throw new Error(
          "Usage:\n" +
            "  Update an existing artifact:\n" +
            "    llama html upload <dealId> --doc <slug> --file PATH [--assets DIR]\n" +
            "  Create a new artifact:\n" +
            "    llama html upload <dealId> --new --title \"...\" --file PATH [--doc <slug>]\n" +
            "  Stream from stdin (either form above with --stdin in place of --file PATH).\n" +
            "\n" +
            "Default (no --doc, no --new) targets slug 'main' but REFUSES if 'main'\n" +
            "already has content — pass --doc main to update it explicitly, or\n" +
            "--new --title \"...\" to add a NEW artifact alongside.\n" +
            "\n" +
            "Routing — is this the right command?\n" +
            "  ✓ DEAL-specific HTML (IC memo for X, dashboard for X, 2×2 for X)\n" +
            "      → YES, you're in the right place. Pass <dealId> + --new / --doc.\n" +
            "  ✗ Cross-deal / institutional knowledge (sector landscape, market map,\n" +
            "    thesis, framework, methodology, anything not tied to one company)\n" +
            "      → use `llama wiki save <slug> --title \"...\" --file <path>.html --sources \"...\"`\n" +
            "        instead (renders at /wiki/<slug>).\n" +
            "  ✗ Founder-facing public share link\n" +
            "      → escape to Netlify only when the user explicitly says \"share publicly\";\n" +
            "        Llama Command outranks Netlify for everything internal.",
        );
      }
      const knownFlags = [
        "doc", "slug", "new", "title",
        "file", "stdin", "assets", "source",
      ];
      const { flags } = parseFlags(rest.slice(1), knownFlags);

      // --slug is the natural agent guess (DB column is `document_slug`).
      // Accept it as an alias for --doc so the earlier failure mode
      // (silent fall-through to 'main') can't happen again.
      if (flags.slug && !flags.doc) {
        process.stderr.write("note: --slug accepted as alias for --doc.\n");
        flags.doc = flags.slug;
      } else if (flags.slug && flags.doc) {
        process.stderr.write("note: both --doc and --slug given; --doc wins.\n");
      }

      const isNew = Boolean(flags.new);
      const explicitDoc =
        typeof flags.doc === "string" && flags.doc.trim()
          ? flags.doc.trim()
          : null;
      const titleFlag =
        typeof flags.title === "string" && flags.title.trim()
          ? flags.title.trim()
          : null;

      // Pre-flight: ask the server what slugs already exist on this deal.
      // One extra GET round-trip — cheap insurance against silent overwrite.
      let existing = [];
      try {
        const docList = await request(
          "GET",
          `/api/deals/${encodeURIComponent(dealId)}/documents`,
        );
        existing = Array.isArray(docList?.documents) ? docList.documents : [];
      } catch (err) {
        // If the deal exists but the list endpoint somehow errors, we
        // shouldn't block the whole upload — surface the warning and
        // proceed in "no existing docs" mode. The server is still the
        // ultimate gate for permission failures.
        process.stderr.write(
          `warning: could not pre-check existing documents (${err.message}). Continuing.\n`,
        );
      }
      const findDoc = (s) =>
        existing.find((d) => d && d.slug === s) || null;
      const docHasHtml = (d) =>
        Boolean(d && (d.latest_version > 0 || d.latest_updated_at));

      let slug;
      let mode; // 'created' | 'updated'

      if (isNew) {
        // Create-new branch. Caller must provide --doc OR --title (we
        // derive the slug from the title in the latter case).
        let candidate = explicitDoc || (titleFlag ? slugifyTitle(titleFlag) : null);
        if (!candidate) {
          throw new Error(
            "--new requires --doc <slug> or --title \"...\" so the new artifact has a stable identifier.",
          );
        }
        if (!isValidDocSlug(candidate)) {
          throw new Error(
            `slug "${candidate}" must match /^[a-z0-9][a-z0-9_-]{0,63}$/`,
          );
        }
        if (findDoc(candidate)) {
          if (explicitDoc) {
            const existingDoc = findDoc(candidate);
            const meta = docHasHtml(existingDoc)
              ? ` (currently at v${existingDoc.latest_version}, last update ${existingDoc.latest_updated_at})`
              : "";
            throw new Error(
              `--new --doc ${candidate} but a document with slug "${candidate}" already exists${meta}.\n` +
                `Pick a different slug, or drop --new to UPDATE the existing one.`,
            );
          }
          // Auto-resolve title collisions: foo -> foo-2 -> foo-3 -> ...
          let suffix = 2;
          while (findDoc(`${candidate}-${suffix}`)) suffix++;
          const oldCandidate = candidate;
          candidate = `${candidate}-${suffix}`;
          process.stderr.write(
            `note: slug "${oldCandidate}" already in use; using "${candidate}" instead.\n`,
          );
        }
        slug = candidate;
        mode = "created";
        // Stamp the doc metadata first (title, etc.) so the UI selection
        // page shows a nice name. PUT auto-creates the row too, but
        // POST gives us a chance to set --title.
        await request(
          "POST",
          `/api/deals/${encodeURIComponent(dealId)}/documents`,
          { slug, title: titleFlag || slug },
        );
      } else if (explicitDoc) {
        // Update an existing slug.
        if (!isValidDocSlug(explicitDoc)) {
          throw new Error(
            `slug "${explicitDoc}" must match /^[a-z0-9][a-z0-9_-]{0,63}$/`,
          );
        }
        const target = findDoc(explicitDoc);
        if (!target) {
          if (explicitDoc === "main") {
            // 'main' is the legacy default — fine to auto-init on first
            // upload to an empty deal.
            slug = "main";
            mode = "created";
          } else {
            const slugList = existing.length
              ? existing.map((d) => d.slug).join(", ")
              : "(none)";
            throw new Error(
              `No document with slug "${explicitDoc}" exists on this deal.\n` +
                `To create it: add --new --title "..."\n` +
                `Or pre-create: llama html docs create ${dealId} ${explicitDoc} --title "..."\n` +
                `Existing slugs: ${slugList}`,
            );
          }
        } else {
          slug = explicitDoc;
          mode = docHasHtml(target) ? "updated" : "created";
        }
      } else {
        // Bare upload — no --doc, no --new. Safe-default to 'main' only
        // if 'main' is empty / absent. Otherwise refuse, naming the
        // existing artifact so the caller can pick an explicit intent.
        const main = findDoc("main");
        if (docHasHtml(main)) {
          const versionInfo = main.latest_version
            ? ` (v${main.latest_version}, ${main.latest_updated_at || "last update unknown"})`
            : "";
          const slugList = existing.length
            ? existing.map((d) => d.slug).join(", ")
            : "main";
          throw new Error(
            `Refusing to silently overwrite the existing 'main' artifact${versionInfo}.\n` +
              `\n` +
              `If you meant to UPDATE 'main':         --doc main\n` +
              `If you meant to add a NEW artifact:    --new --title "<name>"\n` +
              `\n` +
              `Existing slugs on this deal: ${slugList}\n` +
              `List details:                llama html docs ${dealId}`,
          );
        }
        slug = "main";
        mode = main ? "updated" : "created";
      }

      let html;
      if (flags.file) {
        const { readFileSync } = await import("fs");
        html = readFileSync(String(flags.file), "utf8");
      } else if (flags.stdin) {
        const chunks = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        html = Buffer.concat(chunks).toString("utf8");
      } else {
        throw new Error(
          "Pass --file <path> to upload a file, or --stdin to read from stdin.",
        );
      }
      if (!html || !html.trim()) {
        throw new Error("HTML body is empty.");
      }
      const source =
        typeof flags.source === "string" && flags.source.trim()
          ? flags.source.trim()
          : "cli";

      // No --assets → JSON path (small, faster).
      if (!flags.assets) {
        const data = await request("PUT", htmlEndpoint(dealId, slug), {
          html,
          source,
        });
        print({
          ok: true,
          mode,
          document_slug: slug,
          version: data?.version,
          bytes: data?.bytes ?? Buffer.byteLength(html, "utf8"),
          deal_uuid: dealId,
          viewer: `${getBaseUrl()}/deals/${encodeURIComponent(dealId)}/browse/${encodeURIComponent(slug)}`,
        });
        return;
      }

      // --assets path → multipart bundle. Walk the asset directory,
      // attach every file as `asset:<relativePath>`, and let the server
      // rewrite the HTML refs to /api/deals/<id>/asset/<path>?v=N.
      const { readFileSync, readdirSync, statSync } = await import("fs");
      const { join, relative, sep, basename } = await import("path");
      const assetsRoot = String(flags.assets);
      const assetsRootStat = statSync(assetsRoot);
      if (!assetsRootStat.isDirectory()) {
        throw new Error(`--assets must point to a directory: ${assetsRoot}`);
      }

      // Recursively collect every file under the assets root.
      const collected = []; // { absPath, relPath, bytes }
      const walk = (dir) => {
        for (const name of readdirSync(dir)) {
          const abs = join(dir, name);
          const st = statSync(abs);
          if (st.isDirectory()) {
            walk(abs);
          } else if (st.isFile()) {
            const rel = relative(assetsRoot, abs).split(sep).join("/");
            collected.push({ absPath: abs, relPath: rel, bytes: st.size });
          }
        }
      };
      walk(assetsRoot);
      if (collected.length === 0) {
        throw new Error(`--assets directory is empty: ${assetsRoot}`);
      }

      // Some "Save Page As" exports put assets in a sibling folder named
      // after the HTML (e.g. "Foo.html" + "Foo_files/"). When the HTML
      // references "./Foo_files/img.png" but we walk just the inner dir,
      // the rel paths don't match. Detect this case: if the assets root's
      // basename is "<something>_files" or "<something> files", the HTML
      // probably uses that prefix — prepend it to each relPath.
      const rootName = basename(assetsRoot);
      const looksLikeSavePageDir = /[_ ]files$/i.test(rootName);
      const finalPaths = looksLikeSavePageDir
        ? collected.map((c) => ({ ...c, relPath: `${rootName}/${c.relPath}` }))
        : collected;

      // Mime sniff from extension. Server defaults to
      // application/octet-stream if blob.type is empty.
      const mimeFor = (path) => {
        const ext = (path.split(".").pop() || "").toLowerCase();
        return (
          {
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
            png: "image/png",
            gif: "image/gif",
            webp: "image/webp",
            svg: "image/svg+xml",
            ico: "image/x-icon",
            avif: "image/avif",
            css: "text/css",
            js: "text/javascript",
            json: "application/json",
            woff: "font/woff",
            woff2: "font/woff2",
            ttf: "font/ttf",
            otf: "font/otf",
            mp4: "video/mp4",
            webm: "video/webm",
            pdf: "application/pdf",
          }[ext] || "application/octet-stream"
        );
      };

      const form = new FormData();
      form.append("html", html);
      form.append("source", source);
      let totalBytes = 0;
      for (const { absPath, relPath } of finalPaths) {
        const buf = readFileSync(absPath);
        totalBytes += buf.length;
        // FormData wants a Blob; in Node 20+ Blob is global and accepts Buffer.
        form.append(
          `asset:${relPath}`,
          new Blob([buf], { type: mimeFor(relPath) }),
          relPath,
        );
      }

      console.error(
        `Uploading bundle: html ${Buffer.byteLength(html, "utf8")} bytes + ${finalPaths.length} assets (${totalBytes} bytes)`,
      );

      const headers = await getAuthHeaders();
      const res = await fetch(`${getBaseUrl()}${htmlEndpoint(dealId, slug)}`, {
        method: "PUT",
        headers: { ...headers /* let fetch set the multipart boundary */ },
        body: form,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          `HTTP ${res.status}: ${body?.error || JSON.stringify(body).slice(0, 300)}`,
        );
      }
      print({
        ok: true,
        mode,
        document_slug: slug,
        version: body.version,
        asset_count: body.asset_count,
        asset_bytes: body.asset_bytes,
        deal_uuid: dealId,
        viewer: `${getBaseUrl()}/deals/${encodeURIComponent(dealId)}/browse/${encodeURIComponent(slug)}`,
      });
      return;
    }

    // versions — list version history (newest first, includes soft-deleted).
    if (sub === "versions") {
      const dealId = rest[0];
      if (!dealId) {
        throw new Error("Usage: llama html versions <dealId> [--doc SLUG]");
      }
      const { flags } = parseFlags(rest.slice(1));
      const slug =
        typeof flags.doc === "string" && flags.doc.trim()
          ? flags.doc.trim()
          : "main";
      const data = await request("GET", `${htmlEndpoint(dealId, slug)}/history`);
      print(data);
      return;
    }

    // restore — re-promote an old version as the new latest.
    if (sub === "restore") {
      const dealId = rest[0];
      const version = Number(rest[1]);
      if (!dealId || !Number.isFinite(version)) {
        throw new Error(
          "Usage: llama html restore <dealId> <version> [--doc SLUG]",
        );
      }
      const { flags } = parseFlags(rest.slice(2));
      const slug =
        typeof flags.doc === "string" && flags.doc.trim()
          ? flags.doc.trim()
          : "main";
      const data = await request(
        "POST",
        `${htmlEndpoint(dealId, slug)}/restore/${version}`,
      );
      print({
        ok: true,
        document_slug: slug,
        restored_from: version,
        new_version: data?.version,
        deal_uuid: dealId,
      });
      return;
    }

    // reset — soft-delete the current HTML. /browse page reverts to empty state.
    if (sub === "reset" || sub === "delete") {
      const dealId = rest[0];
      if (!dealId) {
        throw new Error("Usage: llama html reset <dealId> [--doc SLUG]");
      }
      const { flags } = parseFlags(rest.slice(1));
      const slug =
        typeof flags.doc === "string" && flags.doc.trim()
          ? flags.doc.trim()
          : "main";
      const data = await request("DELETE", htmlEndpoint(dealId, slug));
      print({
        ok: true,
        document_slug: slug,
        soft_deleted_version: data?.version ?? null,
        deal_uuid: dealId,
      });
      return;
    }

    throw new Error(
      `Unknown html subcommand "${sub || ""}". Use: docs / link / unlink / show / upload / versions / restore / reset.`,
    );
  }

  usage();
  process.exitCode = 1;
}

main()
  // Soft, throttled, TTY-gated update nudge. Runs AFTER the command's own
  // output and is awaited so the registry check completes before exit — but
  // it can never fail the command (all errors swallowed internally).
  .then(() => maybeNudgeUpdate())
  .catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  });
