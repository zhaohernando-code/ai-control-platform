#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  createSchedulerDispatchRunArtifact,
  runSchedulerDispatchPlan
} from "../src/workflow/scheduler-dispatch-runner.js";

function valueAfter(flag, args) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : "";
}

function hasFlag(flag, args) {
  return args.includes(flag);
}

function usage() {
  return [
    "Usage: node tools/run-scheduler-dispatch-plan.mjs --plan <dispatch-plan.json> --output <scheduler-dispatch-run.v1.json>",
    "",
    "Options:",
    "  --dry-run  Validate and record steps without executing commands"
  ].join("\n");
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(usage());
  process.exit(0);
}

const planPath = valueAfter("--plan", args);
const outputPath = valueAfter("--output", args);
if (!planPath || !outputPath) {
  console.error(usage());
  process.exit(1);
}

let plan;
let result;
try {
  plan = JSON.parse(readFileSync(resolve(planPath), "utf8"));
  result = await runSchedulerDispatchPlan(plan, {
    dry_run: hasFlag("--dry-run", args)
  });
} catch (error) {
  result = {
    status: "fail",
    phase: "input",
    issues: [{ code: "scheduler_dispatch_run_input_failed", message: error.message, path: "plan" }],
    steps: []
  };
  plan = null;
}

const artifact = createSchedulerDispatchRunArtifact(plan || {}, result);
const resolvedOutput = resolve(outputPath);
mkdirSync(dirname(resolvedOutput), { recursive: true });
writeFileSync(resolvedOutput, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify({
  status: artifact.status,
  phase: artifact.phase,
  output: resolvedOutput,
  step_count: artifact.result.steps.length
}, null, 2));
if (artifact.status !== "pass") {
  process.exit(1);
}
