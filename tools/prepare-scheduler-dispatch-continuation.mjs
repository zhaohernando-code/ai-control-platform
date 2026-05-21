#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { prepareSchedulerDispatchContinuationFromRunArtifact } from "../src/workflow/scheduler-dispatch-continuation.js";

function valueAfter(flag, args) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : "";
}

function usage() {
  return [
    "Usage: node tools/prepare-scheduler-dispatch-continuation.mjs --artifact <scheduler-dispatch-run.v1.json> --output <continuation-input.json>",
    "",
    "Validates the scheduler dispatch run and its closeout loop artifact before emitting the next continuation input."
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
  result = prepareSchedulerDispatchContinuationFromRunArtifact(artifact);
} catch (error) {
  result = {
    status: "blocked",
    phase: "scheduler_dispatch_continuation",
    should_continue: false,
    issues: [{ code: "scheduler_dispatch_run_artifact_read_failed", message: error.message, path: "artifact" }],
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
    scheduler_dispatch: result.scheduler_dispatch
  }, null, 2));
} else {
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
}
