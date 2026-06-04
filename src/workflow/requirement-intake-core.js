import { REQUIREMENT_PLAN_GENERATION_PROMPT_VERSION } from "./requirement-plan-generation.js";

export const WORKBENCH_REQUIREMENT_INTAKE_VERSION = "workbench-requirement-intake.v1";

export const DEFAULT_PROJECT_ID = "ai-control-platform";
const DEFAULT_SURFACE_AREA = "workbench_frontend";
export const MAX_STORED_REQUIREMENTS = 12;
const PLAN_REVIEW_VERSION = "workbench-plan-review.v1";

export const SURFACE_PROFILES = {
  workbench_frontend: {
    id: "workbench_frontend",
    label: "Workbench 前端",
    owned_files: [
      "apps/workbench",
      "src/workflow/workbench-projection.js",
      "src/workflow/frontend-acceptance.js",
      "tools/check-workbench-browser-events.mjs",
      "tools/check-workbench-frontend-acceptance.mjs",
      "test/workbench-shell.test.js",
      "test/workbench-server.test.js",
      "test/workbench-projection.test.js",
      "test/frontend-acceptance.test.js"
    ],
    acceptance_gates: [
      "npm run check:workbench:browser-events",
      "npm run check:closeout"
    ]
  },
  workflow_runtime: {
    id: "workflow_runtime",
    label: "流程引擎",
    owned_files: [
      "src/workflow",
      "tools/workbench-server.mjs",
      "test/workbench-server.test.js",
      "test/workbench-projection.test.js"
    ],
    acceptance_gates: [
      "node --test test/workbench-server.test.js test/workbench-projection.test.js",
      "npm run check:closeout"
    ]
  },
  reviewer_scheduler: {
    id: "reviewer_scheduler",
    label: "调度与审查",
    owned_files: [
      "src/workflow/autonomous-continuation.js",
      "src/workflow/autonomous-scheduler-loop.js",
      "src/workflow/reviewer-shard-runner.js",
      "src/workflow/reviewer-provider-health.js",
      "tools/workbench-server.mjs",
      "test/autonomous-scheduler-loop.test.js",
      "test/workbench-server.test.js"
    ],
    acceptance_gates: [
      "node --test test/autonomous-scheduler-loop.test.js test/workbench-server.test.js",
      "npm run check:closeout"
    ]
  },
  governance_process: {
    id: "governance_process",
    label: "治理与门禁",
    owned_files: [
      "PROJECT_STATUS.json",
      "PROCESS.md",
      "PROJECT_RULES.md",
      "docs/contracts",
      "src/workflow",
      "test"
    ],
    acceptance_gates: [
      "npm run check:process-hardening",
      "npm run check:closeout"
    ]
  },
  platform_project: {
    id: "platform_project",
    label: "AI Control Platform 项目",
    owned_files: [
      "apps/workbench",
      "src/workflow/requirement-intake.js",
      "src/workflow/workbench-projection.js",
      "src/workflow/frontend-acceptance.js",
      "tools/workbench-server.mjs",
      "tools/check-workbench-browser-events.mjs",
      "tools/check-workbench-frontend-acceptance.mjs",
      "test/requirement-intake.test.js",
      "test/workbench-shell.test.js",
      "test/workbench-server.test.js",
      "test/workbench-projection.test.js",
      "test/frontend-acceptance.test.js"
    ],
    acceptance_gates: [
      "node --test test/requirement-intake.test.js test/workbench-server.test.js test/workbench-projection.test.js test/workbench-shell.test.js test/frontend-acceptance.test.js",
      "npm run check:workbench:browser-events",
      "npm run check:closeout"
    ]
  }
};

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function normalizeString(value) {
  return String(value || "").trim();
}

export function compactStrings(value) {
  return asArray(value).map(normalizeString).filter(Boolean);
}

export function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function uniqueStrings(value) {
  return [...new Set(compactStrings(value))];
}

function withProjectWideOwnedFiles(profile = {}) {
  return {
    ...profile,
    owned_files: uniqueStrings([
      ".",
      ...asArray(profile.owned_files)
    ])
  };
}

export function issue(code, message, path) {
  return { code, message, path };
}

export function safeIdPart(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function isProjectLevelRequirement(input = {}) {
  const projectId = normalizeString(input.project_id || input.projectId);
  const text = [
    input.problem_statement || input.problemStatement,
    input.constraints
  ].map(normalizeString).join("\n");
  return projectId === DEFAULT_PROJECT_ID ||
    input.plan_review_requested === true ||
    input.planReviewRequested === true ||
    /不只是前端|不只.*前端|后端|流程|机制|API|接口|项目/.test(text);
}

export function requirementProfile(input = {}) {
  if (typeof input === "string") {
    return withProjectWideOwnedFiles(SURFACE_PROFILES[normalizeString(input)] || SURFACE_PROFILES[DEFAULT_SURFACE_AREA]);
  }
  const baseProfile = isProjectLevelRequirement(input)
    ? SURFACE_PROFILES.platform_project
    : SURFACE_PROFILES[normalizeString(input.surface_area || input.surfaceArea) || DEFAULT_SURFACE_AREA] ||
      SURFACE_PROFILES[DEFAULT_SURFACE_AREA];
  return withProjectWideOwnedFiles(baseProfile);
}

export function requirementIdFrom(title, createdAt) {
  const stamp = normalizeString(createdAt).replace(/[^0-9]/g, "").slice(0, 14) || `${Date.now()}`;
  return `requirement-${safeIdPart(title).slice(0, 48)}-${stamp}`;
}

export function requirementSummary(input = {}, profile = {}) {
  const title = normalizeString(input.title);
  const problemStatement = normalizeString(input.problem_statement || input.problemStatement);
  const acceptanceCriteria = normalizeString(input.acceptance_criteria || input.acceptanceCriteria);
  const constraints = normalizeString(input.constraints);
  const parts = [
    `需求：${title}`,
    problemStatement ? `现状与目标：${problemStatement}` : "",
    acceptanceCriteria ? `验收：${acceptanceCriteria}` : "",
    constraints ? `约束：${constraints}` : "",
    profile.label ? `范围：${profile.label}` : ""
  ].filter(Boolean);
  return parts.join("。");
}

export function normalizeStringList(value) {
  return compactStrings(value).slice(0, 12);
}

export function pendingPlanReview(requirement = {}, createdAt = "") {
  const generatedAt = normalizeString(createdAt) || new Date().toISOString();
  return {
    version: PLAN_REVIEW_VERSION,
    id: planReviewIdFrom(requirement.id),
    requirement_id: requirement.id,
    requirement_title: requirement.title,
    status: "pending_plan_generation",
    phase: "pending_plan_generation",
    plan_id: null,
    assessment_summary: null,
    proposed_acceptance_plan: null,
    implementation_outline: [],
    acceptance_gates: [],
    risks: [],
    generator: null,
    generation_prompt_version: REQUIREMENT_PLAN_GENERATION_PROMPT_VERSION,
    next_action: "等待大模型生成方案",
    action_status: "等待方案生成",
    submitted_at: requirement.submitted_at,
    generated_at: null,
    requested_at: generatedAt,
    reviewed_at: null,
    review_decision: null
  };
}

export function generationIssueSummary(issues = []) {
  return asArray(issues)
    .map((item) => normalizeString(item?.message || item?.code || item))
    .filter(Boolean)
    .join("；")
    .slice(0, 1000);
}

export function createPlanReview(requirement = {}, createdAt = "") {
  return pendingPlanReview(requirement, createdAt);
}

export function planReviewIdFrom(requirementId = "") {
  return `plan-review-${safeIdPart(requirementId)}`;
}

export function nextWorkPackage(requirement = {}, profile = {}) {
  return {
    id: `${requirement.id}-intake`,
    title: `处理需求：${requirement.title}`,
    action: "continue_requirement_intake",
    owned_files: profile.owned_files,
    acceptance_gates: profile.acceptance_gates,
    reason: requirement.summary,
    global_goal_id: requirement.id,
    source: {
      requirement_id: requirement.id,
      intake_channel: "workbench_frontend",
      surface_area: requirement.surface_area,
      acceptance_criteria: requirement.acceptance_criteria,
      constraints: requirement.constraints || ""
    }
  };
}

export function normalizeRequirementItems(value) {
  return asArray(value)
    .filter(isObject)
    .map((item) => {
      const projectId = normalizeString(item.project_id || item.projectId);
      return {
        ...item,
        id: normalizeString(item.id),
        title: normalizeString(item.title),
        status: normalizeString(item.status) || "submitted",
        ...(projectId ? { project_id: projectId } : {}),
        summary: normalizeString(item.summary),
        submitted_at: normalizeString(item.submitted_at || item.created_at),
        surface_area: normalizeString(item.surface_area || item.surfaceArea),
        surface_label: normalizeString(item.surface_label || item.surfaceLabel),
        problem_statement: normalizeString(item.problem_statement || item.problemStatement),
        acceptance_criteria: normalizeString(item.acceptance_criteria || item.acceptanceCriteria),
        constraints: normalizeString(item.constraints),
        owned_files: compactStrings(item.owned_files || item.ownedFiles),
        acceptance_gates: compactStrings(item.acceptance_gates || item.acceptanceGates)
      };
    })
    .filter((item) => item.id && item.title);
}

export function isClosedRequirementStatus(value = "") {
  return ["completed", "complete", "accepted", "closed", "closed_failed", "canceled", "cancelled"].includes(normalizeString(value).toLowerCase());
}

export function workPackageBelongsToRequirement(workPackage = {}, requirementId = "") {
  const id = normalizeString(requirementId);
  if (!id || !isObject(workPackage)) return false;
  return normalizeString(workPackage.global_goal_id || workPackage.globalGoalId) === id ||
    normalizeString(workPackage.source?.requirement_id || workPackage.source?.requirementId) === id;
}

export function withoutRequirementWorkPackages(workPackages = [], requirementId = "") {
  return asArray(workPackages)
    .filter((workPackage) => !workPackageBelongsToRequirement(workPackage, requirementId));
}
