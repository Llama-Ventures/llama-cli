#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createBuildManifest } from "./build-manifest.mjs";

const FORBIDDEN_PREFIXES = [
  "package/apps/",
  "package/services/",
  "package/src/",
  "package/packages/",
  "package/node_modules/",
];

export function validateReleaseManifest(actual, expected, { requireClean = false } = {}) {
  const errors = [];
  for (const key of ["format", "packageName", "packageVersion", "sourceSha"]) {
    if (actual?.[key] !== expected?.[key]) {
      errors.push(`${key}: expected ${expected?.[key]}, got ${actual?.[key]}`);
    }
  }
  for (const key of ["format", "name", "apiVersion", "openapiVersion", "sha256"]) {
    if (actual?.coreApiContract?.[key] !== expected?.coreApiContract?.[key]) {
      errors.push(
        `coreApiContract.${key}: expected ${expected?.coreApiContract?.[key]}, got ${actual?.coreApiContract?.[key]}`,
      );
    }
  }
  if (requireClean && actual?.sourceDirty !== false) {
    errors.push(`sourceDirty: release artifacts require false, got ${actual?.sourceDirty}`);
  }
  return errors;
}

function isMain() {
  return process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isMain()) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "llama-cli-release-"));
  try {
    execFileSync("npm", ["pack", "--silent", "--pack-destination", tempDirectory], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    const tarballs = fs.readdirSync(tempDirectory).filter((name) => name.endsWith(".tgz"));
    if (tarballs.length !== 1) throw new Error(`Expected one npm tarball, found ${tarballs.length}`);
    const tarball = path.join(tempDirectory, tarballs[0]);
    const contents = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean);

    const requiredFiles = [
      "package/contracts/core-api.json",
      "package/contracts/required-operations.json",
      "package/lib/build-info.mjs",
      "package/lib/build-manifest.json",
      "package/package.json",
    ];
    for (const required of requiredFiles) {
      if (!contents.includes(required)) throw new Error(`Release artifact is missing ${required}`);
    }
    const forbidden = contents.filter((entry) => FORBIDDEN_PREFIXES.some((prefix) => entry.startsWith(prefix)));
    if (forbidden.length) throw new Error(`Release artifact contains forbidden implementation paths: ${forbidden.join(", ")}`);

    const actualManifest = JSON.parse(
      execFileSync("tar", ["-xOf", tarball, "package/lib/build-manifest.json"], { encoding: "utf8" }),
    );
    const expectedManifest = createBuildManifest({ root, env: process.env });
    const requireClean = process.env.LLAMA_REQUIRE_CLEAN_SOURCE === "1";
    const errors = validateReleaseManifest(actualManifest, expectedManifest, { requireClean });
    if (errors.length) throw new Error(`Invalid build manifest:\n- ${errors.join("\n- ")}`);

    const packedContract = JSON.parse(
      execFileSync("tar", ["-xOf", tarball, "package/contracts/core-api.json"], { encoding: "utf8" }),
    );
    if (packedContract.sha256 !== actualManifest.coreApiContract.sha256) {
      throw new Error("Packed Core contract identity differs from the embedded build manifest");
    }

    console.log(
      `Release artifact verified: ${tarballs[0]} / source ${actualManifest.sourceSha} / Core API ${actualManifest.coreApiContract.apiVersion} (${actualManifest.coreApiContract.sha256}) / ${contents.length} files`,
    );
  } catch (error) {
    console.error(`verify-release-artifact: ${error.message}`);
    process.exitCode = 1;
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}
