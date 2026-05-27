import { recordArtifact } from "./artifact-ledger.js";
import { appendRunEvent } from "./run-manifest.js";

export const WORKBENCH_REQUIREMENT_INTAKE_VERSION = "workbench-requirement-intake.v1";
export const REQUIREMENT_PLAN_GENERATION_PROMPT_VERSION = "requirement-plan-generation-prompt.v1";

const DEFAULT_PROJECT_ID = "ai-control-platform";
const DEFAULT_SURFACE_AREA = "workbench_frontend";
const MAX_STORED_REQUIREMENTS = 12;
const PLAN_REVIEW_VERSION = "workbench-plan-review.v1";
const EXECUTION_GOVERNANCE_VERSION = "work-package-execution-governance.v1";

const SURFACE_PROFILES = {
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

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function compactStrings(value) {
  return asArray(value).map(normalizeString).filter(Boolean);
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function uniqueStrings(value) {
  return [...new Set(compactStrings(value))];
}

function withProjectWideOwnedFiles(profile = {}) {
  return {
    ...profile,
    owned_files: uniqueStrings([
      ".",
      ...asArray(profile.owned_files),
    ])
  };
}

function issue(code, message, path) {
  return { code, message, path };
}

function safeIdPart(value) {
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

function requirementProfile(input = {}) {
  if (typeof input === "string") {
    return withProjectWideOwnedFiles(SURFACE_PROFILES[normalizeString(input)] || SURFACE_PROFILES[DEFAULT_SURFACE_AREA]);
  }
  const baseProfile = isProjectLevelRequirement(input)
    ? SURFACE_PROFILES.platform_project
    : SURFACE_PROFILES[normalizeString(input.surface_area || input.surfaceArea) || DEFAULT_SURFACE_AREA] ||
      SURFACE_PROFILES[DEFAULT_SURFACE_AREA];
  return withProjectWideOwnedFiles(baseProfile);
}

function requirementIdFrom(title, createdAt) {
  const stamp = normalizeString(createdAt).replace(/[^0-9]/g, "").slice(0, 14) || `${Date.now()}`;
  return `requirement-${safeIdPart(title).slice(0, 48)}-${stamp}`;
}

function requirementSummary(input = {}, profile = {}) {
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

function jsonCandidate(text) {
  const value = normalizeString(text);
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const objectStart = value.indexOf("{");
  const objectEnd = value.lastIndexOf("}");
  if (objectStart !== -1 && objectEnd > objectStart) return value.slice(objectStart, objectEnd + 1);
  return "";
}

function normalizeStringList(value) {
  return compactStrings(value).slice(0, 12);
}

const FRONTEND_VIEW_MIGRATION_SLICES = [
  {
    id: "workbench-home",
    title: "工作台主页",
    reason: "迁移工作台主页视图到 React + Next.js App Router，并使用 antd Layout、Card、Statistic、List 等基础与布局组件承载现有投影数据。",
    owned_files: [
      "apps/workbench",
      "test/workbench-shell.test.js",
      "test/frontend-acceptance.test.js"
    ],
    acceptance_gates: [
      "工作台主页由 Next.js + React 渲染，页面基础布局与核心信息区使用 antd 组件。"
    ]
  },
  {
    id: "requirement-intake",
    title: "需求录入",
    reason: "迁移需求录入视图到 React + Next.js App Router，并使用 antd Form、Input、Select、Button、Alert 等组件承载提需求流程。",
    owned_files: [
      "apps/workbench",
      "tools/workbench-server.mjs",
      "test/requirement-intake.test.js",
      "test/workbench-server.test.js",
      "test/frontend-acceptance.test.js"
    ],
    acceptance_gates: [
      "需求录入流程在新前端中可提交并写入后端投影，表单与反馈使用 antd 组件。"
    ]
  },
  {
    id: "plan-review",
    title: "方案审核",
    reason: "迁移方案评估与审核视图到 React + Next.js App Router，并使用 antd Descriptions、Typography、Space、Button、Modal 等组件承载审核动作。",
    owned_files: [
      "apps/workbench",
      "src/workflow/workbench-projection.js",
      "test/workbench-projection.test.js",
      "test/workbench-shell.test.js",
      "test/frontend-acceptance.test.js"
    ],
    acceptance_gates: [
      "方案审核视图可展示模型生成方案并触发同意开发，审核动作后直接进入开发态。"
    ]
  }
];

function planStepExecutionGovernance({
  granularity = "single_step",
  decompositionRequired = false,
  decompositionStatus = "not_required",
  decompositionEvidenceId = "",
  parentWorkPackageId = "",
  sliceId = "",
  gateCount = 0
} = {}) {
  const decomposition = {
    required: decompositionRequired,
    status: decompositionStatus
  };
  if (decompositionEvidenceId) decomposition.evidence_id = decompositionEvidenceId;
  if (parentWorkPackageId) decomposition.parent_work_package_id = parentWorkPackageId;
  if (sliceId) decomposition.slice_id = sliceId;

  return {
    version: EXECUTION_GOVERNANCE_VERSION,
    granularity,
    decomposition,
    verification: {
      required: true,
      status: gateCount > 0 ? "defined" : "missing",
      gate_count: gateCount
    }
  };
}

function shouldSplitFrontendViewMigrationWorkPackage(workPackage = {}) {
  if (normalizeString(workPackage?.action) !== "execute_requirement_plan_step") return false;
  if (workPackage?.source?.plan_step_slice || workPackage?.source?.planStepSlice) return false;
  const text = [
    workPackage.title,
    workPackage.reason,
    workPackage.source?.implementation_step,
    workPackage.source?.implementationStep,
    workPackage.source?.constraints
  ].map(normalizeString).join("\n");
  return /按视图切片迁移|切片迁移|核心视图/.test(text) &&
    /前端重构|React|Next\.js|antd|Ant Design/i.test(text);
}

export function normalizeRequirementPlanWorkPackageGranularity(workPackage = {}) {
  if (!shouldSplitFrontendViewMigrationWorkPackage(workPackage)) return [workPackage];

  const baseId = safeIdPart(workPackage.id || workPackage.work_package_id || "requirement-plan-step");
  const baseTitle = normalizeString(workPackage.title) || "实施步骤";
  const baseReason = normalizeString(
    workPackage.reason ||
      workPackage.source?.implementation_step ||
      workPackage.source?.implementationStep
  );
  const baseAcceptanceGates = uniqueStrings([
    ...normalizeStringList(workPackage.acceptance_gates || workPackage.acceptanceGates),
    ...normalizeStringList(workPackage.source?.acceptance_gates || workPackage.source?.acceptanceGates)
  ]);
  const baseOwnedFiles = normalizeStringList(workPackage.owned_files || workPackage.ownedFiles);
  const originalDependsOn = normalizeStringList(workPackage.depends_on || workPackage.dependencies);

  return FRONTEND_VIEW_MIGRATION_SLICES.map((slice, index) => {
    const sliceId = `${baseId}-${slice.id}`;
    const parentWorkPackageId = normalizeString(workPackage.id || workPackage.work_package_id);
    const dependsOn = index === 0 ? originalDependsOn : [`${baseId}-${FRONTEND_VIEW_MIGRATION_SLICES[index - 1].id}`];
    const acceptanceGates = uniqueStrings([
      ...baseAcceptanceGates,
      ...slice.acceptance_gates,
      `完成已审核实施步骤 ${workPackage.source?.plan_step_index || ""} 的${slice.title}切片：${baseReason || slice.reason}`
    ]);
    return {
      ...workPackage,
      id: sliceId,
      title: `${baseTitle}：${slice.title}切片`,
      reason: slice.reason,
      owned_files: uniqueStrings([
        ...baseOwnedFiles,
        ...slice.owned_files
      ]),
      acceptance_gates: acceptanceGates,
      depends_on: dependsOn,
      source: {
        ...(workPackage.source || {}),
        implementation_step: slice.reason,
        parent_implementation_step: baseReason,
        parent_work_package_id: parentWorkPackageId,
        plan_step_slice: slice.id,
        plan_step_slice_index: index + 1,
        plan_step_slice_total: FRONTEND_VIEW_MIGRATION_SLICES.length,
        acceptance_gates: acceptanceGates,
        execution_governance: planStepExecutionGovernance({
          granularity: "bounded_slice",
          decompositionRequired: true,
          decompositionStatus: "completed",
          decompositionEvidenceId: `${baseId}-manager-decomposition`,
          parentWorkPackageId,
          sliceId: slice.id,
          gateCount: acceptanceGates.length
        })
      }
    };
  });
}

function workPackageId(workPackage = {}) {
  return normalizeString(workPackage.id || workPackage.work_package_id || workPackage.workPackageId);
}

export function normalizeRequirementPlanWorkPackagesGranularity(workPackages = []) {
  const replacementDependencies = new Map();
  const normalizedPackages = [];

  asArray(workPackages).forEach((workPackage) => {
    const originalId = workPackageId(workPackage);
    const packages = normalizeRequirementPlanWorkPackageGranularity(workPackage);
    normalizedPackages.push(...packages);
    if (originalId && packages.length > 1) {
      replacementDependencies.set(originalId, workPackageId(packages.at(-1)));
    }
  });

  if (replacementDependencies.size === 0) return normalizedPackages;

  return normalizedPackages.map((workPackage) => {
    const dependencies = normalizeStringList(workPackage.depends_on || workPackage.dependencies);
    if (dependencies.length === 0) return workPackage;
    return {
      ...workPackage,
      depends_on: uniqueStrings(dependencies.map((dependency) => {
        return replacementDependencies.get(dependency) || dependency;
      }))
    };
  });
}

export function createRequirementPlanPrompt(requirement = {}) {
  return [
    "# Requirement Plan Generation",
    "",
    "你处于计划生成模式。只生成方案，不写代码，不修改文件，不声称已经实现。",
    "请基于用户需求生成可审核的中台任务方案。不要复制粘贴用户原话作为方案；需要抽象目标、范围、验收标准、风险和门禁证据。",
    "必须只返回一个 JSON object，不要包裹解释性文字。",
    "",
    "输入需求：",
    JSON.stringify({
      id: requirement.id || null,
      title: requirement.title || null,
      project_id: requirement.project_id || null,
      surface_area: requirement.surface_area || null,
      surface_label: requirement.surface_label || null,
      problem_statement: requirement.problem_statement || null,
      constraints: requirement.constraints || null
    }, null, 2),
    "",
    "输出 JSON schema：",
    JSON.stringify({
      assessment_summary: "一段中文评估摘要，说明目标、影响范围和关键不确定性",
      proposed_acceptance_plan: "面向用户审核的中文 Markdown 方案，包含目标、实施范围、验收标准、风险、门禁证据",
      implementation_outline: ["可执行步骤 1", "可执行步骤 2"],
      acceptance_gates: ["需要运行或验证的门禁"],
      risks: ["需要用户知道的风险或假设"]
    }, null, 2)
  ].join("\n");
}

function generatedPlanFromOutput(value) {
  if (isObject(value)) return value;
  const candidate = jsonCandidate(value);
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function evaluateGeneratedRequirementPlan(requirement = {}, generatedPlan = {}) {
  const issues = [];
  const assessment = normalizeString(generatedPlan.assessment_summary || generatedPlan.assessmentSummary);
  const plan = normalizeString(generatedPlan.proposed_acceptance_plan || generatedPlan.proposedAcceptancePlan);
  const implementationOutline = normalizeStringList(generatedPlan.implementation_outline || generatedPlan.implementationOutline);
  const acceptanceGates = normalizeStringList(generatedPlan.acceptance_gates || generatedPlan.acceptanceGates);
  const risks = normalizeStringList(generatedPlan.risks);
  const problem = normalizeString(requirement.problem_statement);

  if (!assessment) {
    issues.push(issue("missing_generated_assessment_summary", "generated plan must include assessment_summary", "assessment_summary"));
  }
  if (!plan) {
    issues.push(issue("missing_generated_acceptance_plan", "generated plan must include proposed_acceptance_plan", "proposed_acceptance_plan"));
  }
  if (implementationOutline.length === 0) {
    issues.push(issue("missing_generated_implementation_outline", "generated plan must include implementation_outline", "implementation_outline"));
  }
  if (acceptanceGates.length === 0) {
    issues.push(issue("missing_generated_acceptance_gates", "generated plan must include acceptance_gates", "acceptance_gates"));
  }
  if (problem && plan === problem) {
    issues.push(issue("generated_plan_copies_problem_statement", "generated plan must not be a verbatim copy of problem_statement", "proposed_acceptance_plan"));
  }

  return {
    status: issues.length ? "fail" : "pass",
    assessment_summary: assessment,
    proposed_acceptance_plan: plan,
    implementation_outline: implementationOutline,
    acceptance_gates: acceptanceGates,
    risks,
    issues
  };
}

export function parseRequirementPlanGenerationOutput(requirement = {}, output = "") {
  const parsed = generatedPlanFromOutput(output);
  if (!parsed) {
    return {
      status: "fail",
      issues: [issue("invalid_requirement_plan_generation_output", "plan generator must return a JSON object", "output")]
    };
  }
  return evaluateGeneratedRequirementPlan(requirement, parsed);
}

function pendingPlanReview(requirement = {}, createdAt = "") {
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

function generationIssueSummary(issues = []) {
  return asArray(issues)
    .map((item) => normalizeString(item?.message || item?.code || item))
    .filter(Boolean)
    .join("；")
    .slice(0, 1000);
}

export function markRequirementPlanGenerationFailed(projectStatus = {}, input = {}, options = {}) {
  const requirementId = normalizeString(input.requirement_id || input.requirementId);
  const existingReviews = isObject(projectStatus.plan_reviews) ? projectStatus.plan_reviews : {};
  const review = requirementId ? existingReviews[requirementId] : null;
  if (!review) {
    return {
      status: "fail",
      issues: [issue("plan_review_not_found", "plan review not found for requirement", "requirement_id")]
    };
  }

  const failedAt = normalizeString(options.created_at || options.createdAt || input.created_at || input.createdAt) ||
    new Date().toISOString();
  const issues = asArray(input.issues);
  const stderr = normalizeString(input.stderr).slice(0, 2000);
  const message = normalizeString(input.message) ||
    stderr ||
    generationIssueSummary(issues) ||
    "model plan generation failed";
  const nextReview = {
    ...review,
    status: "plan_generation_failed",
    phase: "plan_generation_failed",
    generator: input.generator || input.provenance || review.generator || null,
    generation_error: {
      message,
      stderr: stderr || null,
      issues,
      failed_at: failedAt
    },
    generation_issues: issues,
    failed_at: failedAt,
    next_action: "方案生成失败，请重试生成或检查模型入口",
    action_status: "方案生成失败"
  };

  return {
    status: "pass",
    plan_review: nextReview,
    project_status: {
      ...projectStatus,
      updated_at: failedAt,
      plan_reviews: {
        ...existingReviews,
        [requirementId]: nextReview
      }
    }
  };
}

export function applyGeneratedRequirementPlan(projectStatus = {}, input = {}, options = {}) {
  const requirementId = normalizeString(input.requirement_id || input.requirementId);
  const existingReviews = isObject(projectStatus.plan_reviews) ? projectStatus.plan_reviews : {};
  const review = requirementId ? existingReviews[requirementId] : null;
  const requirement = asArray(projectStatus?.requirement_intake?.items).find((item) => normalizeString(item?.id) === requirementId) || {};
  if (!review) {
    return {
      status: "fail",
      issues: [issue("plan_review_not_found", "plan review not found for requirement", "requirement_id")]
    };
  }

  const generatedPlan = input.generated_plan || input.generatedPlan || input.plan || input;
  const validation = evaluateGeneratedRequirementPlan(requirement, generatedPlan);
  if (validation.status !== "pass") {
    return {
      status: "fail",
      issues: validation.issues
    };
  }

  const generatedAt = normalizeString(options.created_at || options.createdAt || input.created_at || input.createdAt) ||
    new Date().toISOString();
  const nextReview = {
    ...review,
    status: "ready_for_review",
    phase: "ready_for_review",
    plan_id: normalizeString(review.plan_id) || `plan-${safeIdPart(requirementId)}`,
    assessment_summary: validation.assessment_summary,
    proposed_acceptance_plan: validation.proposed_acceptance_plan,
    implementation_outline: validation.implementation_outline,
    acceptance_gates: validation.acceptance_gates,
    risks: validation.risks,
    generator: input.generator || input.provenance || options.generator || null,
    generated_at: generatedAt,
    next_action: "等待用户审核方案",
    action_status: "等待你确认方案"
  };
  const nextProjectStatus = {
    ...projectStatus,
    updated_at: generatedAt,
    plan_reviews: {
      ...existingReviews,
      [requirementId]: nextReview
    }
  };

  return {
    status: "pass",
    plan_review: nextReview,
    project_status: nextProjectStatus
  };
}

function createPlanReview(requirement = {}, createdAt = "") {
  return pendingPlanReview(requirement, createdAt);
}

function planReviewIdFrom(requirementId = "") {
  return `plan-review-${safeIdPart(requirementId)}`;
}

function nextWorkPackage(requirement = {}, profile = {}) {
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

export function createRequirementPlanWorkPackages(projectStatus = {}, requirementId = "", profile = {}) {
  const id = normalizeString(requirementId);
  const planReviews = isObject(projectStatus.plan_reviews) ? projectStatus.plan_reviews : {};
  const review = id ? planReviews[id] : null;
  const requirement = asArray(projectStatus?.requirement_intake?.items)
    .find((item) => normalizeString(item?.id) === id) || {};
  const outline = normalizeStringList(review?.implementation_outline || review?.implementationOutline);
  if (!id || !review || outline.length === 0) return [];

  const title = normalizeString(requirement.title || review.requirement_title || id);
  const ownedFiles = uniqueStrings([
    ...normalizeStringList(requirement.owned_files || requirement.ownedFiles),
    ...normalizeStringList(review.owned_files || review.ownedFiles),
    ...normalizeStringList(profile.owned_files || profile.ownedFiles)
  ]);
  const baseAcceptanceGates = uniqueStrings([
    ...normalizeStringList(requirement.acceptance_gates || requirement.acceptanceGates),
    ...normalizeStringList(profile.acceptance_gates || profile.acceptanceGates)
  ]);
  const reviewAcceptanceGates = normalizeStringList(review.acceptance_gates || review.acceptanceGates);
  const total = outline.length;

  const packages = [];
  let previousDependencyIds = [];

  outline.forEach((step, index) => {
    const stepNumber = String(index + 1).padStart(2, "0");
    const packageId = `${id}-plan-step-${stepNumber}`;
    const stepAcceptanceGates = uniqueStrings([
      ...baseAcceptanceGates,
      ...(reviewAcceptanceGates[index] ? [reviewAcceptanceGates[index]] : []),
      `完成已审核实施步骤 ${index + 1}：${step}`
    ]);
    const workPackage = {
      id: packageId,
      title: `${title}：实施步骤 ${stepNumber} / ${total}`,
      action: "execute_requirement_plan_step",
      owned_files: ownedFiles.length > 0 ? ownedFiles : ["."],
      acceptance_gates: stepAcceptanceGates,
      depends_on: previousDependencyIds,
      reason: step,
      global_goal_id: id,
      source: {
        requirement_id: id,
        plan_review_id: normalizeString(review.id),
        plan_id: normalizeString(review.plan_id),
        plan_step_index: index + 1,
        plan_step_total: total,
        implementation_step: step,
        constraints: normalizeString(requirement.constraints),
        acceptance_gates: stepAcceptanceGates,
        execution_governance: planStepExecutionGovernance({
          granularity: "single_step",
          gateCount: stepAcceptanceGates.length
        })
      }
    };
    const normalizedPackages = normalizeRequirementPlanWorkPackagesGranularity([workPackage]);
    packages.push(...normalizedPackages);
    previousDependencyIds = normalizedPackages.length > 0
      ? [normalizeString(normalizedPackages.at(-1).id)]
      : [packageId];
  });

  return packages;
}

function nextArtifactId(workflowState = {}, requirementId = "") {
  const prefix = `requirement-intake-${safeIdPart(workflowState?.manifest?.run_id)}-${safeIdPart(workflowState?.manifest?.cycle_id)}-${safeIdPart(requirementId)}`;
  const used = new Set([
    ...asArray(workflowState?.manifest?.events).map((event) => normalizeString(event?.artifact_id)).filter(Boolean),
    ...asArray(workflowState?.artifact_ledger?.artifacts || workflowState?.artifactLedger?.artifacts)
      .map((artifact) => normalizeString(artifact?.id))
      .filter(Boolean)
  ]);
  let index = 1;
  let id = `${prefix}-${String(index).padStart(3, "0")}`;
  while (used.has(id)) {
    index += 1;
    id = `${prefix}-${String(index).padStart(3, "0")}`;
  }
  return id;
}

function normalizeRequirementItems(value) {
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
  if (!SURFACE_PROFILES[normalizeString(input.surface_area || input.surfaceArea) || DEFAULT_SURFACE_AREA]) {
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
        open_count: queue.filter((item) => !["completed", "complete", "accepted", "closed"].includes(normalizeString(item.status).toLowerCase())).length,
        items: queue
      },
      plan_reviews: {
        ...(isObject(projectStatus.plan_reviews) ? projectStatus.plan_reviews : {}),
        [requirement.id]: planReview
      }
    }
  };
}

export function updateRequirementPlanReview(projectStatus = {}, input = {}, options = {}) {
  const requirementId = normalizeString(input.requirement_id || input.requirementId);
  const action = normalizeString(input.action).toLowerCase();
  const existingReviews = isObject(projectStatus.plan_reviews) ? projectStatus.plan_reviews : {};
  const review = requirementId ? existingReviews[requirementId] : null;
  if (!review) {
    return {
      status: "fail",
      issues: [issue("plan_review_not_found", "plan review not found for requirement", "requirement_id")]
    };
  }
  if (!["approve", "revise"].includes(action)) {
    return {
      status: "fail",
      issues: [issue("invalid_plan_review_action", "action must be approve or revise", "action")]
    };
  }
  if (action === "approve" && normalizeString(review.phase) !== "ready_for_review") {
    return {
      status: "fail",
      issues: [issue("plan_review_not_ready", "plan review must be generated before approval", "plan_reviews")]
    };
  }

  const reviewedAt = normalizeString(options.created_at || options.createdAt || input.created_at || input.createdAt) ||
    new Date().toISOString();
  const approved = action === "approve";
  const feedbackCategories = uniqueStrings(input.feedback_categories || input.feedbackCategories);
  const reviewNote = normalizeString(input.note);
  const nextReview = {
    ...review,
    status: approved ? "in_development" : "revising",
    phase: approved ? "in_development" : "revising",
    reviewed_at: reviewedAt,
    review_decision: action,
    review_note: reviewNote,
    feedback_categories: feedbackCategories,
    review_feedback: approved ? null : {
      categories: feedbackCategories,
      note: reviewNote,
      submitted_at: reviewedAt
    },
    next_action: approved ? "开发已开始" : "方案已退回，等待修订后重新审核",
    action_status: approved ? "开发中" : "已退回修订"
  };
  const nextProjectStatusBase = {
    ...projectStatus,
    updated_at: reviewedAt,
    plan_reviews: {
      ...existingReviews,
      [requirementId]: nextReview
    }
  };
  const nextPlanWorkPackages = approved
    ? createRequirementPlanWorkPackages(nextProjectStatusBase, requirementId)
    : asArray(projectStatus.next_work_packages || projectStatus.nextWorkPackages);
  const nextGlobalGoals = approved && nextPlanWorkPackages.length > 0
    ? asArray(projectStatus.global_goals || projectStatus.globalGoals).map((goal) => {
      const goalId = normalizeString(goal?.id || goal?.goal_id || goal?.key);
      if (goalId !== requirementId) return goal;
      return {
        ...goal,
        status: "in_progress",
        next_work_packages: nextPlanWorkPackages
      };
    })
    : asArray(projectStatus.global_goals || projectStatus.globalGoals);

  return {
    status: "pass",
    plan_review: nextReview,
    project_status: {
      ...nextProjectStatusBase,
      ...(approved && nextPlanWorkPackages.length > 0 ? { next_work_packages: nextPlanWorkPackages } : {}),
      ...(approved && nextGlobalGoals.length > 0 ? { global_goals: nextGlobalGoals } : {})
    }
  };
}

export function summarizeRequirementIntake(projectStatus = {}) {
  const requirementIntake = isObject(projectStatus.requirement_intake) ? projectStatus.requirement_intake : {};
  const items = normalizeRequirementItems(requirementIntake.items);
  const latest = items[0] || null;

  return {
    status: items.length > 0 ? "available" : "not_configured",
    submitted_count: Number(requirementIntake.submitted_count || items.length || 0),
    open_count: Number(requirementIntake.open_count || items.filter((item) => !["completed", "complete", "accepted", "closed"].includes(normalizeString(item.status).toLowerCase())).length),
    active_requirement_id: normalizeString(requirementIntake.active_requirement_id || requirementIntake.activeRequirementId) || latest?.id || null,
    latest,
    items
  };
}

export function recordRequirementIntakeSubmitted(workflowState = {}, submission = {}, options = {}) {
  if (!isObject(workflowState)) {
    return {
      status: "fail",
      issues: [issue("invalid_workflow_state", "workflow state must be an object", "workflow_state")]
    };
  }
  if (!isObject(submission?.project_status) || !isObject(submission?.requirement)) {
    return {
      status: "fail",
      issues: [issue("invalid_requirement_submission_result", "submission must include project_status and requirement", "submission")]
    };
  }

  const runId = normalizeString(workflowState?.manifest?.run_id);
  const cycleId = normalizeString(workflowState?.manifest?.cycle_id);
  if (!runId || !cycleId) {
    return {
      status: "fail",
      issues: [issue("missing_workflow_identity", "workflow state manifest run_id and cycle_id are required", "workflow_state.manifest")]
    };
  }

  const requirement = submission.requirement;
  const createdAt = normalizeString(options.created_at || options.createdAt || requirement.submitted_at) || new Date().toISOString();
  const artifactId = nextArtifactId(workflowState, requirement.id);
  const nextWorkPackages = asArray(submission.project_status.next_work_packages);
  const artifact = {
    id: artifactId,
    type: "evaluation",
    status: "pass",
    producer: "workbench-requirement-intake",
    uri: `requirement-intake://${encodeURIComponent(runId)}/${encodeURIComponent(cycleId)}/${encodeURIComponent(requirement.id)}`,
    created_at: createdAt,
    metadata: {
      version: WORKBENCH_REQUIREMENT_INTAKE_VERSION,
      type: "requirement_intake_submitted",
      status: "ready",
      run_id: runId,
      cycle_id: cycleId,
      requirement,
      next_step: submission.project_status.next_step || null,
      global_goal_id: requirement.id,
      next_work_package_count: nextWorkPackages.length,
      next_work_packages: nextWorkPackages.map((workPackage) => ({
        id: workPackage.id || null,
        title: workPackage.title || null,
        action: workPackage.action || null,
        global_goal_id: workPackage.global_goal_id || null,
        owned_files: uniqueStrings(workPackage.owned_files || workPackage.ownedFiles),
        acceptance_gates: uniqueStrings(workPackage.acceptance_gates || workPackage.acceptanceGates)
      }))
    }
  };
  const manifest = appendRunEvent(workflowState.manifest, {
    id: `event-${artifactId}`,
    type: "requirement_intake_submitted",
    status: "ready",
    artifact_id: artifactId,
    message: `workbench requirement submitted: ${requirement.title}`,
    created_at: createdAt,
    metadata: artifact.metadata
  });
  const baseLedger = workflowState.artifact_ledger || workflowState.artifactLedger || {};
  const artifactLedger = recordArtifact({
    ...baseLedger,
    artifacts: Array.isArray(baseLedger.artifacts) ? baseLedger.artifacts : []
  }, artifact);

  return {
    status: "pass",
    artifact,
    fact: artifact.metadata,
    workflow_state: {
      ...workflowState,
      project_status: submission.project_status,
      global_goals: asArray(submission.project_status.global_goals),
      manifest: {
        ...manifest,
        artifacts: [...asArray(manifest.artifacts), artifact]
      },
      artifact_ledger: artifactLedger
    }
  };
}
