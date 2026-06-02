#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { createSelfGovernanceReport } from "../src/workflow/self-governance.js";

function valueAfter(flag, args = process.argv.slice(2)) {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

function hasFlag(flag, args = process.argv.slice(2)) {
  return args.includes(flag);
}

function ensureParent(path) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
}

function readJsonIfExists(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function runCommand(id, command, args, { json = true, allowFail = true } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20
  });
  const commandLine = [command, ...args].join(" ");
  if (result.error) {
    return {
      id,
      command: commandLine,
      status: "error",
      error: result.error.message,
      stdout: result.stdout || "",
      stderr: result.stderr || ""
    };
  }

  let parsed = null;
  if (json) {
    try {
      parsed = JSON.parse(result.stdout || "{}");
    } catch (error) {
      parsed = null;
      if (result.status === 0) {
        return {
          id,
          command: commandLine,
          status: "error",
          exit_code: result.status,
          error: `command did not return JSON: ${error.message}`,
          stdout: result.stdout || "",
          stderr: result.stderr || ""
        };
      }
    }
  }

  return {
    id,
    command: commandLine,
    status: result.status === 0 || allowFail ? (parsed?.status || (result.status === 0 ? "pass" : "fail")) : "fail",
    exit_code: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    artifact: parsed,
    artifact_status: parsed?.status || null
  };
}

function frontendAcceptanceResult(outputPath) {
  const args = [
    "tools/run-with-node18.mjs",
    "tools/check-workbench-next-frontend-acceptance.mjs",
    "--output",
    outputPath,
    "--allow-fail"
  ];
  const result = runCommand("workbench-frontend-acceptance", "node", args, { json: true, allowFail: true });
  return {
    ...result,
    artifact: readJsonIfExists(outputPath) || result.artifact
  };
}

function normalizeGate(result) {
  return result.artifact && typeof result.artifact === "object"
    ? result.artifact
    : {
      status: result.status === "pass" ? "pass" : "fail",
      issues: [
        {
          code: `${result.id}_unavailable`,
          message: result.error || result.stderr || `${result.command} did not produce a readable artifact`
        }
      ]
    };
}

const args = process.argv.slice(2);
const outputPath = valueAfter("--output", args) || "tmp/self-governance-scan/report.json";
const evidencePath = valueAfter("--evidence-output", args) || "tmp/self-governance-scan/evidence.json";
const skipFrontend = hasFlag("--skip-frontend", args);

const commandResults = [
  runCommand("git-worktree-isolation", "node", ["tools/check-git-worktree-isolation.mjs"], { json: true, allowFail: true }),
  runCommand("process-hardening", "node", ["tools/check-process-hardening.mjs", "docs/examples/process-hardening-current.json"], { json: true, allowFail: true })
];
if (!skipFrontend) {
  commandResults.push(frontendAcceptanceResult("tmp/self-governance-scan/frontend-acceptance.json"));
}

const projectStatus = readJsonIfExists("PROJECT_STATUS.json") || {};
const governanceSources = {
  require_scanner_findings: true,
  evidence_sources: commandResults.map((result) => result.id),
  project_status: projectStatus,
  command_results: commandResults.map((result) => ({
    id: result.id,
    command: result.command,
    status: result.status,
    exit_code: result.exit_code,
    artifact_status: result.artifact_status,
    error: result.error,
    stdout: result.stdout?.slice(0, 4000),
    stderr: result.stderr?.slice(0, 4000)
  })),
  git_worktree_isolation: normalizeGate(commandResults.find((result) => result.id === "git-worktree-isolation")),
  process_hardening: normalizeGate(commandResults.find((result) => result.id === "process-hardening")),
  frontend_acceptance: commandResults.find((result) => result.id === "workbench-frontend-acceptance")?.artifact || { status: "not_configured" }
};

const report = createSelfGovernanceReport({
  created_at: new Date().toISOString(),
  generate_findings: true,
  governance_sources: governanceSources
});
const evidence = {
  version: "self-governance-scan-evidence.v1",
  status: "pass",
  command_results: commandResults,
  governance_sources: governanceSources
};

ensureParent(outputPath);
ensureParent(evidencePath);
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({
  status: report.status,
  output: outputPath,
  evidence_output: evidencePath,
  finding_count: report.finding_count,
  auto_repair_count: report.auto_repair.count,
  evidence_building_count: report.evidence_building.count,
  user_decision_count: report.user_decisions.count
}, null, 2));
