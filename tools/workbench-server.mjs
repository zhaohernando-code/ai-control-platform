#!/usr/bin/env node
import { createServer } from "node:http";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { createWorkbenchProjection } from "../src/workflow/workbench-projection.js";
import { publishWorkbenchSnapshot, snapshotIssues } from "../src/workflow/workbench-snapshots.js";
import { createSchedulerDispatchPlan } from "../src/workflow/scheduler-dispatch-plan.js";
import {
  evaluateSchedulerDispatchControlPolicy,
  normalizeSchedulerDispatchControlRequest,
  recordSchedulerDispatchPolicyDecision
} from "../src/workflow/scheduler-dispatch-policy.js";
import { runAgentHealthCheck } from "../src/workflow/agent-health-checker.js";
import {
  createSchedulerDispatchRunArtifact,
  recordSchedulerDispatchRunArtifact,
  runSchedulerDispatchPlan
} from "../src/workflow/scheduler-dispatch-runner.js";
import {
  prepareSchedulerDispatchContinuationFromRunArtifact,
  recordSchedulerDispatchContinuationPrepared,
  recordSchedulerNextCycleEnqueue
} from "../src/workflow/scheduler-dispatch-continuation.js";
import {
  buildSchedulerLoopRunRegistry,
  createSchedulerLoopRunArtifact,
  evaluateSchedulerLoopRecovery,
  recordAutonomousSchedulerLoopRunArtifact,
  recordSchedulerLoopResumeAttempt,
  runSchedulerLoopDriver
} from "../src/workflow/autonomous-scheduler-loop.js";
import { createAgentContextWorkPackageProviderExecutor } from "../src/workflow/context-work-package-provider-executor.js";
import {
  prepareContinuationFromProjectStatus,
  recordProjectStatusContinuationPrepared
} from "../src/workflow/project-status-continuation.js";
import { materializeContextPackCycleFromWorkflowState } from "../src/workflow/context-pack-cycle.js";
import {
  runContextWorkPackages,
  stageContextWorkPackageDispatch
} from "../src/workflow/context-work-package-runner.js";
import {
  createSqliteWorkbenchStateStore,
  isSqliteSnapshotPath,
  mergeProjectStatusHistory,
  sqliteSnapshotIdFromInputPath,
  sqliteSnapshotInputPath
} from "../src/workflow/workbench-state-store.js";
import { createAgentKeyRouteHandler } from "./workbench-agent-key-routes.mjs";
import { handleWorkbenchBasicRoutes } from "./workbench-basic-routes.mjs";
import { createMainlineAlreadySatisfiedEvaluator } from "./workbench-mainline-evaluator.mjs";
import { handleRequirementRoutes } from "./workbench-requirement-routes.mjs";
import {
  generateRequirementPlanIfRequested,
  requirementAutoAdvanceAllowedAfterPlanReview,
  requirementAutoAdvanceEnabled,
  requirementPlanGenerationRunsInBackground,
  runRequirementAutoAdvance,
  startRequirementPlanGenerationInBackground,
  workflowStateWithProjectStatus
} from "./workbench-requirement-services.mjs";
import { handleReviewerRoutes } from "./workbench-reviewer-routes.mjs";
import { handleSchedulerDispatchRoutes } from "./workbench-scheduler-dispatch-routes.mjs";
import { handleSchedulerLoopRoutes } from "./workbench-scheduler-loop-routes.mjs";
import { createWorkbenchStaticRouteHandler } from "./workbench-static-routes.mjs";
import { handleWorkflowEvidenceRoutes } from "./workbench-workflow-evidence-routes.mjs";
import {
  DEFAULT_JSON_BODY_LIMIT_BYTES,
  jsonResponse,
  readJsonBody
} from "./workbench-http-utils.mjs";
import {
  contextWorkPackageRunOptions,
  createWorkbenchLoopClient,
  executeProjectedNextAction,
  workbenchBaseUrlFromRequest
} from "./workbench-loop-client.mjs";
import {
  normalizeCliPort,
  parseWorkbenchServerCliArgs,
  workbenchServerHelpText
} from "./workbench-server-cli.mjs";

const root = resolve(process.cwd());
const historyPath = resolve(root, "docs/examples/projection-history.json");
const defaultEventsPath = resolve(root, "docs/examples/operator-events.json");
const defaultProjectStatusPath = resolve(root, "PROJECT_STATUS.json");
const examplesRoot = resolve(root, "docs/examples");
const defaultSnapshotsRoot = resolve(root, "tmp/workbench-snapshots");
const defaultStateDbPath = resolve(process.env.HOME || "/Users/hernando_zhao", "codex/runtime/ai-control-platform/workbench-state/workbench-state.sqlite");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readProjectStatus(projectStatusPath = null, stateStore = null) {
  if (stateStore) return stateStore.readProjectStatus();
  return projectStatusPath ? readJson(projectStatusPath) : null;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function writeProjectStatusState(projectStatusPath = null, projectStatus = {}, stateStore = null) {
  if (stateStore) return stateStore.writeProjectStatus(projectStatus);
  if (!projectStatusPath) return null;
  return writeJson(projectStatusPath, projectStatus);
}

/**
 * Create an initial workflow state with all required identity fields and
 * validation contracts (manifest/artifact_ledger run_id/cycle_id, model_plan,
 * operator_event_ledger). Used when there is no existing workflow snapshot
 * to bootstrap from.
 */
function createInitialWorkflowState(runId, cycleId, projectStatusPath = null, stateStore = null) {
  return {
    run_id: runId,
    cycle_id: cycleId,
    status: "pending",
    manifest: {
      run_id: runId,
      cycle_id: cycleId,
      events: [],
      artifacts: []
    },
    artifact_ledger: {
      run_id: runId,
      cycle_id: cycleId,
      artifacts: []
    },
    model_plan: {
      selected_model: "deepseek-v4-pro[1m]",
      routes: []
    },
    reviewer_gate: { findings: [] },
    operator_event_ledger: {
      run_id: runId,
      cycle_id: cycleId,
      events: []
    },
    project_status: readProjectStatus(projectStatusPath, stateStore) || {}
  };
}

function projectStatusFromHistory(history = {}, selectedId = "", allowedRoots = [examplesRoot, defaultSnapshotsRoot], stateStore = null) {
  const items = Array.isArray(history.items) ? [...history.items].reverse() : [];
  const statuses = [];
  for (const item of items) {
    if (!item?.input_path) continue;
    try {
      const workflowState = readWorkflowStateFromItem(item, allowedRoots, stateStore);
      if (workflowState?.project_status || workflowState?.projectStatus) {
        statuses.push(workflowState.project_status || workflowState.projectStatus);
      }
    } catch {
      // Stale history entries should not prevent the current projection from rendering.
    }
    if (selectedId && item.id === selectedId) break;
  }
  return mergeProjectStatusHistory(...statuses);
}

function projectionInputWithProjectStatus(input = {}, projectStatusPath = null, stateStore = null, context = {}) {
  const projectStatus = readProjectStatus(projectStatusPath, stateStore);
  const historicalProjectStatus = context.history
    ? projectStatusFromHistory(context.history, context.selectedId || context.selected_id, context.allowedRoots, stateStore)
    : null;
  const mergedProjectStatus = mergeProjectStatusHistory(
    historicalProjectStatus,
    input.project_status || input.projectStatus,
    projectStatus
  );
  const agentKeyHealth = stateStore && typeof stateStore.summarizeAgentRegistry === "function"
    ? stateStore.summarizeAgentRegistry()
    : input.agent_key_health || input.agentKeyHealth;
  if (Object.keys(mergedProjectStatus).length === 0) return agentKeyHealth ? { ...input, agent_key_health: agentKeyHealth } : input;
  return {
    ...input,
    project_status: mergedProjectStatus,
    global_goals: Array.isArray(mergedProjectStatus.global_goals) ? mergedProjectStatus.global_goals : input.global_goals,
    agent_key_health: agentKeyHealth
  };
}

function isWithinPath(basePath, filePath) {
  return filePath === basePath || filePath.startsWith(`${basePath}/`);
}

function historyItemPath(itemPath, field, allowedRoots = [examplesRoot, defaultSnapshotsRoot]) {
  if (!itemPath) return null;
  if (typeof itemPath !== "string" || isAbsolute(itemPath)) {
    const error = new Error(`${field} must be a relative workbench history path`);
    error.code = "INVALID_HISTORY_PATH";
    throw error;
  }

  const filePath = resolve(root, itemPath);
  if (!allowedRoots.some((allowedRoot) => isWithinPath(allowedRoot, filePath))) {
    const error = new Error(`${field} must stay under allowed workbench history roots`);
    error.code = "INVALID_HISTORY_PATH";
    throw error;
  }

  return filePath;
}

function readWorkflowStateFromItem(item = {}, allowedRoots = [examplesRoot, defaultSnapshotsRoot], stateStore = null) {
  if (stateStore) {
    if (isSqliteSnapshotPath(item.input_path)) {
      return stateStore.readWorkflowSnapshot(sqliteSnapshotIdFromInputPath(item.input_path));
    }
    return requireSqliteWorkflowSnapshot();
  }
  return readJson(historyItemPath(item.input_path, "input_path", allowedRoots));
}

function writeWorkflowStateToItem(item = {}, workflowState = {}, allowedRoots = [examplesRoot, defaultSnapshotsRoot], stateStore = null) {
  if (stateStore) {
    if (isSqliteSnapshotPath(item.input_path)) {
      return stateStore.writeWorkflowSnapshot(sqliteSnapshotIdFromInputPath(item.input_path), workflowState, item);
    }
    return requireSqliteWorkflowSnapshot();
  }
  const inputPath = historyItemPath(item.input_path, "input_path", allowedRoots);
  writeJson(inputPath, workflowState);
  return inputPath;
}

function projectionById(id = null, history = readJson(historyPath), allowedRoots = [examplesRoot, defaultSnapshotsRoot], projectStatusPath = null, stateStore = null) {
  const selectedId = id || history.latest;
  const item = history.items.find((entry) => entry.id === selectedId);

  // If no item found and history is empty, generate initial projection for new submissions
  if (!item) {
    if (history.items.length === 0 && !selectedId) {
      // First-time state: empty history, create initial projection
      const runId = `initial-workbench-${Date.now()}`;
      const cycleId = `initial-cycle-${Date.now()}`;
      const initialWorkflowState = createInitialWorkflowState(runId, cycleId, projectStatusPath, stateStore);
      return {
        history,
        item: null,
        projection: createWorkbenchProjection(initialWorkflowState)
      };
    }

    const error = new Error(`projection not found: ${selectedId}`);
    error.code = "PROJECTION_NOT_FOUND";
    throw error;
  }

  return {
    history,
    item,
    projection: item.input_path
      ? createWorkbenchProjection(projectionInputWithProjectStatus(readWorkflowStateFromItem(item, allowedRoots, stateStore), projectStatusPath, stateStore, {
        history,
        selectedId,
        allowedRoots
      }))
      : stateStore
        ? requireSqliteWorkflowSnapshot()
        : readJson(historyItemPath(item.projection_path, "projection_path", allowedRoots))
  };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function safeSnapshotIdPart(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "snapshot";
}

function requireSqliteWorkflowSnapshot() {
  const error = new Error("SQLite workbench state requires workflow snapshots");
  error.code = "WORKFLOW_SNAPSHOT_REQUIRED";
  throw error;
}

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

function normalizeEvent(input = {}, projectionId = null) {
  const createdAt = input.created_at || new Date().toISOString();
  return {
    id: input.id || `operator-event-${createdAt}`,
    type: typeof input.type === "string" && input.type.trim() ? input.type.trim() : "operator_action",
    action: input.action.trim(),
    projection_id: input.projection_id || projectionId || null,
    run_id: input.run_id.trim(),
    cycle_id: input.cycle_id.trim(),
    created_at: createdAt,
    metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {}
  };
}

function operatorEventIssues(input = {}) {
  const issues = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return ["event must be an object"];
  }
  for (const field of ["action", "run_id", "cycle_id"]) {
    if (typeof input[field] !== "string" || !input[field].trim()) {
      issues.push(`${field} is required`);
    }
  }
  if (input.metadata !== undefined && (!input.metadata || typeof input.metadata !== "object" || Array.isArray(input.metadata))) {
    issues.push("metadata must be an object when provided");
  }
  return issues;
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

function readEvents(eventsPath, stateStore = null) {
  return stateStore ? stateStore.readEvents() : readJson(eventsPath);
}

function appendEvent(eventsPath, event, stateStore = null) {
  const ledger = readEvents(eventsPath, stateStore);
  const nextLedger = {
    version: ledger.version || "operator-events.v1",
    events: [...(Array.isArray(ledger.events) ? ledger.events : []), event]
  };
  if (stateStore) stateStore.writeEvents(nextLedger);
  else writeJson(eventsPath, nextLedger);
  return nextLedger;
}

export function createWorkbenchServer(options = {}) {
  if (options.serveLegacyStatic === true || options.serve_legacy_static === true) {
    throw Object.assign(new Error("legacy static Workbench serving has been retired; serve the Workbench through the Next.js App Router runtime"), { code: "LEGACY_STATIC_WORKBENCH_RETIRED" });
  }

  const eventsPath = options.eventsPath || defaultEventsPath;
  const jsonBodyLimitBytes = Number(options.jsonBodyLimitBytes || options.json_body_limit_bytes || DEFAULT_JSON_BODY_LIMIT_BYTES);
  const serverHistoryPath = options.historyPath || historyPath;
  const projectStatusPath = options.projectStatusPath === null
    ? null
    : resolve(options.projectStatusPath || defaultProjectStatusPath);
  const snapshotsRoot = resolve(options.snapshotsRoot || defaultSnapshotsRoot);
  const allowedHistoryRoots = [examplesRoot, snapshotsRoot];
  const stateDbPath = normalizeString(options.stateDbPath || options.state_db || options.stateDb);
  const allowFixtureFileState = options.allowFixtureFileState === true;
  if (!stateDbPath && !options.stateStore && !allowFixtureFileState) {
    throw new Error("Workbench live state requires SQLite: pass stateDbPath or --state-db");
  }
  const stateStore = options.stateStore || (stateDbPath ? createSqliteWorkbenchStateStore({
      dbPath: stateDbPath,
      seedRoot: root,
      seedHistoryPath: serverHistoryPath,
      seedProjectStatusPath: projectStatusPath,
      seedEventsPath: eventsPath
    }) : null);
  const readServerHistory = () => stateStore ? stateStore.readHistory() : readJson(serverHistoryPath);
  const writeServerHistory = (history) => stateStore
    ? stateStore.writeHistory(history)
    : writeJson(serverHistoryPath, history);
  const readWorkflowState = (item) => readWorkflowStateFromItem(item, allowedHistoryRoots, stateStore);
  const writeWorkflowState = (item, workflowState) => writeWorkflowStateToItem(item, workflowState, allowedHistoryRoots, stateStore);
  const publishSnapshot = (input, publishOptions = {}) => stateStore
    ? stateStore.publishSnapshot(input)
    : publishWorkbenchSnapshot(input, publishOptions);
  const realReviewerExecutor = options.realReviewerExecutor;
  const requirementPlanGenerator = typeof options.requirementPlanGenerator === "function"
    ? options.requirementPlanGenerator
    : typeof options.requirement_plan_generator === "function"
      ? options.requirement_plan_generator
      : null;
  const disableDefaultAgentProviderExecutor = options.disableDefaultAgentProviderExecutor === true ||
    options.disable_default_agent_provider_executor === true;
  const contextWorkPackageProviderExecutor = typeof options.contextWorkPackageProviderExecutor === "function"
    ? options.contextWorkPackageProviderExecutor
    : typeof options.context_work_package_provider_executor === "function"
      ? options.context_work_package_provider_executor
      : disableDefaultAgentProviderExecutor
        ? null
        : createAgentContextWorkPackageProviderExecutor({
        cwd: root,
        stateStore,
        timeout_seconds: options.contextWorkPackageProviderTimeoutSeconds ||
          options.context_work_package_provider_timeout_seconds ||
          process.env.AI_CONTROL_WORKBENCH_CONTEXT_PROVIDER_TIMEOUT_SECONDS,
        idle_timeout_seconds: options.contextWorkPackageProviderIdleTimeoutSeconds ||
          options.context_work_package_provider_idle_timeout_seconds ||
          process.env.AI_CONTROL_WORKBENCH_CONTEXT_PROVIDER_IDLE_TIMEOUT_SECONDS,
        channels_path: options.agentChannelsPath ||
          options.agent_channels_path ||
          process.env.AI_CONTROL_WORKBENCH_AGENT_CHANNELS_PATH,
        profiles_path: options.agentProfilesPath ||
          options.agent_profiles_path ||
          process.env.AI_CONTROL_WORKBENCH_AGENT_PROFILES_PATH
      });
  const contextWorkPackageBackgroundLauncher = typeof options.contextWorkPackageBackgroundLauncher === "function"
    ? options.contextWorkPackageBackgroundLauncher
    : typeof options.context_work_package_background_launcher === "function"
      ? options.context_work_package_background_launcher
      : launchContextWorkPackageBackgroundJob;
  const workbenchProjection = (workflowState) => createWorkbenchProjection(
    projectionInputWithProjectStatus(workflowState, projectStatusPath, stateStore)
  );
  const handleStaticRoute = createWorkbenchStaticRouteHandler({
    root,
    jsonResponse
  });
  const handleAgentKeyRoute = createAgentKeyRouteHandler({
    stateStore,
    options,
    jsonBodyLimitBytes,
    jsonResponse,
    readJsonBody
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    try {
      if (handleStaticRoute.handleProjectMountRoot(url, res)) {
        return;
      }

      url.pathname = handleStaticRoute.routePathname(url.pathname);

      if (url.pathname === "/api/workbench/projection") {
        const { projection } = projectionById(url.searchParams.get("id"), readServerHistory(), allowedHistoryRoots, projectStatusPath, stateStore);
        jsonResponse(res, 200, projection);
        return;
      }

      if (url.pathname === "/api/workbench/projections") {
        const history = readServerHistory();
        jsonResponse(res, 200, projectionHistoryWithReadiness(history, allowedHistoryRoots, projectStatusPath, stateStore));
        return;
      }

      if (await handleAgentKeyRoute(url, req, res)) {
        return;
      }

      const routeContext = {
        url, req, res, root, snapshotsRoot, serverHistoryPath, eventsPath,
        stateStore, realReviewerExecutor, jsonBodyLimitBytes, jsonResponse, readJsonBody, readJson,
        readServerHistory, writeServerHistory, readWorkflowState, writeWorkflowState,
        readProjectStatus, writeProjectStatusState, publishSnapshot, snapshotIssues,
        readEvents, appendEvent, operatorEventIssues, normalizeEvent,
        createInitialWorkflowState, projectStatusPath, safeSnapshotIdPart,
        requirementPlanGenerationRunsInBackground, startRequirementPlanGenerationInBackground,
        generateRequirementPlanIfRequested, requirementPlanGenerator,
        requirementAutoAdvanceAllowedAfterPlanReview, workflowStateWithProjectStatus,
        workbenchProjection, runRequirementAutoAdvance, allowedHistoryRoots, normalizeString,
        requirementAutoAdvanceEnabled, projectionById, createSchedulerDispatchPlan,
        schedulerPlanInputFromWorkflowState, schedulerPlanOptionsFromRequest,
        normalizeSchedulerDispatchControlRequest, evaluateSchedulerDispatchControlPolicy,
        recordSchedulerDispatchPolicyDecision, runSchedulerDispatchPlan,
        createSchedulerDispatchRunArtifact, readSchedulerWorkflowStateOutput,
        recordSchedulerDispatchRunArtifact, prepareSchedulerDispatchContinuationFromRunArtifact,
        writePreparedSchedulerContinuation, recordSchedulerDispatchContinuationPrepared,
        metadataPath, latestSchedulerDispatchRun, safeGeneratedContinuationPath,
        schedulerContinuationOutputPath, generatedContinuationInputIssues, latestArtifactForEvent,
        recordSchedulerNextCycleEnqueue, schedulerDispatchRunIssues,
        schedulerDispatchRunArtifactFromInput, resolve, runSchedulerLoopDriver,
        createWorkbenchLoopClient, workbenchBaseUrlFromRequest, createSchedulerLoopRunArtifact,
        recordAutonomousSchedulerLoopRunArtifact, buildSchedulerLoopRunRegistry,
        evaluateSchedulerLoopRecovery, recordSchedulerLoopResumeAttempt, executeProjectedNextAction
      };

      if (await handleWorkbenchBasicRoutes(routeContext)) {
        return;
      }

      if (await handleReviewerRoutes(routeContext)) {
        return;
      }

      if (await handleWorkflowEvidenceRoutes(routeContext)) {
        return;
      }

      if (url.pathname === "/api/workbench/project-status-continuation" && req.method === "POST") {
        const history = readServerHistory();
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const input = await readJsonBody(req, { maxBytes: jsonBodyLimitBytes });
        const workflowState = readWorkflowState(item);
        const projectStatus = readProjectStatus(projectStatusPath, stateStore) || workflowState.project_status;
        const prepared = prepareContinuationFromProjectStatus(projectStatus, { workflow_state: workflowState });
        const recorded = recordProjectStatusContinuationPrepared(workflowState, prepared, {
          created_at: input.created_at || input.createdAt
        });
        if (recorded.status !== "pass") {
          jsonResponse(res, 400, { error: "project status continuation record failed", issues: recorded.issues });
          return;
        }

        writeWorkflowState(item, { ...workflowState, ...recorded.workflow_state });
        const statusCode = prepared.status === "ready" ? 201 : 409;
        jsonResponse(res, statusCode, {
          status: prepared.status === "ready" ? "created" : "blocked",
          item,
          continuation: prepared,
          artifact: recorded.artifact,
          projection: workbenchProjection(recorded.workflow_state)
        });
        return;
      }

      if (await handleRequirementRoutes(routeContext)) {
        return;
      }

      if (url.pathname === "/api/workbench/context-pack-cycle" && req.method === "POST") {
        const history = readServerHistory();
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const input = await readJsonBody(req, { maxBytes: jsonBodyLimitBytes });
        const workflowState = readWorkflowState(item);
        const materialized = materializeContextPackCycleFromWorkflowState(workflowState, {
          cycle_id: input.cycle_id || input.cycleId,
          created_at: input.created_at || input.createdAt
        });
        if (materialized.status !== "ready") {
          jsonResponse(res, 409, {
            error: "context pack cycle is not ready",
            issues: materialized.issues || [],
            item,
            projection: workbenchProjection(workflowState)
          });
          return;
        }

        const snapshotId = normalizeString(input.snapshot_id || input.snapshotId) ||
          generatedContextPackSnapshotId(selectedId);
        const published = publishSnapshot({
          id: snapshotId,
          label: input.label || `Context pack cycle from ${selectedId}`,
          input: materialized.workflow_state,
          created_at: input.created_at || input.createdAt
        }, {
          root,
          historyPath: serverHistoryPath,
          snapshotsRoot
        });
        if (published.status === "fail") {
          jsonResponse(res, 400, { error: "context pack cycle snapshot publish failed", issues: published.issues });
          return;
        }

        if (materialized.source_record?.status === "pass") {
          writeWorkflowState(item, { ...workflowState, ...materialized.source_record.workflow_state });
        }

        jsonResponse(res, 201, {
          status: "created",
          item,
          materialized: {
            status: materialized.status,
            phase: materialized.phase,
            work_package_count: materialized.work_packages.length,
            context_pack: materialized.context_pack
          },
          source_artifact: materialized.source_record?.artifact || null,
          next_item: published.item,
          projection: published.projection,
          current_projection: materialized.source_record?.status === "pass"
            ? workbenchProjection(materialized.source_record.workflow_state)
            : workbenchProjection(workflowState)
        });
        return;
      }

      if (url.pathname === "/api/workbench/context-work-packages-run" && req.method === "POST") {
        const history = readServerHistory();
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const input = await readJsonBody(req, { maxBytes: jsonBodyLimitBytes });
        const workflowState = readWorkflowState(item);
        const projection = workbenchProjection(workflowState);
        const runOptions = contextWorkPackageRunOptions(input, projection);
        if (backgroundContextWorkPackageRequested(input)) {
          if (!stateStore || !stateDbPath || !isSqliteSnapshotPath(item.input_path)) {
            jsonResponse(res, 409, {
              status: "blocked",
              error: "background context work package dispatch requires sqlite live state",
              item,
              issues: [{
                code: "background_dispatch_requires_sqlite_state",
                message: "background context work package dispatch requires a sqlite workflow snapshot so the child runner can update state without blocking the API",
                path: "state_store"
              }],
              projection
            });
            return;
          }

          const dispatchRunId = `context-work-package-dispatch-${selectedId}-${Date.now()}`;
          const staged = stageContextWorkPackageDispatch(workflowState, {
            ...runOptions,
            dispatch_run_id: dispatchRunId
          });
          if (staged.status !== "pass") {
            jsonResponse(res, 409, {
              status: staged.status,
              error: "context work package dispatch could not be started",
              issues: staged.issues || [],
              item,
              phase: staged.phase,
              fixed_development_mode_gate: staged.fixed_development_mode_gate || staged.gate_result || null,
              work_package_execution_governance: staged.work_package_execution_governance ||
                (staged.phase === "work_package_execution_governance" ? staged.gate_result : null),
              projection
            });
            return;
          }

          writeWorkflowState(item, staged.workflow_state);
          if (staged.workflow_state.project_status) {
            writeProjectStatusState(projectStatusPath, staged.workflow_state.project_status, stateStore);
          }
          const stagedProjection = workbenchProjection(staged.workflow_state);
          const backgroundJob = contextWorkPackageBackgroundLauncher({
            state_db: stateDbPath,
            snapshot_id: sqliteSnapshotIdFromInputPath(item.input_path),
            output_path: backgroundContextWorkPackageOutputPath(dispatchRunId),
            selected_work_package_ids: staged.selected_work_package_ids,
            dispatch_run_id: dispatchRunId,
            created_at: input.created_at || input.createdAt || new Date().toISOString(),
            timeout_seconds: options.contextWorkPackageProviderTimeoutSeconds ||
              options.context_work_package_provider_timeout_seconds ||
              process.env.AI_CONTROL_WORKBENCH_CONTEXT_PROVIDER_TIMEOUT_SECONDS,
            idle_timeout_seconds: options.contextWorkPackageProviderIdleTimeoutSeconds ||
              options.context_work_package_provider_idle_timeout_seconds ||
              process.env.AI_CONTROL_WORKBENCH_CONTEXT_PROVIDER_IDLE_TIMEOUT_SECONDS,
            channels_path: options.agentChannelsPath ||
              options.agent_channels_path ||
              process.env.AI_CONTROL_WORKBENCH_AGENT_CHANNELS_PATH,
            profiles_path: options.agentProfilesPath ||
              options.agent_profiles_path ||
              process.env.AI_CONTROL_WORKBENCH_AGENT_PROFILES_PATH
          });
          jsonResponse(res, 202, {
            status: "accepted",
            phase: staged.phase,
            item,
            dispatch_run_id: dispatchRunId,
            selected_work_package_ids: staged.selected_work_package_ids,
            background_job: backgroundJob,
            projection: stagedProjection
          });
          return;
        }

        const result = runContextWorkPackages(workflowState, {
          ...runOptions,
          already_satisfied_evaluator: createMainlineAlreadySatisfiedEvaluator({ root }),
          provider_executor: contextWorkPackageProviderExecutor
        });
        if (result.status !== "pass") {
          jsonResponse(res, 409, {
            status: result.status,
            error: result.status === "validated"
              ? "context work package run validated without completion authority"
              : "context work package run failed",
            issues: result.issues || [],
            item,
            phase: result.phase,
            fixed_development_mode_gate: result.fixed_development_mode_gate || result.gate_result || null,
            work_package_execution_governance: result.work_package_execution_governance ||
              (result.phase === "work_package_execution_governance" ? result.gate_result : null),
            execution_plan: result.execution_plan || null,
            package_results: result.package_results || [],
            executor_provenance: result.executor_provenance || null,
            allows_work_package_completion: result.allows_work_package_completion === true,
            completion_authority: result.completion_authority || null,
            projection: workbenchProjection(workflowState)
          });
          return;
        }

        writeWorkflowState(item, { ...workflowState, ...result.workflow_state });
        if (result.workflow_state?.project_status) {
          writeProjectStatusState(projectStatusPath, result.workflow_state.project_status, stateStore);
        }
        jsonResponse(res, 201, {
          status: "created",
          item,
          phase: result.phase,
          executed_count: result.executed_count,
          executed_work_packages: result.executed_work_packages,
          artifact: result.artifact,
          projection: workbenchProjection(result.workflow_state)
        });
        return;
      }

      if (await handleSchedulerDispatchRoutes(routeContext)) {
        return;
      }

      if (await handleSchedulerLoopRoutes(routeContext)) {
        return;
      }

      handleStaticRoute.handleFallback(url, res);
    } catch (error) {
      if (error.code === "ENOENT") {
        jsonResponse(res, 404, { error: "not found" });
        return;
      }

      if (error.code === "PROJECTION_NOT_FOUND") {
        jsonResponse(res, 404, { error: error.message });
        return;
      }

      if (error.code === "INVALID_HISTORY_PATH" || error.code === "WORKFLOW_SNAPSHOT_REQUIRED") {
        jsonResponse(res, 400, { error: error.message });
        return;
      }

      if (error.code === "INVALID_WORKBENCH_HOST") {
        jsonResponse(res, 400, { error: error.message });
        return;
      }

      if (error.code === "INVALID_CONTINUATION_PATH") {
        jsonResponse(res, 400, { error: error.message });
        return;
      }

      if (error.code === "INVALID_JSON_BODY") {
        jsonResponse(res, 400, { error: "invalid json" });
        return;
      }

      if (error.code === "REQUEST_BODY_TOO_LARGE") {
        jsonResponse(res, 413, {
          error: "request body too large",
          max_bytes: jsonBodyLimitBytes
        });
        return;
      }

      jsonResponse(res, 500, { error: error.message });
    }
  });

  const agentHealthIntervalMs = Number(options.agentHealthIntervalMs || options.agent_health_interval_ms || 10 * 60 * 1000);
  if (stateStore && agentHealthIntervalMs > 0 && options.disableAgentHealthTimer !== true) {
    const timer = setInterval(() => {
      runAgentHealthCheck(stateStore, {
        include_fresh: false,
        ttl_ms: agentHealthIntervalMs,
        checked_at: new Date().toISOString()
      }, {
        fetchImpl: options.agentHealthFetch || options.fetchImpl,
        accountHealthRunner: options.agentAccountHealthRunner,
        accountHealthCheckImpl: options.agentAccountHealthCheckImpl,
        manualAgentCliPath: options.manualAgentCliPath
      }).catch(() => {});
    }, agentHealthIntervalMs);
    timer.unref?.();
    server.on("close", () => clearInterval(timer));
  }

  return server;
}

export function startWorkbenchServer({
  port = 4180,
  host = "127.0.0.1",
  historyPath: configuredHistoryPath,
  snapshotsRoot: configuredSnapshotsRoot,
  eventsPath: configuredEventsPath,
  projectStatusPath,
  stateDbPath = defaultStateDbPath
} = {}) {
  const server = createWorkbenchServer({
    historyPath: configuredHistoryPath,
    snapshotsRoot: configuredSnapshotsRoot,
    eventsPath: configuredEventsPath,
    projectStatusPath,
    stateDbPath
  });
  const listenPort = normalizeCliPort(port);
  server.listen(listenPort, host);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(workbenchServerHelpText());
    process.exit(0);
  }
  let cliOptions;
  try {
    cliOptions = parseWorkbenchServerCliArgs(process.argv.slice(2), process.env, { defaultStateDbPath });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const server = startWorkbenchServer(cliOptions);
  server.on("listening", () => {
    const address = server.address();
    console.log(`Workbench server listening on http://${address.address}:${address.port}`);
  });
}
