#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  "bin/llama.mjs",
  "bin/llama-mcp.mjs",
  "contracts/required-operations.json",
];
const retiredMarkers = [
  "refresh-persona",
  "skill-correction",
  "skill_correction_",
  "persona-watcher",
  "<persona>_analysis",
];
const failures = [];

for (const relativePath of files) {
  const content = fs.readFileSync(path.join(root, relativePath), "utf8");
  for (const marker of retiredMarkers) {
    if (content.includes(marker)) failures.push(`${relativePath} still contains ${marker}`);
  }
}

if (failures.length > 0) {
  console.error("retired persona CLI boundary failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("ok: retired persona commands are absent from CLI, MCP, and required operations");
