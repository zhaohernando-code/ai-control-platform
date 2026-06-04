import {
  DEFAULT_PROJECT_ID,
  MAX_STORED_REQUIREMENTS,
  SURFACE_PROFILES,
  WORKBENCH_REQUIREMENT_INTAKE_VERSION,
  asArray,
  createPlanReview,
  isClosedRequirementStatus,
  isObject,
  issue,
  nextWorkPackage,
  normalizeRequirementItems,
  normalizeString,
  requirementIdFrom,
  requirementProfile,
  requirementSummary
} from "./requirement-intake-core.js";

export function validateRequirementSubmission(input = {}) {
  const issues = [];

  if (!isObject(input)) {
    return {
      status: "fail",
      issues: [issue("invalid_requirement_submission", "requirement submission must be an object", "")]
    };
  }

  if (!normalizeString(input.title)) {
    issues.push(issue("missing_requirement_title", "title is required", "title"));
  }
  if (!normalizeString(input.problem_statement || input.problemStatement)) {
    issues.push(issue("missing_problem_statement", "problem_statement is required", "problem_statement"));
  }
  if (!SURFACE_PROFILES[normalizeString(input.surface_area || input.surfaceArea) || "workbench_frontend"]) {
    issues.push(issue("invalid_surface_area", `surface_area must be one of: ${Object.keys(SURFACE_PROFILES).join(", ")}`, "surface_area"));
  }

  return {
    status: issues.length ? "fail" : "pass",
    issues
  };
}

export function submitRequirementToProjectStatus(projectStatus = {}, input = {}, options = {}) {
  const validation = validateRequirementSubmission(input);
  if (validation.status !== "pass") {
    return {
      status: "fail",
      issues: validation.issues
    };
  }

  const createdAt = normalizeString(options.created_at || options.createdAt) || new Date().toISOString();
  const profile = requirementProfile(input);
  const title = normalizeString(input.title);
  const baseRequirement = {
    id: normalizeString(options.requirement_id || options.requirementId) || requirementIdFrom(title, createdAt),
    title,
    status: "submitted",
    submitted_at: createdAt,
    project_id: normalizeString(input.project_id || input.projectId) || DEFAULT_PROJECT_ID,
    surface_area: profile.id,
    surface_label: profile.label,
    problem_statement: normalizeString(input.problem_statement || input.problemStatement),
    constraints: normalizeString(input.constraints),
    owned_files: profile.owned_files.slice(),
    acceptance_gates: profile.acceptance_gates.slice()
  };
  const planReview = createPlanReview(baseRequirement, createdAt);
  const requirement = {
    ...baseRequirement,
    acceptance_criteria: normalizeString(input.acceptance_criteria || input.acceptanceCriteria),
    plan_review_id: planReview.id
  };
  requirement.summary = requirementSummary(requirement, profile);

  const existingItems = normalizeRequirementItems(projectStatus?.requirement_intake?.items);
  const queue = [
    requirement,
    ...existingItems.filter((item) => item.id !== requirement.id)
  ].slice(0, MAX_STORED_REQUIREMENTS);
  const currentGoal = {
    id: requirement.id,
    title: requirement.title,
    status: "in_progress",
    next_step: requirement.summary,
    owned_files: profile.owned_files.slice(),
    acceptance_gates: profile.acceptance_gates.slice(),
    source: "workbench_requirement_intake",
    submitted_at: createdAt
  };
  const nextPackage = nextWorkPackage(requirement, profile);

  return {
    status: "pass",
    requirement,
    plan_review: planReview,
    project_status: {
      ...projectStatus,
      project: normalizeString(projectStatus.project) || DEFAULT_PROJECT_ID,
      status: normalizeString(projectStatus.status) || "in_progress",
      updated_at: createdAt,
      next_step: requirement.summary,
      next_work_packages: [nextPackage],
      global_goals: [
        currentGoal,
        ...asArray(projectStatus.global_goals).filter((goal) => normalizeString(goal?.id) !== requirement.id)
      ],
      requirement_intake: {
        version: WORKBENCH_REQUIREMENT_INTAKE_VERSION,
        active_requirement_id: requirement.id,
        latest_requirement_id: requirement.id,
        submitted_count: queue.length,
        open_count: queue.filter((item) => !isClosedRequirementStatus(item.status)).length,
        items: queue
      },
      plan_reviews: {
        ...(isObject(projectStatus.plan_reviews) ? projectStatus.plan_reviews : {}),
        [requirement.id]: planReview
      }
    }
  };
}
