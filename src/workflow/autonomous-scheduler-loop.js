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

export { schedulerLoopInput, AUTONOMOUS_SCHEDULER_LOOP_RUN_VERSION };
