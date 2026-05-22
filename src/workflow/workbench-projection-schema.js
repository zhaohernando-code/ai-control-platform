const PROJECTION_STATUSES = new Set(["pass", "rerun", "rollback", "human_intervention"]);
const PROJECTION_VERSIONS = new Set(["workbench.v1", "workbench.mobile.v1"]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function issue(code, message, path) {
  return { code, message, path };
}

function hasObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function requireString(projection, field, issues) {
  if (!normalizeString(projection?.[field])) {
    issues.push(issue("missing_string_field", `${field} is required`, field));
  }
}

function requireObject(projection, field, issues) {
  if (!hasObject(projection?.[field])) {
    issues.push(issue("missing_object_field", `${field} must be an object`, field));
  }
}

function requireArray(projection, field, issues) {
  if (!Array.isArray(projection?.[field])) {
    issues.push(issue("missing_array_field", `${field} must be an array`, field));
  }
}

function requireOwnField(projection, field, issues, pathPrefix = "") {
  if (!hasObject(projection) || !Object.prototype.hasOwnProperty.call(projection, field)) {
    issues.push(issue("missing_required_field", `${pathPrefix ? `${pathPrefix}.` : ""}${field} is required`, pathPrefix ? `${pathPrefix}.${field}` : field));
  }
}

function validateAgentLifecyclePool(projection, issues, path = "agent_lifecycle_pool") {
  if (!hasObject(projection)) return;
  for (const field of ["timed_out", "heartbeat_count"]) {
    requireOwnField(projection, field, issues, path);
  }
}

function validateStatus(projection, issues) {
  const status = normalizeString(projection?.status);
  if (!PROJECTION_STATUSES.has(status)) {
    issues.push(issue("invalid_projection_status", `status must be one of: ${Array.from(PROJECTION_STATUSES).join(", ")}`, "status"));
  }
}

function validatePcProjection(projection, issues) {
  for (const field of ["run_id", "cycle_id", "goal", "decision", "generated_at"]) {
    requireString(projection, field, issues);
  }

  for (const field of [
    "input_validation",
    "manifest",
    "artifacts",
    "closeout",
    "resume_health",
    "reviewer_provider_health",
    "reviewer_scope_split",
    "reviewer_shard_review",
    "scheduler_dispatch",
    "scheduler_continuation",
    "scheduler_loop",
    "agent_lifecycle_pool",
    "global_goal_completion",
    "operations_timeline",
    "next_action_readout",
    "model_routing",
    "reviewer_gate",
    "autonomous_run",
    "task_dag",
    "one_screen"
  ]) {
    requireObject(projection, field, issues);
  }

  requireArray(projection, "reasons", issues);
  requireArray(projection, "blockers", issues);

  if (hasObject(projection.one_screen)) {
    requireString(projection.one_screen, "headline", issues);
    requireString(projection.one_screen, "primary_status", issues);
    requireObject(projection.one_screen, "counters", issues);
    requireArray(projection.one_screen, "next_actions", issues);
  }
  validateAgentLifecyclePool(projection.agent_lifecycle_pool, issues);
}

function validateMobileProjection(projection, issues) {
  for (const field of ["run_id", "cycle_id", "status", "decision", "headline"]) {
    requireString(projection, field, issues);
  }

  for (const field of ["counters", "closeout", "resume_health", "provider_health", "scope_split", "shard_review", "scheduler_dispatch", "scheduler_continuation", "scheduler_loop", "agent_lifecycle_pool", "global_goal_completion", "operations_timeline", "next_action_readout", "model", "reviewer"]) {
    requireObject(projection, field, issues);
  }

  requireArray(projection, "next_actions", issues);
  requireArray(projection, "blockers", issues);
  validateAgentLifecyclePool(projection.agent_lifecycle_pool, issues);
}

export function validateWorkbenchProjectionSchema(projection) {
  const issues = [];

  if (!hasObject(projection)) {
    return {
      status: "fail",
      issues: [issue("invalid_projection", "projection must be an object", "")]
    };
  }

  const version = normalizeString(projection.projection_version);
  if (!PROJECTION_VERSIONS.has(version)) {
    issues.push(issue("invalid_projection_version", `projection_version must be one of: ${Array.from(PROJECTION_VERSIONS).join(", ")}`, "projection_version"));
  }

  validateStatus(projection, issues);

  if (version === "workbench.mobile.v1") {
    validateMobileProjection(projection, issues);
  } else {
    validatePcProjection(projection, issues);
  }

  return {
    status: issues.length ? "fail" : "pass",
    issues
  };
}

export function assertWorkbenchProjectionSchema(projection) {
  const validation = validateWorkbenchProjectionSchema(projection);

  if (validation.status !== "pass") {
    const error = new Error("workbench projection schema validation failed");
    error.code = "WORKBENCH_PROJECTION_SCHEMA_INVALID";
    error.validation = validation;
    throw error;
  }

  return validation;
}

export { PROJECTION_STATUSES, PROJECTION_VERSIONS };
