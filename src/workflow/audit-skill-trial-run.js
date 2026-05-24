export const AUDIT_SKILL_TRIAL_RUN_VERSION = "audit-skill-trial-run.v1";
export const DEFAULT_AUDIT_PROJECT_ROOT = "/Users/hernando_zhao/codex/projects/ai-control-platform";

export const AUDIT_SKILL_DIMENSIONS = [
  "code_quality",
  "system_robustness",
  "security_permission",
  "cost_efficiency",
  "flow_integrity",
  "quality_gate",
  "auto_repair_authenticity",
  "recovery_capability",
  "iteration_evolution",
  "product_capability_gap",
  "user_experience",
  "knowledge_retention",
  "model_collaboration"
];

const VALID_DIMENSION_STATUSES = new Set(["audited", "not_applicable"]);
const VALID_FINDING_TYPES = new Set(["明确缺陷", "证据缺口", "可选迭代"]);
const VALID_SEVERITIES = new Set(["致命", "高", "中", "低"]);
const VALID_DISPOSITIONS = new Set(["立即修复", "继续取证", "用户决策", "延后"]);
const FINAL_VERDICTS = new Set(["通过", "带条件通过", "不通过", "需补证"]);
const SUMMARY_ONLY_DOCS = new Set([
  "PROJECT_STATUS.json",
  "PROCESS.md",
  "DECISIONS.md",
  "PROJECT_PLAN.md",
  "README.md"
]);
const SAMPLE_TOKENS = ["sample", "fixture", "mock", "demo", "synthetic"];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeToken(value) {
  return normalizeString(value).toLowerCase();
}

function issue(code, message, path) {
  return { code, message, path };
}

function evidenceId(evidence, index) {
  return normalizeString(evidence?.id || evidence?.evidence_id || evidence?.code) || `evidence-${index + 1}`;
}

function findingEvidenceIds(finding) {
  return asArray(finding?.evidence_ids || finding?.evidenceIds || finding?.evidence).map(normalizeString).filter(Boolean);
}

function evidenceIdsForDimension(dimension) {
  return asArray(dimension?.evidence_ids || dimension?.evidenceIds || dimension?.evidence).map(normalizeString).filter(Boolean);
}

function evidenceSource(evidence) {
  return normalizeString(evidence?.source || evidence?.command_or_path || evidence?.path || evidence?.entrypoint);
}

function sourceBasename(source) {
  return source.split(/[\\/]/u).filter(Boolean).at(-1) || source;
}

function isSummaryOnlyEvidence(evidence) {
  const source = evidenceSource(evidence);
  if (!source) return false;
  return SUMMARY_ONLY_DOCS.has(sourceBasename(source));
}

function hasCurrentImplementationEvidence(evidence) {
  if (isSummaryOnlyEvidence(evidence)) return false;
  const kind = normalizeToken(evidence?.kind);
  if (["code", "test", "command", "runtime", "browser", "api", "diff"].includes(kind)) return true;
  const source = evidenceSource(evidence);
  return /(^|\/)(src|test|tools|apps|scripts)\//u.test(source) || /\.(js|mjs|ts|tsx|json)$/u.test(source);
}

function isPassingCloseoutEvidence(evidence) {
  if (normalizeToken(evidence?.kind) !== "command") return false;
  const command = `${evidence?.source || ""} ${evidence?.command_or_path || ""}`.toLowerCase();
  if (!command.includes("check:closeout") && !command.includes("check-closeout.mjs")) return false;
  return Number(evidence?.exit_code) === 0;
}

function containsSampleSignal(value) {
  const text = normalizeString(value).toLowerCase();
  return SAMPLE_TOKENS.some((token) => text.includes(token));
}

function validateEvidence(evidence, index, issues) {
  const path = `evidence[${index}]`;
  if (!isObject(evidence)) {
    issues.push(issue("invalid_evidence", "evidence must be an object", path));
    return;
  }
  for (const field of ["kind", "source", "collected_at", "collector", "command_or_path", "result_summary"]) {
    if (!normalizeString(evidence[field])) {
      issues.push(issue("missing_evidence_field", `${field} is required`, `${path}.${field}`));
    }
  }
  if (normalizeToken(evidence.kind) === "command" && !Number.isFinite(Number(evidence.exit_code))) {
    issues.push(issue("missing_command_exit_code", "command evidence must include exit_code", `${path}.exit_code`));
  }
  if (["browser", "api"].includes(normalizeToken(evidence.kind))) {
    for (const field of ["entrypoint", "status", "observed_result"]) {
      if (!normalizeString(evidence[field])) {
        issues.push(issue("missing_runtime_evidence_field", `${field} is required for browser/api evidence`, `${path}.${field}`));
      }
    }
  }
  if (normalizeToken(evidence.kind) === "file") {
    if (!normalizeString(evidence.line) && !normalizeString(evidence.field_path)) {
      issues.push(issue("missing_file_locator", "file evidence must include line or field_path", path));
    }
  }
}

function validateRepairSchedule(schedule, path, issues) {
  if (!isObject(schedule)) {
    issues.push(issue("missing_repair_schedule", "明确缺陷 must include repair_schedule", path));
    return;
  }
  for (const field of [
    "scope",
    "target_files_or_modules",
    "owner_role",
    "verification_commands",
    "post_repair_evidence_required",
    "rollback_risk"
  ]) {
    const value = schedule[field];
    if (Array.isArray(value) ? value.length === 0 : !normalizeString(value)) {
      issues.push(issue("incomplete_repair_schedule", `${field} is required`, `${path}.${field}`));
    }
  }
}

function validateEvidencePlan(plan, path, issues) {
  if (!isObject(plan)) {
    issues.push(issue("missing_evidence_plan", "证据缺口 must include evidence_plan", path));
    return;
  }
  for (const field of ["missing_evidence", "how_to_collect", "minimum_command_or_entrypoint"]) {
    if (!normalizeString(plan[field])) {
      issues.push(issue("incomplete_evidence_plan", `${field} is required`, `${path}.${field}`));
    }
  }
  if (typeof plan.blocking_closure !== "boolean") {
    issues.push(issue("incomplete_evidence_plan", "blocking_closure must be boolean", `${path}.blocking_closure`));
  }
}

function validateDecisionPackage(decisionPackage, path, issues) {
  if (!isObject(decisionPackage)) {
    issues.push(issue("missing_decision_package", "可选迭代 must include decision_package", path));
    return;
  }
  if (asArray(decisionPackage.options).length < 2) {
    issues.push(issue("insufficient_decision_options", "decision_package.options must include at least two options", `${path}.options`));
  }
  for (const field of ["tradeoffs", "recommended_option", "estimated_cost", "confidence_gain"]) {
    if (!normalizeString(decisionPackage[field])) {
      issues.push(issue("incomplete_decision_package", `${field} is required`, `${path}.${field}`));
    }
  }
}

function validateFinding(finding, index, evidenceById, dimensionIds, issues) {
  const path = `findings[${index}]`;
  if (!isObject(finding)) {
    issues.push(issue("invalid_finding", "finding must be an object", path));
    return;
  }

  const type = normalizeString(finding.type);
  const severity = normalizeString(finding.severity);
  const disposition = normalizeString(finding.disposition);
  if (!VALID_FINDING_TYPES.has(type)) {
    issues.push(issue("invalid_finding_type", "finding type must be 明确缺陷, 证据缺口, or 可选迭代", `${path}.type`));
  }
  if (!VALID_SEVERITIES.has(severity)) {
    issues.push(issue("invalid_finding_severity", "finding severity must be 致命, 高, 中, or 低", `${path}.severity`));
  }
  if (!VALID_DISPOSITIONS.has(disposition)) {
    issues.push(issue("invalid_finding_disposition", "finding disposition is invalid", `${path}.disposition`));
  }
  const dimension = normalizeString(finding.dimension);
  if (!dimensionIds.has(dimension)) {
    issues.push(issue("finding_dimension_not_covered", "finding dimension must be covered by dimensions", `${path}.dimension`));
  }

  const evidenceIds = findingEvidenceIds(finding);
  if (evidenceIds.length === 0) {
    issues.push(issue("finding_without_evidence", "finding must bind at least one evidence_id", `${path}.evidence_ids`));
  }
  for (const id of evidenceIds) {
    if (!evidenceById.has(id)) {
      issues.push(issue("finding_unknown_evidence", `finding references unknown evidence ${id}`, `${path}.evidence_ids`));
    }
  }
  const knownEvidence = evidenceIds.map((id) => evidenceById.get(id)).filter(Boolean);
  if (knownEvidence.length > 0 && knownEvidence.every(isSummaryOnlyEvidence)) {
    issues.push(issue("finding_summary_only_evidence", "finding evidence cannot rely only on summary docs", `${path}.evidence_ids`));
  }

  if (type === "明确缺陷") {
    validateRepairSchedule(finding.repair_schedule, `${path}.repair_schedule`, issues);
    if (finding.user_visible === true && !normalizeString(finding.repair_schedule?.live_or_browser_verification)) {
      issues.push(issue("missing_live_verification_plan", "user-visible defects require live_or_browser_verification", `${path}.repair_schedule.live_or_browser_verification`));
    }
  } else if (type === "证据缺口") {
    validateEvidencePlan(finding.evidence_plan, `${path}.evidence_plan`, issues);
  } else if (type === "可选迭代") {
    validateDecisionPackage(finding.decision_package, `${path}.decision_package`, issues);
    if (disposition !== "用户决策" && disposition !== "延后") {
      issues.push(issue("optional_iteration_auto_repair_forbidden", "可选迭代 must not enter automatic repair without user decision", `${path}.disposition`));
    }
  }
}

function validateDimension(dimension, index, evidenceById, issues) {
  const path = `dimensions[${index}]`;
  if (!isObject(dimension)) {
    issues.push(issue("invalid_dimension", "dimension must be an object", path));
    return;
  }
  const id = normalizeString(dimension.id || dimension.dimension);
  if (!AUDIT_SKILL_DIMENSIONS.includes(id)) {
    issues.push(issue("invalid_dimension_id", "dimension id is not in required audit dimension list", `${path}.id`));
  }
  const status = normalizeString(dimension.status);
  if (!VALID_DIMENSION_STATUSES.has(status)) {
    issues.push(issue("invalid_dimension_status", "dimension status must be audited or not_applicable", `${path}.status`));
  }
  for (const field of ["skill_name", "skill_version_or_path", "prompt_scope", "input_artifacts", "output_artifact"]) {
    const value = dimension[field];
    if (Array.isArray(value) ? value.length === 0 : !normalizeString(value)) {
      issues.push(issue("missing_skill_trace", `${field} is required`, `${path}.${field}`));
    }
  }
  const evidenceIds = evidenceIdsForDimension(dimension);
  if (evidenceIds.length === 0) {
    issues.push(issue("dimension_without_evidence", "each dimension must bind at least one evidence_id", `${path}.evidence_ids`));
  }
  for (const evidenceIdValue of evidenceIds) {
    if (!evidenceById.has(evidenceIdValue)) {
      issues.push(issue("dimension_unknown_evidence", `dimension references unknown evidence ${evidenceIdValue}`, `${path}.evidence_ids`));
    }
  }
  const knownEvidence = evidenceIds.map((id) => evidenceById.get(id)).filter(Boolean);
  if (knownEvidence.length > 0 && knownEvidence.every(isSummaryOnlyEvidence)) {
    issues.push(issue("dimension_summary_only_evidence", "dimension evidence cannot rely only on summary docs", `${path}.evidence_ids`));
  }
  if (status === "not_applicable" && !normalizeString(dimension.not_applicable_reason)) {
    issues.push(issue("missing_not_applicable_reason", "not_applicable dimensions require a reason", `${path}.not_applicable_reason`));
  }
}

function summaryNumber(summary, field) {
  const value = Number(summary?.[field]);
  return Number.isFinite(value) ? value : NaN;
}

export function evaluateAuditSkillTrialRun(artifact = {}, options = {}) {
  const issues = [];
  const expectedProjectRoot = normalizeString(options.expectedProjectRoot) || DEFAULT_AUDIT_PROJECT_ROOT;

  if (!isObject(artifact)) {
    return {
      gate_id: "audit-skill-trial-run",
      status: "fail",
      issues: [issue("invalid_audit_skill_trial_run", "artifact must be an object", "")]
    };
  }

  if (artifact.version !== AUDIT_SKILL_TRIAL_RUN_VERSION) {
    issues.push(issue("invalid_audit_skill_trial_version", "artifact version must be audit-skill-trial-run.v1", "version"));
  }
  if (normalizeString(artifact.project_root) !== expectedProjectRoot) {
    issues.push(issue("audit_project_root_mismatch", "audit_run.project_root must match the real project root", "project_root"));
  }
  if (normalizeString(artifact.input_mode) !== "real_project_state") {
    issues.push(issue("invalid_audit_input_mode", "audit_run.input_mode must be real_project_state", "input_mode"));
  }
  if (containsSampleSignal(artifact.input_mode) || containsSampleSignal(artifact.scope)) {
    issues.push(issue("sample_input_forbidden", "sample, fixture, mock, demo, or synthetic input cannot support final audit", "input_mode"));
  }
  if (!FINAL_VERDICTS.has(normalizeString(artifact.final_verdict))) {
    issues.push(issue("invalid_final_verdict", "final_verdict is invalid", "final_verdict"));
  }

  const evidence = asArray(artifact.evidence);
  const evidenceById = new Map(evidence.map((item, index) => [evidenceId(item, index), item]));
  evidence.forEach((item, index) => validateEvidence(item, index, issues));

  const summaryOnlyEvidence = evidence.filter(isSummaryOnlyEvidence);
  const hasImplementationEvidence = evidence.some(hasCurrentImplementationEvidence);
  if (summaryOnlyEvidence.length > 0 && !hasImplementationEvidence) {
    issues.push(issue("summary_only_evidence_forbidden", "summary docs cannot be the only evidence", "evidence"));
  }
  if (!evidence.some(isPassingCloseoutEvidence)) {
    issues.push(issue("missing_current_closeout_evidence", "audit trial must include a passing current closeout command evidence", "evidence"));
  }

  const dimensions = asArray(artifact.dimensions);
  const dimensionsById = new Map(dimensions.map((dimension) => [normalizeString(dimension?.id || dimension?.dimension), dimension]));
  for (const required of AUDIT_SKILL_DIMENSIONS) {
    if (!dimensionsById.has(required)) {
      issues.push(issue("missing_required_dimension", `${required} must be audited or justified not_applicable`, "dimensions"));
    }
  }
  dimensions.forEach((dimension, index) => validateDimension(dimension, index, evidenceById, issues));

  const dimensionIds = new Set(dimensionsById.keys());
  const findings = asArray(artifact.findings);
  findings.forEach((finding, index) => validateFinding(finding, index, evidenceById, dimensionIds, issues));

  const highDefectCount = findings.filter((finding) => (
    normalizeString(finding?.type) === "明确缺陷" && ["高", "致命"].includes(normalizeString(finding?.severity))
  )).length;
  const blockingEvidenceGapCount = findings.filter((finding) => (
    normalizeString(finding?.type) === "证据缺口" && finding?.evidence_plan?.blocking_closure === true
  )).length;
  if (highDefectCount > 0 && normalizeString(artifact.final_verdict) !== "不通过") {
    issues.push(issue("high_defect_requires_fail_verdict", "high or fatal defects require final_verdict 不通过", "final_verdict"));
  }
  if (blockingEvidenceGapCount > 0 && normalizeString(artifact.final_verdict) !== "需补证") {
    issues.push(issue("blocking_evidence_gap_requires_evidence_verdict", "blocking evidence gaps require final_verdict 需补证", "final_verdict"));
  }

  const coverage = isObject(artifact.coverage_summary) ? artifact.coverage_summary : {};
  const covered = summaryNumber(coverage, "covered_dimensions_count");
  const justified = summaryNumber(coverage, "justified_not_applicable_count");
  const required = summaryNumber(coverage, "required_dimensions_count");
  if (required !== AUDIT_SKILL_DIMENSIONS.length) {
    issues.push(issue("invalid_required_dimension_count", "coverage_summary.required_dimensions_count is wrong", "coverage_summary.required_dimensions_count"));
  }
  if (required !== covered + justified) {
    issues.push(issue("dimension_coverage_mismatch", "required_dimensions_count must equal covered plus justified not_applicable", "coverage_summary"));
  }
  for (const field of [
    "findings_without_evidence_count",
    "defects_without_repair_schedule_count",
    "optional_without_decision_package_count"
  ]) {
    if (summaryNumber(coverage, field) !== 0) {
      issues.push(issue("coverage_summary_nonzero_gap", `${field} must be 0`, `coverage_summary.${field}`));
    }
  }

  return {
    gate_id: "audit-skill-trial-run",
    status: issues.length ? "fail" : "pass",
    version: artifact.version || null,
    project_root: artifact.project_root || null,
    final_verdict: artifact.final_verdict || null,
    required_dimensions_count: AUDIT_SKILL_DIMENSIONS.length,
    covered_dimensions_count: dimensions.filter((dimension) => normalizeString(dimension?.status) === "audited").length,
    finding_count: findings.length,
    evidence_count: evidence.length,
    issues
  };
}
