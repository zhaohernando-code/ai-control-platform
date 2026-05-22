#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { prepareContinuationFromProjectStatus } from "../src/workflow/project-status-continuation.js";

function valueAfter(flag, args) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : "";
}

function usage() {
  return [
    "Usage: node tools/prepare-project-status-continuation.mjs --project-status <PROJECT_STATUS.json> --output <continuation-input.json>",
    "",
    "Converts durable repository PROJECT_STATUS/global_goals into a continuation input and decision."
  ].join("\n");
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(usage());
  process.exit(0);
}

const projectStatusPath = valueAfter("--project-status", args);
const outputPath = valueAfter("--output", args);
if (!projectStatusPath || !outputPath) {
  console.error(usage());
  process.exit(1);
}

let result;
try {
  const projectStatus = JSON.parse(readFileSync(resolve(projectStatusPath), "utf8"));
  result = prepareContinuationFromProjectStatus(projectStatus);
} catch (error) {
  result = {
    status: "blocked",
    phase: "project_status_continuation",
    should_continue: false,
    issues: [{ code: "project_status_read_failed", message: error.message, path: "project_status" }],
    continuation_input: null,
    decision: null
  };
}

if (result.status === "ready" || result.status === "complete") {
  const resolvedOutput = resolve(outputPath);
  mkdirSync(dirname(resolvedOutput), { recursive: true });
  writeFileSync(resolvedOutput, `${JSON.stringify(result.continuation_input, null, 2)}\n`);
  console.log(JSON.stringify({
    status: result.status,
    phase: result.phase,
    should_continue: result.should_continue,
    output: resolvedOutput,
    action: result.decision?.action || null,
    next_step: result.continuation_input?.project_status?.next_step || null,
    global_goal_status: result.global_goal_completion?.status || null,
    pending_global_goals: result.global_goal_completion?.pending || 0
  }, null, 2));
} else {
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
}
