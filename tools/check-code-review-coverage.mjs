#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { evaluateCodeReviewCoverageDispatch } from "../src/workflow/code-review-coverage-dispatch.js";

const inputPath = process.argv[2];

if (!inputPath) {
  console.error("usage: check-code-review-coverage.mjs <artifact.json>");
  process.exit(2);
}

const input = JSON.parse(readFileSync(inputPath, "utf8"));
const result = evaluateCodeReviewCoverageDispatch(input);

console.log(JSON.stringify(result, null, 2));

if (result.status !== "pass") {
  process.exit(1);
}
