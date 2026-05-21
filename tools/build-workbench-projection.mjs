#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

import { createWorkbenchProjection } from "../src/workflow/workbench-projection.js";

const [, , inputPath, outputPath] = process.argv;

if (!inputPath || !outputPath) {
  console.error("usage: build-workbench-projection.mjs <input.json> <output.json>");
  process.exit(2);
}

const input = JSON.parse(readFileSync(inputPath, "utf8"));
const projection = createWorkbenchProjection(input);

writeFileSync(outputPath, `${JSON.stringify(projection, null, 2)}\n`);
console.log(JSON.stringify({ status: "pass", output: outputPath, projection_status: projection.status }, null, 2));
