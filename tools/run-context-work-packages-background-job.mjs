#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

import { VERIFIED_PROVIDER_MULTI_AGENT_PROFILE } from "../src/workflow/context-work-package-execution-adapter.js";
import { createAgentContextWorkPackageProviderExecutor } from "../src/workflow/context-work-package-provider-executor.js";
import {
  markContextWorkPackageDispatchFailed,
  runContextWorkPackages
} from "../src/workflow/context-work-package-runner.js";
import { createSqliteWorkbenchStateStore } from "../src/workflow/workbench-state-store.js";

function usage() {
  return [
    "Usage: node tools/run-context-work-packages-background-job.mjs --state-db <workbench-state.sqlite> --snapshot-id <id> --output <artifact.json>",
    "",
    "Options:",
    "  --selected-work-package-ids <csv>  Required ids staged as running by the API",
    "  --dispatch-run-id <id>             Dispatch run id recorded on the staged packages",
    "  --max-package-count <n>            Dispatch at most this many packages when ids are omitted",
    "  --created-at <iso>                 Stable timestamp for run artifacts",
    "  --cwd <path>                       Provider agent cwd; defaults to current working directory",
    "  --timeout-seconds <seconds>        Provider agent timeout",
    "  --channels-path <path>             Agent channels config",
    "  --profiles-path <path>             Agent profiles config"
  ].join("\n");
}

function valueAfter(flag, args) {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  return args[index + 1] || null;
}

function hasFlag(flag, args) {
  return args.includes(flag);
}

function normalizeString(value) {
  return String(value || "").trim();
}

function csvValues(value) {
  return normalizeString(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function safeIdPart(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function selectedWorkPackages(workflowState = {}, selectedIds = []) {
  const selected = new Set(selectedIds.map(normalizeString).filter(Boolean));
  return (workflowState.manifest?.work_packages || [])
    .filter((workPackage) => selected.has(normalizeString(workPackage?.id || workPackage?.work_package_id)));
}

function workPackageRequiresCodeOutput(workPackage = {}) {
  const action = normalizeString(workPackage.action || workPackage.type).toLowerCase();
  const title = normalizeString(workPackage.title || workPackage.reason).toLowerCase();
  if (action === "execute_requirement_plan_step") return true;
  if (/implement|implementation|repair|fix|code|generate|write|modify|refactor/.test(action)) return true;
  if (/实施|修复|代码|生成|修改|重构|实现/.test(title)) return true;
  return false;
}

function isWorkerWorktree(path = "") {
  return resolve(path).split(/[\\/]+/).includes("worker-workspaces");
}

function createExecutionWorktree(repoRoot = "", dispatchRunId = "") {
  const root = resolve(repoRoot || process.cwd());
  if (isWorkerWorktree(root)) {
    return { status: "pass", path: root, branch: null, reused: true };
  }
  const codexRoot = resolve(root, "..", "..");
  const projectId = root.split(/[\\/]+/).pop() || "ai-control-platform";
  const workerBase = join(codexRoot, "worker-workspaces", projectId);
  mkdirSync(workerBase, { recursive: true });
  const slug = safeIdPart(dispatchRunId || `context-work-package-${Date.now()}`).slice(0, 80);
  const worktreePath = join(workerBase, slug);
  const branchName = `worker/${slug}`;
  const result = spawnSync("git", ["-C", root, "worktree", "add", "-b", branchName, worktreePath, "HEAD"], {
    encoding: "utf8",
    timeout: 30000
  });
  if (result.status !== 0) {
    return {
      status: "fail",
      path: worktreePath,
      branch: branchName,
      error: normalizeString(result.stderr) || normalizeString(result.stdout) || "git worktree add failed"
    };
  }
  return { status: "pass", path: worktreePath, branch: branchName, reused: false };
}

function writeJson(path, value) {
  const destination = resolve(path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`);
  return destination;
}

function nowIso() {
  return new Date().toISOString();
}

const args = process.argv.slice(2);
if (hasFlag("--help", args) || hasFlag("-h", args)) {
  console.log(usage());
  process.exit(0);
}

const stateDb = valueAfter("--state-db", args);
const snapshotId = valueAfter("--snapshot-id", args);
const outputPath = valueAfter("--output", args);
const selectedIds = csvValues(valueAfter("--selected-work-package-ids", args));
const dispatchRunId = valueAfter("--dispatch-run-id", args);
const createdAt = valueAfter("--created-at", args) || nowIso();

if (!stateDb || !snapshotId || !outputPath || selectedIds.length === 0) {
  console.error(usage());
  process.exit(2);
}

const stateStore = createSqliteWorkbenchStateStore({
  dbPath: stateDb
});

let workflowState;
let artifact;
let exitCode = 0;

try {
  workflowState = stateStore.readWorkflowSnapshot(snapshotId);
  const requestedCwd = resolve(valueAfter("--cwd", args) || process.cwd());
  const selectedPackages = selectedWorkPackages(workflowState, selectedIds);
  const requiresCodeOutput = selectedPackages.some(workPackageRequiresCodeOutput);
  const executionWorktree = requiresCodeOutput
    ? createExecutionWorktree(requestedCwd, dispatchRunId)
    : { status: "pass", path: requestedCwd, branch: null, reused: true };
  if (executionWorktree.status !== "pass") {
    throw new Error(`failed to create isolated execution worktree: ${executionWorktree.error}`);
  }
  const providerCwd = executionWorktree.path;
  const executor = createAgentContextWorkPackageProviderExecutor({
    cwd: providerCwd,
    stateStore,
    timeout_seconds: valueAfter("--timeout-seconds", args) || process.env.AI_CONTROL_WORKBENCH_CONTEXT_PROVIDER_TIMEOUT_SECONDS,
    idle_timeout_seconds: valueAfter("--idle-timeout-seconds", args) || process.env.AI_CONTROL_WORKBENCH_CONTEXT_PROVIDER_IDLE_TIMEOUT_SECONDS,
    no_tools: !requiresCodeOutput,
    channels_path: valueAfter("--channels-path", args) || process.env.AI_CONTROL_WORKBENCH_AGENT_CHANNELS_PATH,
    profiles_path: valueAfter("--profiles-path", args) || process.env.AI_CONTROL_WORKBENCH_AGENT_PROFILES_PATH
  });
  const result = runContextWorkPackages(workflowState, {
    selected_work_package_ids: selectedIds,
    max_package_count: valueAfter("--max-package-count", args) || selectedIds.length,
    execution_mode: "provider_model_routed",
    execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    created_at: createdAt,
    execution_cwd: providerCwd,
    primary_worktree_path: requestedCwd,
    worker_worktree: executionWorktree,
    provider_executor: executor
  });

  if (result.status === "pass") {
    stateStore.writeWorkflowSnapshot(snapshotId, result.workflow_state);
    if (result.workflow_state?.project_status) {
      stateStore.writeProjectStatus(result.workflow_state.project_status);
    }
  } else {
    const latestState = stateStore.readWorkflowSnapshot(snapshotId);
    const failed = markContextWorkPackageDispatchFailed(latestState, {
      selected_work_package_ids: selectedIds,
      dispatch_run_id: dispatchRunId,
      created_at: createdAt,
      issues: result.issues || [],
      package_results: result.package_results || result.artifact?.metadata?.package_results || [],
      executor_provenance: result.executor_provenance || result.artifact?.metadata?.executor_provenance || null,
      dispatch_artifact: {
        path: resolve(outputPath),
        status: result.status,
        phase: result.phase
      }
    });
    if (failed.status === "pass") {
      stateStore.writeWorkflowSnapshot(snapshotId, failed.workflow_state);
      if (failed.workflow_state?.project_status) {
        stateStore.writeProjectStatus(failed.workflow_state.project_status);
      }
    }
    exitCode = 1;
  }

  artifact = {
    version: "context-work-packages-background-job.v1",
    status: result.status,
    phase: result.phase,
    created_at: createdAt,
    snapshot_id: snapshotId,
    dispatch_run_id: dispatchRunId,
    selected_work_package_ids: selectedIds,
    result: {
      status: result.status,
      phase: result.phase,
      executed_count: result.executed_count || 0,
      executed_work_packages: result.executed_work_packages || [],
      issues: result.issues || [],
      artifact: result.artifact || null,
      package_results: result.package_results || result.artifact?.metadata?.package_results || [],
      executor_provenance: result.executor_provenance || result.artifact?.metadata?.executor_provenance || null,
      worker_worktree: executionWorktree,
      completion_authority: result.completion_authority || result.artifact?.metadata?.completion_authority || null
    }
  };
} catch (error) {
  exitCode = 1;
  try {
    const latestState = workflowState || stateStore.readWorkflowSnapshot(snapshotId);
    const failed = markContextWorkPackageDispatchFailed(latestState, {
      selected_work_package_ids: selectedIds,
      dispatch_run_id: dispatchRunId,
      created_at: createdAt,
      issues: [{ code: "background_context_work_package_job_failed", message: error.message, path: "background_job" }]
    });
    if (failed.status === "pass") {
      stateStore.writeWorkflowSnapshot(snapshotId, failed.workflow_state);
      if (failed.workflow_state?.project_status) {
        stateStore.writeProjectStatus(failed.workflow_state.project_status);
      }
    }
  } catch {
    // Preserve the original failure in the job artifact.
  }
  artifact = {
    version: "context-work-packages-background-job.v1",
    status: "fail",
    phase: "background_job_exception",
    created_at: createdAt,
    snapshot_id: snapshotId,
    dispatch_run_id: dispatchRunId,
    selected_work_package_ids: selectedIds,
    issues: [{ code: "background_context_work_package_job_failed", message: error.message, path: "background_job" }]
  };
}

const artifactPath = writeJson(outputPath, artifact);
console.log(JSON.stringify({
  status: artifact.status,
  phase: artifact.phase,
  output: artifactPath,
  snapshot_id: snapshotId,
  selected_work_package_ids: selectedIds
}, null, 2));

process.exit(exitCode);
