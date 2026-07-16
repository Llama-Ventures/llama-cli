import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SHA_RE = /^[0-9a-f]{40}$/i;
const CONTRACT_DIGEST_RE = /^[0-9a-f]{64}$/i;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export function resolveSourceIdentity({ cwd = process.cwd(), env = process.env } = {}) {
  const environmentSha = env.LLAMA_CLI_SOURCE_SHA || env.GITHUB_SHA || "";
  let sourceSha = environmentSha.trim();
  let sourceKind = env.LLAMA_CLI_SOURCE_SHA ? "explicit" : env.GITHUB_SHA ? "github" : "git";
  let gitSha = "";

  try {
    gitSha = git(cwd, ["rev-parse", "HEAD"]);
  } catch {
    // Release archives intentionally have no .git directory. In that case an
    // explicit source SHA is mandatory and becomes the verifiable hand-off.
  }

  if (!sourceSha) {
    if (!gitSha) {
      throw new Error(
        "Cannot identify the CLI source commit. Set LLAMA_CLI_SOURCE_SHA to the exact 40-character Git SHA.",
      );
    }
    sourceSha = gitSha;
  }

  if (!SHA_RE.test(sourceSha)) {
    throw new Error(`Invalid CLI source SHA: ${sourceSha || "<empty>"}`);
  }
  if (gitSha && sourceSha.toLowerCase() !== gitSha.toLowerCase()) {
    throw new Error(
      `CLI source SHA does not match the checked-out commit: ${sourceSha} != ${gitSha}`,
    );
  }

  let sourceDirty = null;
  try {
    sourceDirty = git(cwd, ["status", "--porcelain", "--untracked-files=all"]) !== "";
  } catch {
    sourceDirty =
      env.LLAMA_CLI_SOURCE_DIRTY === "true"
        ? true
        : env.LLAMA_CLI_SOURCE_DIRTY === "false"
          ? false
          : null;
  }

  return {
    sourceSha: sourceSha.toLowerCase(),
    sourceKind,
    sourceDirty,
  };
}

export function createBuildManifest({ root = process.cwd(), env = process.env } = {}) {
  const packageJson = readJson(path.join(root, "package.json"));
  const coreContract = readJson(path.join(root, "contracts", "core-api.json"));
  const source = resolveSourceIdentity({ cwd: root, env });

  if (coreContract.format !== "llama.core-api-contract.v1") {
    throw new Error(`Unsupported Core API contract format: ${coreContract.format}`);
  }
  if (!CONTRACT_DIGEST_RE.test(coreContract.sha256 || "")) {
    throw new Error("Core API contract digest must be a 64-character SHA-256 value");
  }
  if (!/^\d+\.\d+\.\d+$/.test(coreContract.apiVersion || "")) {
    throw new Error(`Invalid Core API version: ${coreContract.apiVersion || "<empty>"}`);
  }

  return {
    format: "llama.cli-build.v1",
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    sourceSha: source.sourceSha,
    sourceKind: source.sourceKind,
    sourceDirty: source.sourceDirty,
    coreApiContract: {
      format: coreContract.format,
      name: coreContract.name,
      apiVersion: coreContract.apiVersion,
      openapiVersion: coreContract.openapiVersion,
      sha256: coreContract.sha256,
    },
  };
}

export function writeBuildManifest({ root = process.cwd(), env = process.env } = {}) {
  const manifest = createBuildManifest({ root, env });
  const outputPath = path.join(root, "lib", "build-manifest.json");
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifest, outputPath };
}
