import {
  APPROVED_BOUNDED_REAL_REVIEWER_PROFILE,
  APPROVED_MOCK_REVIEWER_PROFILE
} from "./reviewer-execution-policy.js";
import {
  MAX_SNAPSHOT_ID_LENGTH,
  asArray,
  issue,
  normalizeString,
  safeIdPart
} from "./autonomous-scheduler-loop-utils.js";

function boundedMaxIterations(value) {
  const parsed = Number(value || 1);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) {
    return {
      status: "fail",
      value: null,
      issues: [issue("invalid_scheduler_loop_iterations", "max_iterations must be an integer between 1 and 5", "max_iterations")]
    };
  }
  return { status: "pass", value: parsed, issues: [] };
}

export function schedulerLoopInput(input = {}) {
  const maxIterations = boundedMaxIterations(input.max_iterations || input.maxIterations || 1);
  const executionProfile = normalizeString(input.execution_profile || input.executionProfile || "approved_mock_non_dry_run");
  const executionStrategy = normalizeString(input.execution_strategy || input.executionStrategy || "scheduler_dispatch_chain");
  const issues = [...maxIterations.issues];

  if (![APPROVED_MOCK_REVIEWER_PROFILE, APPROVED_BOUNDED_REAL_REVIEWER_PROFILE].includes(executionProfile)) {
    issues.push(issue("unsupported_scheduler_loop_profile", "scheduler loop profile must be approved_mock_non_dry_run or approved_bounded_real_reviewer", "execution_profile"));
  }
  if (executionProfile === APPROVED_BOUNDED_REAL_REVIEWER_PROFILE && executionStrategy !== "projected_next_action") {
    issues.push(issue("real_reviewer_requires_projected_strategy", "approved_bounded_real_reviewer requires projected_next_action strategy", "execution_strategy"));
  }
  if (!["scheduler_dispatch_chain", "projected_next_action"].includes(executionStrategy)) {
    issues.push(issue("unsupported_scheduler_loop_strategy", "scheduler loop strategy must be scheduler_dispatch_chain or projected_next_action", "execution_strategy"));
  }

  return {
    status: issues.length ? "fail" : "pass",
    issues,
    max_iterations: maxIterations.value,
    execution_profile: executionProfile,
    execution_strategy: executionStrategy,
    start_projection_id: normalizeString(input.start_projection_id || input.startProjectionId),
    snapshot_prefix: normalizeString(input.snapshot_prefix || input.snapshotPrefix || "scheduler-loop")
  };
}

function requireClient(client = {}, strategy = "scheduler_dispatch_chain") {
  const required = strategy === "projected_next_action"
    ? ["loadHistory", "loadProjection", "runNextAction"]
    : ["loadHistory", "createSchedulerDispatchPlan", "runSchedulerDispatch", "enqueueSchedulerNextCycle"];
  const missing = required
    .filter((method) => typeof client[method] !== "function");
  return missing.length > 0
    ? [issue("missing_scheduler_loop_client", `scheduler loop client is missing: ${missing.join(", ")}`, "client")]
    : [];
}

function planStepCount(planResponse = {}) {
  return asArray(planResponse?.plan?.steps || planResponse?.steps).length;
}

function planPhase(planResponse = {}) {
  return planResponse?.plan?.phase || planResponse?.phase || null;
}

function planStatus(planResponse = {}) {
  return planResponse?.plan?.status || planResponse?.status || null;
}

function continuationReady(dispatchResponse = {}) {
  return dispatchResponse?.projection?.scheduler_continuation?.ready === true ||
    dispatchResponse?.projection?.scheduler_dispatch?.next_continuation_status === "pass";
}

function loopSnapshotId(prefix, projectionId, index) {
  const suffix = String(index + 1).padStart(2, "0");
  const base = `${safeIdPart(prefix)}-${safeIdPart(projectionId)}`;
  const maxBaseLength = MAX_SNAPSHOT_ID_LENGTH - suffix.length - 1;
  const safeBase = base.length > maxBaseLength
    ? base.slice(0, maxBaseLength).replace(/[._-]+$/u, "")
    : base;
  return `${safeBase || "snapshot"}-${suffix}`;
}

function projectedNextProjectionId(actionResult = {}) {
  return actionResult?.result?.next_item?.id ||
    null;
}

function projectedActionResultProjection(actionResult = {}) {
  return actionResult?.result?.projection ||
    actionResult?.result?.current_projection ||
    actionResult?.projection ||
    null;
}

function projectedReadoutKey(readout = {}) {
  return JSON.stringify({
    status: normalizeString(readout?.status),
    action: normalizeString(readout?.action),
    target_projection_id: normalizeString(readout?.target_projection_id || readout?.targetProjectionId),
    source_event_id: normalizeString(readout?.source_event_id || readout?.sourceEventId),
    source_type: normalizeString(readout?.source_type || readout?.sourceType),
    reason: normalizeString(readout?.reason)
  });
}

function projectedProgressKey(projection = {}) {
  return JSON.stringify({
    next_action_readout: projection?.next_action_readout || null,
    reviewer_shard_review: projection?.reviewer_shard_review || null,
    agent_lifecycle_pool: projection?.agent_lifecycle_pool || null,
    scheduler_dispatch: projection?.scheduler_dispatch || null,
    scheduler_continuation: projection?.scheduler_continuation || null,
    scheduler_loop: projection?.scheduler_loop || null,
    projected_action_progress: projection?.projected_action_progress || null,
    global_goal_completion: projection?.global_goal_completion || null
  });
}

function projectionShowsProjectedActionProgress(beforeReadout = {}, resultProjection = {}) {
  if (!resultProjection) return false;
  if (projectedReadoutKey(resultProjection.next_action_readout || {}) !== projectedReadoutKey(beforeReadout || {})) {
    return true;
  }
  return false;
}

function isTerminalProjectedAction(action = "") {
  return !action ||
    action === "wait_for_driver_event" ||
    action === "inspect_scheduler_loop" ||
    action === "inspect_resume_target" ||
    action === "inspect_latest_driver";
}

function projectedNextActionInput(action, input = {}, normalized = {}, currentProjectionId, index) {
  const body = {
    expected_action: action,
    max_iterations: 1,
    reviewer_mock_status: input.reviewer_mock_status || input.reviewerMockStatus,
    reviewer_mock_findings_json: input.reviewer_mock_findings_json || input.reviewerMockFindingsJson,
    max_external_reviewer_calls: input.max_external_reviewer_calls ?? input.maxExternalReviewerCalls,
    provider_cost_mode: input.provider_cost_mode || input.providerCostMode,
    budget_tier: input.budget_tier || input.budgetTier,
    risk: input.risk || input.risk_level || input.riskLevel,
    timeout_seconds: input.timeout_seconds || input.timeoutSeconds,
    record_provider_health_on_timeout: input.record_provider_health_on_timeout ?? input.recordProviderHealthOnTimeout,
    snapshot_id: loopSnapshotId(normalized.snapshot_prefix, currentProjectionId, index),
    snapshot_prefix: normalized.snapshot_prefix,
    created_at: input.created_at || input.createdAt
  };

  if (action !== "run_context_work_packages") {
    return {
      ...body,
      execution_profile: normalized.execution_profile
    };
  }

  return {
    ...body,
    max_package_count: input.max_package_count ?? input.maxPackageCount,
    execution_cwd: input.execution_cwd || input.executionCwd,
    primary_worktree_path: input.primary_worktree_path || input.primaryWorktreePath,
    worker_workspaces_root: input.worker_workspaces_root || input.workerWorkspacesRoot,
    add_dir: input.add_dir || input.addDir,
    execution_mode: input.context_work_package_execution_mode || input.contextWorkPackageExecutionMode,
    context_work_package_execution_profile: input.context_work_package_execution_profile || input.contextWorkPackageExecutionProfile,
    executor_profile: input.executor_profile || input.executorProfile,
    executor_kind: input.executor_kind || input.executorKind,
    adapter_profile: input.adapter_profile || input.adapterProfile,
    tags: Array.isArray(input.tags) ? input.tags : undefined,
    stage: input.stage
  };
}

export async function runSchedulerLoopDriver(input = {}, options = {}) {
  const normalized = schedulerLoopInput(input);
  const clientIssues = requireClient(options.client, normalized.execution_strategy);
  if (normalized.status !== "pass" || clientIssues.length > 0) {
    return {
      status: "fail",
      phase: "input",
      issues: [...normalized.issues, ...clientIssues],
      iterations: []
    };
  }

  const iterations = [];
  let currentProjectionId = normalized.start_projection_id;
  try {
    const history = await options.client.loadHistory();
    currentProjectionId = currentProjectionId || history.latest;
    if (!currentProjectionId) {
      return {
        status: "pass",
        phase: "no_projection_history",
        issues: [],
        iterations
      };
    }

    for (let index = 0; index < normalized.max_iterations; index += 1) {
      const iteration = {
        index: index + 1,
        projection_id: currentProjectionId,
        status: "pending",
        plan_status: null,
        plan_phase: null,
        step_count: 0,
        dispatch_status: null,
        continuation_ready: false,
        enqueue_status: null,
        projected_action: null,
        next_action_status: null,
        next_projection_id: null,
        issues: []
      };
      iterations.push(iteration);

      if (normalized.execution_strategy === "projected_next_action") {
        const projection = await options.client.loadProjection(currentProjectionId);
        const readout = projection?.next_action_readout || {};
        const beforeProgressKey = projectedProgressKey(projection);
        iteration.projected_action = readout.action || null;
        iteration.next_action_status = readout.status || null;

        if (readout.status !== "ready" || isTerminalProjectedAction(readout.action)) {
          iteration.status = "stopped";
          iteration.terminal_action = readout.action || null;
          iteration.terminal_reason = readout.reason || "projected next action is not executable";
          return {
            status: "pass",
            phase: "terminal_projected_action",
            issues: [],
            iterations
          };
        }

        const actionResult = await options.client.runNextAction(
          currentProjectionId,
          projectedNextActionInput(readout.action, input, normalized, currentProjectionId, index)
        );
        iteration.status = actionResult.status || "executed";
        iteration.next_projection_id = projectedNextProjectionId(actionResult);
        if (iteration.status === "blocked") {
          iteration.issues.push(...asArray(actionResult.issues));
          return {
            status: "fail",
            phase: "projected_action_blocked",
            issues: iteration.issues,
            iterations
          };
        }
        const resultProjection = projectedActionResultProjection(actionResult);
        const hasProgress = projectionShowsProjectedActionProgress(readout, resultProjection) ||
          (resultProjection && projectedProgressKey(resultProjection) !== beforeProgressKey);
        if (!iteration.next_projection_id && !hasProgress) {
          iteration.status = "blocked";
          iteration.issues.push(issue(
            "projected_action_missing_progress_evidence",
            "projected next-action execution must return either next_item.id or an updated projection with changed next_action_readout",
            "action_result"
          ));
          return {
            status: "fail",
            phase: "projected_action_missing_progress_evidence",
            issues: iteration.issues,
            iterations
          };
        }
        currentProjectionId = iteration.next_projection_id || currentProjectionId;
        continue;
      }

      const plan = await options.client.createSchedulerDispatchPlan(currentProjectionId, {});
      iteration.plan_status = planStatus(plan);
      iteration.plan_phase = planPhase(plan);
      iteration.step_count = planStepCount(plan);

      if (iteration.step_count === 0) {
        iteration.status = "stopped";
        return {
          status: "pass",
          phase: "no_dispatchable_scheduler_actions",
          issues: [],
          iterations
        };
      }

      const dispatch = await options.client.runSchedulerDispatch(currentProjectionId, {
        execution_profile: normalized.execution_profile,
        created_at: input.created_at || input.createdAt
      });
      iteration.dispatch_status = dispatch.status || dispatch.result?.status || null;
      iteration.continuation_ready = continuationReady(dispatch);
      if (!iteration.continuation_ready) {
        iteration.status = "blocked";
        iteration.issues.push(issue("scheduler_continuation_not_ready", "scheduler dispatch did not produce ready continuation", "dispatch.projection.scheduler_continuation"));
        return {
          status: "fail",
          phase: "continuation_not_ready",
          issues: iteration.issues,
          iterations
        };
      }

      const snapshotId = loopSnapshotId(normalized.snapshot_prefix, currentProjectionId, index);
      const enqueue = await options.client.enqueueSchedulerNextCycle(currentProjectionId, {
        snapshot_id: snapshotId,
        label: `Scheduler loop ${index + 1}`,
        created_at: input.created_at || input.createdAt
      });
      iteration.enqueue_status = enqueue.status || null;
      iteration.next_projection_id = enqueue.next_item?.id || null;
      iteration.status = "queued";
      if (!iteration.next_projection_id) {
        iteration.status = "blocked";
        iteration.issues.push(issue("missing_next_projection_id", "scheduler next-cycle enqueue must return next_item.id", "enqueue.next_item.id"));
        return {
          status: "fail",
          phase: "enqueue_missing_next_projection",
          issues: iteration.issues,
          iterations
        };
      }
      currentProjectionId = iteration.next_projection_id;
    }

    return {
      status: "pass",
      phase: "iteration_limit_reached",
      issues: [],
      iterations
    };
  } catch (error) {
    const latestIteration = iterations.at(-1);
    const responseIssues = asArray(error.response?.issues);
    if (normalized.execution_strategy === "projected_next_action" &&
      latestIteration &&
      (error.http_status === 409 || responseIssues.length > 0)) {
      latestIteration.status = "blocked";
      latestIteration.issues.push(...responseIssues);
      return {
        status: "fail",
        phase: "projected_action_blocked",
        issues: latestIteration.issues.length > 0
          ? latestIteration.issues
          : [issue("projected_action_blocked", error.message, "next_action")],
        iterations
      };
    }
    return {
      status: "fail",
      phase: "execution",
      issues: [issue("scheduler_loop_execution_failed", error.message, "client")],
      iterations
    };
  }
}

function dispatchChainClientReady(client = {}) {
  return ["loadHistory", "createSchedulerDispatchPlan", "runSchedulerDispatch", "enqueueSchedulerNextCycle"]
    .every((method) => typeof client[method] === "function");
}

function isConnectivityFailurePhase(result = {}) {
  return result?.status === "fail" && result?.phase === "execution";
}

export async function runSchedulerLoopDriverWithFallback(input = {}, options = {}) {
  const allowFallback = Boolean(input.allow_strategy_fallback || input.allowStrategyFallback);
  const requestedStrategy = normalizeString(input.execution_strategy || input.executionStrategy || "scheduler_dispatch_chain");
  const profile = normalizeString(input.execution_profile || input.executionProfile || "approved_mock_non_dry_run");

  const primary = await runSchedulerLoopDriver(input, options);
  if (!allowFallback) return primary;
  if (requestedStrategy !== "projected_next_action") return primary;
  if (profile === APPROVED_BOUNDED_REAL_REVIEWER_PROFILE) {
    return {
      ...primary,
      fallback: {
        attempted: false,
        from_strategy: requestedStrategy,
        to_strategy: "scheduler_dispatch_chain",
        reason: "approved_bounded_real_reviewer profile forbids dispatch-chain fallback"
      }
    };
  }
  if (!isConnectivityFailurePhase(primary)) return primary;
  if (!dispatchChainClientReady(options.client || {})) {
    return {
      ...primary,
      fallback: {
        attempted: false,
        from_strategy: requestedStrategy,
        to_strategy: "scheduler_dispatch_chain",
        reason: "scheduler dispatch-chain client methods unavailable; cannot fall back"
      }
    };
  }

  const fallbackInput = { ...input, execution_strategy: "scheduler_dispatch_chain" };
  delete fallbackInput.executionStrategy;
  const primaryReason = primary.issues?.[0]?.message || primary.issues?.[0]?.code || "projected_next_action execution failed";
  const fallback = await runSchedulerLoopDriver(fallbackInput, options);

  return {
    ...fallback,
    primary_result: primary,
    fallback: {
      attempted: true,
      from_strategy: requestedStrategy,
      to_strategy: "scheduler_dispatch_chain",
      reason: `projected_next_action unavailable; fell back to scheduler_dispatch_chain (${primaryReason})`,
      primary_phase: primary.phase,
      primary_status: primary.status
    }
  };
}
