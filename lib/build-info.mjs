import { createRequire } from "node:module";

const requireFromHere = createRequire(import.meta.url);

function readJson(relativePath) {
  try {
    return requireFromHere(relativePath);
  } catch {
    return null;
  }
}

export function getBuildInfo() {
  const built = readJson("./build-manifest.json");
  if (built) return built;

  const packageJson = readJson("../package.json") || {};
  const contract = readJson("../contracts/core-api.json") || {};
  return {
    format: "llama.cli-build.v1",
    packageName: packageJson.name || "@llamaventures/cli",
    packageVersion: packageJson.version || "unknown",
    sourceSha: "local/unknown",
    sourceKind: "local",
    sourceDirty: null,
    coreApiContract: {
      format: contract.format || "unknown",
      name: contract.name || "llama-core-api",
      apiVersion: contract.apiVersion || "unknown",
      openapiVersion: contract.openapiVersion || "unknown",
      sha256: contract.sha256 || "unknown",
    },
  };
}
