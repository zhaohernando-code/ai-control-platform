#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { classifyHost } from "../src/workflow/host-boundary.js";

const [, , briefPath] = process.argv;

if (!briefPath) {
  console.error("usage: check-host-boundary.mjs <brief.json>");
  process.exit(2);
}

const brief = JSON.parse(readFileSync(briefPath, "utf8"));
const result = classifyHost({
  request: brief.request,
  targetProjectId: brief.targetProjectId,
  explicitAdapter: brief.explicitAdapter === true
});

console.log(JSON.stringify(result, null, 2));

if (!result.allowed) {
  process.exit(1);
}

