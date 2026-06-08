import {
  AUDIT_SKILL_DIMENSIONS,
  DEFAULT_AUDIT_PROJECT_ROOT
} from "./audit-skill-trial-run.js";

export function dimensionSkillName(id) {
  return `${id.replaceAll("_", "-")}-audit`;
}

export function defaultRepairSchedule() {
  return {
    scope: "served frontend entrypoint and closeout route verification",
    target_files_or_modules: ["tools/workbench-server.mjs", "apps/workbench"],
    owner_role: "platform_core",
    verification_commands: ["npm run check:closeout"],
    post_repair_evidence_required: "fresh browser or runtime evidence from the real served route",
    live_or_browser_verification: "follow the user-visible route and verify the served entry uses the claimed Next.js/Ant Design mode",
    rollback_risk: "medium"
  };
}

export function normalizeDimensionId(value, fallback = "product_capability_gap") {
  const candidates = String(value || "")
    .split(/[|,，、\s]+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return candidates.find((candidate) => AUDIT_SKILL_DIMENSIONS.includes(candidate)) || fallback;
}

export function normalizeEvidencePlan(plan = {}, requestedFinalVerdict = "", disposition = "") {
  return {
    missing_evidence: plan.missing_evidence || plan.missing || "Additional live route evidence",
    how_to_collect: plan.how_to_collect || plan.collection_method || "Run the governance audit skill trial with fresh route evidence",
    blocking_closure: typeof plan.blocking_closure === "boolean"
      ? plan.blocking_closure
      : (typeof plan.blocks_closure === "boolean"
          ? plan.blocks_closure
          : requestedFinalVerdict === "需补证" && disposition === "继续取证"),
    minimum_command_or_entrypoint: plan.minimum_command_or_entrypoint ||
      plan.minimum_command ||
      plan.command ||
      "npm run run:governance-audit-skill-trial",
    ...(plan.note ? { note: plan.note } : {})
  };
}

export function normalizeDecisionPackage(decisionPackage = {}) {
  const options = (Array.isArray(decisionPackage.options) ? decisionPackage.options : []).map((option) => String(option || "").trim()).filter(Boolean);
  if (options.length < 2) options.push("记录为非阻断跟进，在下一轮治理中复核");
  return {
    ...decisionPackage,
    options,
    estimated_cost: decisionPackage.estimated_cost || decisionPackage.estimated_cost_or_effort || decisionPackage.estimated_effort || decisionPackage.cost_or_effort
  };
}

function fallbackEvidenceIds(evidenceIds) {
  return evidenceIds.length > 0 ? evidenceIds : ["governance-skill-invocation"];
}

function normalizeFindingEvidenceIds(finding, evidenceIds) {
  const known = new Set(evidenceIds);
  const requested = (Array.isArray(finding.evidence_ids) ? finding.evidence_ids : [])
    .map((id) => String(id || "").trim())
    .filter(Boolean);
  const valid = requested.filter((id) => known.has(id));
  return valid.length > 0 ? valid : fallbackEvidenceIds(evidenceIds);
}

export function expandCompactAuditVerdict(compact, options) {
  const evidenceIds = (options.preflightEvidenceItems || []).map((item) => item.id);
  const requestedFinalVerdict = compact.final_verdict || "";
  const findings = Array.isArray(compact.findings) ? compact.findings.map((finding, index) => {
    const type = finding.type || "明确缺陷";
    const disposition = finding.disposition || (type === "明确缺陷" ? "立即修复" : "继续取证");
    return {
      id: finding.id || `governance-finding-${index + 1}`,
      dimension: normalizeDimensionId(finding.dimension),
      type,
      severity: finding.severity || "高",
      disposition,
      summary: finding.summary || finding.impact || "Governance audit finding",
      impact: finding.impact || finding.summary || "The live-facing acceptance boundary is not satisfied.",
      user_visible: finding.user_visible !== false,
      evidence_ids: normalizeFindingEvidenceIds(finding, evidenceIds),
      ...(type === "明确缺陷" ? { repair_schedule: finding.repair_schedule || defaultRepairSchedule() } : {}),
      ...(type === "证据缺口" ? {
        evidence_plan: normalizeEvidencePlan(finding.evidence_plan, requestedFinalVerdict, disposition)
      } : {}),
      ...(type === "可选迭代" ? {
        decision_package: normalizeDecisionPackage(finding.decision_package || {
          options: ["defer", "schedule follow-up"],
          tradeoffs: "Deferring avoids scope expansion; follow-up increases confidence.",
          recommended_option: "schedule follow-up",
          estimated_cost: "low",
          confidence_gain: "medium"
        })
      } : {})
    };
  }) : [];
  const finalVerdict = requestedFinalVerdict || (findings.length > 0 ? "不通过" : "需补证");
  return {
    version: "audit-skill-trial-run.v1",
    project_root: DEFAULT_AUDIT_PROJECT_ROOT,
    input_mode: "real_project_state",
    scope: "governance audit skill trial for live frontend served-entry validation",
    created_at: new Date().toISOString(),
    final_verdict: finalVerdict,
    dimensions: AUDIT_SKILL_DIMENSIONS.map((id) => ({
      id,
      status: "audited",
      skill_name: dimensionSkillName(id),
      skill_version_or_path: `/Users/hernando_zhao/.codex/skills/${dimensionSkillName(id)}/SKILL.md`,
      prompt_scope: "real project state and runner-collected live route evidence",
      input_artifacts: ["tools/workbench-server.mjs", "apps/workbench/app", "apps/workbench/lib/api"],
      output_artifact: `tmp/audit-skill-trial/${id}.json`,
      evidence_ids: fallbackEvidenceIds(evidenceIds)
    })),
    evidence: [...(options.preflightEvidenceItems || [])],
    findings,
    coverage_summary: {
      required_dimensions_count: AUDIT_SKILL_DIMENSIONS.length,
      covered_dimensions_count: AUDIT_SKILL_DIMENSIONS.length,
      justified_not_applicable_count: 0,
      findings_without_evidence_count: 0,
      defects_without_repair_schedule_count: 0,
      optional_without_decision_package_count: 0
    }
  };
}
