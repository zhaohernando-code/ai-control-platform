#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { createSelfGovernanceReport } from "../src/workflow/self-governance.js";

function usage() {
  console.error("Usage: node tools/build-self-governance-report.mjs <input.json> <output.json>");
}

const [, , inputPath, outputPath] = process.argv;

if (!inputPath || !outputPath) {
  usage();
  process.exit(2);
}

try {
  const input = JSON.parse(readFileSync(inputPath, "utf8"));
  const report = createSelfGovernanceReport(input);
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    status: report.status,
    output: outputPath,
    finding_count: report.finding_count,
    auto_repair_count: report.auto_repair.count,
    evidence_building_count: report.evidence_building.count,
    user_decision_count: report.user_decisions.count
  }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
