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

function parseFlags(args) {
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
  return { flags, positional };
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

function usage() {
  console.log(`Llama Command CLI

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
  llama deal update <dealId> <field> <value>
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
  llama deal fact add <dealId> --category <cat> --claim "<text>" [--source <url>] [--confidence high|medium|low]
  llama deal fact verify <dealId> <factId> --status confirmed|disputed [--corrected-value "..."]

Skill corrections (persona-owner pushback — read by persona-watcher):
  llama skill-correction list <skill-slug> [--include-deleted]
  llama skill-correction add <skill-slug> "<correction text>" [--deal <uuid>] [--block <blockId>]
  llama skill-correction delete <id>
  Server enforces persona owner OR system admin on POST/DELETE; GET is open.
  External personas (owner_email=null, e.g. virtual-liu-yi) are admin-only for write.

Mentions / Inbox:
  llama mentions                                       # default: my unresolved cues
  llama mentions list [--everyone] [--all]             # --everyone = team-wide; --all = include resolved
  llama mentions show <mentionId>                      # full row
  llama mentions resolve <mentionId>                   # mark thread resolved (idempotent)
  llama mentions unread                                # just the badge count

Wiki:
  llama wiki search <query>
  llama wiki read <slug>
  llama wiki save <slug> --title "..." --content "..." --sources "url1;url2" [--type company] [--related "A;B"]

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
`);
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

Inspect / clean up:
  llama pitch status         # session id, idle minutes, finalized?
  llama pitch end            # clear local session state

Caps (server-enforced):
  5 sessions per IP per day, 3 per email per day, 30min idle timeout,
  100 messages per session, 1M tokens per session.
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
        ? "Local session state cleared. Server-side session may still be active until idle timeout (30min)."
        : "No local session was active.",
    });
    return;
  }

  // No action → REPL mode (requires existing session)
  if (action === undefined || (rest.length === 0 && !["start", "say", "upload", "status", "end"].includes(action))) {
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
  if (!area || area === "help" || area === "--help" || area === "-h") {
    usage();
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
        if (e instanceof Error && e.message.startsWith("Server rejected") || e.message.startsWith("Verify call failed")) {
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

    let serverCheck = "skipped (no credentials)";
    if (bearer || token) {
      try {
        const me = await request("GET", "/api/me");
        serverCheck = `ok — authenticated as ${me?.email ?? "unknown"} (role: ${me?.role ?? "unknown"})`;
      } catch (e) {
        serverCheck = `failed — ${e.message.split("\n")[0]}`;
      }
    }

    print({
      baseUrl: getBaseUrl(),
      gcloudIdentityToken: bearer ? "present" : "absent",
      llamaToken: token ? `${token.slice(0, 8)}...${token.slice(-4)}` : "absent",
      llamaTokenSource: tokenSrc,
      serverCheck,
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

  if (area === "deal" && action === "update") {
    const [dealId, field, ...valueParts] = rest;
    const value = valueParts.join(" ");
    if (!dealId || !field) throw new Error("Usage: llama deal update <dealId> <field> <value>");
    print(await request("POST", "/api/deals/update", { dealId, field, value }));
    return;
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
          `[--source <url>] [--confidence high|medium|low]`
        );
      }
      print(await request("POST", `/api/deals/${encodeURIComponent(dealId)}/facts`, {
        category: String(flags.category),
        claim: String(flags.claim),
        source: flags.source ? String(flags.source) : "",
        confidence: flags.confidence ? String(flags.confidence) : "medium",
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
  if (area === "wiki" && action === "read") {
    const slug = rest[0];
    if (!slug) throw new Error("Usage: llama wiki read <slug>");
    const results = await request("GET", `/api/wiki/search?q=${encodeURIComponent(slug)}`);
    const match = Array.isArray(results) ? results.find((r) => r.slug === slug) : null;
    print(match || { error: `Article "${slug}" not found.` });
    return;
  }

  // ----- Wiki: save (create or update) -----
  if (area === "wiki" && action === "save") {
    const { flags, positional } = parseFlags(rest);
    const slug = positional[0];
    const title = flags.title;
    const content = flags.content;
    const sourcesRaw = flags.sources;
    if (!slug || !title || !content || !sourcesRaw) {
      throw new Error(
        `Usage: llama wiki save <slug> --title "..." --content "..." --sources "url1;url2" [--type company] [--related "A;B"] [--lang en|zh]`
      );
    }
    const splitCsv = (v) => String(v).split(/[;|]/).map((s) => s.trim()).filter(Boolean);
    const payload = {
      slug,
      title: String(title),
      content: String(content),
      sources: splitCsv(sourcesRaw),
      type: flags.type ? String(flags.type) : undefined,
      related: flags.related ? splitCsv(flags.related) : undefined,
      lang: flags.lang === "zh" ? "zh" : "en",
      status: flags.status ? String(flags.status) : undefined,
    };
    print(await request("POST", "/api/wiki/save", payload));
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

  usage();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
