#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import {
  cleanupWorkbenchLiveTestData,
  DEFAULT_LIVE_WORKBENCH_STATE_DB,
  inspectWorkbenchLiveStateCleanliness
} from "../src/workflow/workbench-live-state-cleanliness.js";

function valueAfter(name, args) {
  const index = args.indexOf(name);
  if (index < 0) return "";
  return args[index + 1] || "";
}

function usage() {
  return [
    "Usage: node tools/check-workbench-live-state-cleanliness.mjs [--state-db <path>] [--cleanup]",
    "",
    "Fails when the live workbench SQLite state contains reserved test/verification",
    "requirement records. Use --cleanup only after a test intentionally wrote to the",
    "live workbench API and must remove its own data before closeout."
  ].join("\n");
}

export function runCli(args = process.argv.slice(2)) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return 0;
  }

  const dbPath = valueAfter("--state-db", args) || process.env.AI_CONTROL_WORKBENCH_STATE_DB || DEFAULT_LIVE_WORKBENCH_STATE_DB;
  const cleanup = args.includes("--cleanup");
  const result = cleanup
    ? cleanupWorkbenchLiveTestData({ dbPath })
    : inspectWorkbenchLiveStateCleanliness({ dbPath });

  console.log(JSON.stringify(result, null, 2));
  return result.status === "pass" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runCli());
}
