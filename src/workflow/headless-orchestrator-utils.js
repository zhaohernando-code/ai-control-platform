import { evaluateGlobalGoalCompletion } from "./global-goal-completion.js";
import { HEADLESS_MAIN_ORCHESTRATOR_ROLE } from "./headless-worker-planning.js";

export const HEADLESS_CLI_ORCHESTRATOR_VERSION = "headless-cli-orchestrator.v1";
export const DEFAULT_CHILD_WORKER_TIMEOUT_MS = 10 * 60 * 1000;

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function normalizeString(value) {
  return String(value || "").trim();
}

export function normalizeToken(value) {
  return normalizeString(value).toLowerCase();
}

export function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function issue(code, message, path) {
  return { code, message, path };
}

export function safeIdPart(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

export function workflowStateIdentityIssues(workflowState = {}) {
  const manifestRunId = normalizeString(workflowState?.manifest?.run_id);
  const manifestCycleId = normalizeString(workflowState?.manifest?.cycle_id);
  const ledgerRunId = normalizeString(workflowState?.artifact_ledger?.run_id || workflowState?.artifactLedger?.run_id);
  const ledgerCycleId = normalizeString(workflowState?.artifact_ledger?.cycle_id || workflowState?.artifactLedger?.cycle_id);
  const issues = [];

  if (!manifestRunId || !manifestCycleId) {
    issues.push(issue("missing_workflow_manifest_identity", "workflow_state manifest run_id and cycle_id are required", "workflow_state.manifest"));
  }
  if (!ledgerRunId || !ledgerCycleId) {
    issues.push(issue("missing_workflow_ledger_identity", "workflow_state artifact_ledger run_id and cycle_id are required", "workflow_state.artifact_ledger"));
  }
  if (manifestRunId && ledgerRunId && manifestRunId !== ledgerRunId) {
    issues.push(issue("workflow_run_id_mismatch", "workflow_state manifest and artifact_ledger run_id must match", "workflow_state.artifact_ledger.run_id"));
  }
  if (manifestCycleId && ledgerCycleId && manifestCycleId !== ledgerCycleId) {
    issues.push(issue("workflow_cycle_id_mismatch", "workflow_state manifest and artifact_ledger cycle_id must match", "workflow_state.artifact_ledger.cycle_id"));
  }

  return issues;
}

export function validateHeadlessInput(input = {}) {
  const issues = [];
  if (!isObject(input)) {
    return {
      status: "fail",
      issues: [issue("invalid_headless_orchestrator_input", "headless orchestrator input must be an object", "")]
    };
  }
  if (!isObject(input.project_status || input.projectStatus)) {
    issues.push(issue("missing_project_status", "PROJECT_STATUS durable input is required", "project_status"));
  }
  if ((input.project_status || input.projectStatus)?.project !== "ai-control-platform") {
    issues.push(issue("project_status_mismatch", "headless CLI main orchestrator must target ai-control-platform", "project_status.project"));
  }
  if (!isObject(input.workflow_state || input.workflowState)) {
    issues.push(issue("missing_workflow_state", "workflow_state durable input is required", "workflow_state"));
  } else {
    issues.push(...workflowStateIdentityIssues(input.workflow_state || input.workflowState));
  }
  if (input.role && normalizeToken(input.role) !== HEADLESS_MAIN_ORCHESTRATOR_ROLE) {
    issues.push(issue("invalid_orchestrator_role", "headless CLI adapter must declare role=main_orchestrator", "role"));
  }

  return {
    status: issues.length ? "fail" : "pass",
    issues
  };
}

export function hasMaterializedContextCycle(workflowState = {}) {
  return asArray(workflowState?.manifest?.events).some((event) => [
    "context_pack_cycle_created",
    "context_pack_cycle_materialized"
  ].includes(event?.type));
}

export function continuationRunEvaluationFromProjectStatus(projectStatus = {}) {
  const globalGoalCompletion = evaluateGlobalGoalCompletion({
    project_status: projectStatus,
    global_goals: projectStatus.global_goals
  });
  return {
    status: "pass",
    decision: "pass",
    source: "PROJECT_STATUS.json",
    next_work_packages: asArray(globalGoalCompletion.next_work_packages),
    global_goal_completion: globalGoalCompletion
  };
}
