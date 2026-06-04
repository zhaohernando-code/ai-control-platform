export const AUTONOMOUS_SCHEDULER_LOOP_RUN_VERSION = "autonomous-scheduler-loop-run.v1";
export const SCHEDULER_LOOP_RESUME_ATTEMPT_VERSION = "scheduler-loop-resume-attempt.v1";
export const MAX_SNAPSHOT_ID_LENGTH = 80;

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function normalizeString(value) {
  return String(value || "").trim();
}

export function issue(code, message, path) {
  return { code, message, path };
}

export function safeIdPart(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

export function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
