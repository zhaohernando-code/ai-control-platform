#!/usr/bin/env node
import { createServer, request as httpRequest } from "node:http";
import { dirname, extname, isAbsolute, normalize, relative, resolve } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { createWorkbenchProjection } from "../src/workflow/workbench-projection.js";
import { publishWorkbenchSnapshot, snapshotIssues } from "../src/workflow/workbench-snapshots.js";
import { createSchedulerDispatchPlan } from "../src/workflow/scheduler-dispatch-plan.js";
import {
  evaluateSchedulerDispatchControlPolicy,
  normalizeSchedulerDispatchControlRequest,
  recordSchedulerDispatchPolicyDecision
} from "../src/workflow/scheduler-dispatch-policy.js";
import { recordReviewerProviderHealthFact } from "../src/workflow/reviewer-provider-health.js";
import {
  recordReviewerShardAggregate,
  recordReviewerShardResult
} from "../src/workflow/reviewer-shard-results.js";
import {
  cleanupAgentLifecyclePool,
  recordAgentLifecycleFact
} from "../src/workflow/agent-lifecycle-pool.js";
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
import { runReviewerShard } from "../src/workflow/reviewer-shard-runner.js";
import { createClaudeDeepSeekShardExecutor } from "../src/workflow/claude-deepseek-shard-executor.js";
import {
  evaluateReviewerExecutionPolicy,
  evaluateReviewerProviderHealthPreflight
} from "../src/workflow/reviewer-execution-policy.js";
import { recordWorkbenchBrowserEventsRunArtifact } from "../src/workflow/workbench-browser-events.js";
import {
  prepareContinuationFromProjectStatus,
  recordProjectStatusContinuationPrepared
} from "../src/workflow/project-status-continuation.js";
import { materializeContextPackCycleFromWorkflowState } from "../src/workflow/context-pack-cycle.js";
import { runContextWorkPackages } from "../src/workflow/context-work-package-runner.js";

const root = resolve(process.cwd());
const historyPath = resolve(root, "docs/examples/projection-history.json");
const defaultEventsPath = resolve(root, "docs/examples/operator-events.json");
const defaultProjectStatusPath = resolve(root, "PROJECT_STATUS.json");
const examplesRoot = resolve(root, "docs/examples");
const defaultSnapshotsRoot = resolve(root, "tmp/workbench-snapshots");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function jsonResponse(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function projectionInputWithProjectStatus(input = {}, projectStatusPath = null) {
  if (!projectStatusPath) return input;
  const projectStatus = readJson(projectStatusPath);
  return {
    ...input,
    project_status: projectStatus
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

function projectionById(id = null, history = readJson(historyPath), allowedRoots = [examplesRoot, defaultSnapshotsRoot], projectStatusPath = null) {
  const selectedId = id || history.latest;
  const item = history.items.find((entry) => entry.id === selectedId);

  if (!item) {
    const error = new Error(`projection not found: ${selectedId}`);
    error.code = "PROJECTION_NOT_FOUND";
    throw error;
  }

  return {
    history,
    item,
    projection: item.input_path
      ? createWorkbenchProjection(projectionInputWithProjectStatus(readJson(historyItemPath(item.input_path, "input_path", allowedRoots)), projectStatusPath))
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

function projectionHistoryWithReadiness(history = {}, allowedRoots = [examplesRoot, defaultSnapshotsRoot], projectStatusPath = null) {
  return {
    ...history,
    items: asArray(history.items).map((item) => {
      if (!item?.input_path) return item;
      try {
        const workflowState = readJson(historyItemPath(item.input_path, "input_path", allowedRoots));
        const projection = createWorkbenchProjection(projectionInputWithProjectStatus(workflowState, projectStatusPath));
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

function requestJson(url, body = null) {
  return new Promise((resolveRequest, reject) => {
    if (url.protocol !== "http:") {
      reject(new Error("workbench loop client supports only local http"));
      return;
    }
    const payload = body ? JSON.stringify(body) : null;
    const req = httpRequest(url, {
      method: payload ? "POST" : "GET",
      headers: payload
        ? {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload)
        }
        : {}
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        text += chunk;
      });
      response.on("end", () => {
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const error = new Error(json?.error || text || `workbench request failed: ${response.statusCode}`);
          error.http_status = response.statusCode;
          error.response = json;
          reject(error);
          return;
        }
        resolveRequest(json);
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function createWorkbenchLoopClient(baseUrl) {
  const base = new URL(baseUrl);
  return {
    loadHistory() {
      return requestJson(new URL("/api/workbench/projections", base));
    },
    loadProjection(projectionId) {
      const url = new URL("/api/workbench/projection", base);
      if (projectionId) url.searchParams.set("id", projectionId);
      return requestJson(url);
    },
    runNextAction(projectionId, body = {}) {
      const url = new URL("/api/workbench/next-action", base);
      if (projectionId) url.searchParams.set("id", projectionId);
      return requestJson(url, body);
    },
    createSchedulerDispatchPlan(projectionId, body = {}) {
      const url = new URL("/api/workbench/scheduler-dispatch-plan", base);
      if (projectionId) url.searchParams.set("id", projectionId);
      return requestJson(url, body);
    },
    runSchedulerDispatch(projectionId, body = {}) {
      const url = new URL("/api/workbench/scheduler-dispatch", base);
      if (projectionId) url.searchParams.set("id", projectionId);
      return requestJson(url, body);
    },
    enqueueSchedulerNextCycle(projectionId, body = {}) {
      const url = new URL("/api/workbench/scheduler-next-cycle", base);
      if (projectionId) url.searchParams.set("id", projectionId);
      return requestJson(url, body);
    },
    runAutonomousSchedulerLoop(projectionId, body = {}) {
      const url = new URL("/api/workbench/autonomous-scheduler-loop", base);
      if (projectionId) url.searchParams.set("id", projectionId);
      return requestJson(url, body);
    },
    resumeAutonomousSchedulerLoop(projectionId, body = {}) {
      const url = new URL("/api/workbench/autonomous-scheduler-loop-resume", base);
      if (projectionId) url.searchParams.set("id", projectionId);
      return requestJson(url, body);
    },
    prepareProjectStatusContinuation(projectionId, body = {}) {
      const url = new URL("/api/workbench/project-status-continuation", base);
      if (projectionId) url.searchParams.set("id", projectionId);
      return requestJson(url, body);
    },
    createContextPackFromSeed(projectionId, body = {}) {
      const url = new URL("/api/workbench/context-pack-cycle", base);
      if (projectionId) url.searchParams.set("id", projectionId);
      return requestJson(url, body);
    },
    runContextWorkPackages(projectionId, body = {}) {
      const url = new URL("/api/workbench/context-work-packages-run", base);
      if (projectionId) url.searchParams.set("id", projectionId);
      return requestJson(url, body);
    },
    runReviewerShard(projectionId, body = {}) {
      const url = new URL("/api/workbench/reviewer-shard-run", base);
      if (projectionId) url.searchParams.set("id", projectionId);
      return requestJson(url, body);
    },
    recordAgentLifecyclePool(projectionId, body = {}) {
      const url = new URL("/api/workbench/agent-lifecycle-pool", base);
      if (projectionId) url.searchParams.set("id", projectionId);
      return requestJson(url, body);
    }
  };
}

function contextWorkPackageRunOptions(input = {}) {
  const executionProfile = input.context_work_package_execution_profile ||
    input.contextWorkPackageExecutionProfile ||
    input.execution_profile ||
    input.executionProfile;
  return {
    max_package_count: input.max_package_count ?? input.maxPackageCount,
    created_at: input.created_at || input.createdAt,
    execution_mode: input.execution_mode || input.executionMode,
    execution_profile: executionProfile,
    executor_profile: input.executor_profile || input.executorProfile,
    executor_kind: input.executor_kind || input.executorKind,
    adapter_profile: input.adapter_profile || input.adapterProfile,
    risk: input.risk || input.risk_level || input.riskLevel,
    risk_level: input.risk_level || input.riskLevel,
    budget_tier: input.budget_tier || input.budgetTier,
    budget: input.budget,
    codex_plan_pressure: input.codex_plan_pressure ?? input.codexPlanPressure,
    cost_pressure: input.cost_pressure ?? input.costPressure,
    tags: Array.isArray(input.tags) ? input.tags : undefined,
    stage: input.stage
  };
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolveBody(body));
    req.on("error", reject);
  });
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

function workbenchBaseUrlFromRequest(req) {
  const host = String(req.headers.host || "").trim();
  if (!host || !/^[a-zA-Z0-9.:-]+$/.test(host)) {
    const error = new Error("request host is required for scheduler dispatch writeback planning");
    error.code = "INVALID_WORKBENCH_HOST";
    throw error;
  }
  return `http://${host}`;
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

function schedulerPlanOptionsFromRequest(req, item, selectedId, input = {}) {
  return {
    workflow_state_input_path: item.input_path,
    workbench_writeback_mode: "service",
    workbench_base_url: workbenchBaseUrlFromRequest(req),
    projection_id: selectedId,
    reviewer_mock_status: input.reviewer_mock_status || input.reviewerMockStatus,
    reviewer_mock_findings_json: input.reviewer_mock_findings_json || input.reviewerMockFindingsJson,
    next_step: input.next_step || input.nextStep
  };
}

function readEvents(eventsPath) {
  return readJson(eventsPath);
}

function appendEvent(eventsPath, event) {
  const ledger = readEvents(eventsPath);
  const nextLedger = {
    version: ledger.version || "operator-events.v1",
    events: [...(Array.isArray(ledger.events) ? ledger.events : []), event]
  };
  writeFileSync(eventsPath, `${JSON.stringify(nextLedger, null, 2)}\n`);
  return nextLedger;
}

const SUPPORTED_NEXT_ACTIONS = new Set([
  "prepare_project_status_continuation",
  "continue_after_reviewer_aggregate",
  "create_context_pack_from_seed",
  "run_context_work_packages",
  "enqueue_scheduler_next_cycle",
  "run_autonomous_scheduler_loop",
  "run_reviewer_scope_shard",
  "cleanup_agent_lifecycle_pool",
  "resume_autonomous_scheduler_loop"
]);

function reviewerShardExecutorFromInput(input = {}, options = {}) {
  const policy = evaluateReviewerExecutionPolicy(input);
  if (policy.status !== "pass") {
    const error = new Error("reviewer execution policy rejected");
    error.code = "reviewer_execution_policy_rejected";
    error.issues = policy.issues;
    error.policy = policy;
    throw error;
  }
  const preflight = evaluateReviewerProviderHealthPreflight(options.workflowState, policy);
  if (preflight.status !== "pass") {
    const error = new Error("reviewer provider health preflight rejected");
    error.code = "reviewer_provider_health_preflight_rejected";
    error.issues = preflight.issues;
    error.policy = policy;
    throw error;
  }

  const mockFindingsJson = normalizeString(input.reviewer_mock_findings_json || input.reviewerMockFindingsJson);
  const mockStatus = normalizeString(input.reviewer_mock_status || input.reviewerMockStatus);
  if (policy.controls.executor_mode === "mock") {
    return {
      policy,
      executor: async () => ({
        status: mockStatus || "pass",
        findings: mockFindingsJson ? JSON.parse(mockFindingsJson) : [],
        provenance: {
          executor_kind: "mock",
          provider: "mock",
          model: "mock",
          timeout_seconds: null,
          tools: "",
          external_call_budget_used: 0,
          execution_profile: policy.profile
        }
      })
    };
  }

  const timeoutSeconds = policy.controls.timeout_seconds;
  const baseExecutor = options.realReviewerExecutor || createClaudeDeepSeekShardExecutor({
    cwd: root,
    timeout_seconds: timeoutSeconds
  });
  return {
    policy,
    executor: async (request) => {
      const result = await baseExecutor(request);
      return {
        ...result,
        provenance: {
          ...(result?.provenance || {}),
          execution_profile: policy.profile,
          policy_execution_mode: policy.execution_mode,
          model_routing_selected_model: policy.controls.model_routing?.selected_model || null
        }
      };
    }
  };
}

async function executeProjectedNextAction({ req, selectedId, projection, input = {} }) {
  const readout = projection.next_action_readout || {};
  const action = normalizeString(readout.action);
  const expectedAction = normalizeString(input.expected_action || input.expectedAction);

  if (expectedAction && expectedAction !== action) {
    return {
      status: "blocked",
      http_status: 409,
      error: "projected next action drifted",
      issues: [{
        code: "next_action_drift",
        message: `expected ${expectedAction} but projection recommends ${action || "none"}`,
        path: "next_action_readout.action"
      }]
    };
  }

  if (readout.status !== "ready" || !SUPPORTED_NEXT_ACTIONS.has(action)) {
    return {
      status: "blocked",
      http_status: 409,
      error: "projected next action is not supported for autonomous execution",
      issues: [{
        code: "unsupported_projected_next_action",
        message: `${action || "none"} is not in the autonomous execution allowlist`,
        path: "next_action_readout.action"
      }]
    };
  }

  const client = createWorkbenchLoopClient(workbenchBaseUrlFromRequest(req));
  if (action === "enqueue_scheduler_next_cycle") {
    const result = await client.enqueueSchedulerNextCycle(selectedId, {
      snapshot_id: input.snapshot_id || input.snapshotId,
      label: input.label,
      created_at: input.created_at || input.createdAt
    });
    return { status: "executed", action, result };
  }

  if (action === "prepare_project_status_continuation") {
    const result = await client.prepareProjectStatusContinuation(selectedId, {
      created_at: input.created_at || input.createdAt
    });
    return { status: "executed", action, result };
  }

  if (action === "continue_after_reviewer_aggregate") {
    const result = await client.prepareProjectStatusContinuation(selectedId, {
      created_at: input.created_at || input.createdAt
    });
    return { status: "executed", action, result };
  }

  if (action === "create_context_pack_from_seed") {
    const result = await client.createContextPackFromSeed(selectedId, {
      snapshot_id: input.snapshot_id || input.snapshotId,
      cycle_id: input.cycle_id || input.cycleId,
      label: input.label,
      created_at: input.created_at || input.createdAt
    });
    return { status: "executed", action, result };
  }

  if (action === "run_context_work_packages") {
    try {
      const result = await client.runContextWorkPackages(selectedId, contextWorkPackageRunOptions(input));
      return { status: "executed", action, result };
    } catch (error) {
      return {
        status: "blocked",
        http_status: error.http_status || 409,
        error: error.message,
        issues: error.response?.issues || [],
        result: error.response || null
      };
    }
  }

  if (action === "run_reviewer_scope_shard") {
    const result = await client.runReviewerShard(selectedId, {
      shard_id: input.shard_id || input.shardId,
      created_at: input.created_at || input.createdAt,
      aggregate_created_at: input.aggregate_created_at || input.aggregateCreatedAt,
      record_provider_health_on_timeout: input.record_provider_health_on_timeout ?? input.recordProviderHealthOnTimeout ?? true,
      provider_smoke_status: input.provider_smoke_status || input.providerSmokeStatus,
      execution_profile: input.execution_profile || input.executionProfile,
      max_external_reviewer_calls: input.max_external_reviewer_calls ?? input.maxExternalReviewerCalls,
      provider_cost_mode: input.provider_cost_mode || input.providerCostMode,
      budget_tier: input.budget_tier || input.budgetTier,
      risk: input.risk || input.risk_level || input.riskLevel,
      reviewer_mock_status: input.reviewer_mock_status || input.reviewerMockStatus,
      reviewer_mock_findings_json: input.reviewer_mock_findings_json || input.reviewerMockFindingsJson,
      timeout_seconds: input.timeout_seconds || input.timeoutSeconds
    });
    return { status: "executed", action, result };
  }

  if (action === "cleanup_agent_lifecycle_pool") {
    const result = await client.recordAgentLifecyclePool(selectedId, {
      cleanup_latest_pool: true,
      created_at: input.created_at || input.createdAt,
      failure: input.failure,
      blocked: input.blocked,
      message: input.message
    });
    return { status: "executed", action, result };
  }

  if (action === "resume_autonomous_scheduler_loop") {
    const result = await client.resumeAutonomousSchedulerLoop(selectedId, {
      max_iterations: input.max_iterations || input.maxIterations || 1,
      execution_profile: input.execution_profile || input.executionProfile || "approved_mock_non_dry_run",
      snapshot_prefix: input.snapshot_prefix || input.snapshotPrefix || "resume-loop",
      created_at: input.created_at || input.createdAt
    });
    return { status: "executed", action, result };
  }

  const result = await client.runAutonomousSchedulerLoop(selectedId, {
    max_iterations: input.max_iterations || input.maxIterations || 1,
    execution_profile: input.execution_profile || input.executionProfile || "approved_mock_non_dry_run",
    execution_strategy: input.execution_strategy || input.executionStrategy,
    reviewer_mock_status: input.reviewer_mock_status || input.reviewerMockStatus,
    reviewer_mock_findings_json: input.reviewer_mock_findings_json || input.reviewerMockFindingsJson,
    max_external_reviewer_calls: input.max_external_reviewer_calls ?? input.maxExternalReviewerCalls,
    provider_cost_mode: input.provider_cost_mode || input.providerCostMode,
    budget_tier: input.budget_tier || input.budgetTier,
    risk: input.risk || input.risk_level || input.riskLevel,
    timeout_seconds: input.timeout_seconds || input.timeoutSeconds,
    snapshot_prefix: input.snapshot_prefix || input.snapshotPrefix || "autonomous-loop",
    created_at: input.created_at || input.createdAt
  });
  return { status: "executed", action, result };
}

function safeStaticPath(pathname) {
  const normalized = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const filePath = resolve(root, normalized.replace(/^[/\\]/, ""));

  if (!filePath.startsWith(root)) {
    return null;
  }

  return filePath;
}

export function createWorkbenchServer(options = {}) {
  const eventsPath = options.eventsPath || defaultEventsPath;
  const serverHistoryPath = options.historyPath || historyPath;
  const projectStatusPath = options.projectStatusPath === null
    ? null
    : resolve(options.projectStatusPath || defaultProjectStatusPath);
  const snapshotsRoot = resolve(options.snapshotsRoot || defaultSnapshotsRoot);
  const allowedHistoryRoots = [examplesRoot, snapshotsRoot];
  const realReviewerExecutor = options.realReviewerExecutor;
  const contextWorkPackageProviderExecutor = typeof options.contextWorkPackageProviderExecutor === "function"
    ? options.contextWorkPackageProviderExecutor
    : typeof options.context_work_package_provider_executor === "function"
      ? options.context_work_package_provider_executor
      : null;
  const workbenchProjection = (workflowState) => createWorkbenchProjection(
    projectionInputWithProjectStatus(workflowState, projectStatusPath)
  );

  return createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    try {
      if (url.pathname === "/api/workbench/projection") {
        const { projection } = projectionById(url.searchParams.get("id"), readJson(serverHistoryPath), allowedHistoryRoots, projectStatusPath);
        jsonResponse(res, 200, projection);
        return;
      }

      if (url.pathname === "/api/workbench/projections") {
        const history = readJson(serverHistoryPath);
        jsonResponse(res, 200, projectionHistoryWithReadiness(history, allowedHistoryRoots, projectStatusPath));
        return;
      }

      if (url.pathname === "/api/workbench/snapshot" && req.method === "GET") {
        const history = readJson(serverHistoryPath);
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 404, { error: `snapshot input not found: ${selectedId}` });
          return;
        }
        jsonResponse(res, 200, readJson(historyItemPath(item.input_path, "input_path", allowedHistoryRoots)));
        return;
      }

      if (url.pathname === "/api/workbench/snapshots" && req.method === "POST") {
        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }
        const issues = snapshotIssues(input);
        if (issues.length > 0) {
          jsonResponse(res, 400, { error: "invalid workflow state snapshot", issues });
          return;
        }
        const result = publishWorkbenchSnapshot(input, {
          root,
          historyPath: serverHistoryPath,
          snapshotsRoot
        });
        if (result.status === "fail") {
          jsonResponse(res, 400, { error: "workflow state snapshot publish failed", issues: result.issues });
          return;
        }
        jsonResponse(res, 201, { status: result.status, item: result.item, projection: result.projection });
        return;
      }

      if (url.pathname === "/api/workbench/reviewer-provider-health" && req.method === "POST") {
        const history = readJson(serverHistoryPath);
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }

        const inputPath = historyItemPath(item.input_path, "input_path", allowedHistoryRoots);
        const workflowState = readJson(inputPath);
        const result = recordReviewerProviderHealthFact(workflowState, {
          request: workflowState.reviewer_gate?.request || workflowState.reviewerGate?.request || workflowState.reviewer_gate || workflowState.reviewerGate,
          smoke_status: input.smoke_status || input.smokeStatus || input.provider_smoke_status,
          tools: input.tools || input.allowed_tools || input.allowedTools,
          created_at: input.created_at
        });
        if (result.status !== "pass") {
          jsonResponse(res, 400, { error: "reviewer provider health record failed", issues: result.issues });
          return;
        }

        writeFileSync(inputPath, `${JSON.stringify({ ...workflowState, ...result.workflow_state }, null, 2)}\n`);
        jsonResponse(res, 201, {
          status: "created",
          item,
          fact: result.fact,
          projection: workbenchProjection(result.workflow_state)
        });
        return;
      }

      if (url.pathname === "/api/workbench/reviewer-shard-result" && req.method === "POST") {
        const history = readJson(serverHistoryPath);
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }

        const inputPath = historyItemPath(item.input_path, "input_path", allowedHistoryRoots);
        const workflowState = readJson(inputPath);
        const result = recordReviewerShardResult(workflowState, {
          shard_id: input.shard_id || input.shardId,
          status: input.status,
          findings: input.findings || input.review_findings || [],
          created_at: input.created_at
        });
        if (result.status !== "pass") {
          jsonResponse(res, 400, { error: "reviewer shard result record failed", issues: result.issues });
          return;
        }

        let nextState = result.workflow_state;
        let aggregate = null;
        if (input.aggregate === true) {
          aggregate = recordReviewerShardAggregate(nextState, {
            created_at: input.aggregate_created_at || input.created_at
          });
          if (aggregate.status !== "pass") {
            jsonResponse(res, 400, { error: "reviewer shard aggregate record failed", issues: aggregate.issues });
            return;
          }
          nextState = aggregate.workflow_state;
        }

        writeFileSync(inputPath, `${JSON.stringify({ ...workflowState, ...nextState }, null, 2)}\n`);
        jsonResponse(res, 201, {
          status: "created",
          item,
          fact: result.fact,
          aggregate: aggregate?.fact || null,
          projection: workbenchProjection(nextState)
        });
        return;
      }

      if (url.pathname === "/api/workbench/agent-lifecycle-pool" && req.method === "POST") {
        const history = readJson(serverHistoryPath);
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }

        const inputPath = historyItemPath(item.input_path, "input_path", allowedHistoryRoots);
        const workflowState = readJson(inputPath);
        const result = (input.cleanup_latest_pool || input.cleanupLatestPool)
          ? cleanupAgentLifecyclePool(workflowState, {
            created_at: input.created_at || input.createdAt,
            failure: input.failure,
            blocked: input.blocked,
            message: input.message
          })
          : recordAgentLifecycleFact(workflowState, {
            event_type: input.event_type || input.eventType || input.type,
            pool_id: input.pool_id || input.poolId,
            worker_id: input.worker_id || input.workerId,
            status: input.status,
            message: input.message,
            created_at: input.created_at || input.createdAt
          });
        if (!["pass", "cleanup_required", "blocked"].includes(result.status)) {
          jsonResponse(res, 400, { error: "agent lifecycle pool record failed", issues: result.issues });
          return;
        }

        writeFileSync(inputPath, `${JSON.stringify({ ...workflowState, ...result.workflow_state }, null, 2)}\n`);
        jsonResponse(res, 201, {
          status: result.status === "blocked" ? "blocked" : "created",
          item,
          fact: result.fact || null,
          facts: result.facts || [],
          before: result.before || null,
          after: result.after || null,
          projection: workbenchProjection(result.workflow_state)
        });
        return;
      }

      if (url.pathname === "/api/workbench/workbench-browser-events-run" && req.method === "POST") {
        const history = readJson(serverHistoryPath);
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }

        const inputPath = historyItemPath(item.input_path, "input_path", allowedHistoryRoots);
        const workflowState = readJson(inputPath);
        const result = recordWorkbenchBrowserEventsRunArtifact(
          workflowState,
          input.artifact || input.run_artifact || input.runArtifact || input,
          {
            artifact_id: input.artifact_id || input.artifactId,
            created_at: input.created_at || input.createdAt
          }
        );
        if (result.status !== "pass") {
          jsonResponse(res, 400, { error: "workbench browser events run record failed", issues: result.issues });
          return;
        }

        writeFileSync(inputPath, `${JSON.stringify({ ...workflowState, ...result.workflow_state }, null, 2)}\n`);
        jsonResponse(res, 201, {
          status: "created",
          item,
          artifact: result.artifact,
          projection: workbenchProjection(result.workflow_state)
        });
        return;
      }

      if (url.pathname === "/api/workbench/reviewer-shard-run" && req.method === "POST") {
        const history = readJson(serverHistoryPath);
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }

        const inputPath = historyItemPath(item.input_path, "input_path", allowedHistoryRoots);
        const workflowState = readJson(inputPath);
        let executorSetup;
        try {
          executorSetup = reviewerShardExecutorFromInput(input, { realReviewerExecutor, workflowState });
        } catch (error) {
          jsonResponse(res, 400, {
            error: error.code === "reviewer_execution_policy_rejected" || error.code === "reviewer_provider_health_preflight_rejected"
              ? "reviewer execution policy rejected"
              : "reviewer shard executor setup failed",
            issues: error.issues || [{ code: "reviewer_shard_executor_setup_failed", message: error.message, path: "reviewer_mock_findings_json" }],
            policy: error.policy || null,
            projection: workbenchProjection(readJson(inputPath))
          });
          return;
        }

        const result = await runReviewerShard(workflowState, {
          shard_id: input.shard_id || input.shardId,
          created_at: input.created_at || input.createdAt,
          aggregate_created_at: input.aggregate_created_at || input.aggregateCreatedAt,
          record_provider_health_on_timeout: input.record_provider_health_on_timeout ?? input.recordProviderHealthOnTimeout ?? true,
          provider_smoke_status: input.provider_smoke_status || input.providerSmokeStatus,
          executor: executorSetup.executor
        });
        if (result.status !== "pass") {
          jsonResponse(res, 400, { error: "reviewer shard run failed", issues: result.issues || [], projection: workbenchProjection(workflowState) });
          return;
        }

        writeFileSync(inputPath, `${JSON.stringify({ ...workflowState, ...result.workflow_state }, null, 2)}\n`);
        jsonResponse(res, 201, {
          status: "created",
          item,
          phase: result.phase,
          shard_id: result.result?.shard_id || result.shard?.id || null,
          shard_status: result.result?.status || null,
          result: result.result,
          reviewer_execution_policy: executorSetup.policy,
          provider_health: result.provider_health || null,
          aggregate: result.aggregate || null,
          pending_shards: result.pending_shards ?? result.aggregate?.pending_shards ?? null,
          projection: workbenchProjection(result.workflow_state)
        });
        return;
      }

      if (url.pathname === "/api/workbench/project-status-continuation" && req.method === "POST") {
        const history = readJson(serverHistoryPath);
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }

        const inputPath = historyItemPath(item.input_path, "input_path", allowedHistoryRoots);
        const workflowState = readJson(inputPath);
        const projectStatus = projectStatusPath ? readJson(projectStatusPath) : workflowState.project_status;
        const prepared = prepareContinuationFromProjectStatus(projectStatus, { workflow_state: workflowState });
        const recorded = recordProjectStatusContinuationPrepared(workflowState, prepared, {
          created_at: input.created_at || input.createdAt
        });
        if (recorded.status !== "pass") {
          jsonResponse(res, 400, { error: "project status continuation record failed", issues: recorded.issues });
          return;
        }

        writeFileSync(inputPath, `${JSON.stringify({ ...workflowState, ...recorded.workflow_state }, null, 2)}\n`);
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

      if (url.pathname === "/api/workbench/context-pack-cycle" && req.method === "POST") {
        const history = readJson(serverHistoryPath);
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }

        const inputPath = historyItemPath(item.input_path, "input_path", allowedHistoryRoots);
        const workflowState = readJson(inputPath);
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
        const published = publishWorkbenchSnapshot({
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
          writeFileSync(inputPath, `${JSON.stringify({ ...workflowState, ...materialized.source_record.workflow_state }, null, 2)}\n`);
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
        const history = readJson(serverHistoryPath);
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }

        const inputPath = historyItemPath(item.input_path, "input_path", allowedHistoryRoots);
        const workflowState = readJson(inputPath);
        const result = runContextWorkPackages(workflowState, {
          ...contextWorkPackageRunOptions(input),
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
            execution_plan: result.execution_plan || null,
            package_results: result.package_results || [],
            executor_provenance: result.executor_provenance || null,
            allows_work_package_completion: result.allows_work_package_completion === true,
            completion_authority: result.completion_authority || null,
            projection: workbenchProjection(workflowState)
          });
          return;
        }

        writeFileSync(inputPath, `${JSON.stringify({ ...workflowState, ...result.workflow_state }, null, 2)}\n`);
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

      if (url.pathname === "/api/workbench/scheduler-dispatch-plan" && req.method === "POST") {
        const history = readJson(serverHistoryPath);
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }

        const inputPath = historyItemPath(item.input_path, "input_path", allowedHistoryRoots);
        const workflowState = readJson(inputPath);
        const plan = createSchedulerDispatchPlan(
          schedulerPlanInputFromWorkflowState(workflowState, input),
          schedulerPlanOptionsFromRequest(req, item, selectedId, input)
        );
        if (plan.status !== "pass") {
          jsonResponse(res, 400, { error: "scheduler dispatch plan failed", issues: plan.issues });
          return;
        }

        jsonResponse(res, 201, {
          status: "created",
          item,
          plan
        });
        return;
      }

      if (url.pathname === "/api/workbench/scheduler-dispatch" && req.method === "POST") {
        const history = readJson(serverHistoryPath);
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }
        const normalizedControl = normalizeSchedulerDispatchControlRequest(input);
        if (normalizedControl.status !== "pass") {
          jsonResponse(res, 400, { error: "scheduler dispatch control request rejected", issues: normalizedControl.issues });
          return;
        }
        const controlInput = normalizedControl.input;
        const inputPath = historyItemPath(item.input_path, "input_path", allowedHistoryRoots);
        const workflowState = readJson(inputPath);
        const plan = createSchedulerDispatchPlan(
          schedulerPlanInputFromWorkflowState(workflowState, controlInput),
          schedulerPlanOptionsFromRequest(req, item, selectedId, controlInput)
        );
        if (plan.status !== "pass") {
          jsonResponse(res, 400, { error: "scheduler dispatch plan failed", issues: plan.issues });
          return;
        }

        const policy = evaluateSchedulerDispatchControlPolicy(controlInput, plan);
        const policyRecorded = recordSchedulerDispatchPolicyDecision(workflowState, policy, {
          created_at: controlInput.created_at || controlInput.createdAt,
          plan
        });
        if (policyRecorded.status !== "pass") {
          jsonResponse(res, 400, { error: "scheduler dispatch policy record failed", issues: policyRecorded.issues });
          return;
        }
        writeFileSync(inputPath, `${JSON.stringify({ ...workflowState, ...policyRecorded.workflow_state }, null, 2)}\n`);

        if (policy.status !== "pass") {
          jsonResponse(res, 400, {
            error: "scheduler dispatch policy rejected",
            issues: policy.issues,
            policy,
            control: normalizedControl,
            artifact: policyRecorded.artifact,
            projection: workbenchProjection(policyRecorded.workflow_state)
          });
          return;
        }

        const runResult = await runSchedulerDispatchPlan(plan, { dry_run: policy.execution_mode === "dry_run" });
        const runArtifact = createSchedulerDispatchRunArtifact(plan, runResult, {
          created_at: controlInput.created_at || controlInput.createdAt
        });
        let workflowStateForRunRecord = policyRecorded.workflow_state;
        if (
          policy.execution_mode !== "dry_run" &&
          plan.dispatch_kind === "agent_lifecycle_cleanup" &&
          runResult.status === "pass"
        ) {
          const cleanupOutput = readSchedulerWorkflowStateOutput(runResult);
          if (cleanupOutput.status !== "pass") {
            jsonResponse(res, 400, {
              error: "scheduler dispatch cleanup output unavailable",
              issues: cleanupOutput.issues || [],
              projection: workbenchProjection(policyRecorded.workflow_state)
            });
            return;
          }
          workflowStateForRunRecord = cleanupOutput.workflow_state;
        }

        const recorded = recordSchedulerDispatchRunArtifact(workflowStateForRunRecord, runArtifact, {
          created_at: controlInput.created_at || controlInput.createdAt
        });
        if (recorded.status !== "pass") {
          jsonResponse(res, 400, { error: "scheduler dispatch run record failed", issues: recorded.issues });
          return;
        }

        let nextWorkflowState = recorded.workflow_state;
        let continuation = null;
        if (policy.execution_mode !== "dry_run" && plan.dispatch_kind !== "agent_lifecycle_cleanup") {
          continuation = prepareSchedulerDispatchContinuationFromRunArtifact(runArtifact);
          if (continuation.status !== "ready") {
            jsonResponse(res, 400, {
              error: "scheduler dispatch continuation preparation failed",
              issues: continuation.issues || [],
              continuation,
              projection: workbenchProjection(nextWorkflowState)
            });
            return;
          }
          const continuationOutputPath = writePreparedSchedulerContinuation(runArtifact, continuation, [
            resolve(root, "tmp"),
            snapshotsRoot
          ]);
          const continuationRecorded = recordSchedulerDispatchContinuationPrepared(nextWorkflowState, continuation, {
            created_at: controlInput.created_at || controlInput.createdAt,
            source_artifact_id: recorded.artifact.id,
            continuation_input_path: metadataPath(continuationOutputPath)
          });
          if (continuationRecorded.status !== "pass") {
            jsonResponse(res, 400, { error: "scheduler dispatch continuation record failed", issues: continuationRecorded.issues });
            return;
          }
          nextWorkflowState = continuationRecorded.workflow_state;
        }

        writeFileSync(inputPath, `${JSON.stringify({ ...workflowState, ...nextWorkflowState }, null, 2)}\n`);
        jsonResponse(res, 201, {
          status: "created",
          item,
          plan,
          policy,
          control: normalizedControl,
          result: runResult,
          artifact: recorded.artifact,
          continuation,
          projection: workbenchProjection(nextWorkflowState)
        });
        return;
      }

      if (url.pathname === "/api/workbench/scheduler-next-cycle" && req.method === "POST") {
        const history = readJson(serverHistoryPath);
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }

        const inputPath = historyItemPath(item.input_path, "input_path", allowedHistoryRoots);
        const workflowState = readJson(inputPath);
        const latestRun = latestSchedulerDispatchRun(workflowState);
        if (!latestRun.metadata) {
          jsonResponse(res, 400, { error: "scheduler dispatch run artifact not found" });
          return;
        }

        const continuation = prepareSchedulerDispatchContinuationFromRunArtifact(latestRun.metadata);
        if (continuation.status !== "ready") {
          jsonResponse(res, 400, {
            error: "scheduler dispatch continuation preparation failed",
            issues: continuation.issues || [],
            continuation
          });
          return;
        }

        let continuationOutputPath;
        let generatedInput;
        try {
          continuationOutputPath = safeGeneratedContinuationPath(
            schedulerContinuationOutputPath(latestRun.metadata),
            [resolve(root, "tmp"), snapshotsRoot]
          );
          generatedInput = readJson(continuationOutputPath);
        } catch (error) {
          if (error.code === "ENOENT") {
            jsonResponse(res, 400, { error: "scheduler dispatch generated continuation input not found" });
            return;
          }
          throw error;
        }
        const generatedIssues = generatedContinuationInputIssues(generatedInput, continuation);
        if (generatedIssues.length > 0) {
          jsonResponse(res, 400, { error: "generated continuation input validation failed", issues: generatedIssues });
          return;
        }

        const createdAt = input.created_at || input.createdAt;
        const sourceArtifactId = latestRun.artifact?.id || latestRun.event?.artifact_id;
        const continuationInputPath = metadataPath(continuationOutputPath);
        const existingContinuation = latestArtifactForEvent(workflowState, "scheduler_dispatch_continuation");
        const existingContinuationMatchesRun = existingContinuation.metadata?.status === "ready" &&
          existingContinuation.metadata?.source_artifact_id === sourceArtifactId &&
          existingContinuation.metadata?.continuation_input_path === continuationInputPath;
        const continuationRecorded = existingContinuationMatchesRun
          ? {
            status: "pass",
            artifact: existingContinuation.artifact,
            workflow_state: workflowState
          }
          : recordSchedulerDispatchContinuationPrepared(workflowState, continuation, {
            created_at: createdAt,
            source_artifact_id: sourceArtifactId,
            continuation_input_path: continuationInputPath
          });
        if (continuationRecorded.status !== "pass") {
          jsonResponse(res, 400, { error: "scheduler dispatch continuation record failed", issues: continuationRecorded.issues });
          return;
        }

        const requestedSnapshotId = normalizeString(input.snapshot_id || input.snapshotId);
        const snapshotId = requestedSnapshotId || `next-cycle-${selectedId}-${Date.now()}`;
        const enqueued = recordSchedulerNextCycleEnqueue(continuationRecorded.workflow_state, continuation, {
          created_at: createdAt,
          source_artifact_id: sourceArtifactId,
          continuation_artifact_id: continuationRecorded.artifact.id,
          continuation_input_path: continuationInputPath,
          snapshot_id: snapshotId
        });
        if (enqueued.status !== "pass") {
          jsonResponse(res, 400, { error: "scheduler next cycle enqueue record failed", issues: enqueued.issues });
          return;
        }

        const published = publishWorkbenchSnapshot({
          id: snapshotId,
          label: input.label || `Next cycle from ${selectedId}`,
          input: generatedInput.workflow_state,
          created_at: createdAt
        }, {
          root,
          historyPath: serverHistoryPath,
          snapshotsRoot
        });
        if (published.status === "fail") {
          jsonResponse(res, 400, { error: "scheduler next cycle snapshot publish failed", issues: published.issues });
          return;
        }

        writeFileSync(inputPath, `${JSON.stringify({ ...workflowState, ...enqueued.workflow_state }, null, 2)}\n`);

        jsonResponse(res, 201, {
          status: "queued",
          item,
          continuation,
          continuation_artifact: continuationRecorded.artifact,
          enqueue_artifact: enqueued.artifact,
          next_item: published.item,
          projection: published.projection,
          current_projection: workbenchProjection(enqueued.workflow_state)
        });
        return;
      }

      if (url.pathname === "/api/workbench/autonomous-scheduler-loop" && req.method === "POST") {
        const history = readJson(serverHistoryPath);
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }

        const maxIterations = Number(input.max_iterations || input.maxIterations || 1);
        const loopInput = {
          start_projection_id: selectedId,
          max_iterations: maxIterations,
          execution_profile: input.execution_profile || input.executionProfile || "approved_mock_non_dry_run",
          execution_strategy: input.execution_strategy || input.executionStrategy || "scheduler_dispatch_chain",
          reviewer_mock_status: input.reviewer_mock_status || input.reviewerMockStatus,
          reviewer_mock_findings_json: input.reviewer_mock_findings_json || input.reviewerMockFindingsJson,
          max_external_reviewer_calls: input.max_external_reviewer_calls ?? input.maxExternalReviewerCalls,
          provider_cost_mode: input.provider_cost_mode || input.providerCostMode,
          budget_tier: input.budget_tier || input.budgetTier,
          risk: input.risk || input.risk_level || input.riskLevel,
          timeout_seconds: input.timeout_seconds || input.timeoutSeconds,
          record_provider_health_on_timeout: input.record_provider_health_on_timeout ?? input.recordProviderHealthOnTimeout,
          snapshot_prefix: input.snapshot_prefix || input.snapshotPrefix || "autonomous-loop",
          created_at: input.created_at || input.createdAt
        };
        const loopResult = await runSchedulerLoopDriver(loopInput, {
          client: createWorkbenchLoopClient(workbenchBaseUrlFromRequest(req))
        });
        const loopArtifact = createSchedulerLoopRunArtifact(loopInput, loopResult, {
          created_at: input.created_at || input.createdAt
        });

        const inputPath = historyItemPath(item.input_path, "input_path", allowedHistoryRoots);
        const latestWorkflowState = readJson(inputPath);
        const recorded = recordAutonomousSchedulerLoopRunArtifact(latestWorkflowState, loopArtifact, {
          created_at: input.created_at || input.createdAt
        });
        if (recorded.status !== "pass") {
          jsonResponse(res, 400, { error: "autonomous scheduler loop record failed", issues: recorded.issues });
          return;
        }
        writeFileSync(inputPath, `${JSON.stringify({ ...latestWorkflowState, ...recorded.workflow_state }, null, 2)}\n`);

        jsonResponse(res, loopResult.status === "pass" ? 201 : 400, {
          status: loopResult.status === "pass" ? "created" : "failed",
          item,
          result: loopResult,
          artifact: recorded.artifact,
          projection: workbenchProjection(recorded.workflow_state)
        });
        return;
      }

      if (url.pathname === "/api/workbench/autonomous-scheduler-loop-resume" && req.method === "POST") {
        const history = readJson(serverHistoryPath);
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }

        const sourcePath = historyItemPath(item.input_path, "input_path", allowedHistoryRoots);
        const sourceWorkflowState = readJson(sourcePath);
        const registry = buildSchedulerLoopRunRegistry(sourceWorkflowState);
        const recovery = evaluateSchedulerLoopRecovery(registry);
        const sourceProjection = workbenchProjection(sourceWorkflowState);
        if (recovery.status !== "ready" || !recovery.resume_projection_id) {
          const blockedAttempt = recordSchedulerLoopResumeAttempt(sourceWorkflowState, {
            status: "blocked",
            source_projection_id: selectedId,
            recovery_status: recovery.status,
            recovery_action: recovery.action,
            issues: recovery.issues || []
          }, {
            created_at: input.created_at || input.createdAt
          });
          if (blockedAttempt.status === "pass") {
            writeFileSync(sourcePath, `${JSON.stringify({ ...sourceWorkflowState, ...blockedAttempt.workflow_state }, null, 2)}\n`);
          }
          jsonResponse(res, 409, {
            error: "autonomous scheduler loop is not resumable",
            recovery,
            resume_attempt: blockedAttempt.artifact || null,
            projection: blockedAttempt.status === "pass"
              ? workbenchProjection(blockedAttempt.workflow_state)
              : sourceProjection
          });
          return;
        }

        const targetId = recovery.resume_projection_id;
        const targetItem = history.items.find((entry) => entry.id === targetId);
        if (!targetItem?.input_path) {
          const blockedAttempt = recordSchedulerLoopResumeAttempt(sourceWorkflowState, {
            status: "blocked",
            source_projection_id: selectedId,
            resume_projection_id: targetId,
            recovery_status: recovery.status,
            recovery_action: recovery.action,
            issues: [{ code: "resume_input_missing", message: `resume workflow state input not found: ${targetId}`, path: "recovery.resume_projection_id" }]
          }, {
            created_at: input.created_at || input.createdAt
          });
          if (blockedAttempt.status === "pass") {
            writeFileSync(sourcePath, `${JSON.stringify({ ...sourceWorkflowState, ...blockedAttempt.workflow_state }, null, 2)}\n`);
          }
          jsonResponse(res, 400, {
            error: `resume workflow state input not found: ${targetId}`,
            recovery,
            resume_attempt: blockedAttempt.artifact || null,
            projection: blockedAttempt.status === "pass"
              ? workbenchProjection(blockedAttempt.workflow_state)
              : sourceProjection
          });
          return;
        }

        const loopInput = {
          start_projection_id: targetId,
          max_iterations: Number(input.max_iterations || input.maxIterations || 1),
          execution_profile: input.execution_profile || input.executionProfile || "approved_mock_non_dry_run",
          execution_strategy: input.execution_strategy || input.executionStrategy || "scheduler_dispatch_chain",
          reviewer_mock_status: input.reviewer_mock_status || input.reviewerMockStatus,
          reviewer_mock_findings_json: input.reviewer_mock_findings_json || input.reviewerMockFindingsJson,
          max_external_reviewer_calls: input.max_external_reviewer_calls ?? input.maxExternalReviewerCalls,
          provider_cost_mode: input.provider_cost_mode || input.providerCostMode,
          budget_tier: input.budget_tier || input.budgetTier,
          risk: input.risk || input.risk_level || input.riskLevel,
          timeout_seconds: input.timeout_seconds || input.timeoutSeconds,
          record_provider_health_on_timeout: input.record_provider_health_on_timeout ?? input.recordProviderHealthOnTimeout,
          snapshot_prefix: input.snapshot_prefix || input.snapshotPrefix || "resume-loop",
          created_at: input.created_at || input.createdAt
        };
        const loopResult = await runSchedulerLoopDriver(loopInput, {
          client: createWorkbenchLoopClient(workbenchBaseUrlFromRequest(req))
        });
        const loopArtifact = createSchedulerLoopRunArtifact(loopInput, loopResult, {
          created_at: input.created_at || input.createdAt
        });

        const targetPath = historyItemPath(targetItem.input_path, "input_path", allowedHistoryRoots);
        const targetWorkflowState = readJson(targetPath);
        const recorded = recordAutonomousSchedulerLoopRunArtifact(targetWorkflowState, loopArtifact, {
          created_at: input.created_at || input.createdAt
        });
        if (recorded.status !== "pass") {
          jsonResponse(res, 400, { error: "autonomous scheduler loop resume record failed", issues: recorded.issues });
          return;
        }
        writeFileSync(targetPath, `${JSON.stringify({ ...targetWorkflowState, ...recorded.workflow_state }, null, 2)}\n`);

        const resumeAttempt = recordSchedulerLoopResumeAttempt(sourceWorkflowState, {
          status: loopResult.status === "pass" ? "pass" : "fail",
          source_projection_id: selectedId,
          resume_projection_id: targetId,
          recovery_status: recovery.status,
          recovery_action: recovery.action,
          loop_status: loopResult.status,
          loop_phase: loopResult.phase,
          loop_artifact_id: recorded.artifact.id,
          issues: loopResult.issues || []
        }, {
          created_at: input.created_at || input.createdAt
        });
        if (resumeAttempt.status !== "pass") {
          jsonResponse(res, 400, { error: "scheduler loop resume attempt record failed", issues: resumeAttempt.issues });
          return;
        }
        writeFileSync(sourcePath, `${JSON.stringify({ ...sourceWorkflowState, ...resumeAttempt.workflow_state }, null, 2)}\n`);

        jsonResponse(res, loopResult.status === "pass" ? 201 : 400, {
          status: loopResult.status === "pass" ? "created" : "failed",
          source_item: item,
          item: targetItem,
          recovery,
          result: loopResult,
          artifact: recorded.artifact,
          resume_attempt: resumeAttempt.artifact,
          source_projection: workbenchProjection(resumeAttempt.workflow_state),
          projection: workbenchProjection(recorded.workflow_state)
        });
        return;
      }

      if (url.pathname === "/api/workbench/next-action" && req.method === "POST") {
        const history = readJson(serverHistoryPath);
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }

        const inputPath = historyItemPath(item.input_path, "input_path", allowedHistoryRoots);
        const workflowState = readJson(inputPath);
        const projection = workbenchProjection(workflowState);
        const executed = await executeProjectedNextAction({
          req,
          selectedId,
          projection,
          input
        });
        if (executed.status !== "executed") {
          jsonResponse(res, executed.http_status || 409, {
            error: executed.error,
            issues: executed.issues || [],
            item,
            next_action_readout: projection.next_action_readout,
            result: executed.result || null,
            projection
          });
          return;
        }

        jsonResponse(res, 201, {
          status: "executed",
          action: executed.action,
          item,
          next_action_readout: projection.next_action_readout,
          result: executed.result,
          projection: executed.result?.projection || executed.result?.current_projection || null
        });
        return;
      }

      if (url.pathname === "/api/workbench/scheduler-dispatch-run" && req.method === "POST") {
        const history = readJson(serverHistoryPath);
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }

        const issues = schedulerDispatchRunIssues(input);
        if (issues.length > 0) {
          jsonResponse(res, 400, { error: "invalid scheduler dispatch run artifact", issues });
          return;
        }

        const inputPath = historyItemPath(item.input_path, "input_path", allowedHistoryRoots);
        const workflowState = readJson(inputPath);
        const result = recordSchedulerDispatchRunArtifact(
          workflowState,
          schedulerDispatchRunArtifactFromInput(input),
          { created_at: input.created_at }
        );
        if (result.status !== "pass") {
          jsonResponse(res, 400, { error: "scheduler dispatch run record failed", issues: result.issues });
          return;
        }

        writeFileSync(inputPath, `${JSON.stringify({ ...workflowState, ...result.workflow_state }, null, 2)}\n`);
        jsonResponse(res, 201, {
          status: "created",
          item,
          artifact: result.artifact,
          projection: workbenchProjection(result.workflow_state)
        });
        return;
      }

      if (url.pathname === "/api/workbench/events" && req.method === "GET") {
        jsonResponse(res, 200, readEvents(eventsPath));
        return;
      }

      if (url.pathname === "/api/workbench/events" && req.method === "POST") {
        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }
        const issues = operatorEventIssues(input);
        if (issues.length > 0) {
          jsonResponse(res, 400, { error: "invalid operator event", issues });
          return;
        }
        const event = normalizeEvent(input, url.searchParams.get("projection_id"));
        const ledger = appendEvent(eventsPath, event);
        jsonResponse(res, 201, { status: "created", event, count: ledger.events.length });
        return;
      }

      const staticPath = safeStaticPath(url.pathname === "/" ? "/apps/workbench/desktop.html" : url.pathname);
      if (!staticPath) {
        jsonResponse(res, 403, { error: "forbidden" });
        return;
      }

      const content = readFileSync(staticPath);
      res.writeHead(200, {
        "content-type": MIME_TYPES[extname(staticPath)] || "application/octet-stream",
        "cache-control": "no-store"
      });
      res.end(content);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "PROJECTION_NOT_FOUND") {
        jsonResponse(res, 404, { error: error.message });
        return;
      }

      if (error.code === "INVALID_HISTORY_PATH") {
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

      jsonResponse(res, 500, { error: error.message });
    }
  });
}

function valueAfter(flag, args = process.argv.slice(2)) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function normalizeCliPort(value) {
  const raw = String(value ?? "").trim();
  const port = Number(raw);
  if (!raw || !Number.isInteger(port) || port < 0 || port > 65535) {
    const error = new Error(`Invalid workbench server port: ${raw || "(empty)"}. Expected an integer from 0 to 65535.`);
    error.code = "INVALID_WORKBENCH_PORT";
    throw error;
  }
  return port;
}

function parseWorkbenchServerCliArgs(args = process.argv.slice(2), env = process.env) {
  const optionNames = new Set(["--host", "--port", "--history-path", "--snapshots-root", "--events-path", "--project-status"]);
  const positionalArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (optionNames.has(arg.split("=")[0])) {
      if (!arg.includes("=")) index += 1;
      continue;
    }
    if (optionNames.has(arg)) {
      index += 1;
      continue;
    }
    if (!arg.startsWith("-")) positionalArgs.push(arg);
  }

  const optionValue = (name) => {
    const equalsPrefix = `${name}=`;
    const inline = args.find((arg) => arg.startsWith(equalsPrefix));
    if (inline) return inline.slice(equalsPrefix.length);
    return valueAfter(name, args);
  };
  const portValue = args.includes("--port")
    || args.some((arg) => arg.startsWith("--port="))
    ? optionValue("--port")
    : env.PORT ?? positionalArgs[0] ?? "4180";
  return {
    port: normalizeCliPort(portValue),
    host: optionValue("--host") || "127.0.0.1",
    historyPath: optionValue("--history-path"),
    snapshotsRoot: optionValue("--snapshots-root"),
    eventsPath: optionValue("--events-path"),
    projectStatusPath: optionValue("--project-status")
  };
}

export function startWorkbenchServer({
  port = 4180,
  host = "127.0.0.1",
  historyPath: configuredHistoryPath,
  snapshotsRoot: configuredSnapshotsRoot,
  eventsPath: configuredEventsPath,
  projectStatusPath
} = {}) {
  const server = createWorkbenchServer({
    historyPath: configuredHistoryPath,
    snapshotsRoot: configuredSnapshotsRoot,
    eventsPath: configuredEventsPath,
    projectStatusPath
  });
  const listenPort = normalizeCliPort(port);
  server.listen(listenPort, host);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log([
      "Usage: node tools/workbench-server.mjs [port] [--host <host>] [--port <port>] [--history-path <path>] [--snapshots-root <path>] [--events-path <path>] [--project-status <path>]",
      "",
      "Starts the local workbench service. Paths are resolved from the platform repo root."
    ].join("\n"));
    process.exit(0);
  }
  let cliOptions;
  try {
    cliOptions = parseWorkbenchServerCliArgs();
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
