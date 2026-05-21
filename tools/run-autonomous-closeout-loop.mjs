#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  createAutonomousLoopRunArtifact,
  prepareAutonomousContinuationFromLoopArtifact,
  runAutonomousCloseoutLoop
} from "../src/workflow/autonomous-orchestrator.js";

function valueAfter(flag, args) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : "";
}

function usage() {
  return [
    "Usage: node tools/run-autonomous-closeout-loop.mjs --input <loop-input.json>",
    "       node tools/run-autonomous-closeout-loop.mjs --resume-from <autonomous-closeout-loop-run.v1.json>",
    "",
    "Options:",
    "  --history-path <path>",
    "  --snapshots-root <path>",
    "  --output <path>       Write replayable input/output envelope JSON",
    "  --resume-from <path>  Validate replay artifact and emit scheduler continuation input"
  ].join("\n");
}

function blockedResumeResult(code, message, path = "resume_from") {
  return {
    status: "blocked",
    phase: "replay_validation",
    should_continue: false,
    issues: [{ code, message, path }],
    blockers: [
      {
        id: "autonomous_loop_artifact_replay",
        category: "replay_artifact_invalid",
        status: "blocked",
        message: "autonomous closeout loop artifact failed replay validation",
        issues: [{ code, message, path }]
      }
    ],
    continuation_input: null,
    context_pack_seed: null,
    snapshot_publish_plan: null,
    next_decision: null
  };
}

function printResult(result) {
  console.log(JSON.stringify(result, null, 2));
  if (!["pass", "ready"].includes(result.status)) {
    process.exitCode = 1;
  }
}

const args = process.argv.slice(2);
const inputPath = valueAfter("--input", args);
const resumePath = valueAfter("--resume-from", args);
if ((!inputPath && !resumePath) || args.includes("--help") || args.includes("-h")) {
  console.error(usage());
  process.exit(inputPath || resumePath ? 0 : 1);
}
if (inputPath && resumePath) {
  printResult(blockedResumeResult("ambiguous_autonomous_loop_mode", "--input and --resume-from cannot be used together", "mode"));
} else if (resumePath) {
  let resume;
  try {
    const artifact = JSON.parse(readFileSync(resolve(resumePath), "utf8"));
    resume = prepareAutonomousContinuationFromLoopArtifact(artifact);
  } catch (error) {
    resume = blockedResumeResult("replay_artifact_read_failed", error.message, "resume_from");
  }
  printResult(resume);
} else {
  const input = JSON.parse(readFileSync(resolve(inputPath), "utf8"));
  const result = await runAutonomousCloseoutLoop(input, {
    root: process.cwd(),
    historyPath: valueAfter("--history-path", args) || undefined,
    snapshotsRoot: valueAfter("--snapshots-root", args) || undefined
  });
  const artifact = createAutonomousLoopRunArtifact(input, result);
  const outputPath = valueAfter("--output", args);

  if (outputPath) {
    const resolvedOutputPath = resolve(outputPath);
    mkdirSync(dirname(resolvedOutputPath), { recursive: true });
    writeFileSync(resolvedOutputPath, `${JSON.stringify(artifact, null, 2)}\n`);
  }

  console.log(JSON.stringify(outputPath ? {
    status: artifact.status,
    phase: artifact.phase,
    output: outputPath
  } : result, null, 2));
  if (result.status !== "pass") {
    process.exitCode = 1;
  }
}
