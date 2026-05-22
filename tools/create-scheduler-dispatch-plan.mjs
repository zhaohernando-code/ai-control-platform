#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { createSchedulerDispatchPlan } from "../src/workflow/scheduler-dispatch-plan.js";
import { prepareContinuationFromProjectStatus } from "../src/workflow/project-status-continuation.js";

function valueAfter(flag, args) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : "";
}

function usage() {
  return [
    "Usage: node tools/create-scheduler-dispatch-plan.mjs (--input <continuation-input.json> | --project-status <PROJECT_STATUS.json>) --workflow-state-input <workflow-state.json> --output <dispatch-plan.json>",
    "",
    "Options:",
    "  --next-step <text>",
    "  --workflow-state-output <path>",
    "  --reviewer-shard-loop-artifact <path>",
    "  --continuation-input-output <path>",
    "  --history-path <path>",
    "  --snapshots-root <path>",
    "  --closeout-loop-artifact <path>",
    "  --workbench-writeback-mode <none|service>",
    "  --workbench-base-url <url>",
    "  --projection-id <id>",
    "  --reviewer-mock-status <pass|fail>",
    "  --reviewer-mock-findings-json <json>"
  ].join("\n");
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(usage());
  process.exit(0);
}

const inputPath = valueAfter("--input", args);
const projectStatusPath = valueAfter("--project-status", args);
const outputPath = valueAfter("--output", args);
if ((!inputPath && !projectStatusPath) || !outputPath) {
  console.error(usage());
  process.exit(1);
}

let result;
try {
  let input;
  if (projectStatusPath) {
    const projectStatus = JSON.parse(readFileSync(resolve(projectStatusPath), "utf8"));
    const prepared = prepareContinuationFromProjectStatus(projectStatus);
    if (prepared.status === "blocked") {
      throw new Error(`project status continuation blocked: ${JSON.stringify(prepared.issues)}`);
    }
    input = prepared.continuation_input;
  } else {
    input = JSON.parse(readFileSync(resolve(inputPath), "utf8"));
  }
  result = createSchedulerDispatchPlan(input, {
    workflow_state_input_path: valueAfter("--workflow-state-input", args),
    workflow_state_output_path: valueAfter("--workflow-state-output", args),
    reviewer_shard_loop_artifact_path: valueAfter("--reviewer-shard-loop-artifact", args),
    continuation_input_path: valueAfter("--continuation-input-output", args),
    history_path: valueAfter("--history-path", args),
    snapshots_root: valueAfter("--snapshots-root", args),
    closeout_loop_artifact_path: valueAfter("--closeout-loop-artifact", args),
    workbench_writeback_mode: valueAfter("--workbench-writeback-mode", args),
    workbench_base_url: valueAfter("--workbench-base-url", args),
    projection_id: valueAfter("--projection-id", args),
    reviewer_mock_status: valueAfter("--reviewer-mock-status", args),
    reviewer_mock_findings_json: valueAfter("--reviewer-mock-findings-json", args),
    next_step: valueAfter("--next-step", args)
  });
} catch (error) {
  result = {
    status: "fail",
    phase: "scheduler_dispatch_plan",
    issues: [{ code: "scheduler_dispatch_plan_input_failed", message: error.message, path: "input" }],
    steps: []
  };
}

if (result.status === "pass") {
  const resolvedOutput = resolve(outputPath);
  mkdirSync(dirname(resolvedOutput), { recursive: true });
  writeFileSync(resolvedOutput, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({
    status: result.status,
    phase: result.phase,
    output: resolvedOutput,
    step_count: result.steps.length
  }, null, 2));
} else {
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
}
