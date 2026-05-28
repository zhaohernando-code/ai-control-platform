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

function validateAgentKeyHealth(projection, issues, path = "agent_key_health") {
  if (!hasObject(projection)) return;
  for (const field of ["status", "agent_count", "key_count", "available_key_count", "agents"]) {
    requireOwnField(projection, field, issues, path);
  }
  if (!Array.isArray(projection.agents)) {
    issues.push(issue("missing_agent_key_health_agents", "agent_key_health.agents must be an array", `${path}.agents`));
  }
}

function validateNextActionTerminal(projection, issues, path = "next_action_terminal") {
  if (!hasObject(projection)) return;
  for (const field of ["status", "terminal_action", "terminal_reason"]) {
    requireOwnField(projection, field, issues, path);
  }
}

function validateSelfGovernance(projection, issues, path = "self_governance") {
  if (!hasObject(projection)) return;
  for (const field of ["status", "finding_count", "cadence", "role_count", "auto_repair_count", "evidence_building_count", "user_decision_count"]) {
    requireOwnField(projection, field, issues, path);
  }
}

function validateProjectManagement(projection, issues, path = "project_management") {
  if (!hasObject(projection)) return;
  for (const field of ["status", "projects_total", "active_projects", "tasks_total", "active_tasks", "human_decisions"]) {
    requireOwnField(projection, field, issues, path);
  }
  if (!Array.isArray(projection.projects) || projection.projects.length === 0) {
    issues.push(issue("missing_project_management_projects", "project_management.projects must include at least one project", `${path}.projects`));
  }
  const platformProject = asArray(projection.projects).find((project) => normalizeString(project?.project_id) === "ai-control-platform");
  if (!platformProject) {
    issues.push(issue("missing_platform_project", "project_management.projects must include ai-control-platform", `${path}.projects`));
  } else {
    for (const field of ["display_name", "phase", "current_task", "owner_agent", "last_updated"]) {
      if (!normalizeString(platformProject[field])) {
        issues.push(issue("missing_platform_project_field", `ai-control-platform must include ${field}`, `${path}.projects.ai-control-platform.${field}`));
      }
    }
    if (!Array.isArray(platformProject.task_flow) || platformProject.task_flow.length < 7) {
      issues.push(issue("missing_platform_project_task_flow", "ai-control-platform must expose the full task lifecycle", `${path}.projects.ai-control-platform.task_flow`));
    }
  }
  if (!Array.isArray(projection.task_flow) || projection.task_flow.length < 7) {
    issues.push(issue("missing_project_management_task_flow", "project_management.task_flow must expose the project lifecycle", `${path}.task_flow`));
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
    "frontend_acceptance",
    "resume_health",
    "reviewer_provider_health",
    "reviewer_scope_split",
    "reviewer_shard_review",
    "headless_child_provider",
    "projected_action_progress",
    "scheduler_dispatch",
    "scheduler_continuation",
    "scheduler_loop",
    "agent_lifecycle_pool",
    "agent_key_health",
    "self_governance",
    "project_management",
    "global_goal_completion",
    "operations_timeline",
    "next_action_readout",
    "next_action_terminal",
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
  validateAgentKeyHealth(projection.agent_key_health, issues);
  validateSelfGovernance(projection.self_governance, issues);
  validateProjectManagement(projection.project_management, issues);
  validateNextActionTerminal(projection.next_action_terminal, issues);
}

function validateMobileProjection(projection, issues) {
  for (const field of ["run_id", "cycle_id", "status", "decision", "headline"]) {
    requireString(projection, field, issues);
  }

  for (const field of ["counters", "closeout", "frontend_acceptance", "project_management", "resume_health", "provider_health", "scope_split", "shard_review", "headless_child_provider", "projected_action_progress", "scheduler_dispatch", "scheduler_continuation", "scheduler_loop", "agent_lifecycle_pool", "agent_key_health", "self_governance", "global_goal_completion", "operations_timeline", "next_action_readout", "next_action_terminal", "model", "reviewer"]) {
    requireObject(projection, field, issues);
  }

  requireArray(projection, "next_actions", issues);
  requireArray(projection, "blockers", issues);
  validateAgentLifecyclePool(projection.agent_lifecycle_pool, issues);
  validateAgentKeyHealth(projection.agent_key_health, issues);
  validateSelfGovernance(projection.self_governance, issues);
  validateProjectManagement(projection.project_management, issues);
  validateNextActionTerminal(projection.next_action_terminal, issues);
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
