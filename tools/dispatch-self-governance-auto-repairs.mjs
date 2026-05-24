#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { dispatchSelfGovernanceAutoRepairs } from "../src/workflow/self-governance-dispatch.js";

function valueAfter(flag, args = process.argv.slice(2)) {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

function ensureParent(path) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
}

const inputPath = valueAfter("--input") || process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const outputPath = valueAfter("--output") || "tmp/self-governance-dispatch/run.json";
const workflowOutputPath = valueAfter("--workflow-output") || "";

if (!inputPath) {
  console.error("Usage: node tools/dispatch-self-governance-auto-repairs.mjs --input <self-governance-report.json> [--output <run.json>] [--workflow-output <workflow.json>]");
  process.exit(2);
}

try {
  const report = JSON.parse(readFileSync(inputPath, "utf8"));
  const result = dispatchSelfGovernanceAutoRepairs(report, {
    created_at: new Date().toISOString()
  });
  ensureParent(outputPath);
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  if (workflowOutputPath && result.workflow_state) {
    ensureParent(workflowOutputPath);
    writeFileSync(workflowOutputPath, `${JSON.stringify(result.workflow_state, null, 2)}\n`);
  }
  console.log(JSON.stringify({
    status: result.status,
    phase: result.phase,
    output: outputPath,
    workflow_output: workflowOutputPath || null,
    auto_repair_count: result.plan?.auto_repair_count || 0,
    started_work_package_count: result.started_work_package_count || 0,
    started_work_package_ids: result.started_work_package_ids || []
  }, null, 2));
  if (!["pass", "not_required"].includes(result.status)) process.exit(1);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
