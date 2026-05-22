import { decideContinuation } from "./autonomous-continuation.js";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function issue(code, message, path) {
  return { code, message, path };
}

function normalizeProjectStatus(projectStatus = {}) {
  return {
    project: normalizeString(projectStatus.project),
    status: normalizeString(projectStatus.status),
    current_phase: projectStatus.current_phase || null,
    current_milestone: projectStatus.current_milestone || null,
    updated_at: normalizeString(projectStatus.updated_at),
    blockers: asArray(projectStatus.blockers),
    next_step: normalizeString(projectStatus.next_step),
    global_goals: asArray(projectStatus.global_goals),
    linked_docs: asArray(projectStatus.linked_docs)
  };
}

function validateProjectStatus(projectStatus = {}) {
  const issues = [];
  if (!isObject(projectStatus)) {
    return {
      status: "fail",
      issues: [issue("invalid_project_status", "project status must be an object", "project_status")]
    };
  }
  if (projectStatus.project !== "ai-control-platform") {
    issues.push(issue("project_status_mismatch", "PROJECT_STATUS must target ai-control-platform", "project"));
  }
  if (!normalizeString(projectStatus.next_step) && asArray(projectStatus.global_goals).length === 0) {
    issues.push(issue("missing_continuation_source", "PROJECT_STATUS must contain next_step or global_goals", "next_step"));
  }
  return {
    status: issues.length ? "fail" : "pass",
    issues
  };
}

export function createContinuationInputFromProjectStatus(projectStatus = {}, options = {}) {
  const normalizedStatus = normalizeProjectStatus(projectStatus);
  const runEvaluation = options.run_evaluation || options.runEvaluation || {
    status: "pass",
    decision: "pass",
    source: "PROJECT_STATUS.json",
    next_work_packages: []
  };

  return {
    project_status: normalizedStatus,
    run_evaluation: runEvaluation,
    workflow_state: options.workflow_state || options.workflowState || null
  };
}

export function prepareContinuationFromProjectStatus(projectStatus = {}, options = {}) {
  const validation = validateProjectStatus(projectStatus);
  if (validation.status !== "pass") {
    return {
      status: "blocked",
      phase: "project_status_continuation",
      should_continue: false,
      issues: validation.issues,
      continuation_input: null,
      decision: null
    };
  }

  const continuationInput = createContinuationInputFromProjectStatus(projectStatus, options);
  const decision = decideContinuation(continuationInput);

  return {
    status: decision.action === "complete" ? "complete" : (decision.should_continue ? "ready" : "blocked"),
    phase: "project_status_continuation",
    should_continue: decision.should_continue,
    issues: decision.validation?.issues || [],
    continuation_input: continuationInput,
    decision,
    global_goal_completion: decision.global_goal_completion
  };
}
