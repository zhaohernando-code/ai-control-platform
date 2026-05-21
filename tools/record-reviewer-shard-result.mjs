#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  recordReviewerShardAggregate,
  recordReviewerShardResult
} from "../src/workflow/reviewer-shard-results.js";

function usage() {
  return [
    "Usage: node tools/record-reviewer-shard-result.mjs --input <workflow-state.json> --output <workflow-state.json> --shard-id <id>",
    "",
    "Options:",
    "  --status <pass|fail>          Shard review status when no findings fail",
    "  --findings-json <json>        JSON array of reviewer findings",
    "  --findings-file <path>        JSON file containing reviewer findings",
    "  --created-at <iso>            Fact timestamp",
    "  --aggregate                   Also write reviewer_shard_aggregate after recording the shard",
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

function readFindings(args) {
  const findingsJson = valueAfter("--findings-json", args);
  const findingsFile = valueAfter("--findings-file", args);
  if (!findingsJson && !findingsFile) return [];
  const raw = findingsFile ? readFileSync(resolve(findingsFile), "utf8") : findingsJson;
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

const args = process.argv.slice(2);
if (hasFlag("--help", args) || hasFlag("-h", args)) {
  console.log(usage());
  process.exit(0);
}

const inputPath = valueAfter("--input", args);
const outputPath = valueAfter("--output", args);
const shardId = valueAfter("--shard-id", args);
const inPlace = hasFlag("--in-place", args);

if (!inputPath || !shardId || (!outputPath && !inPlace)) {
  console.error(usage());
  process.exit(1);
}

let workflowState;
let findings;
try {
  workflowState = JSON.parse(readFileSync(resolve(inputPath), "utf8"));
  findings = readFindings(args);
} catch (error) {
  console.error(JSON.stringify({
    status: "fail",
    issues: [{ code: "reviewer_shard_input_read_failed", message: error.message, path: "input" }]
  }, null, 2));
  process.exit(1);
}

const result = recordReviewerShardResult(workflowState, {
  shard_id: shardId,
  status: valueAfter("--status", args),
  findings,
  created_at: valueAfter("--created-at", args)
});

if (result.status !== "pass") {
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
}

let nextState = result.workflow_state;
let aggregate = null;
if (hasFlag("--aggregate", args)) {
  aggregate = recordReviewerShardAggregate(nextState, {
    created_at: valueAfter("--created-at", args)
  });
  if (aggregate.status !== "pass") {
    console.error(JSON.stringify(aggregate, null, 2));
    process.exit(1);
  }
  nextState = aggregate.workflow_state;
}

const destination = resolve(inPlace ? inputPath : outputPath);
writeFileSync(destination, `${JSON.stringify({ ...workflowState, ...nextState }, null, 2)}\n`);
console.log(JSON.stringify({
  status: "pass",
  output: destination,
  artifact_id: result.fact.id,
  shard_id: result.fact.shard_id,
  shard_status: result.fact.status,
  failed_finding_count: result.fact.failed_finding_count,
  aggregate: aggregate ? {
    artifact_id: aggregate.fact.id,
    status: aggregate.fact.status,
    completed_shards: aggregate.fact.completed_shards,
    pending_shards: aggregate.fact.pending_shards,
    failed_finding_count: aggregate.fact.failed_finding_count
  } : null
}, null, 2));
