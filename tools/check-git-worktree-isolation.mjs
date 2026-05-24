#!/usr/bin/env node
import { spawnSync } from "node:child_process";

import { evaluateGitWorktreeIsolation } from "../src/workflow/git-worktree-isolation.js";

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trimEnd();
}

const gate = evaluateGitWorktreeIsolation({
  branch: git(["branch", "--show-current"]),
  porcelain: git(["status", "--porcelain=v1", "--untracked-files=all"])
});

console.log(JSON.stringify(gate, null, 2));
if (gate.status !== "pass") {
  process.exit(1);
}
