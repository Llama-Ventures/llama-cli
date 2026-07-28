import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  formatServerCompatibilityNudge,
  maybeNudgeServerCompatibility,
  parseServerCompatibility,
} from "../lib/server-compatibility.mjs";

function headers(status = "stale") {
  return new Headers({
    "X-Llama-CLI-Status": status,
    "X-Llama-CLI-Recommended-Version": "1.22.0",
    "X-Llama-CLI-Minimum-Version": "1.17.0",
    "X-Llama-CLI-Upgrade-Command": "npm i -g @llamaventures/cli@latest",
  });
}

test("parses the server-owned compatibility headers", () => {
  assert.deepEqual(parseServerCompatibility(headers()), {
    status: "stale",
    recommendedVersion: "1.22.0",
    minimumVersion: "1.17.0",
    upgradeCommand: "npm i -g @llamaventures/cli@latest",
  });
  assert.equal(parseServerCompatibility(new Headers()), null);
});

test("formats an agent-readable stderr-only recommendation", () => {
  const line = formatServerCompatibilityNudge(
    parseServerCompatibility(headers()),
    "1.21.0",
  );
  assert.match(line, /CLI_UPDATE_RECOMMENDED/);
  assert.match(line, /1\.21\.0/);
  assert.match(line, /1\.22\.0/);
  assert.match(line, /npm i -g @llamaventures\/cli@latest/);
});

test("nudges once per day without requiring a TTY", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llama-cli-compat-"));
  const stampFile = path.join(dir, ".update-check");
  const written = [];
  const options = {
    currentVersion: "1.21.0",
    stampFile,
    now: 1_000_000,
    env: {},
    write: (line) => written.push(line),
  };
  assert.equal(maybeNudgeServerCompatibility(headers(), options), true);
  assert.equal(maybeNudgeServerCompatibility(headers(), options), false);
  assert.equal(written.length, 1);
  assert.equal(
    maybeNudgeServerCompatibility(headers(), {
      ...options,
      now: options.now + 24 * 60 * 60 * 1000 + 1,
    }),
    true,
  );
  assert.equal(written.length, 2);
});

test("never emits a soft nudge for ok or hard-blocked responses", () => {
  const written = [];
  const options = {
    currentVersion: "1.21.0",
    stampFile: path.join(os.tmpdir(), `llama-cli-compat-${process.pid}`),
    env: {},
    write: (line) => written.push(line),
  };
  assert.equal(maybeNudgeServerCompatibility(headers("ok"), options), false);
  assert.equal(maybeNudgeServerCompatibility(headers("unsupported"), options), false);
  assert.deepEqual(written, []);
});
