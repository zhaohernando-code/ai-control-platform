#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

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
  const executor = createAgentContextWorkPackageProviderExecutor({
    cwd: valueAfter("--cwd", args) || process.cwd(),
    stateStore,
    timeout_seconds: valueAfter("--timeout-seconds", args) || process.env.AI_CONTROL_WORKBENCH_CONTEXT_PROVIDER_TIMEOUT_SECONDS,
    channels_path: valueAfter("--channels-path", args) || process.env.AI_CONTROL_WORKBENCH_AGENT_CHANNELS_PATH,
    profiles_path: valueAfter("--profiles-path", args) || process.env.AI_CONTROL_WORKBENCH_AGENT_PROFILES_PATH
  });
  const result = runContextWorkPackages(workflowState, {
    selected_work_package_ids: selectedIds,
    max_package_count: valueAfter("--max-package-count", args) || selectedIds.length,
    execution_mode: "provider_model_routed",
    execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    created_at: createdAt,
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
      issues: result.issues || []
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
