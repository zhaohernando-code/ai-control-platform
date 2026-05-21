#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { runAutonomousCloseoutLoop } from "../src/workflow/autonomous-orchestrator.js";

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
    "  --snapshots-root <path>"
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

console.log(JSON.stringify(result, null, 2));
if (result.status !== "pass") {
  process.exit(1);
}
