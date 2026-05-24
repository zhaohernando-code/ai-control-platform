#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";

import { evaluateGitWorktreeIsolation } from "../src/workflow/git-worktree-isolation.js";

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trimEnd();
}

function valueAfter(flag, args) {
  const index = args.indexOf(flag);
  if (index === -1) return "";
  return args[index + 1] || "";
}

function envValue(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (value) return value;
  }
  return "";
}

function parseWorktrees(porcelain) {
  const worktrees = [];
  let current = null;
  for (const line of String(porcelain || "").split(/\r?\n/)) {
    if (!line) {
      if (current) worktrees.push(current);
      current = null;
      continue;
    }
    const [key, ...rest] = line.split(" ");
    if (key === "worktree") {
      if (current) worktrees.push(current);
      current = { path: rest.join(" ") };
      continue;
    }
    if (!current) continue;
    if (key === "branch") current.branch = rest.join(" ");
    if (key === "bare" || key === "detached") current[key] = true;
  }
  if (current) worktrees.push(current);
  return worktrees;
}

function primaryWorktreePath(worktrees, gitCommonDir) {
  const explicit = envValue("PRIMARY_WORKTREE_PATH", "GIT_PRIMARY_WORKTREE_PATH");
  if (explicit) return resolve(explicit);
  const primary = worktrees.find((item) => item.branch === "refs/heads/main") || worktrees[0];
  if (primary?.path) return resolve(primary.path);
  if (gitCommonDir) return resolve(dirname(gitCommonDir));
  return "";
}

function defaultWorkerWorkspacesRoot(primaryPath) {
  if (!primaryPath) return "";
  const parent = dirname(primaryPath);
  if (basename(parent) !== "projects") return "";
  return resolve(parent, "..", "worker-workspaces");
}

const args = process.argv.slice(2);
const currentWorktreePath = resolve(git(["rev-parse", "--show-toplevel"]));
const gitCommonDir = git(["rev-parse", "--git-common-dir"]);
const worktrees = parseWorktrees(git(["worktree", "list", "--porcelain"]));
const role = valueAfter("--role", args) || valueAfter("--execution-role", args) || envValue("EXECUTION_ROLE", "ROLE");
const primaryPath = valueAfter("--primary-worktree", args) || primaryWorktreePath(worktrees, gitCommonDir);
const workerWorkspacesRoot = valueAfter("--worker-workspaces-root", args) ||
  envValue("WORKER_WORKSPACES_ROOT", "WORKER_WORKSPACE_ROOT") ||
  defaultWorkerWorkspacesRoot(primaryPath);

const gate = evaluateGitWorktreeIsolation({
  branch: git(["branch", "--show-current"]),
  porcelain: git(["status", "--porcelain=v1", "--untracked-files=all"]),
  role,
  current_worktree_path: currentWorktreePath,
  primary_worktree_path: primaryPath,
  worker_workspaces_root: workerWorkspacesRoot
});

console.log(JSON.stringify(gate, null, 2));
if (gate.status !== "pass") {
  process.exit(1);
}
