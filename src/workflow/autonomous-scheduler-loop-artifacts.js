import {
  AUTONOMOUS_SCHEDULER_LOOP_RUN_VERSION,
  asArray,
  isObject,
  issue,
  normalizeString
} from "./autonomous-scheduler-loop-utils.js";

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
      iterations: result.iterations || [],
      fallback: result.fallback || null
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
