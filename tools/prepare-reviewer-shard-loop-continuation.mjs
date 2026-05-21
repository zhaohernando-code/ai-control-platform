#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { prepareReviewerShardLoopContinuationInput } from "../src/workflow/reviewer-shard-runner.js";

function valueAfter(flag, args) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : "";
}

function usage() {
  return [
    "Usage: node tools/prepare-reviewer-shard-loop-continuation.mjs --artifact <reviewer-shard-loop-run.v1.json> --output <continuation-input.json>",
    "",
    "Options:",
    "  --next-step <text>  Durable project_status.next_step for the continuation input"
  ].join("\n");
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(usage());
  process.exit(0);
}

const artifactPath = valueAfter("--artifact", args);
const outputPath = valueAfter("--output", args);
if (!artifactPath || !outputPath) {
  console.error(usage());
  process.exit(1);
}

let result;
try {
  const artifact = JSON.parse(readFileSync(resolve(artifactPath), "utf8"));
  result = prepareReviewerShardLoopContinuationInput(artifact, {
    next_step: valueAfter("--next-step", args)
  });
} catch (error) {
  result = {
    status: "blocked",
    phase: "reviewer_shard_loop_replay_validation",
    should_continue: false,
    issues: [{ code: "reviewer_shard_loop_artifact_read_failed", message: error.message, path: "artifact" }],
    continuation_input: null
  };
}

if (result.status === "ready") {
  const resolvedOutput = resolve(outputPath);
  mkdirSync(dirname(resolvedOutput), { recursive: true });
  writeFileSync(resolvedOutput, `${JSON.stringify(result.continuation_input, null, 2)}\n`);
  console.log(JSON.stringify({
    status: result.status,
    phase: result.phase,
    output: resolvedOutput,
    reviewer_shard_loop: result.reviewer_shard_loop
  }, null, 2));
} else {
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
}
