import { recordArtifact } from "./artifact-ledger.js";
import { appendRunEvent } from "./run-manifest.js";

const AUTONOMOUS_SCHEDULER_LOOP_RUN_VERSION = "autonomous-scheduler-loop-run.v1";

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
  const issues = [...maxIterations.issues];

  if (executionProfile !== "approved_mock_non_dry_run") {
    issues.push(issue("unsupported_scheduler_loop_profile", "scheduler loop currently supports only approved_mock_non_dry_run", "execution_profile"));
  }

  return {
    status: issues.length ? "fail" : "pass",
    issues,
    max_iterations: maxIterations.value,
    execution_profile: executionProfile,
    start_projection_id: normalizeString(input.start_projection_id || input.startProjectionId),
    snapshot_prefix: normalizeString(input.snapshot_prefix || input.snapshotPrefix || "scheduler-loop")
  };
}

function requireClient(client = {}) {
  const missing = ["loadHistory", "createSchedulerDispatchPlan", "runSchedulerDispatch", "enqueueSchedulerNextCycle"]
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
  return `${safeIdPart(prefix)}-${safeIdPart(projectionId)}-${String(index + 1).padStart(2, "0")}`;
}

export async function runSchedulerLoopDriver(input = {}, options = {}) {
  const normalized = schedulerLoopInput(input);
  const clientIssues = requireClient(options.client);
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
        next_projection_id: null,
        issues: []
      };
      iterations.push(iteration);

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
    if (!["pending", "stopped", "blocked", "queued"].includes(normalizeString(iteration?.status))) {
      issues.push(issue("invalid_scheduler_loop_iteration_status", "iteration.status must be pending, stopped, blocked, or queued", `result.iterations.${index}.status`));
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
    issue_count: issues.length,
    latest_issue: issues[0]?.message || issues[0]?.code || null,
    iteration_count: iterations.length,
    latest_iteration_status: latestIteration?.status || null,
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

export { schedulerLoopInput, AUTONOMOUS_SCHEDULER_LOOP_RUN_VERSION };
