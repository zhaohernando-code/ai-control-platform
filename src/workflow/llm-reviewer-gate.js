const DEFAULT_PROVIDER = {
  provider: "claude-code",
  model: "deepseek-v4-pro",
  cost_tier: "medium",
  accuracy_tier: "high",
  tooling: "read-only"
};

const WRITE_CAPABLE_TOOLS = new Set([
  "bash",
  "edit",
  "write",
  "multiedit",
  "notebookedit",
  "server",
  "browser"
]);

const HUMAN_CATEGORIES = new Set(["credentials", "missing_credentials", "secrets", "requirements_conflict"]);
const ROLLBACK_CATEGORIES = new Set(["host_boundary", "owned_files", "security", "data_loss"]);
const CRITICAL_SEVERITIES = new Set(["critical", "fatal", "blocker", "p0", "p1"]);

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

function normalizeProvider(input = {}) {
  return {
    provider: normalizeString(input.provider) || DEFAULT_PROVIDER.provider,
    model: normalizeString(input.model) || DEFAULT_PROVIDER.model,
    cost_tier: normalizeString(input.cost_tier) || DEFAULT_PROVIDER.cost_tier,
    accuracy_tier: normalizeString(input.accuracy_tier) || DEFAULT_PROVIDER.accuracy_tier,
    tooling: normalizeString(input.tooling) || DEFAULT_PROVIDER.tooling
  };
}

function normalizeToolList(input) {
  if (Array.isArray(input)) return compactStrings(input).map(normalizeToken);
  return normalizeString(input)
    .split(",")
    .map(normalizeToken)
    .filter(Boolean);
}

function hasWriteCapableTool(request) {
  const tools = normalizeToolList(request.tools || request.allowed_tools || request.allowedTools);
  const tooling = normalizeToken(request.provider?.tooling || request.tooling);
  return tooling.includes("write") || tooling.includes("destructive") || tools.some((tool) => WRITE_CAPABLE_TOOLS.has(tool));
}

function findingId(finding, index) {
  return normalizeString(finding.finding_id || finding.id || finding.code || finding.title) || `review-finding-${index + 1}`;
}

function findingCategory(finding) {
  return normalizeToken(finding.category || finding.type || finding.code || "reviewer");
}

function findingSeverity(finding) {
  return normalizeToken(finding.severity || finding.level || "medium");
}

function findingStatus(finding) {
  const status = normalizeToken(finding.status || finding.result || finding.outcome);
  if (["pass", "passed", "ok", "success", "succeeded"].includes(status)) return "pass";
  if (["fail", "failed", "error", "blocked"].includes(status)) return "fail";
  return status || "fail";
}

function requiresHuman(finding) {
  const category = findingCategory(finding);
  const code = normalizeToken(finding.code);
  return Boolean(
    finding.requires_human ||
      finding.requiresHuman ||
      finding.missing_credentials ||
      HUMAN_CATEGORIES.has(category) ||
      HUMAN_CATEGORIES.has(code)
  );
}

function requiresRollback(finding) {
  const category = findingCategory(finding);
  const code = normalizeToken(finding.code);
  const severity = findingSeverity(finding);
  return Boolean(
    finding.requires_rollback ||
      finding.requiresRollback ||
      ROLLBACK_CATEGORIES.has(category) ||
      ROLLBACK_CATEGORIES.has(code) ||
      CRITICAL_SEVERITIES.has(severity)
  );
}

function severityRank(severity) {
  return {
    info: 1,
    low: 2,
    medium: 3,
    high: 4,
    p1: 5,
    critical: 6,
    blocker: 7,
    fatal: 8,
    p0: 9
  }[normalizeToken(severity)] || 0;
}

function maxSeverity(findings) {
  return asArray(findings).reduce((max, finding) => {
    const severity = findingSeverity(finding);
    return severityRank(severity) > severityRank(max) ? severity : max;
  }, "none");
}

export function createReviewerGateRequest(input = {}) {
  return {
    run_id: normalizeString(input.run_id),
    cycle_id: normalizeString(input.cycle_id),
    provider: normalizeProvider(input.provider || input),
    scope: normalizeString(input.scope),
    files: compactStrings(input.files),
    questions: compactStrings(input.questions),
    forbidden_actions: compactStrings(input.forbidden_actions || input.forbiddenActions),
    output_contract: normalizeString(input.output_contract || input.outputContract) ||
      "Return structured findings with severity, category, message, evidence, requires_rollback, and requires_human.",
    read_only: input.read_only !== false,
    allowed_tools: normalizeToolList(input.allowed_tools || input.allowedTools || "Read,Grep,Glob")
  };
}

export function validateReviewerGateRequest(request) {
  const issues = [];

  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return {
      status: "fail",
      issues: [issue("invalid_reviewer_gate_request", "reviewer gate request must be an object", "")]
    };
  }

  for (const field of ["run_id", "cycle_id", "scope", "output_contract"]) {
    if (!normalizeString(request[field])) {
      issues.push(issue("missing_required_field", `${field} is required`, field));
    }
  }

  if (!Array.isArray(request.files) || request.files.length === 0) {
    issues.push(issue("missing_files", "reviewer gate must declare files", "files"));
  }

  if (!Array.isArray(request.questions) || request.questions.length === 0) {
    issues.push(issue("missing_questions", "reviewer gate must declare questions", "questions"));
  }

  if (request.read_only !== true) {
    issues.push(issue("reviewer_not_read_only", "external reviewer gate must be read-only by default", "read_only"));
  }

  if (hasWriteCapableTool(request)) {
    issues.push(issue("write_capable_tooling_forbidden", "reviewer gate cannot allow write-capable or destructive tools", "allowed_tools"));
  }

  return {
    status: issues.length ? "fail" : "pass",
    issues
  };
}

export function normalizeReviewerFindings(findings, request = {}) {
  const provider = normalizeProvider(request.provider || request);
  return asArray(findings).map((finding, index) => {
    const category = findingCategory(finding);
    const severity = findingSeverity(finding);

    return {
      finding_id: findingId(finding, index),
      status: findingStatus(finding),
      category,
      severity,
      message: normalizeString(finding.message || finding.summary || finding.title) || "reviewer finding",
      requires_rollback: requiresRollback(finding),
      requires_human: requiresHuman(finding),
      evidence: finding.evidence || null,
      provider: provider.provider,
      model: provider.model
    };
  });
}

export function createReviewerTimeoutFinding(request = {}, timeoutSeconds = null) {
  const reviewerRequest = createReviewerGateRequest(request);
  const timeoutText = timeoutSeconds ? ` after ${timeoutSeconds}s` : "";

  return normalizeReviewerFindings(
    [
      {
        id: `${reviewerRequest.run_id || "run"}-reviewer-timeout`,
        status: "fail",
        category: "reviewer_timeout",
        severity: "medium",
        message: `External reviewer gate timed out${timeoutText}; schedule a bounded rerun or model downgrade.`,
        evidence: {
          provider: reviewerRequest.provider.provider,
          model: reviewerRequest.provider.model,
          timeout_seconds: timeoutSeconds
        }
      }
    ],
    reviewerRequest
  )[0];
}

export function summarizeReviewerGate(input = {}) {
  const request = input.request ? createReviewerGateRequest(input.request) : createReviewerGateRequest(input);
  const findings = normalizeReviewerFindings(input.findings || input.review_findings, request);
  const failedFindings = findings.filter((finding) => finding.status === "fail");
  const humanFindings = findings.filter((finding) => finding.requires_human);
  const rollbackFindings = findings.filter((finding) => finding.requires_rollback);
  let recommendedDecisionSignal = "pass";

  if (humanFindings.length > 0) {
    recommendedDecisionSignal = "human_intervention";
  } else if (rollbackFindings.length > 0) {
    recommendedDecisionSignal = "rollback";
  } else if (failedFindings.length > 0) {
    recommendedDecisionSignal = "rerun";
  }

  return {
    run_id: request.run_id || null,
    cycle_id: request.cycle_id || null,
    provider: request.provider.provider,
    model: request.provider.model,
    status: failedFindings.length > 0 ? "fail" : "pass",
    counts: {
      total: findings.length,
      passed: findings.filter((finding) => finding.status === "pass").length,
      failed: failedFindings.length,
      rollback: rollbackFindings.length,
      human: humanFindings.length
    },
    max_severity: maxSeverity(findings),
    recommended_decision_signal: recommendedDecisionSignal
  };
}

export { DEFAULT_PROVIDER, WRITE_CAPABLE_TOOLS };
