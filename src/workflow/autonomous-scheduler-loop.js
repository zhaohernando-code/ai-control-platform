import { recordArtifact } from "./artifact-ledger.js";
import { appendRunEvent } from "./run-manifest.js";
import {
  APPROVED_BOUNDED_REAL_REVIEWER_PROFILE,
  APPROVED_MOCK_REVIEWER_PROFILE
} from "./reviewer-execution-policy.js";

const AUTONOMOUS_SCHEDULER_LOOP_RUN_VERSION = "autonomous-scheduler-loop-run.v1";
const SCHEDULER_LOOP_RESUME_ATTEMPT_VERSION = "scheduler-loop-resume-attempt.v1";
const MAX_SNAPSHOT_ID_LENGTH = 80;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function issue(code, message, path) {
  return { code, message, path };
}

function safeIdPart(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function manifestIdentity(workflowState = {}) {
  return {
    run_id: normalizeString(workflowState?.manifest?.run_id),
    cycle_id: normalizeString(workflowState?.manifest?.cycle_id)
  };
}

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

function schedulerLoopInput(input = {}) {
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
    return {
      status: "fail",
      phase: "execution",
      issues: [issue("scheduler_loop_execution_failed", error.message, "client")],
      iterations
    };
  }
}

export function createSchedulerLoopRunArtifact(input = {}, result = {}, options = {}) {
  return {
    version: AUTONOMOUS_SCHEDULER_LOOP_RUN_VERSION,
    status: result.status || "fail",
    phase: result.phase || null,
    created_at: options.created_at || new Date().toISOString(),
    input: {
      start_projection_id: input.start_projection_id || input.startProjectionId || null,
      max_iterations: input.max_iterations || input.maxIterations || 1,
      execution_profile: input.execution_profile || input.executionProfile || "approved_mock_non_dry_run",
      execution_strategy: input.execution_strategy || input.executionStrategy || "scheduler_dispatch_chain",
      snapshot_prefix: input.snapshot_prefix || input.snapshotPrefix || "scheduler-loop"
    },
    result: {
      status: result.status || "fail",
      phase: result.phase || null,
      issues: result.issues || [],
      iterations: result.iterations || []
    }
  };
}

export function validateSchedulerLoopRunArtifact(artifact = {}) {
  const issues = [];
  if (!isObject(artifact)) {
    return {
      status: "fail",
      issues: [issue("invalid_scheduler_loop_artifact", "artifact must be an object", "")]
    };
  }

  if (artifact.version !== AUTONOMOUS_SCHEDULER_LOOP_RUN_VERSION) {
    issues.push(issue("invalid_scheduler_loop_version", `version must be ${AUTONOMOUS_SCHEDULER_LOOP_RUN_VERSION}`, "version"));
  }
  if (!["pass", "fail"].includes(artifact.status)) {
    issues.push(issue("invalid_scheduler_loop_status", "status must be pass or fail", "status"));
  }
  if (!normalizeString(artifact.phase)) {
    issues.push(issue("missing_scheduler_loop_phase", "phase is required", "phase"));
  }
  if (!normalizeString(artifact.created_at)) {
    issues.push(issue("missing_scheduler_loop_created_at", "created_at is required", "created_at"));
  }
  if (!isObject(artifact.input)) {
    issues.push(issue("missing_scheduler_loop_input", "input must be an object", "input"));
  }
  if (!isObject(artifact.result)) {
    issues.push(issue("missing_scheduler_loop_result", "result must be an object", "result"));
  }

  const result = artifact.result || {};
  if (result.status !== artifact.status) {
    issues.push(issue("scheduler_loop_status_mismatch", "artifact status must match result.status", "result.status"));
  }
  if (result.phase !== artifact.phase) {
    issues.push(issue("scheduler_loop_phase_mismatch", "artifact phase must match result.phase", "result.phase"));
  }
  if (!Array.isArray(result.iterations)) {
    issues.push(issue("missing_scheduler_loop_iterations", "result.iterations must be an array", "result.iterations"));
  }
  asArray(result.iterations).forEach((iteration, index) => {
    if (!Number.isInteger(iteration?.index)) {
      issues.push(issue("invalid_scheduler_loop_iteration_index", "iteration.index must be an integer", `result.iterations.${index}.index`));
    }
    if (!normalizeString(iteration?.projection_id)) {
      issues.push(issue("missing_scheduler_loop_iteration_projection", "iteration.projection_id is required", `result.iterations.${index}.projection_id`));
    }
    if (!["pending", "stopped", "blocked", "queued", "executed"].includes(normalizeString(iteration?.status))) {
      issues.push(issue("invalid_scheduler_loop_iteration_status", "iteration.status must be pending, stopped, blocked, queued, or executed", `result.iterations.${index}.status`));
    }
    if (iteration?.status === "queued" && !normalizeString(iteration?.next_projection_id)) {
      issues.push(issue("missing_scheduler_loop_next_projection", "queued iteration must include next_projection_id", `result.iterations.${index}.next_projection_id`));
    }
    if (iteration?.status === "blocked" && asArray(iteration?.issues).length === 0) {
      issues.push(issue("missing_scheduler_loop_blocker_issues", "blocked iteration must include issues", `result.iterations.${index}.issues`));
    }
  });

  return {
    status: issues.length ? "fail" : "pass",
    issues
  };
}

function artifactFromLoopEvent(event = {}, artifacts = []) {
  const artifact = artifacts.find((entry) => entry.id === event.artifact_id) || null;
  const metadata = artifact?.metadata || event.metadata || {};
  if (metadata.version === AUTONOMOUS_SCHEDULER_LOOP_RUN_VERSION) {
    return {
      ...metadata,
      created_at: metadata.created_at || event.created_at || artifact?.created_at || null,
      status: metadata.status || event.status || artifact?.status || "fail"
    };
  }
  return metadata;
}

function runReadoutFromEvent(event = {}, artifact = {}) {
  const validation = validateSchedulerLoopRunArtifact(artifact);
  const result = artifact.result || {};
  const iterations = asArray(result.iterations);
  const latestIteration = iterations.at(-1) || null;
  const issues = validation.status === "pass" ? asArray(result.issues) : validation.issues;

  return {
    event_id: event.id || null,
    artifact_id: event.artifact_id || null,
    status: validation.status === "pass" ? artifact.status : "invalid",
    phase: validation.status === "pass" ? artifact.phase : "replay_validation",
    created_at: event.created_at || artifact.created_at || null,
    validation_status: validation.status,
    execution_strategy: artifact.input?.execution_strategy || "scheduler_dispatch_chain",
    execution_profile: artifact.input?.execution_profile || "approved_mock_non_dry_run",
    issue_count: issues.length,
    latest_issue: issues[0]?.message || issues[0]?.code || null,
    iteration_count: iterations.length,
    latest_iteration_status: latestIteration?.status || null,
    terminal_action: latestIteration?.terminal_action || null,
    terminal_reason: latestIteration?.terminal_reason || null,
    latest_projection_id: latestIteration?.next_projection_id || latestIteration?.projection_id || null,
    resume_projection_id: latestIteration?.next_projection_id || null,
    issues
  };
}

export function buildSchedulerLoopRunRegistry(workflowState = {}) {
  const manifest = workflowState?.manifest || {};
  const ledger = workflowState?.artifact_ledger || workflowState?.artifactLedger || {};
  const identity = manifestIdentity(workflowState);
  const artifacts = [
    ...asArray(ledger?.artifacts),
    ...asArray(manifest?.artifacts)
  ];
  const events = asArray(manifest?.events).filter((event) => event?.type === "autonomous_scheduler_loop_run");
  const runs = events.map((event) => runReadoutFromEvent(event, artifactFromLoopEvent(event, artifacts)));
  const latest = runs.at(-1) || null;
  const invalidRuns = runs.filter((run) => run.validation_status !== "pass");

  return {
    status: invalidRuns.length > 0 ? "blocked" : "pass",
    run_id: identity.run_id || null,
    cycle_id: identity.cycle_id || null,
    total_runs: runs.length,
    pass_count: runs.filter((run) => run.status === "pass").length,
    fail_count: runs.filter((run) => run.status === "fail").length,
    invalid_count: invalidRuns.length,
    latest,
    latest_resume_projection_id: latest?.resume_projection_id || null,
    runs,
    issues: invalidRuns.flatMap((run) => run.issues.map((entry) => ({
      ...entry,
      artifact_id: run.artifact_id || null,
      event_id: run.event_id || null
    })))
  };
}

export function evaluateSchedulerLoopRecovery(registry = {}) {
  const latest = registry.latest || null;
  if (!latest) {
    return {
      status: "not_configured",
      action: "start_bounded_loop",
      resumable: false,
      resume_projection_id: null,
      issues: []
    };
  }
  if (registry.invalid_count > 0 || latest.validation_status !== "pass") {
    return {
      status: "blocked",
      action: "quarantine_invalid_loop_artifact",
      resumable: false,
      resume_projection_id: null,
      issues: registry.issues || latest.issues || []
    };
  }
  if (latest.status === "pass" && latest.resume_projection_id) {
    return {
      status: "ready",
      action: "resume_from_latest_projection",
      resumable: true,
      resume_projection_id: latest.resume_projection_id,
      issues: []
    };
  }
  if (latest.status === "pass" && latest.phase === "no_dispatchable_scheduler_actions") {
    return {
      status: "idle",
      action: "wait_for_new_work",
      resumable: false,
      resume_projection_id: null,
      issues: []
    };
  }
  if (latest.status === "fail") {
    return {
      status: "recoverable",
      action: "rerun_bounded_loop_after_state_reload",
      resumable: false,
      resume_projection_id: null,
      issues: latest.issues || []
    };
  }

  return {
    status: "pending",
    action: "inspect_latest_loop_run",
    resumable: false,
    resume_projection_id: latest.resume_projection_id || null,
    issues: latest.issues || []
  };
}

function nextAutonomousSchedulerLoopArtifactId(workflowState = {}, options = {}) {
  const explicit = normalizeString(options.artifact_id || options.artifactId);
  if (explicit) return explicit;

  const prefix = `autonomous-scheduler-loop-${safeIdPart(workflowState?.manifest?.run_id)}-${safeIdPart(workflowState?.manifest?.cycle_id)}`;
  const used = new Set([
    ...asArray(workflowState?.manifest?.events).map((event) => normalizeString(event?.artifact_id)).filter(Boolean),
    ...asArray(workflowState?.artifact_ledger?.artifacts || workflowState?.artifactLedger?.artifacts)
      .map((artifact) => normalizeString(artifact?.id))
      .filter(Boolean)
  ]);
  let index = 1;
  let id = `${prefix}-${String(index).padStart(3, "0")}`;
  while (used.has(id)) {
    index += 1;
    id = `${prefix}-${String(index).padStart(3, "0")}`;
  }
  return id;
}

function nextSchedulerLoopResumeAttemptArtifactId(workflowState = {}, options = {}) {
  const explicit = normalizeString(options.artifact_id || options.artifactId);
  if (explicit) return explicit;

  const prefix = `scheduler-loop-resume-attempt-${safeIdPart(workflowState?.manifest?.run_id)}-${safeIdPart(workflowState?.manifest?.cycle_id)}`;
  const used = new Set([
    ...asArray(workflowState?.manifest?.events).map((event) => normalizeString(event?.artifact_id)).filter(Boolean),
    ...asArray(workflowState?.artifact_ledger?.artifacts || workflowState?.artifactLedger?.artifacts)
      .map((artifact) => normalizeString(artifact?.id))
      .filter(Boolean)
  ]);
  let index = 1;
  let id = `${prefix}-${String(index).padStart(3, "0")}`;
  while (used.has(id)) {
    index += 1;
    id = `${prefix}-${String(index).padStart(3, "0")}`;
  }
  return id;
}

export function recordAutonomousSchedulerLoopRunArtifact(workflowState = {}, runArtifact = {}, options = {}) {
  if (!isObject(workflowState)) {
    return {
      status: "fail",
      issues: [issue("invalid_workflow_state", "workflow state must be an object", "workflow_state")]
    };
  }

  const runId = normalizeString(workflowState?.manifest?.run_id);
  const cycleId = normalizeString(workflowState?.manifest?.cycle_id);
  if (!runId || !cycleId) {
    return {
      status: "fail",
      issues: [issue("missing_workflow_identity", "workflow state manifest run_id and cycle_id are required", "workflow_state.manifest")]
    };
  }

  if (runArtifact?.version !== AUTONOMOUS_SCHEDULER_LOOP_RUN_VERSION) {
    return {
      status: "fail",
      issues: [issue("invalid_scheduler_loop_artifact", "autonomous scheduler loop artifact version is required", "run_artifact.version")]
    };
  }

  const id = nextAutonomousSchedulerLoopArtifactId(workflowState, options);
  const createdAt = normalizeString(options.created_at || options.createdAt || runArtifact.created_at) || new Date().toISOString();
  const artifact = {
    id,
    type: "evaluation",
    status: runArtifact.status || "fail",
    uri: `scheduler-loop://run/${encodeURIComponent(runId)}/${encodeURIComponent(cycleId)}/${encodeURIComponent(id)}`,
    producer: "autonomous-scheduler-loop",
    created_at: createdAt,
    metadata: {
      type: "autonomous_scheduler_loop_run",
      run_id: runId,
      cycle_id: cycleId,
      ...runArtifact
    }
  };
  const manifest = appendRunEvent(workflowState.manifest, {
    id: `event-${id}`,
    type: "autonomous_scheduler_loop_run",
    status: artifact.status,
    artifact_id: id,
    message: `autonomous scheduler loop ${runArtifact.phase || "run"} ${artifact.status}`,
    created_at: createdAt,
    metadata: artifact.metadata
  });
  const baseLedger = workflowState.artifact_ledger || workflowState.artifactLedger || {};
  const artifactLedger = recordArtifact({
    ...baseLedger,
    artifacts: Array.isArray(baseLedger.artifacts) ? baseLedger.artifacts : []
  }, artifact);

  return {
    status: "pass",
    artifact,
    workflow_state: {
      ...workflowState,
      manifest: {
        ...manifest,
        artifacts: [...asArray(manifest.artifacts), artifact]
      },
      artifact_ledger: artifactLedger
    }
  };
}

export function recordSchedulerLoopResumeAttempt(workflowState = {}, attempt = {}, options = {}) {
  if (!isObject(workflowState)) {
    return {
      status: "fail",
      issues: [issue("invalid_workflow_state", "workflow state must be an object", "workflow_state")]
    };
  }

  const runId = normalizeString(workflowState?.manifest?.run_id);
  const cycleId = normalizeString(workflowState?.manifest?.cycle_id);
  if (!runId || !cycleId) {
    return {
      status: "fail",
      issues: [issue("missing_workflow_identity", "workflow state manifest run_id and cycle_id are required", "workflow_state.manifest")]
    };
  }

  const attemptStatus = normalizeString(attempt.status || "blocked");
  if (!["pass", "fail", "blocked"].includes(attemptStatus)) {
    return {
      status: "fail",
      issues: [issue("invalid_resume_attempt_status", "resume attempt status must be pass, fail, or blocked", "attempt.status")]
    };
  }

  const id = nextSchedulerLoopResumeAttemptArtifactId(workflowState, options);
  const createdAt = normalizeString(options.created_at || options.createdAt || attempt.created_at || attempt.createdAt) || new Date().toISOString();
  const issues = asArray(attempt.issues);
  const artifactStatus = attemptStatus === "pass" ? "pass" : "fail";
  const metadata = {
    type: "scheduler_loop_resume_attempt",
    version: SCHEDULER_LOOP_RESUME_ATTEMPT_VERSION,
    status: attemptStatus,
    run_id: runId,
    cycle_id: cycleId,
    source_projection_id: normalizeString(attempt.source_projection_id || attempt.sourceProjectionId) || null,
    resume_projection_id: normalizeString(attempt.resume_projection_id || attempt.resumeProjectionId) || null,
    recovery_status: normalizeString(attempt.recovery_status || attempt.recoveryStatus) || null,
    recovery_action: normalizeString(attempt.recovery_action || attempt.recoveryAction) || null,
    loop_status: normalizeString(attempt.loop_status || attempt.loopStatus) || null,
    loop_phase: normalizeString(attempt.loop_phase || attempt.loopPhase) || null,
    loop_artifact_id: normalizeString(attempt.loop_artifact_id || attempt.loopArtifactId) || null,
    issues
  };
  const artifact = {
    id,
    type: "evaluation",
    status: artifactStatus,
    uri: `scheduler-loop://resume-attempt/${encodeURIComponent(runId)}/${encodeURIComponent(cycleId)}/${encodeURIComponent(id)}`,
    producer: "autonomous-scheduler-loop",
    created_at: createdAt,
    metadata
  };
  const manifest = appendRunEvent(workflowState.manifest, {
    id: `event-${id}`,
    type: "scheduler_loop_resume_attempt",
    status: attemptStatus,
    artifact_id: id,
    message: `scheduler loop resume ${attemptStatus}`,
    created_at: createdAt,
    metadata
  });
  const baseLedger = workflowState.artifact_ledger || workflowState.artifactLedger || {};
  const artifactLedger = recordArtifact({
    ...baseLedger,
    artifacts: Array.isArray(baseLedger.artifacts) ? baseLedger.artifacts : []
  }, artifact);

  return {
    status: "pass",
    artifact,
    fact: metadata,
    workflow_state: {
      ...workflowState,
      manifest: {
        ...manifest,
        artifacts: [...asArray(manifest.artifacts), artifact]
      },
      artifact_ledger: artifactLedger
    }
  };
}

export {
  schedulerLoopInput,
  AUTONOMOUS_SCHEDULER_LOOP_RUN_VERSION,
  SCHEDULER_LOOP_RESUME_ATTEMPT_VERSION
};
