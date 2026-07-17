#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

fs.rmSync(path.join(process.cwd(), "lib", "build-manifest.json"), { force: true });
