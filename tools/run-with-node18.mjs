#!/usr/bin/env node
import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import { spawnSync } from "node:child_process";

const MIN_MAJOR = 18;
const FALLBACK_NODE_PATHS = [
  process.env.AI_CONTROL_PLATFORM_NODE,
  "/Users/hernando_zhao/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
].filter(Boolean);

function major(version) {
  return Number(String(version || "").split(".")[0]);
}

function candidateVersion(nodePath) {
  const result = spawnSync(nodePath, ["-p", "process.versions.node"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function findPathCandidate(command) {
  const result = spawnSync("sh", ["-lc", `command -v ${command}`], { encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function findNodeRuntime() {
  if (major(process.versions.node) >= MIN_MAJOR) return process.execPath;

  for (const nodePath of FALLBACK_NODE_PATHS) {
    if (existsSync(nodePath) && major(candidateVersion(nodePath)) >= MIN_MAJOR) {
      return nodePath;
    }
  }

  for (const command of ["node24", "node22", "node20", "node18"]) {
    const nodePath = findPathCandidate(command);
    if (nodePath && major(candidateVersion(nodePath)) >= MIN_MAJOR) {
      return nodePath;
    }
  }

  return null;
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: run-with-node18.mjs <script-or-command> [...args]");
  process.exit(2);
}

const nodePath = findNodeRuntime();
if (!nodePath) {
  console.error(`Node.js ${MIN_MAJOR}+ is required, current runtime is ${process.versions.node}, and no fallback runtime was found.`);
  process.exit(1);
}

const nodeBinDir = nodePath.slice(0, nodePath.lastIndexOf("/"));
const env = {
  ...process.env,
  PATH: [nodeBinDir, process.env.PATH].filter(Boolean).join(delimiter)
};

const result = spawnSync(nodePath, args, { stdio: "inherit", env });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
