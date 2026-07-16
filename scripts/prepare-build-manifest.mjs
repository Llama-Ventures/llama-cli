#!/usr/bin/env node

import { writeBuildManifest } from "./build-manifest.mjs";

try {
  writeBuildManifest();
} catch (error) {
  console.error(`prepare-build-manifest: ${error.message}`);
  process.exit(1);
}
