#!/usr/bin/env node
import { resolve } from "node:path";

import { readCloseoutInput, runCloseoutPlan } from "../src/workflow/closeout-runner.js";

function valueAfter(flag, args) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : "";
}

function hasFlag(flag, args) {
  return args.includes(flag);
}

function usage() {
  return [
    "Usage: node tools/run-closeout-plan.mjs --input <decision-or-plan.json> [--mode local|http]",
    "",
    "Local mode options:",
    "  --history-path <path>",
    "  --snapshots-root <path>",
    "",
    "HTTP mode options:",
    "  --base-url <url>"
  ].join("\n");
}

const args = process.argv.slice(2);
if (hasFlag("--help", args) || hasFlag("-h", args)) {
  console.log(usage());
  process.exit(0);
}

const inputPath = valueAfter("--input", args);
if (!inputPath) {
  console.error(usage());
  process.exit(1);
}

const root = process.cwd();
const input = readCloseoutInput(resolve(inputPath));
const result = await runCloseoutPlan(input, {
  mode: valueAfter("--mode", args) || "local",
  baseUrl: valueAfter("--base-url", args),
  root,
  historyPath: valueAfter("--history-path", args) || undefined,
  snapshotsRoot: valueAfter("--snapshots-root", args) || undefined
});

console.log(JSON.stringify(result, null, 2));

if (result.status === "fail") {
  process.exit(1);
}
