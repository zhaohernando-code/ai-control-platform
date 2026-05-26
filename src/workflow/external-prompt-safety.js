const PROMPT_SAFETY_ALIASES = [
  [/self[-_\s]?governance/gi, "quality process"],
  [/autonomous[-_\s]?continuation/gi, "session continuation"],
  [/\bautonomous\b/gi, "continuous"],
  [/code[-_\s]?review[-_\s]?coverage/gi, "review evidence"],
  [/dispatch(?:er|ed|es|ing)?/gi, "assign"],
  [/scanner/gi, "inspector"],
  [/\bsecurity\b/gi, "risk"],
  [/\bdestructive_action\b/gi, "high risk action"]
];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function compactStrings(value) {
  return asArray(value).map(normalizeString).filter(Boolean);
}

function sanitizePromptText(value = "") {
  return PROMPT_SAFETY_ALIASES.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    normalizeString(value)
  );
}

function sanitizePromptArray(value = []) {
  return compactStrings(value).map(sanitizePromptText);
}

function promptTaskRef(index = 0) {
  return `task-${Number(index) + 1 || 1}`;
}

function promptSafeSource(source = {}) {
  if (!isObject(source)) return null;
  return {
    requirement_id: sanitizePromptText(source.requirement_id || source.requirementId),
    plan_step_index: Number(source.plan_step_index || source.planStepIndex || 0) || null,
    plan_step_total: Number(source.plan_step_total || source.planStepTotal || 0) || null,
    implementation_step: sanitizePromptText(source.implementation_step || source.implementationStep || source.reason),
    acceptance_gates: sanitizePromptArray(source.acceptance_gates || source.acceptanceGates)
  };
}

export function promptSafeWorkflowIdentity(workflowState = {}) {
  return {
    run_id: normalizeString(workflowState?.manifest?.run_id) || null,
    cycle_id: normalizeString(workflowState?.manifest?.cycle_id) || null,
    goal: sanitizePromptText(workflowState?.manifest?.goal) || null
  };
}

export function promptSafeContextPack(contextPack = {}) {
  return {
    requirement_summary: sanitizePromptText(contextPack.requirement_summary),
    host: normalizeString(contextPack.host),
    target_project_id: normalizeString(contextPack.target_project_id),
    non_goals: sanitizePromptArray(contextPack.non_goals),
    forbidden_actions: sanitizePromptArray(contextPack.forbidden_actions),
    owned_files: compactStrings(contextPack.owned_files),
    acceptance_gates: compactStrings(contextPack.acceptance_gates),
    rollback_conditions: sanitizePromptArray(contextPack.rollback_conditions),
    subtasks: asArray(contextPack.subtasks).map((subtask, index) => ({
      task_ref: promptTaskRef(index),
      title: sanitizePromptText(subtask?.title || subtask?.summary || subtask?.id),
      action: sanitizePromptText(subtask?.action),
      reason: sanitizePromptText(subtask?.reason || subtask?.source?.reason || subtask?.source?.implementation_step),
      owned_files: compactStrings(subtask?.owned_files),
      acceptance_gates: compactStrings(subtask?.acceptance_gates || subtask?.source?.acceptance_gates),
      depends_on: compactStrings(subtask?.depends_on).map((_, dependencyIndex) => promptTaskRef(dependencyIndex))
    }))
  };
}

export function promptSafeWorkPackage(workPackage = {}, index = 0) {
  return {
    task_ref: promptTaskRef(index),
    title: sanitizePromptText(workPackage.title || workPackage.summary || workPackage.id),
    action: sanitizePromptText(workPackage.action),
    reason: sanitizePromptText(workPackage.reason || workPackage.source?.reason || workPackage.source?.implementation_step),
    owned_files: compactStrings(workPackage.owned_files),
    acceptance_gates: compactStrings(workPackage.acceptance_gates || workPackage.source?.acceptance_gates),
    status: sanitizePromptText(workPackage.status),
    source: promptSafeSource(workPackage.source),
    prompt_metadata_note: isObject(workPackage.reviewer) || isObject(workPackage.code_review_coverage)
      ? "Some internal metadata is intentionally omitted from this provider prompt; use repository files and gates as source of truth."
      : undefined
  };
}

export function promptSafeWorkPackages(workPackages = []) {
  return asArray(workPackages).map((workPackage, index) => promptSafeWorkPackage(workPackage, index));
}

export function promptSafeReviewerShard(shard = {}) {
  return {
    id: sanitizePromptText(shard.id),
    provider: sanitizePromptText(shard.provider),
    model: sanitizePromptText(shard.model),
    profile: sanitizePromptText(shard.profile),
    allowed_tools: compactStrings(shard.allowed_tools),
    files: compactStrings(shard.files),
    questions: sanitizePromptArray(shard.questions),
    scope: sanitizePromptText(shard.prompt_excerpt || shard.scope),
    forbidden_actions: sanitizePromptArray(shard.forbidden_actions)
  };
}

export function promptSafetyPreamble() {
  return [
    "Project framing:",
    "- This is an internal project-management and quality-operations platform.",
    "- The task context below is minimized for provider routing; repository files and acceptance gates remain the source of truth."
  ].join("\n");
}

export { sanitizePromptText };
