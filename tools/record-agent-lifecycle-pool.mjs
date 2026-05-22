#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  cleanupAgentLifecyclePool,
  recordAgentLifecycleFact
} from "../src/workflow/agent-lifecycle-pool.js";

function usage() {
  return [
    "Usage: node tools/record-agent-lifecycle-pool.mjs --input <workflow-state.json> --output <workflow-state.json>",
    "",
    "Options:",
    "  --event-type <type>          WorkerSpawned, WorkerCompleted, WorkerEvaluation, WorkerClosed, PoolIterationClosed",
    "  --pool-id <id>               Lifecycle pool id",
    "  --worker-id <id>             Worker/child process id",
    "  --status <pass|fail>         Fact status",
    "  --message <text>             Fact message",
    "  --created-at <iso>           Fact timestamp",
    "  --cleanup-latest-pool        Auto-record missing evaluation/closed/iteration close facts",
    "  --failure <text>             Cleanup blocker/failure message",
    "  --blocked <text>             Cleanup blocker message",
    "  --in-place                   Write back to --input instead of requiring --output"
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

const args = process.argv.slice(2);
if (hasFlag("--help", args) || hasFlag("-h", args)) {
  console.log(usage());
  process.exit(0);
}

const inputPath = valueAfter("--input", args);
const outputPath = valueAfter("--output", args);
const inPlace = hasFlag("--in-place", args);
const cleanupLatestPool = hasFlag("--cleanup-latest-pool", args);

if (!inputPath || (!outputPath && !inPlace)) {
  console.error(usage());
  process.exit(1);
}
if (!cleanupLatestPool && !valueAfter("--event-type", args)) {
  console.error(usage());
  process.exit(1);
}

let workflowState;
try {
  workflowState = JSON.parse(readFileSync(resolve(inputPath), "utf8"));
} catch (error) {
  console.error(JSON.stringify({
    status: "fail",
    issues: [{ code: "agent_lifecycle_input_read_failed", message: error.message, path: "input" }]
  }, null, 2));
  process.exit(1);
}

const input = {
  event_type: valueAfter("--event-type", args),
  pool_id: valueAfter("--pool-id", args),
  worker_id: valueAfter("--worker-id", args),
  status: valueAfter("--status", args),
  message: valueAfter("--message", args),
  created_at: valueAfter("--created-at", args),
  failure: valueAfter("--failure", args),
  blocked: valueAfter("--blocked", args)
};

const result = cleanupLatestPool
  ? cleanupAgentLifecyclePool(workflowState, input)
  : recordAgentLifecycleFact(workflowState, input);

if (!["pass", "cleanup_required", "blocked"].includes(result.status)) {
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
}

const destination = resolve(inPlace ? inputPath : outputPath);
writeFileSync(destination, `${JSON.stringify({ ...workflowState, ...result.workflow_state }, null, 2)}\n`);
console.log(JSON.stringify({
  status: result.status,
  output: destination,
  artifact_id: result.fact?.id || result.facts?.at(-1)?.id || null,
  fact_count: result.facts?.length ?? 1,
  before: result.before || null,
  after: result.after || null
}, null, 2));
