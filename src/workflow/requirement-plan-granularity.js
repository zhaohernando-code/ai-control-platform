const EXECUTION_GOVERNANCE_VERSION = "work-package-execution-governance.v1";

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

function safeIdPart(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
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
