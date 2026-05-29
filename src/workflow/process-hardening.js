import { FINDING_PASS_SYNONYMS, FINDING_FAIL_SYNONYMS } from "./status-vocabulary.js";

const FINDING_PASS_STATUSES = new Set(FINDING_PASS_SYNONYMS);
const FINDING_FAIL_STATUSES = new Set(FINDING_FAIL_SYNONYMS);

const HARDENING_SEVERITIES = new Set(["p0", "p1", "critical", "blocker", "fatal"]);
const HARDENING_CATEGORIES = new Set([
  "false_success",
  "state_persistence",
  "process_gap",
  "flow_gap",
  "continuation_gap",
  "host_boundary",
  "owned_files",
  "quality_gate_gap"
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeToken(value) {
  return normalizeString(value).toLowerCase();
}

function findingId(finding, index) {
  return normalizeString(finding.finding_id || finding.id || finding.code || finding.title) || `finding-${index + 1}`;
}

function findingStatus(finding) {
  const status = normalizeToken(finding.status || finding.result || finding.outcome);
  if (FINDING_PASS_STATUSES.has(status)) return "pass";
  if (FINDING_FAIL_STATUSES.has(status)) return "fail";
  return status || "fail";
}

function findingSeverity(finding) {
  return normalizeToken(finding.severity || finding.level || "medium");
}

function findingCategory(finding) {
  return normalizeToken(finding.category || finding.type || finding.code || "reviewer");
}

function hardeningRequired(finding) {
  const category = findingCategory(finding);
  const severity = findingSeverity(finding);
  return Boolean(
    findingStatus(finding) === "fail" &&
      (finding.process_hardening_required ||
        HARDENING_SEVERITIES.has(severity) ||
        HARDENING_CATEGORIES.has(category))
  );
}

function defaultInvariant(finding, id) {
  if (finding.invariant) return normalizeString(finding.invariant);
  const message = normalizeString(finding.message || finding.summary || finding.title);
  return message ? `Prevent recurrence of ${id}: ${message}` : `Prevent recurrence of ${id}`;
}

function evidenceIssues(item, index) {
  const prefix = `items.${index}`;
  const issues = [];
  if (!normalizeString(item.finding_id)) issues.push({ code: "missing_finding_id", path: `${prefix}.finding_id` });
  if (!normalizeString(item.invariant)) issues.push({ code: "missing_invariant", path: `${prefix}.invariant` });
  if (!normalizeString(item.enforcement_target)) {
    issues.push({ code: "missing_enforcement_target", path: `${prefix}.enforcement_target` });
  }
  if (!normalizeString(item.regression_test)) issues.push({ code: "missing_regression_test", path: `${prefix}.regression_test` });
  if (!normalizeString(item.verification)) issues.push({ code: "missing_verification", path: `${prefix}.verification` });
  if (normalizeToken(item.status) !== "completed") issues.push({ code: "hardening_not_completed", path: `${prefix}.status` });
  return issues;
}

export function findingsRequiringProcessHardening(findings = []) {
  return asArray(findings).filter(hardeningRequired);
}

export function createProcessHardeningPlan(input = {}) {
  const findings = findingsRequiringProcessHardening(input.findings || input.review_findings);
  return {
    run_id: normalizeString(input.run_id),
    cycle_id: normalizeString(input.cycle_id),
    status: findings.length > 0 ? "pending" : "pass",
    items: findings.map((finding, index) => {
      const id = findingId(finding, index);
      return {
        id: `process-hardening-${id}`,
        finding_id: id,
        category: findingCategory(finding),
        severity: findingSeverity(finding),
        invariant: defaultInvariant(finding, id),
        enforcement_target: normalizeString(finding.enforcement_target),
        regression_test: normalizeString(finding.regression_test),
        verification: normalizeString(finding.verification),
        status: normalizeString(finding.hardening_status) || "pending"
      };
    })
  };
}

export function evaluateProcessHardening(input = {}) {
  const requiredFindings = findingsRequiringProcessHardening(input.findings || input.review_findings);
  const items = asArray(input.items || input.hardening_items || input.plan?.items);
  const issues = [];
  let completedCount = 0;

  for (const finding of requiredFindings) {
    const id = findingId(finding, requiredFindings.indexOf(finding));
    const item = items.find((candidate) => normalizeString(candidate.finding_id) === id);
    if (!item) {
      issues.push({ code: "missing_process_hardening", path: id, message: `process hardening is required for ${id}` });
      continue;
    }
    const itemIssues = evidenceIssues(item, items.indexOf(item));
    if (itemIssues.length === 0) completedCount += 1;
    issues.push(...itemIssues);
  }

  return {
    gate_id: "process-hardening",
    status: issues.length > 0 ? "fail" : "pass",
    required_count: requiredFindings.length,
    completed_count: completedCount,
    issues
  };
}

export { HARDENING_CATEGORIES, HARDENING_SEVERITIES };
