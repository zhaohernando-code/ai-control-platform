import { generateSelfGovernanceFindings } from "./self-governance-scanner.js";

const GOVERNANCE_DIMENSIONS = [
  "code_quality",
  "system_robustness",
  "iteration_evolution",
  "user_experience",
  "flow_integrity",
  "quality_gate",
  "recovery_capability",
  "model_collaboration",
  "cost_efficiency",
  "security_permission",
  "knowledge_retention",
  "product_capability_gap"
];

const VALID_CATEGORIES = new Set(["defect", "evidence_gap", "evolution_opportunity"]);
const VALID_SEVERITIES = new Set(["info", "low", "medium", "high", "critical"]);
const VALID_CADENCES = new Set(["manual", "daily", "weekly", "post_release"]);

const GOVERNANCE_ROLES = [
  {
    id: "code_quality_guard",
    title: "代码质量把关",
    dimensions: ["code_quality", "quality_gate", "knowledge_retention"]
  },
  {
    id: "robustness_assessor",
    title: "系统健壮性评估",
    dimensions: ["system_robustness", "recovery_capability", "security_permission"]
  },
  {
    id: "product_evolution_planner",
    title: "迭代进化建议",
    dimensions: ["iteration_evolution", "product_capability_gap", "user_experience"]
  },
  {
    id: "model_collaboration_auditor",
    title: "模型协作审计",
    dimensions: ["model_collaboration", "cost_efficiency", "flow_integrity"]
  }
];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeToken(value) {
  return normalizeString(value).toLowerCase();
}

function compactStrings(value) {
  return asArray(value).map(normalizeString).filter(Boolean);
}

function issue(code, message, path) {
  return { code, message, path };
}

function safeIdPart(value) {
  return normalizeString(value).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}

function createdAt(input = {}) {
  return normalizeString(input.created_at || input.createdAt) || new Date().toISOString();
}

function findingId(finding = {}, index = 0) {
  return normalizeString(finding.id || finding.finding_id || finding.code || finding.title) || `governance-finding-${index + 1}`;
}

function findingDimension(finding = {}) {
  const dimension = normalizeToken(finding.dimension || finding.area || finding.domain);
  return GOVERNANCE_DIMENSIONS.includes(dimension) ? dimension : "flow_integrity";
}

function findingCategory(finding = {}) {
  const category = normalizeToken(finding.category || finding.type || finding.kind);
  return VALID_CATEGORIES.has(category) ? category : "evolution_opportunity";
}

function findingSeverity(finding = {}) {
  const severity = normalizeToken(finding.severity || finding.level);
  return VALID_SEVERITIES.has(severity) ? severity : "medium";
}

function findingTitle(finding = {}, id = "governance-finding") {
  return normalizeString(finding.title || finding.summary || finding.message) || id;
}

function ownedFilesForFinding(finding = {}) {
  const explicit = compactStrings(finding.owned_files || finding.ownedFiles || finding.files);
  if (explicit.length > 0) return explicit;

  const dimension = findingDimension(finding);
  if (dimension === "user_experience") return ["apps/workbench", "src/workflow/workbench-projection.js"];
  if (dimension === "model_collaboration") return ["src/workflow/llm-reviewer-gate.js", "src/workflow/model-router.js"];
  if (dimension === "recovery_capability") return ["src/workflow/autonomous-continuation.js", "src/workflow/agent-lifecycle-pool.js"];
  if (dimension === "quality_gate") return ["src/workflow/process-hardening.js", "tools/check-closeout.mjs"];
  if (dimension === "cost_efficiency") return ["src/workflow/model-router.js"];
  if (dimension === "security_permission") return ["src/workflow/host-boundary.js", "src/workflow/fixed-development-mode-gate.js"];
  return ["src/workflow", "test"];
}

function defaultAcceptanceGates(finding = {}) {
  const explicit = compactStrings(finding.acceptance_gates || finding.acceptanceGates);
  if (explicit.length > 0) return explicit;
  return ["npm test"];
}

function remediationWorkPackage(finding = {}, index = 0) {
  const id = findingId(finding, index);
  return {
    id: `self-governance-fix-${safeIdPart(id)}`,
    title: `自动修复：${findingTitle(finding, id)}`,
    action: "run_context_work_packages",
    governance_action: "auto_remediate_defect",
    source_finding_id: id,
    dimension: findingDimension(finding),
    severity: findingSeverity(finding),
    owned_files: ownedFilesForFinding(finding),
    acceptance_gates: defaultAcceptanceGates(finding),
    reason: normalizeString(finding.recommended_fix || finding.message || finding.summary) ||
      "明确缺陷应直接进入中台开发流程修复，而不是停留在告警。"
  };
}

function evidenceWorkPackage(finding = {}, index = 0) {
  const id = findingId(finding, index);
  return {
    id: `self-governance-evidence-${safeIdPart(id)}`,
    title: `证据补强：${findingTitle(finding, id)}`,
    action: "run_context_work_packages",
    governance_action: "collect_evidence_before_remediation",
    source_finding_id: id,
    dimension: findingDimension(finding),
    severity: findingSeverity(finding),
    owned_files: ownedFilesForFinding(finding),
    acceptance_gates: defaultAcceptanceGates(finding),
    reason: normalizeString(finding.evidence_needed || finding.message || finding.summary) ||
      "疑似风险需要先补充测试、采样或复现证据，再决定是否自动修复。"
  };
}

function decisionOptions(finding = {}, id = "governance-finding") {
  const explicit = asArray(finding.options || finding.decision_options || finding.decisionOptions)
    .filter((option) => option && typeof option === "object" && !Array.isArray(option));
  if (explicit.length > 0) {
    return explicit.map((option, index) => ({
      id: normalizeString(option.id) || `${safeIdPart(id)}-option-${index + 1}`,
      label: normalizeString(option.label || option.title) || `方案 ${index + 1}`,
      impact: normalizeString(option.impact || option.description),
      tradeoff: normalizeString(option.tradeoff),
      recommended: option.recommended === true
    }));
  }

  return [
    {
      id: `${safeIdPart(id)}-lightweight`,
      label: "轻量跟进",
      impact: "先用较小范围验证价值，成本低、上线快。",
      tradeoff: "覆盖面有限，可能遗漏深层问题。",
      recommended: true
    },
    {
      id: `${safeIdPart(id)}-standard`,
      label: "标准落地",
      impact: "纳入正式工作台和调度流程，形成稳定能力。",
      tradeoff: "需要更多实现和验收成本。",
      recommended: false
    },
    {
      id: `${safeIdPart(id)}-defer`,
      label: "暂缓观察",
      impact: "不立即投入开发，仅保留在治理观察池。",
      tradeoff: "问题可能继续由人工补位。",
      recommended: false
    }
  ];
}

function decisionFacets(finding = {}) {
  return {
    priority: compactStrings(finding.priority_choices || finding.priorityChoices).length
      ? compactStrings(finding.priority_choices || finding.priorityChoices)
      : ["现在做", "下轮做", "暂缓"],
    scope: compactStrings(finding.scope_choices || finding.scopeChoices).length
      ? compactStrings(finding.scope_choices || finding.scopeChoices)
      : ["只看平台本体", "包含被纳管项目", "只看工作台"],
    depth: compactStrings(finding.depth_choices || finding.depthChoices).length
      ? compactStrings(finding.depth_choices || finding.depthChoices)
      : ["快速检查", "标准检查", "深度检查"],
    automation_authority: compactStrings(finding.automation_authority_choices || finding.automationAuthorityChoices).length
      ? compactStrings(finding.automation_authority_choices || finding.automationAuthorityChoices)
      : ["只报告", "可自动修复", "修复前需确认"],
    cadence: compactStrings(finding.cadence_choices || finding.cadenceChoices).length
      ? compactStrings(finding.cadence_choices || finding.cadenceChoices)
      : ["每日", "每周", "每次发布后", "手动触发"],
    cost_ceiling: compactStrings(finding.cost_ceiling_choices || finding.costCeilingChoices).length
      ? compactStrings(finding.cost_ceiling_choices || finding.costCeilingChoices)
      : ["低", "中", "高"],
    output: compactStrings(finding.output_choices || finding.outputChoices).length
      ? compactStrings(finding.output_choices || finding.outputChoices)
      : ["工作台卡片", "周报", "待办队列", "自动生成修复任务"]
  };
}

function cadenceFrom(input = {}) {
  const cadence = normalizeToken(input.cadence || input.schedule?.cadence || input.self_governance?.cadence);
  return VALID_CADENCES.has(cadence) ? cadence : "weekly";
}

function cadenceLabel(cadence) {
  return {
    manual: "手动触发",
    daily: "每日",
    weekly: "每周",
    post_release: "每次发布后"
  }[cadence] || "每周";
}

function nextTriggerFor(cadence) {
  return {
    manual: "等待用户在工作台触发下一次自检",
    daily: "下一次日常巡检窗口",
    weekly: "下一次周度治理窗口",
    post_release: "下一次发布完成后"
  }[cadence] || "下一次周度治理窗口";
}

export function createSelfGovernanceCyclePlan(input = {}) {
  const cadence = cadenceFrom(input);
  const dimensions = compactStrings(input.dimensions).length
    ? compactStrings(input.dimensions).filter((dimension) => GOVERNANCE_DIMENSIONS.includes(dimension))
    : GOVERNANCE_DIMENSIONS;
  const roles = GOVERNANCE_ROLES
    .map((role) => ({
      ...role,
      dimensions: role.dimensions.filter((dimension) => dimensions.includes(dimension))
    }))
    .filter((role) => role.dimensions.length > 0);

  return {
    version: "self-governance-cycle-plan.v1",
    status: "ready",
    cadence,
    cadence_label: cadenceLabel(cadence),
    next_trigger: nextTriggerFor(cadence),
    dimensions,
    roles,
    handoff_policy: {
      defects: "明确缺陷直接生成中台修复工作包",
      evidence_gaps: "证据不足风险先生成补证据工作包",
      evolution_opportunities: "演进机会生成结构化用户决策包"
    }
  };
}

function decisionPackage(finding = {}, index = 0) {
  const id = findingId(finding, index);
  return {
    id: `self-governance-decision-${safeIdPart(id)}`,
    source_finding_id: id,
    title: findingTitle(finding, id),
    dimension: findingDimension(finding),
    severity: findingSeverity(finding),
    recommendation: normalizeString(finding.recommendation || finding.message || finding.summary),
    status: "waiting_for_user_decision",
    options: decisionOptions(finding, id),
    facets: decisionFacets(finding),
    default_decision: {
      priority: "下轮做",
      scope: "只看平台本体",
      depth: "标准检查",
      automation_authority: "修复前需确认",
      cadence: "每周",
      cost_ceiling: "中",
      output: "工作台卡片"
    }
  };
}

function normalizeFinding(finding = {}, index = 0) {
  const id = findingId(finding, index);
  return {
    id,
    title: findingTitle(finding, id),
    category: findingCategory(finding),
    dimension: findingDimension(finding),
    severity: findingSeverity(finding),
    message: normalizeString(finding.message || finding.summary || finding.recommendation),
    evidence: compactStrings(finding.evidence || finding.evidence_refs || finding.evidenceRefs),
    owned_files: ownedFilesForFinding(finding)
  };
}

function explicitFindings(input = {}) {
  const manualFindings = [
    ...asArray(input.findings),
    ...asArray(input.self_governance_findings),
    ...asArray(input.workflow_state?.self_governance_findings),
    ...asArray(input.workflow_state?.self_governance?.findings)
  ];
  const scanInput = manualFindings.length > 0
    ? {
      ...input,
      governance_sources: {
        ...(input.governance_sources || input.governanceSources || {}),
        require_scanner_findings: false
      }
    }
    : input;
  const scanFindings = input.generate_findings === true || input.generateFindings === true
    ? generateSelfGovernanceFindings(scanInput).findings
    : [];
  return [
    ...manualFindings,
    ...scanFindings
  ];
}

function findingsFromManifest(input = {}) {
  const events = asArray(input.workflow_state?.manifest?.events || input.manifest?.events)
    .filter((event) => event?.type === "self_governance_finding" || event?.type === "self_governance_report");
  return events.flatMap((event) => {
    if (event?.type === "self_governance_report") {
      return asArray(event.metadata?.findings);
    }
    return event.metadata ? [event.metadata] : [];
  });
}

export function validateSelfGovernanceInput(input = {}) {
  const findings = [...explicitFindings(input), ...findingsFromManifest(input)];
  const issues = [];

  findings.forEach((finding, index) => {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
      issues.push(issue("invalid_governance_finding", "self-governance finding must be an object", `findings[${index}]`));
      return;
    }
    if (!VALID_CATEGORIES.has(findingCategory(finding))) {
      issues.push(issue("invalid_governance_category", "governance category is invalid", `findings[${index}].category`));
    }
    if (!GOVERNANCE_DIMENSIONS.includes(findingDimension(finding))) {
      issues.push(issue("invalid_governance_dimension", "governance dimension is invalid", `findings[${index}].dimension`));
    }
  });

  return {
    status: issues.length ? "fail" : "pass",
    issues,
    finding_count: findings.length
  };
}

export function createSelfGovernanceReport(input = {}) {
  const validation = validateSelfGovernanceInput(input);
  const cyclePlan = createSelfGovernanceCyclePlan(input);
  const rawFindings = [...explicitFindings(input), ...findingsFromManifest(input)];
  const findings = rawFindings.map(normalizeFinding);
  const defectFindings = rawFindings.filter((finding) => findingCategory(finding) === "defect");
  const evidenceFindings = rawFindings.filter((finding) => findingCategory(finding) === "evidence_gap");
  const evolutionFindings = rawFindings.filter((finding) => findingCategory(finding) === "evolution_opportunity");
  const autoRepairWorkPackages = defectFindings.map(remediationWorkPackage);
  const evidenceWorkPackages = evidenceFindings.map(evidenceWorkPackage);
  const decisionPackages = evolutionFindings.map(decisionPackage);
  const byDimension = findings.reduce((summary, finding) => {
    summary[finding.dimension] = (summary[finding.dimension] || 0) + 1;
    return summary;
  }, {});

  return {
    version: "self-governance.v1",
    status: validation.status === "pass" ? "available" : "invalid",
    generated_at: createdAt(input),
    cycle_plan: cyclePlan,
    validation,
    dimensions: GOVERNANCE_DIMENSIONS,
    finding_count: findings.length,
    findings,
    by_dimension: byDimension,
    auto_repair: {
      status: autoRepairWorkPackages.length > 0 ? "ready" : "not_required",
      count: autoRepairWorkPackages.length,
      work_packages: autoRepairWorkPackages
    },
    evidence_building: {
      status: evidenceWorkPackages.length > 0 ? "ready" : "not_required",
      count: evidenceWorkPackages.length,
      work_packages: evidenceWorkPackages
    },
    user_decisions: {
      status: decisionPackages.length > 0 ? "waiting_for_user" : "not_required",
      count: decisionPackages.length,
      packages: decisionPackages
    },
    completed_improvements: asArray(input.completed_improvements || input.workflow_state?.self_governance?.completed_improvements),
    next_work_packages: [...autoRepairWorkPackages, ...evidenceWorkPackages]
  };
}

export function summarizeSelfGovernance(input = {}) {
  const report = input?.version === "self-governance.v1" ? input : createSelfGovernanceReport(input);
  return {
    status: report.status,
    cadence: report.cycle_plan?.cadence || null,
    next_trigger: report.cycle_plan?.next_trigger || null,
    role_count: asArray(report.cycle_plan?.roles).length,
    finding_count: report.finding_count,
    dimensions_checked: report.dimensions.length,
    auto_repair_count: report.auto_repair.count,
    evidence_building_count: report.evidence_building.count,
    user_decision_count: report.user_decisions.count,
    completed_improvement_count: asArray(report.completed_improvements).length,
    next_work_package_count: report.next_work_packages.length,
    top_dimension: Object.entries(report.by_dimension || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
    latest_decision_title: report.user_decisions.packages[0]?.title || null,
    latest_auto_repair_title: report.auto_repair.work_packages[0]?.title || null,
    latest_evidence_title: report.evidence_building.work_packages[0]?.title || null
  };
}

export { GOVERNANCE_DIMENSIONS, GOVERNANCE_ROLES };
