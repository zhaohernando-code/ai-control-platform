#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  createAutonomousLoopRunArtifact,
  runAutonomousCloseoutLoop
} from "../src/workflow/autonomous-orchestrator.js";

function valueAfter(flag, args) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : "";
}

function usage() {
  return [
    "Usage: node tools/run-autonomous-closeout-loop.mjs --input <loop-input.json>",
    "",
    "Options:",
    "  --history-path <path>",
    "  --snapshots-root <path>",
    "  --output <path>  Write replayable input/output envelope JSON"
  ].join("\n");
}

const args = process.argv.slice(2);
const inputPath = valueAfter("--input", args);
if (!inputPath || args.includes("--help") || args.includes("-h")) {
  console.error(usage());
  process.exit(inputPath ? 0 : 1);
}

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
  process.exit(1);
}
