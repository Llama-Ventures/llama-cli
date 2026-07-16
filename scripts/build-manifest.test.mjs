import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createBuildManifest, resolveSourceIdentity } from "./build-manifest.mjs";

let CHECKOUT_SHA = "";
try {
  CHECKOUT_SHA = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  // `npm run verify:release` must also work from a git archive.
}
const SHA = CHECKOUT_SHA || "c".repeat(40);
const OTHER_SHA = "a".repeat(40) === SHA ? "b".repeat(40) : "a".repeat(40);

test("explicit source SHA produces a complete build manifest", () => {
  const manifest = createBuildManifest({
    root: process.cwd(),
    env: { LLAMA_CLI_SOURCE_SHA: SHA, LLAMA_CLI_SOURCE_DIRTY: "false" },
  });
  assert.equal(manifest.format, "llama.cli-build.v1");
  assert.equal(manifest.packageName, "@llamaventures/cli");
  assert.equal(manifest.sourceSha, SHA);
  assert.match(manifest.coreApiContract.apiVersion, /^\d+\.\d+\.\d+$/);
  assert.match(manifest.coreApiContract.sha256, /^[0-9a-f]{64}$/);
});

test("source identity rejects a non-commit value", () => {
  assert.throws(
    () => resolveSourceIdentity({ cwd: process.cwd(), env: { LLAMA_CLI_SOURCE_SHA: "main" } }),
    /Invalid CLI source SHA/,
  );
});

test("source identity rejects a valid SHA that differs from the checkout", { skip: !CHECKOUT_SHA }, () => {
  assert.throws(
    () => resolveSourceIdentity({ cwd: process.cwd(), env: { LLAMA_CLI_SOURCE_SHA: OTHER_SHA } }),
    /does not match the checked-out commit/,
  );
});

test("untracked source files make a checkout dirty", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llama-cli-dirty-source-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: directory });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: directory });
    execFileSync("git", ["config", "user.name", "Release Test"], { cwd: directory });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: directory });
    fs.writeFileSync(path.join(directory, "tracked.txt"), "tracked\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: directory });
    execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: directory });
    const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: directory,
      encoding: "utf8",
    }).trim();
    fs.writeFileSync(path.join(directory, "untracked.txt"), "untracked\n");
    const identity = resolveSourceIdentity({
      cwd: directory,
      env: { LLAMA_CLI_SOURCE_SHA: sourceSha },
    });
    assert.equal(identity.sourceDirty, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("GitHub SHA is accepted when an explicit SHA is absent", () => {
  const identity = resolveSourceIdentity({ cwd: process.cwd(), env: { GITHUB_SHA: SHA } });
  assert.equal(identity.sourceSha, SHA);
  assert.equal(identity.sourceKind, "github");
});

test("explicit source identity works in a source archive without .git", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llama-cli-source-identity-"));
  try {
    const identity = resolveSourceIdentity({
      cwd: directory,
      env: { LLAMA_CLI_SOURCE_SHA: OTHER_SHA, LLAMA_CLI_SOURCE_DIRTY: "false" },
    });
    assert.equal(identity.sourceSha, OTHER_SHA);
    assert.equal(identity.sourceDirty, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
