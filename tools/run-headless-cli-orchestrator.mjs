#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { runHeadlessCliMainOrchestrator } from "../src/workflow/headless-cli-orchestrator.js";

function valueAfter(flag, args) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : "";
}

function hasFlag(flag, args) {
  return args.includes(flag);
}

function usage() {
  return [
    "Usage: node tools/run-headless-cli-orchestrator.mjs --project-status PROJECT_STATUS.json --workflow-state docs/examples/current-session-workbench-input.json --output tmp/headless-cli-orchestrator-output.json",
    "",
    "Runs one bounded headless Codex CLI main_orchestrator cycle from durable repository state."
  ].join("\n");
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch (error) {
    throw new Error(`${label} read failed: ${error.message}`);
  }
}

const args = process.argv.slice(2);
if (hasFlag("--help", args) || hasFlag("-h", args)) {
  console.log(usage());
  process.exit(0);
}

const projectStatusPath = valueAfter("--project-status", args);
const workflowStatePath = valueAfter("--workflow-state", args);
const projectionHistoryPath = valueAfter("--projection-history", args);
const outputPath = valueAfter("--output", args);
const workflowOutputPath = valueAfter("--workflow-output", args);

if (!projectStatusPath || !workflowStatePath || !outputPath) {
  console.error(usage());
  process.exit(1);
}

let result;
try {
  const projectStatus = readJson(projectStatusPath, "PROJECT_STATUS");
  const workflowState = readJson(workflowStatePath, "workflow_state");
  const projectionHistory = projectionHistoryPath
    ? readJson(projectionHistoryPath, "projection_history")
    : null;

  result = runHeadlessCliMainOrchestrator({
    role: "main_orchestrator",
    project_status: projectStatus,
    workflow_state: workflowState,
    projection_history: projectionHistory
  }, {
    cycle_id: valueAfter("--cycle-id", args),
    created_at: valueAfter("--created-at", args),
    max_package_count: valueAfter("--max-package-count", args) || 1
  });
} catch (error) {
  result = {
    status: "blocked",
    phase: "headless_cli_orchestrator_cli",
    role: "main_orchestrator",
    issues: [{ code: "headless_cli_orchestrator_cli_failed", message: error.message, path: "" }]
  };
}

const resolvedOutput = resolve(outputPath);
mkdirSync(dirname(resolvedOutput), { recursive: true });
writeFileSync(resolvedOutput, `${JSON.stringify(result, null, 2)}\n`);

if (workflowOutputPath && result.workflow_state) {
  const resolvedWorkflowOutput = resolve(workflowOutputPath);
  mkdirSync(dirname(resolvedWorkflowOutput), { recursive: true });
  writeFileSync(resolvedWorkflowOutput, `${JSON.stringify(result.workflow_state, null, 2)}\n`);
}

const summary = {
  status: result.status,
  phase: result.phase,
  role: result.role,
  output: resolvedOutput,
  workflow_output: workflowOutputPath ? resolve(workflowOutputPath) : null,
  child_role: result.child_role || null,
  context_pack_host: result.context_pack?.host || null,
  lifecycle_status: result.lifecycle_cleanup?.after?.status || null,
  next_action: result.projection?.next_action_readout?.action || null,
  must_continue: result.must_continue ?? null,
  issue_count: Array.isArray(result.issues) ? result.issues.length : 0
};

if (result.status === "pass" || result.status === "complete") {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.error(JSON.stringify(summary, null, 2));
  process.exit(1);
}
