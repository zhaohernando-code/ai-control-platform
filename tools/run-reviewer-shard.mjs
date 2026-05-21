#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { createClaudeDeepSeekShardExecutor } from "../src/workflow/claude-deepseek-shard-executor.js";
import {
  runReviewerShard,
  runReviewerShardsUntilAggregate
} from "../src/workflow/reviewer-shard-runner.js";

function usage() {
  return [
    "Usage: node tools/run-reviewer-shard.mjs --input <workflow-state.json> --output <workflow-state.json>",
    "",
    "Options:",
    "  --shard-id <id>               Pending shard id; defaults to the first pending shard",
    "  --all                         Continue pending shards until aggregate or provider health stop",
    "  --max-shards <n>              Safety cap for --all",
    "  --cwd <path>                  Project cwd for external reviewer",
    "  --timeout-seconds <seconds>   External reviewer timeout override",
    "  --created-at <iso>            Fact timestamp",
    "  --aggregate-created-at <iso>  Aggregate timestamp",
    "  --record-provider-health      Write provider health fact when shard times out",
    "  --provider-smoke-status <s>   Optional smoke result for provider health recovery",
    "  --mock-findings-json <json>   Test-only executor output",
    "  --mock-status <pass|fail>     Test-only executor status",
    "  --in-place                    Write back to --input instead of requiring --output"
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

function mockExecutorFromArgs(args) {
  const findingsJson = valueAfter("--mock-findings-json", args);
  const mockStatus = valueAfter("--mock-status", args);
  if (!findingsJson && !mockStatus) return null;

  return async () => ({
    status: mockStatus || "pass",
    findings: findingsJson ? JSON.parse(findingsJson) : []
  });
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
let executor;
try {
  workflowState = JSON.parse(readFileSync(resolve(inputPath), "utf8"));
  executor = mockExecutorFromArgs(args) || createClaudeDeepSeekShardExecutor({
    cwd: valueAfter("--cwd", args) || process.cwd(),
    timeout_seconds: valueAfter("--timeout-seconds", args)
  });
} catch (error) {
  console.error(JSON.stringify({
    status: "fail",
    issues: [{ code: "reviewer_shard_run_input_failed", message: error.message, path: "input" }]
  }, null, 2));
  process.exit(1);
}

const runnerInput = {
  shard_id: valueAfter("--shard-id", args),
  created_at: valueAfter("--created-at", args),
  aggregate_created_at: valueAfter("--aggregate-created-at", args),
  record_provider_health_on_timeout: hasFlag("--record-provider-health", args),
  provider_smoke_status: valueAfter("--provider-smoke-status", args),
  max_shards: valueAfter("--max-shards", args),
  executor
};
const result = hasFlag("--all", args)
  ? await runReviewerShardsUntilAggregate(workflowState, runnerInput)
  : await runReviewerShard(workflowState, runnerInput);

if (result.status !== "pass") {
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
}

const destination = resolve(inPlace ? inputPath : outputPath);
writeFileSync(destination, `${JSON.stringify({ ...workflowState, ...result.workflow_state }, null, 2)}\n`);
console.log(JSON.stringify({
  status: "pass",
  output: destination,
  phase: result.phase,
  shard_id: result.result?.shard_id || result.runs?.at(-1)?.shard_id || null,
  shard_status: result.result?.status || result.runs?.at(-1)?.shard_status || null,
  runs: result.runs || undefined,
  provider_health: result.provider_health ? {
    status: result.provider_health.status,
    provider_health: result.provider_health.provider_health,
    retry_strategy: result.provider_health.retry_strategy,
    scheduled_actions: result.provider_health.scheduled_actions
  } : null,
  pending_shards: result.pending_shards ?? result.aggregate?.pending_shards ?? null,
  aggregate: result.aggregate ? {
    status: result.aggregate.status,
    completed_shards: result.aggregate.completed_shards,
    pending_shards: result.aggregate.pending_shards,
    failed_finding_count: result.aggregate.failed_finding_count
  } : null
}, null, 2));
