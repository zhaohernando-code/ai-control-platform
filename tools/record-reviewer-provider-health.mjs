#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { recordReviewerProviderHealthFact } from "../src/workflow/reviewer-provider-health.js";

function usage() {
  return [
    "Usage: node tools/record-reviewer-provider-health.mjs --input <workflow-state.json> --output <workflow-state.json>",
    "",
    "Options:",
    "  --smoke-status <pass|timeout|fail>  Provider smoke result after reviewer timeout",
    "  --tools <Read,Grep>                 Reviewer tool list from the timed-out attempt",
    "  --created-at <iso>                  Fact timestamp",
    "  --in-place                         Write back to --input instead of requiring --output"
  ].join("\n");
}

function valueAfter(flag, args) {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  return args[index + 1] || null;
}

function hasFlag(flag, args) {
  return args.includes(flag);
}

function toolList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const args = process.argv.slice(2);
if (hasFlag("--help", args) || hasFlag("-h", args)) {
  console.log(usage());
  process.exit(0);
}

const inputPath = valueAfter("--input", args);
const outputPath = valueAfter("--output", args);
const inPlace = hasFlag("--in-place", args);

if (!inputPath || (!outputPath && !inPlace)) {
  console.error(usage());
  process.exit(1);
}

let workflowState;
try {
  workflowState = JSON.parse(readFileSync(resolve(inputPath), "utf8"));
} catch (error) {
  console.error(JSON.stringify({
    status: "fail",
    issues: [{ code: "workflow_state_read_failed", message: error.message, path: "input" }]
  }, null, 2));
  process.exit(1);
}

const result = recordReviewerProviderHealthFact(workflowState, {
  request: workflowState.reviewer_gate?.request || workflowState.reviewerGate?.request || workflowState.reviewer_gate || workflowState.reviewerGate,
  smoke_status: valueAfter("--smoke-status", args),
  tools: toolList(valueAfter("--tools", args)),
  created_at: valueAfter("--created-at", args)
});

if (result.status !== "pass") {
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
}

const destination = resolve(inPlace ? inputPath : outputPath);
writeFileSync(destination, `${JSON.stringify({ ...workflowState, ...result.workflow_state }, null, 2)}\n`);
console.log(JSON.stringify({
  status: "pass",
  output: destination,
  artifact_id: result.fact.id,
  provider_health: result.fact.provider_health,
  retry_strategy: result.fact.retry_strategy,
  scheduled_actions: result.fact.scheduled_actions
}, null, 2));
