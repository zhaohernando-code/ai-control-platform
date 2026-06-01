import { readFileSync } from "node:fs";

const VALID_STATUSES = new Set([
  "open",
  "in_progress",
  "fixed",
  "invalidated",
  "deferred",
  "blocked",
  "requires_owner_authorization"
]);

const VALID_SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const EVIDENCE_TYPES = new Set(["command", "test", "build", "coverage", "live_check", "review", "analysis", "artifact"]);
const VERIFICATION_EVIDENCE_TYPES = new Set(["command", "test", "build", "coverage", "live_check"]);

function issue(code, message, path = "") {
  return { code, message, path };
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmptyString);
}

function parseTime(value) {
  if (!nonEmptyString(value)) return NaN;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : NaN;
}

function hasEvidence(risk, predicate = () => true) {
  return asArray(risk.evidence).some((entry) => isObject(entry) && predicate(entry));
}

function reviewerBlockingFindings(risk) {
  return asArray(risk.review?.reviewers)
    .flatMap((reviewer) => asArray(reviewer?.blocking_findings).filter(nonEmptyString));
}

function validateRequiredRiskFields(risk, index) {
  const path = `risks[${index}]`;
  const issues = [];
  for (const field of [
    "id",
    "title",
    "source",
    "created_at",
    "updated_at",
    "status",
    "severity",
    "scope",
    "owned_files",
    "acceptance_gates",
    "attempted_count",
    "evidence"
  ]) {
    if (!(field in risk)) {
      issues.push(issue("risk_missing_required_field", `${field} is required`, `${path}.${field}`));
    }
  }
  if (!nonEmptyString(risk.id) || !risk.id.startsWith("risk-")) {
    issues.push(issue("invalid_risk_id", "risk id must be a non-empty risk-* string", `${path}.id`));
  }
  if (!VALID_STATUSES.has(risk.status)) {
    issues.push(issue("invalid_risk_status", `unknown risk status ${risk.status}`, `${path}.status`));
  }
  if (!VALID_SEVERITIES.has(risk.severity)) {
    issues.push(issue("invalid_risk_severity", `unknown risk severity ${risk.severity}`, `${path}.severity`));
  }
  for (const arrayField of ["scope", "owned_files", "acceptance_gates"]) {
    if (!validStringArray(risk[arrayField])) {
      issues.push(issue("invalid_risk_string_array", `${arrayField} must contain at least one non-empty string`, `${path}.${arrayField}`));
    }
  }
  if (!Number.isInteger(risk.attempted_count) || risk.attempted_count < 0) {
    issues.push(issue("invalid_attempted_count", "attempted_count must be a non-negative integer", `${path}.attempted_count`));
  }
  if (!Array.isArray(risk.evidence)) {
    issues.push(issue("invalid_risk_evidence", "evidence must be an array", `${path}.evidence`));
  } else {
    risk.evidence.forEach((entry, evidenceIndex) => {
      if (!isObject(entry)) {
        issues.push(issue("invalid_risk_evidence", "evidence entry must be an object", `${path}.evidence[${evidenceIndex}]`));
        return;
      }
      if (!EVIDENCE_TYPES.has(entry.type)) {
        issues.push(issue("invalid_evidence_type", `unknown evidence type ${entry.type}`, `${path}.evidence[${evidenceIndex}].type`));
      }
      if (!nonEmptyString(entry.summary)) {
        issues.push(issue("missing_evidence_summary", "evidence summary is required", `${path}.evidence[${evidenceIndex}].summary`));
      }
    });
  }
  return issues;
}

function validateTerminalStatus(risk, index, options) {
  const path = `risks[${index}]`;
  const issues = [];
  if (options.requireClosed === true && ["open", "in_progress"].includes(risk.status)) {
    issues.push(issue("risk_not_closed", `${risk.id} is ${risk.status}`, `${path}.status`));
  }

  if (risk.status === "fixed") {
    if (!nonEmptyString(risk.resolution?.fixed_by_commit)) {
      issues.push(issue("fixed_risk_missing_commit", "fixed risk requires resolution.fixed_by_commit", `${path}.resolution.fixed_by_commit`));
    }
    if (!hasEvidence(risk, (entry) => VERIFICATION_EVIDENCE_TYPES.has(entry.type))) {
      issues.push(issue("fixed_risk_missing_verification", "fixed risk requires command, test, build, coverage, or live_check evidence", `${path}.evidence`));
    }
    const blockingFindings = reviewerBlockingFindings(risk);
    if (blockingFindings.length > 0) {
      issues.push(issue("fixed_risk_has_blocking_review_findings", "fixed risk has blocking reviewer findings", `${path}.review.reviewers`));
    }
  }

  if (risk.status === "invalidated" && !hasEvidence(risk, (entry) => ["analysis", "review", "artifact"].includes(entry.type))) {
    issues.push(issue("invalidated_risk_missing_evidence", "invalidated risk requires analysis, review, or artifact evidence", `${path}.evidence`));
  }

  if (risk.status === "deferred") {
    if (risk.severity === "critical") {
      issues.push(issue("critical_risk_deferred", "critical risks cannot be deferred by default", `${path}.status`));
    }
    if (!isObject(risk.deferral)) {
      issues.push(issue("deferred_risk_missing_deferral", "deferred risk requires deferral details", `${path}.deferral`));
    } else {
      if (!nonEmptyString(risk.deferral.deferred_until)) {
        issues.push(issue("deferred_risk_missing_until", "deferred risk requires deferred_until", `${path}.deferral.deferred_until`));
      } else if (parseTime(risk.deferral.deferred_until) < options.now.getTime()) {
        issues.push(issue("deferred_risk_expired", "deferred risk is past deferred_until", `${path}.deferral.deferred_until`));
      }
      if (!nonEmptyString(risk.deferral.deferral_reason)) {
        issues.push(issue("deferred_risk_missing_reason", "deferred risk requires deferral_reason", `${path}.deferral.deferral_reason`));
      }
      if (!Number.isInteger(risk.deferral.deferral_count) || risk.deferral.deferral_count < 0) {
        issues.push(issue("deferred_risk_invalid_count", "deferred risk requires non-negative deferral_count", `${path}.deferral.deferral_count`));
      }
      if (risk.deferral.deferral_count > 3) {
        issues.push(issue("deferred_risk_too_many_deferrals", "deferred risk exceeded the deferral count limit", `${path}.deferral.deferral_count`));
      }
    }
  }

  if (risk.status === "blocked") {
    if (!isObject(risk.blockage)) {
      issues.push(issue("blocked_risk_missing_blockage", "blocked risk requires blockage details", `${path}.blockage`));
    } else {
      if (!nonEmptyString(risk.blockage.blocker_description)) {
        issues.push(issue("blocked_risk_missing_description", "blocked risk requires blocker_description", `${path}.blockage.blocker_description`));
      }
      if (!validStringArray(risk.blockage.recovery_conditions)) {
        issues.push(issue("blocked_risk_missing_recovery", "blocked risk requires recovery_conditions", `${path}.blockage.recovery_conditions`));
      }
      if (!nonEmptyString(risk.blockage.last_condition_check)) {
        issues.push(issue("blocked_risk_missing_last_check", "blocked risk requires last_condition_check", `${path}.blockage.last_condition_check`));
      }
    }
  }

  if (risk.status === "requires_owner_authorization" && !hasEvidence(risk)) {
    issues.push(issue("authorization_risk_missing_evidence", "requires_owner_authorization risk requires evidence", `${path}.evidence`));
  }

  return issues;
}

function dependencyIssues(risks) {
  const issues = [];
  const ids = new Set(risks.map((risk) => risk.id).filter(nonEmptyString));
  for (const risk of risks) {
    for (const dependency of asArray(risk.depends_on)) {
      if (!ids.has(dependency)) {
        issues.push(issue("unknown_risk_dependency", `${risk.id} depends on unknown risk ${dependency}`, risk.id));
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(risks.map((risk) => [risk.id, risk]));
  function visit(id, stack = []) {
    if (visiting.has(id)) {
      issues.push(issue("cyclic_risk_dependency", `risk dependency cycle: ${[...stack, id].join(" -> ")}`, id));
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of asArray(byId.get(id)?.depends_on)) {
      if (byId.has(dependency)) visit(dependency, [...stack, id]);
    }
    visiting.delete(id);
    visited.add(id);
  }
  for (const risk of risks) {
    if (nonEmptyString(risk.id)) visit(risk.id);
  }
  return issues;
}

export function readKnownRiskLedger(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function evaluateKnownRiskLedger(ledger = {}, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const requireClosed = options.requireClosed === true;
  const issues = [];
  if (!isObject(ledger)) {
    return {
      version: "known-risk-closeout-check.v1",
      status: "fail",
      issues: [issue("invalid_known_risk_ledger", "ledger must be an object")],
      risk_count: 0,
      open_count: 0,
      terminal_count: 0
    };
  }

  if (ledger.version !== "known-risk-ledger.v1") {
    issues.push(issue("invalid_known_risk_ledger_version", "ledger.version must be known-risk-ledger.v1", "version"));
  }
  if (!Array.isArray(ledger.risks)) {
    issues.push(issue("invalid_known_risk_ledger_risks", "ledger.risks must be an array", "risks"));
  }

  const risks = asArray(ledger.risks);
  const seen = new Set();
  risks.forEach((risk, index) => {
    if (!isObject(risk)) {
      issues.push(issue("invalid_known_risk_entry", "risk entry must be an object", `risks[${index}]`));
      return;
    }
    if (seen.has(risk.id)) {
      issues.push(issue("duplicate_risk_id", `duplicate risk id ${risk.id}`, `risks[${index}].id`));
    }
    seen.add(risk.id);
    issues.push(...validateRequiredRiskFields(risk, index));
    issues.push(...validateTerminalStatus(risk, index, { now, requireClosed }));
  });
  issues.push(...dependencyIssues(risks.filter(isObject)));

  const openCount = risks.filter((risk) => ["open", "in_progress"].includes(risk?.status)).length;
  const terminalCount = risks.filter((risk) => ["fixed", "invalidated", "deferred", "blocked", "requires_owner_authorization"].includes(risk?.status)).length;
  return {
    version: "known-risk-closeout-check.v1",
    status: issues.length > 0 ? "fail" : "pass",
    require_closed: requireClosed,
    checked_at: now.toISOString(),
    risk_count: risks.length,
    open_count: openCount,
    terminal_count: terminalCount,
    issues
  };
}
