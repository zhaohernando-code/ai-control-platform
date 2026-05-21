#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { evaluateProcessHardening } from "../src/workflow/process-hardening.js";

const inputPath = process.argv[2];

if (!inputPath) {
  console.error("usage: check-process-hardening.mjs <hardening-input.json>");
  process.exit(2);
}

const input = JSON.parse(readFileSync(inputPath, "utf8"));
const result = evaluateProcessHardening(input);

console.log(JSON.stringify(result, null, 2));

if (result.status !== "pass") {
  process.exit(1);
}
