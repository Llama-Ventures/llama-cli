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
import { execFileSync } from "node:child_process";
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
  if (process.env.REDACTION_DENYLIST_REQUIRED === "1") {
    console.error(
      "verify-tarball-clean: FAIL — REDACTION_DENYLIST is required for this release gate",
    );
    process.exit(1);
  }
  console.warn("verify-tarball-clean: no denylist available (REDACTION_DENYLIST env or ~/.llama/redaction-denylist.txt) — skipping scan");
  process.exit(0);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Word-boundary match so short terms can't false-positive inside longer words.
const patterns = denylist.map((t) => new RegExp(`\\b${escapeRe(t)}\\b`, "i"));

const hits = [];
const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "llama-cli-hygiene-"));
let files = [];
try {
  execFileSync("npm", ["pack", "--silent", "--pack-destination", tempDirectory], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tarballs = fs.readdirSync(tempDirectory).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1) throw new Error(`Expected one npm tarball, found ${tarballs.length}`);
  const tarball = path.join(tempDirectory, tarballs[0]);
  files = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((file) => file && !file.endsWith("/"));

  for (const file of files) {
    const content = execFileSync("tar", ["-xOf", tarball, file], { encoding: "utf8" });
    patterns.forEach((re, i) => {
      if (re.test(content)) hits.push(`  ${file.replace(/^package\//, "")}  (denylist entry #${i})`);
    });
  }
} catch (error) {
  console.error(`verify-tarball-clean: FAIL — could not inspect packed artifact: ${error.message}`);
  process.exit(1);
} finally {
  fs.rmSync(tempDirectory, { recursive: true, force: true });
}

if (hits.length > 0) {
  console.error("verify-tarball-clean: FAIL — denylisted content in the publish surface:");
  for (const h of hits) console.error(h);
  console.error("Resolve before publishing. (Terms are reported by index only; see the denylist source.)");
  process.exit(1);
}
console.log(`verify-tarball-clean: OK — ${files.length} publish files scanned, ${denylist.length} terms, clean`);
