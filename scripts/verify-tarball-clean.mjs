#!/usr/bin/env node
// Publish-surface hygiene gate.
//
// Scans exactly the files `npm pack` would publish against a denylist of
// terms that must never appear in a public artifact. The denylist itself
// deliberately lives OUTSIDE this repository (a public denylist would defeat
// its purpose): provide it via the REDACTION_DENYLIST env var (comma- or
// newline-separated, case-insensitive) — in CI it comes from a repo secret —
// or via a local file at ~/.llama/redaction-denylist.txt for `verify:release`.
//
// On a hit the script reports the file and the term's INDEX in the list, never
// the term itself, so public CI logs stay clean. No denylist available (e.g.
// fork PRs, fresh clones) => warn and pass; the publish workflow always has
// the secret, so the gate is hard where it matters.
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function loadDenylist() {
  const fromEnv = process.env.REDACTION_DENYLIST;
  const fromFile = (() => {
    try {
      return fs.readFileSync(path.join(os.homedir(), ".llama", "redaction-denylist.txt"), "utf8");
    } catch {
      return null;
    }
  })();
  const raw = fromEnv && fromEnv.trim() ? fromEnv : fromFile;
  if (!raw) return null;
  return [...new Set(raw.split(/[\n,]/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
}

const denylist = loadDenylist();
if (!denylist || denylist.length === 0) {
  console.warn("verify-tarball-clean: no denylist available (REDACTION_DENYLIST env or ~/.llama/redaction-denylist.txt) — skipping scan");
  process.exit(0);
}

const packJson = JSON.parse(execSync("npm pack --dry-run --json --silent", { encoding: "utf8" }));
const files = packJson[0].files.map((f) => f.path);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Word-boundary match so short terms can't false-positive inside longer words.
const patterns = denylist.map((t) => new RegExp(`\\b${escapeRe(t)}\\b`, "i"));

const hits = [];
for (const file of files) {
  const content = fs.readFileSync(file, "utf8");
  patterns.forEach((re, i) => {
    if (re.test(content)) hits.push(`  ${file}  (denylist entry #${i})`);
  });
}

if (hits.length > 0) {
  console.error("verify-tarball-clean: FAIL — denylisted content in the publish surface:");
  for (const h of hits) console.error(h);
  console.error("Resolve before publishing. (Terms are reported by index only; see the denylist source.)");
  process.exit(1);
}
console.log(`verify-tarball-clean: OK — ${files.length} publish files scanned, ${denylist.length} terms, clean`);
