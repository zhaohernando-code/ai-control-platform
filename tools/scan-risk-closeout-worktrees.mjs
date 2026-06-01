#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  closeoutWorktreeReport,
  parseGitWorktreePorcelain
} from "./risk-closeout-recovery.mjs";

function parseArgs(argv) {
  const options = {
    inputPath: null,
    maxAgeMs: undefined,
    now: undefined
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") {
      options.inputPath = argv[index + 1];
      index += 1;
    } else if (arg === "--max-age-ms") {
      options.maxAgeMs = Number(argv[index + 1]);
      index += 1;
    } else if (arg === "--now") {
      options.now = argv[index + 1];
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return options;
}

function usage() {
  return [
    "usage: scan-risk-closeout-worktrees.mjs [--input worktree-porcelain.txt] [--max-age-ms n] [--now ISO_DATE]",
    "",
    "Reports closeout-related git worktrees. Without --input, reads `git worktree list --porcelain`."
  ].join("\n");
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  console.error(usage());
  process.exit(2);
}

if (options.help) {
  console.log(usage());
  process.exit(0);
}

const porcelain = options.inputPath
  ? readFileSync(options.inputPath, "utf8")
  : execFileSync("git", ["worktree", "list", "--porcelain"], { encoding: "utf8" });

const worktrees = parseGitWorktreePorcelain(porcelain);
const report = {
  version: "risk-closeout-worktree-report.v1",
  checked_at: new Date(options.now || Date.now()).toISOString(),
  worktrees: closeoutWorktreeReport(worktrees, options)
};

console.log(JSON.stringify(report, null, 2));
