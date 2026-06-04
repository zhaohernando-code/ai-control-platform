import { spawn } from "node:child_process";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

import { createWorkbenchProjection } from "../src/workflow/workbench-projection.js";
import {
  asArray,
  defaultSnapshotsRoot,
  examplesRoot,
  isWithinPath,
  normalizeString,
  projectionInputWithProjectStatus,
  readJson,
  readWorkflowStateFromItem,
  root,
  safeSnapshotIdPart,
  writeJson
} from "./workbench-server-state-access.mjs";
import { isSqliteSnapshotPath } from "../src/workflow/workbench-state-store.js";
import { workbenchBaseUrlFromRequest } from "./workbench-loop-client.mjs";

function generatedContextPackSnapshotId(selectedId) {
  return `context-pack-cycle-${safeSnapshotIdPart(selectedId)}-${Date.now()}`.slice(0, 80);
}

function artifactsOf(workflowState = {}) {
  return [
    ...asArray(workflowState?.artifact_ledger?.artifacts || workflowState?.artifactLedger?.artifacts),
    ...asArray(workflowState?.manifest?.artifacts)
  ];
}

function latestArtifactForEvent(workflowState = {}, eventType) {
  const event = asArray(workflowState?.manifest?.events)
    .filter((entry) => entry?.type === eventType)
    .at(-1) || null;
  if (!event) return { event: null, artifact: null, metadata: null };

  const artifact = artifactsOf(workflowState).find((entry) => entry?.id === event.artifact_id) || null;
  return {
    event,
    artifact,
    metadata: artifact?.metadata || event.metadata || null
  };
}

function latestSchedulerDispatchRun(workflowState = {}) {
  return latestArtifactForEvent(workflowState, "scheduler_dispatch_run");
}

function schedulerContinuationOutputPath(runArtifact = {}) {
  return normalizeString(runArtifact?.input?.plan?.continuation_output?.path);
}

function safeGeneratedContinuationPath(itemPath, allowedRoots) {
  if (!itemPath) {
    const error = new Error("scheduler dispatch continuation output path is required");
    error.code = "INVALID_CONTINUATION_PATH";
    throw error;
  }
  if (typeof itemPath !== "string") {
    const error = new Error("scheduler dispatch continuation output path must be a string");
    error.code = "INVALID_CONTINUATION_PATH";
    throw error;
  }
  const filePath = isAbsolute(itemPath) ? resolve(itemPath) : resolve(root, itemPath);
  if (!allowedRoots.some((allowedRoot) => isWithinPath(allowedRoot, filePath))) {
    const error = new Error("scheduler dispatch continuation output path must stay under controlled roots");
    error.code = "INVALID_CONTINUATION_PATH";
    throw error;
  }
  return filePath;
}

function generatedContinuationInputIssues(generated = {}, prepared = {}) {
  const issues = [];
  if (!generated || typeof generated !== "object" || Array.isArray(generated)) {
    return ["generated continuation input must be an object"];
  }
  if (generated.project_status?.project !== "ai-control-platform") {
    issues.push("generated continuation input must target ai-control-platform");
  }
  const generatedManifest = generated.workflow_state?.manifest || {};
  const expectedRunId = prepared.scheduler_dispatch?.run_id;
  const expectedCycleId = prepared.scheduler_dispatch?.cycle_id;
  if (expectedRunId && generatedManifest.run_id !== expectedRunId) {
    issues.push("generated continuation input run_id must match scheduler dispatch run");
  }
  if (expectedCycleId && generatedManifest.cycle_id !== expectedCycleId) {
    issues.push("generated continuation input cycle_id must match scheduler dispatch run");
  }
  const expectedWorkPackages = asArray(prepared.next_decision?.next_work_packages).length;
  const generatedNextPackages = [
    ...asArray(generated.project_status?.next_work_packages),
    ...asArray(generated.projectStatus?.next_work_packages),
    ...asArray(generated.run_evaluation?.next_work_packages),
    ...asArray(generated.runEvaluation?.next_work_packages)
  ];
  const generatedWorkPackages = generatedNextPackages.length > 0
    ? generatedNextPackages.length
    : asArray(generated.workflow_state?.manifest?.work_packages).length;
  if (expectedWorkPackages !== generatedWorkPackages) {
    issues.push("generated continuation input work package count must match replay-validated continuation");
  }
  return issues;
}

function projectionHistoryWithReadiness(history = {}, allowedRoots = [examplesRoot, defaultSnapshotsRoot], projectStatusPath = null, stateStore = null) {
  return {
    ...history,
    items: asArray(history.items).map((item) => {
      if (!item?.input_path) return item;
      try {
        const workflowState = readWorkflowStateFromItem(item, allowedRoots, stateStore);
        const projection = createWorkbenchProjection(projectionInputWithProjectStatus(workflowState, projectStatusPath, stateStore));
        return {
          ...item,
          scheduler_dispatch: {
            status: projection.scheduler_dispatch.status,
            phase: projection.scheduler_dispatch.phase,
            artifact_id: projection.scheduler_dispatch.artifact_id,
            continuation_status: projection.scheduler_continuation.continuation_status || projection.scheduler_dispatch.next_continuation_status,
            continuation_ready: projection.scheduler_continuation.ready,
            enqueue_status: projection.scheduler_continuation.enqueue_status,
            enqueue_available: projection.scheduler_continuation.enqueue_available,
            continuation_input_path: projection.scheduler_continuation.continuation_input_path,
            next_continuation_action: projection.scheduler_dispatch.next_continuation_action,
            next_work_package_count: projection.scheduler_continuation.next_work_package_count || projection.scheduler_dispatch.next_work_package_count,
            latest_issue: projection.scheduler_continuation.latest_issue
          },
          scheduler_loop: {
            status: projection.scheduler_loop.status,
            phase: projection.scheduler_loop.phase,
            run_count: projection.scheduler_loop.run_count,
            invalid_count: projection.scheduler_loop.invalid_count,
            iteration_count: projection.scheduler_loop.iteration_count,
            recovery_status: projection.scheduler_loop.recovery_status,
            recovery_action: projection.scheduler_loop.recovery_action,
            resumable: projection.scheduler_loop.resumable,
            resume_projection_id: projection.scheduler_loop.resume_projection_id,
            execution_strategy: projection.scheduler_loop.execution_strategy,
            execution_profile: projection.scheduler_loop.execution_profile,
            latest_projection_id: projection.scheduler_loop.latest_projection_id,
            latest_issue: projection.scheduler_loop.latest_issue
          }
        };
      } catch (error) {
        return {
          ...item,
          scheduler_dispatch: {
            status: "history_read_failed",
            continuation_ready: false,
            enqueue_available: false,
            latest_issue: error.message
          },
          scheduler_loop: {
            status: "history_read_failed",
            recovery_status: "blocked",
            recovery_action: "repair_history_input",
            resumable: false,
            latest_issue: error.message
          }
        };
      }
    })
  };
}

function metadataPath(filePath) {
  return isWithinPath(root, filePath) ? relative(root, filePath) : filePath;
}

function writePreparedSchedulerContinuation(runArtifact, prepared, allowedOutputRoots) {
  const outputPath = safeGeneratedContinuationPath(schedulerContinuationOutputPath(runArtifact), allowedOutputRoots);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(prepared.continuation_input, null, 2)}\n`);
  return outputPath;
}

function backgroundContextWorkPackageRequested(input = {}) {
  const mode = normalizeString(input.dispatch_mode || input.dispatchMode || input.run_mode || input.runMode).toLowerCase();
  return input.background === true ||
    input.async === true ||
    mode === "background" ||
    mode === "async";
}

function backgroundContextWorkPackageOutputPath(dispatchRunId) {
  return resolve(root, "tmp/context-work-package-background-jobs", `${dispatchRunId}.json`);
}

function launchContextWorkPackageBackgroundJob(input = {}) {
  const args = [
    resolve(root, "tools/run-context-work-packages-background-job.mjs"),
    "--state-db", input.state_db,
    "--snapshot-id", input.snapshot_id,
    "--output", input.output_path,
    "--selected-work-package-ids", input.selected_work_package_ids.join(","),
    "--dispatch-run-id", input.dispatch_run_id,
    "--created-at", input.created_at,
    "--cwd", root
  ];
  if (input.timeout_seconds) args.push("--timeout-seconds", String(input.timeout_seconds));
  if (input.idle_timeout_seconds) args.push("--idle-timeout-seconds", String(input.idle_timeout_seconds));
  if (input.channels_path) args.push("--channels-path", input.channels_path);
  if (input.profiles_path) args.push("--profiles-path", input.profiles_path);
  const child = spawn(process.execPath, args, {
    cwd: root,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      AI_CONTROL_WORKBENCH_CONTEXT_PROVIDER_TIMEOUT_SECONDS: String(input.timeout_seconds || process.env.AI_CONTROL_WORKBENCH_CONTEXT_PROVIDER_TIMEOUT_SECONDS || ""),
      AI_CONTROL_WORKBENCH_CONTEXT_PROVIDER_IDLE_TIMEOUT_SECONDS: String(input.idle_timeout_seconds || process.env.AI_CONTROL_WORKBENCH_CONTEXT_PROVIDER_IDLE_TIMEOUT_SECONDS || "")
    }
  });
  child.unref();
  return {
    status: "started",
    pid: child.pid,
    output_path: input.output_path
  };
}

function schedulerDispatchRunArtifactFromInput(input = {}) {
  return input.artifact || input.run_artifact || input.runArtifact || input;
}

function schedulerDispatchRunIssues(input = {}) {
  const artifact = schedulerDispatchRunArtifactFromInput(input);
  const issues = [];

  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    return ["scheduler dispatch run artifact must be an object"];
  }
  if (artifact.version !== "scheduler-dispatch-run.v1") {
    issues.push("scheduler dispatch run artifact version must be scheduler-dispatch-run.v1");
  }
  if (!["pass", "fail"].includes(String(artifact.status || ""))) {
    issues.push("scheduler dispatch run artifact status must be pass or fail");
  }
  if (!artifact.result || typeof artifact.result !== "object" || Array.isArray(artifact.result)) {
    issues.push("scheduler dispatch run artifact result is required");
  }
  if (artifact.result && !Array.isArray(artifact.result.steps)) {
    issues.push("scheduler dispatch run artifact result.steps must be an array");
  }

  return issues;
}

function latestAvailableSchedulerWorkflowStatePath(runResult = {}) {
  for (const step of [...(Array.isArray(runResult.steps) ? runResult.steps : [])].reverse()) {
    const workflowStateOutput = step.outputs?.workflow_state;
    if (workflowStateOutput?.status === "available" && workflowStateOutput.path) {
      return workflowStateOutput.path;
    }
  }
  return "";
}

function readSchedulerWorkflowStateOutput(runResult = {}) {
  const outputPath = latestAvailableSchedulerWorkflowStatePath(runResult);
  if (!outputPath) {
    return {
      status: "fail",
      issues: [{
        code: "missing_scheduler_workflow_state_output",
        message: "agent lifecycle cleanup scheduler dispatch did not produce an available workflow state output",
        path: "result.steps.outputs.workflow_state"
      }]
    };
  }

  try {
    return {
      status: "pass",
      workflow_state: readJson(resolve(root, outputPath)),
      output_path: outputPath
    };
  } catch (error) {
    return {
      status: "fail",
      issues: [{
        code: "unreadable_scheduler_workflow_state_output",
        message: error.message,
        path: outputPath
      }]
    };
  }
}

function schedulerPlanInputFromWorkflowState(workflowState, input = {}) {
  return {
    project_status: {
      project: "ai-control-platform",
      blockers: [],
      next_step: input.next_step || input.nextStep || ""
    },
    run_evaluation: input.run_evaluation || input.runEvaluation || { status: "pass" },
    workflow_state: workflowState
  };
}

function materializeSchedulerWorkflowInput(selectedId, workflowState) {
  const inputPath = `tmp/workbench-scheduler-inputs/${safeSnapshotIdPart(selectedId)}-${Date.now()}.json`;
  const absolutePath = resolve(root, inputPath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeJson(absolutePath, workflowState);
  return inputPath;
}

function schedulerPlanOptionsFromRequest(req, item, selectedId, input = {}, workflowState = null) {
  const workflowStateInputPath = isSqliteSnapshotPath(item.input_path)
    ? materializeSchedulerWorkflowInput(selectedId, workflowState)
    : item.input_path;
  return {
    workflow_state_input_path: workflowStateInputPath,
    workbench_writeback_mode: "service",
    workbench_base_url: workbenchBaseUrlFromRequest(req),
    projection_id: selectedId,
    reviewer_mock_status: input.reviewer_mock_status || input.reviewerMockStatus,
    reviewer_mock_findings_json: input.reviewer_mock_findings_json || input.reviewerMockFindingsJson,
    next_step: input.next_step || input.nextStep
  };
}

export {
  backgroundContextWorkPackageOutputPath,
  backgroundContextWorkPackageRequested,
  generatedContextPackSnapshotId,
  generatedContinuationInputIssues,
  latestArtifactForEvent,
  latestSchedulerDispatchRun,
  launchContextWorkPackageBackgroundJob,
  metadataPath,
  projectionHistoryWithReadiness,
  readSchedulerWorkflowStateOutput,
  safeGeneratedContinuationPath,
  schedulerContinuationOutputPath,
  schedulerDispatchRunArtifactFromInput,
  schedulerDispatchRunIssues,
  schedulerPlanInputFromWorkflowState,
  schedulerPlanOptionsFromRequest,
  writePreparedSchedulerContinuation
};
