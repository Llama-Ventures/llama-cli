#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { operationKey, scanRuntimeOperations } from "./core-api-call-sites.mjs";

export function compareOperationInventory(actualOperations, declaredOperations) {
  const actual = new Set(actualOperations.map((operation) => operation.key || operationKey(operation.method, operation.path)));
  const declared = new Set(declaredOperations.map((operation) => operationKey(operation.method, operation.path)));
  return {
    undeclared: [...actual].filter((key) => !declared.has(key)).sort(),
    stale: [...declared].filter((key) => !actual.has(key)).sort(),
  };
}

function isMain() {
  return process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isMain()) {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const contract = JSON.parse(fs.readFileSync(path.join(root, "contracts", "core-api.json"), "utf8"));
    const inventory = JSON.parse(
      fs.readFileSync(path.join(root, "contracts", "required-operations.json"), "utf8"),
    );
    if (contract.format !== "llama.core-api-contract.v1" || !/^[0-9a-f]{64}$/.test(contract.sha256 || "")) {
      throw new Error("contracts/core-api.json is not a valid pinned Core API contract identity");
    }
    if (inventory.format !== "llama.cli-core-api-operations.v1") {
      throw new Error(`Unsupported operation inventory format: ${inventory.format}`);
    }

    const scan = scanRuntimeOperations(root);
    if (scan.unresolved.length > 0) {
      console.error("Unresolved Core API call sites (use a literal endpoint/helper or an adjacent @core-api-operation annotation):");
      for (const item of scan.unresolved) {
        console.error(`- ${item.file}:${item.line} ${item.callee}(${item.method}, ${item.endpoint})`);
      }
      process.exit(1);
    }

    const comparison = compareOperationInventory(scan.operations, inventory.requiredOperations || []);
    if (comparison.undeclared.length || comparison.stale.length) {
      if (comparison.undeclared.length) {
        console.error("Runtime operations missing from contracts/required-operations.json:");
        comparison.undeclared.forEach((key) => console.error(`- ${key}`));
      }
      if (comparison.stale.length) {
        console.error("Declared operations with no runtime call site:");
        comparison.stale.forEach((key) => console.error(`- ${key}`));
      }
      process.exit(1);
    }

    console.log(
      `Core API contract verified: ${contract.apiVersion} / ${contract.sha256}; ${scan.operations.length} CLI operations declared`,
    );
  } catch (error) {
    console.error(`verify-core-api-contract: ${error.message}`);
    process.exit(1);
  }
}
