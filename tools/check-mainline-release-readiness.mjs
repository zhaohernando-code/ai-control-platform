#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { evaluateWorkbenchLiveRouteAcceptance } from "../src/workflow/live-route-acceptance.js";
import {
  DEFAULT_MAINLINE_BRANCH,
  DEFAULT_MAINLINE_REMOTE_REF,
  evaluateMainlineReleaseReadiness
} from "../src/workflow/mainline-release-readiness.js";

function usage() {
  return [
    "usage: check-mainline-release-readiness.mjs [--project-status PROJECT_STATUS.json]",
    "                                           [--remote-ref origin/main] [--branch main] [--no-fetch]",
    "",
    "Fails unless local HEAD is clean, on main, equal to remote mainline, and the configured public workbench route gate passes."
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    projectStatusPath: "PROJECT_STATUS.json",
    expectedRemoteRef: DEFAULT_MAINLINE_REMOTE_REF,
    expectedBranch: DEFAULT_MAINLINE_BRANCH,
    fetch: true
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--project-status") {
      options.projectStatusPath = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--remote-ref") {
      options.expectedRemoteRef = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--branch") {
      options.expectedBranch = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--no-fetch") {
      options.fetch = false;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function runGit(args, options = {}) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    stdio: options.stdio || ["ignore", "pipe", "pipe"]
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (options.optional) return "";
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return String(result.stdout || "").trim();
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`failed to read ${label} JSON at ${path}: ${error.message}`);
  }
}

function durableEvidenceDescriptorFromProjectStatus(projectStatus = {}) {
  const candidates = [
    projectStatus.workbench_live_route_evidence,
    projectStatus.workbenchLiveRouteEvidence,
    projectStatus.live_route_evidence,
    projectStatus.liveRouteEvidence
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (typeof candidate === "string" && candidate.trim()) {
      return { path: candidate.trim(), metadata: {} };
    }
    if (typeof candidate === "object" && !Array.isArray(candidate)) {
      const path = String(candidate.path || candidate.artifact_path || candidate.artifactPath || "").trim();
      if (path) return { path, metadata: candidate };
    }
  }
  return { path: "", metadata: {} };
}

function resolvePath(path, fromPath) {
  if (!path) return "";
  return isAbsolute(path) ? path : resolve(dirname(resolve(fromPath)), path);
}

function parseAheadBehind(value) {
  const [ahead, behind] = String(value || "").trim().split(/\s+/);
  return {
    ahead_count: Number(ahead),
    behind_count: Number(behind)
  };
}

function fetchRemoteRef(remoteRef) {
  const [remote, ...refParts] = String(remoteRef || "").split("/");
  const branch = refParts.join("/");
  if (!remote || !branch) return;
  runGit(["fetch", remote, branch], { stdio: "inherit" });
}

function buildGateInput(options) {
  const projectStatus = readJson(options.projectStatusPath, "project status");
  if (options.fetch) fetchRemoteRef(options.expectedRemoteRef);

  const evidenceDescriptor = durableEvidenceDescriptorFromProjectStatus(projectStatus);
  const envEvidencePath = process.env.WORKBENCH_LIVE_ROUTE_EVIDENCE || "";
  const evidencePath = envEvidencePath || evidenceDescriptor.path;
  const evidenceResolvedPath = resolvePath(evidencePath, options.projectStatusPath);
  if (evidenceResolvedPath && !existsSync(evidenceResolvedPath)) {
    throw new Error(`live route evidence does not exist at ${evidenceResolvedPath}`);
  }
  const liveRouteEvidence = evidenceResolvedPath ? readJson(evidenceResolvedPath, "live route evidence") : null;
  const liveRouteGate = evaluateWorkbenchLiveRouteAcceptance({
    projectStatus,
    evidenceArtifact: liveRouteEvidence,
    evidenceMetadata: evidenceDescriptor.metadata
  });
  const counts = parseAheadBehind(runGit(["rev-list", "--left-right", "--count", `HEAD...${options.expectedRemoteRef}`]));

  return {
    expected_branch: options.expectedBranch,
    expected_remote_ref: options.expectedRemoteRef,
    branch: runGit(["branch", "--show-current"]),
    head_commit: runGit(["rev-parse", "HEAD"]),
    remote_ref: options.expectedRemoteRef,
    remote_commit: runGit(["rev-parse", options.expectedRemoteRef]),
    dirty_entries: runGit(["status", "--porcelain=v1", "--untracked-files=all"], { optional: true })
      .split(/\r?\n/)
      .filter(Boolean),
    ...counts,
    live_route_gate: liveRouteGate,
    live_route_evidence: liveRouteEvidence || undefined
  };
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

try {
  const result = evaluateMainlineReleaseReadiness(buildGateInput(options));
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "pass") process.exit(1);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
