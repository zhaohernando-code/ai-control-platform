const CONTINUE = "continue";
const RERUN = "rerun";
const ROLLBACK = "rollback";
const STOP_FOR_HUMAN = "stop_for_human";
const COMPLETE = "complete";

const STOP_STATUSES = new Set(["human_intervention", "blocked", "stop_for_human"]);
const RERUN_STATUSES = new Set(["rerun", "retry"]);
const ROLLBACK_STATUSES = new Set(["rollback"]);
const DEFAULT_NEXT_STEP_OWNED_FILES = [
  "PROJECT_STATUS.json",
  "src/workflow",
  "docs/contracts",
  "docs/examples/process-hardening-current.json"
];

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

export function compactStrings(value) {
  return asArray(value).map(normalizeString).filter(Boolean);
}

export function uniqueStrings(value) {
  return [...new Set(compactStrings(value))];
}

export function issue(code, message, path) {
  return { code, message, path };
}

export function statusOf(value) {
  return normalizeToken(value?.status || value?.decision || value?.action || value);
}

export function projectStatus(input) {
  return input?.project_status || input?.projectStatus || {};
}

export function workflowStateFrom(input) {
  return input?.workflow_state || input?.workflowState || null;
}

export {
  COMPLETE,
  CONTINUE,
  DEFAULT_NEXT_STEP_OWNED_FILES,
  RERUN,
  RERUN_STATUSES,
  ROLLBACK,
  ROLLBACK_STATUSES,
  STOP_FOR_HUMAN,
  STOP_STATUSES
};
