import { request as httpRequest } from "node:http";

import { VERIFIED_PROVIDER_MULTI_AGENT_PROFILE } from "../src/workflow/context-work-package-execution-adapter.js";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
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

export function createWorkbenchLoopClient(baseUrl) {
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

function contextWorkPackageRequiresProviderAuthority(projection = {}) {
  return asArray(projection?.task_dag?.dispatchable || projection?.taskDag?.dispatchable)
    .some((node) => {
      const action = normalizeString(node?.action);
      const id = normalizeString(node?.id);
      return action === "continue_requirement_intake" ||
        action === "execute_requirement_plan_step" ||
        action === "continue_global_goal" ||
        id.startsWith("global-goal-");
    });
}

export function contextWorkPackageRunOptions(input = {}, projection = null) {
  const executionProfile = input.context_work_package_execution_profile ||
    input.contextWorkPackageExecutionProfile ||
    input.execution_profile ||
    input.executionProfile;
  const executionMode = input.execution_mode || input.executionMode;
  const shouldUseProviderDefault = !executionMode &&
    !executionProfile &&
    contextWorkPackageRequiresProviderAuthority(projection);
  return {
    max_package_count: input.max_package_count ?? input.maxPackageCount,
    created_at: input.created_at || input.createdAt,
    idle_timeout_seconds: input.idle_timeout_seconds || input.idleTimeoutSeconds,
    execution_mode: executionMode || (shouldUseProviderDefault ? "provider_model_routed" : undefined),
    execution_profile: executionProfile || (shouldUseProviderDefault ? VERIFIED_PROVIDER_MULTI_AGENT_PROFILE : undefined),
    requirement_id: input.requirement_id || input.requirementId,
    selected_work_package_ids: Array.isArray(input.selected_work_package_ids)
      ? input.selected_work_package_ids
      : Array.isArray(input.selectedWorkPackageIds)
        ? input.selectedWorkPackageIds
        : undefined,
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
    stage: input.stage,
    execution_cwd: input.execution_cwd || input.executionCwd,
    primary_worktree_path: input.primary_worktree_path || input.primaryWorktreePath,
    worker_workspaces_root: input.worker_workspaces_root || input.workerWorkspacesRoot,
    add_dir: input.add_dir || input.addDir
  };
}

export function workbenchBaseUrlFromRequest(req) {
  const host = String(req.headers.host || "").trim();
  if (!host || !/^[a-zA-Z0-9.:-]+$/.test(host)) {
    const error = new Error("request host is required for scheduler dispatch writeback planning");
    error.code = "INVALID_WORKBENCH_HOST";
    throw error;
  }
  return `http://${host}`;
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

export async function executeProjectedNextAction({ req, selectedId, projection, input = {} }) {
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

  if (action === "prepare_project_status_continuation" || action === "continue_after_reviewer_aggregate") {
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
      const result = await client.runContextWorkPackages(selectedId, contextWorkPackageRunOptions(input, projection));
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
