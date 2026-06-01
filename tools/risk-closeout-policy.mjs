import { readFileSync } from "node:fs";

import { evaluateKnownRiskLedger } from "./risk-ledger.mjs";

const VALID_POLICY_VERSION = "ai-governed-risk-closeout-policy.v1";
const VALID_SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const VALID_MAX_SEVERITIES = new Set(["critical", "high", "medium", "low", "none"]);
const SEVERITY_RANK = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};

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
  return Array.isArray(value) && value.every(nonEmptyString);
}

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function globToRegExp(pattern) {
  const escaped = normalizePath(pattern)
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function matchesPathRule(path, rule) {
  const normalizedPath = normalizePath(path);
  const normalizedRule = normalizePath(rule);
  if (normalizedRule.includes("*")) return globToRegExp(normalizedRule).test(normalizedPath);
  if (normalizedRule.endsWith("/")) return normalizedPath.startsWith(normalizedRule);
  return normalizedPath === normalizedRule;
}

function pathIsUnsafe(path) {
  const normalized = normalizePath(path);
  return normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../");
}

function changedFiles(input) {
  return asArray(input.changedFiles).map(normalizePath).filter(nonEmptyString);
}

function risks(input) {
  return asArray(input.risks).filter(isObject);
}

function policyIssueRequiresAuthorization(policy, policyIssue) {
  const tokens = asArray(policy?.owner_authorization_required_for).map((token) => token.toLowerCase());
  if (tokens.length === 0) return true;
  const text = `${policyIssue.code} ${policyIssue.message}`.toLowerCase();
  return tokens.some((token) => text.includes(token));
}

export function validateRiskCloseoutPolicy(policy) {
  const issues = [];
  if (!isObject(policy)) {
    return {
      status: "fail",
      issues: [issue("invalid_policy", "policy must be an object")]
    };
  }

  const requiredFields = [
    "version",
    "auto_merge",
    "auto_publish",
    "max_severity_auto_merge",
    "require_two_model_review_for",
    "require_live_verification_for_user_visible_changes",
    "max_files_changed",
    "max_lines_changed",
    "allowed_paths",
    "forbidden_paths",
    "rollback_on_live_failure",
    "stop_on_new_high_risk_discovery"
  ];
  const allowedFields = new Set([...requiredFields, "owner_authorization_required_for"]);
  for (const field of Object.keys(policy)) {
    if (!allowedFields.has(field)) {
      issues.push(issue("policy_unknown_field", `${field} is not allowed`, field));
    }
  }
  for (const field of requiredFields) {
    if (!(field in policy)) issues.push(issue("policy_missing_required_field", `${field} is required`, field));
  }
  if (policy.version !== VALID_POLICY_VERSION) {
    issues.push(issue("invalid_policy_version", `policy.version must be ${VALID_POLICY_VERSION}`, "version"));
  }
  for (const booleanField of [
    "auto_merge",
    "auto_publish",
    "require_live_verification_for_user_visible_changes",
    "rollback_on_live_failure",
    "stop_on_new_high_risk_discovery"
  ]) {
    if (typeof policy[booleanField] !== "boolean") {
      issues.push(issue("invalid_policy_boolean", `${booleanField} must be boolean`, booleanField));
    }
  }
  if (!VALID_MAX_SEVERITIES.has(policy.max_severity_auto_merge)) {
    issues.push(issue("invalid_policy_max_severity", "max_severity_auto_merge is invalid", "max_severity_auto_merge"));
  }
  for (const arrayField of ["require_two_model_review_for", "allowed_paths", "forbidden_paths", "owner_authorization_required_for"]) {
    if (arrayField in policy && !validStringArray(policy[arrayField])) {
      issues.push(issue("invalid_policy_string_array", `${arrayField} must be an array of non-empty strings`, arrayField));
    }
  }
  for (const integerField of ["max_files_changed", "max_lines_changed"]) {
    if (!Number.isInteger(policy[integerField]) || policy[integerField] < 1) {
      issues.push(issue("invalid_policy_limit", `${integerField} must be a positive integer`, integerField));
    }
  }

  return {
    status: issues.length > 0 ? "fail" : "pass",
    issues
  };
}

export function loadRiskCloseoutPolicy(path) {
  let policy;
  try {
    policy = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      status: "fail",
      policy: null,
      issues: [issue("policy_load_failed", error.message, path)]
    };
  }
  const validation = validateRiskCloseoutPolicy(policy);
  return {
    status: validation.status,
    policy: validation.status === "pass" ? policy : null,
    issues: validation.issues
  };
}

function mergePolicyIssues(policy, input = {}) {
  const issues = [];
  if (policy.auto_merge !== true) {
    issues.push(issue("auto_merge_disabled", "policy does not allow automatic merge", "auto_merge"));
  }

  const riskEntries = risks(input);
  const maxSeverity = policy.max_severity_auto_merge;
  for (const risk of riskEntries) {
    if (!VALID_SEVERITIES.has(risk.severity)) continue;
    if (SEVERITY_RANK[risk.severity] > SEVERITY_RANK[maxSeverity]) {
      issues.push(issue("severity_exceeds_auto_merge_policy", `${risk.id} severity ${risk.severity} exceeds ${maxSeverity}`, risk.id));
    }
  }

  const files = changedFiles(input);
  if (files.length > policy.max_files_changed) {
    issues.push(issue("changed_file_count_exceeds_policy", `${files.length} files exceed max ${policy.max_files_changed}`, "changedFiles"));
  }
  if (Number.isFinite(input.linesChanged) && input.linesChanged > policy.max_lines_changed) {
    issues.push(issue("changed_line_count_exceeds_policy", `${input.linesChanged} changed lines exceed max ${policy.max_lines_changed}`, "linesChanged"));
  }
  for (const file of files) {
    if (pathIsUnsafe(file)) {
      issues.push(issue("unsafe_changed_path", `${file} is not a safe repository-relative path`, file));
      continue;
    }
    if (!asArray(policy.allowed_paths).some((rule) => matchesPathRule(file, rule))) {
      issues.push(issue("changed_path_not_allowed", `${file} is outside allowed paths`, file));
    }
    if (asArray(policy.forbidden_paths).some((rule) => matchesPathRule(file, rule))) {
      issues.push(issue("changed_path_forbidden", `${file} matches a forbidden path`, file));
    }
  }

  if (policy.stop_on_new_high_risk_discovery === true && input.newHighRiskDiscovered === true) {
    issues.push(issue("new_high_risk_discovery", "new high-risk discovery stops automatic merge", "newHighRiskDiscovered"));
  }

  const ledger = {
    version: "known-risk-ledger.v1",
    updated_at: new Date(input.now || Date.now()).toISOString(),
    risks: riskEntries
  };
  const ledgerResult = evaluateKnownRiskLedger(ledger, {
    policy,
    requireClosed: true,
    now: input.now
  });
  for (const ledgerIssue of ledgerResult.issues) {
    issues.push(issue("closeout_gate_failed", ledgerIssue.message, ledgerIssue.path || ledgerIssue.code));
  }

  return issues;
}

function publishPolicyIssues(policy, input = {}) {
  const issues = [];
  if (policy.auto_publish !== true) {
    issues.push(issue("auto_publish_disabled", "policy does not allow automatic publish", "auto_publish"));
  }
  if (input.userVisibleChange === true && policy.require_live_verification_for_user_visible_changes === true) {
    const hasLiveEvidence = risks(input).some((risk) => (
      asArray(risk.evidence).some((entry) => entry?.type === "live_check")
    ));
    if (!hasLiveEvidence) {
      issues.push(issue("publish_missing_live_verification", "user-visible changes require live_check evidence", "risks[].evidence"));
    }
  }
  if (input.userVisibleChange === true) {
    const hasRollback = nonEmptyString(input.rollback_commit) ||
      nonEmptyString(input.rollback_procedure) ||
      risks(input).some((risk) => nonEmptyString(risk.release?.rollback_commit));
    if (!hasRollback) {
      issues.push(issue("publish_missing_rollback", "user-visible publish requires rollback commit or procedure", "rollback"));
    }
  }
  return issues;
}

export function evaluateRiskCloseoutPolicy(policy, input = {}) {
  const policyValidation = validateRiskCloseoutPolicy(policy);
  if (policyValidation.status !== "pass") {
    return {
      version: "risk-closeout-policy-decision.v1",
      status: "fail",
      merge_allowed: false,
      publish_allowed: false,
      owner_authorization_required: true,
      issues: policyValidation.issues
    };
  }

  const mergeIssues = mergePolicyIssues(policy, input);
  const publishIssues = publishPolicyIssues(policy, input);
  const issues = [...mergeIssues, ...publishIssues];
  const ownerAuthorizationRequired = issues.some((item) => policyIssueRequiresAuthorization(policy, item));
  return {
    version: "risk-closeout-policy-decision.v1",
    status: issues.length === 0 ? "pass" : (ownerAuthorizationRequired ? "requires_owner_authorization" : "fail"),
    merge_allowed: mergeIssues.length === 0,
    publish_allowed: publishIssues.length === 0,
    owner_authorization_required: ownerAuthorizationRequired,
    issues
  };
}

export function ownerAuthorizationStateForRisk(risk, decision, options = {}) {
  if (!isObject(risk) || !isObject(decision) || decision.owner_authorization_required !== true) return null;
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const issueCodes = asArray(decision.issues).map((item) => item.code).filter(nonEmptyString);
  return {
    ...risk,
    status: "requires_owner_authorization",
    updated_at: now.toISOString(),
    evidence: [
      ...asArray(risk.evidence),
      {
        type: "analysis",
        summary: `Policy owner authorization required: ${issueCodes.join(", ") || "policy exceeded"}`,
        created_at: now.toISOString()
      }
    ]
  };
}
