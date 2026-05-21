import { buildModelCollaborationPlan } from "./model-router.js";

const APPROVED_MOCK_REVIEWER_PROFILE = "approved_mock_non_dry_run";
const APPROVED_BOUNDED_REAL_REVIEWER_PROFILE = "approved_bounded_real_reviewer";

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeToken(value) {
  return normalizeString(value).toLowerCase();
}

function issue(code, message, path) {
  return { code, message, path };
}

function hasMockOutput(input = {}) {
  return Boolean(normalizeString(input.reviewer_mock_status || input.reviewerMockStatus) ||
    normalizeString(input.reviewer_mock_findings_json || input.reviewerMockFindingsJson));
}

function latestProviderHealthFact(workflowState = {}) {
  const events = Array.isArray(workflowState?.manifest?.events)
    ? workflowState.manifest.events.filter((event) => event?.type === "reviewer_provider_health")
    : [];
  return events.at(-1)?.metadata || null;
}

function numberValue(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function boundedTimeout(value) {
  const timeout = numberValue(value ?? 90);
  if (timeout === null || timeout < 30 || timeout > 120) {
    return {
      value: null,
      issues: [issue("invalid_reviewer_timeout", "real reviewer timeout_seconds must be between 30 and 120", "timeout_seconds")]
    };
  }
  return { value: timeout, issues: [] };
}

function modelRoutingPlan(input = {}) {
  return buildModelCollaborationPlan({
    goal: "projected next-action reviewer shard execution",
    stage: "review",
    risk: normalizeToken(input.risk || input.risk_level || "medium"),
    budget_tier: normalizeToken(input.budget_tier || "medium"),
    tags: ["independent_review", "code_audit", "boundary_sensitive"]
  });
}

export function evaluateReviewerExecutionPolicy(input = {}) {
  const profile = normalizeToken(input.execution_profile || input.executionProfile || APPROVED_MOCK_REVIEWER_PROFILE);
  const mockOutput = hasMockOutput(input);

  if (profile === APPROVED_MOCK_REVIEWER_PROFILE) {
    if (!mockOutput) {
      return {
        status: "fail",
        execution_mode: "blocked",
        profile,
        issues: [issue("missing_mock_reviewer_output", "approved mock reviewer profile requires reviewer_mock_status or reviewer_mock_findings_json", "reviewer_mock_status")]
      };
    }
    return {
      status: "pass",
      execution_mode: "mocked",
      profile,
      controls: {
        executor_mode: "mock",
        max_external_reviewer_calls: 0,
        provider_cost_mode: "mocked",
        timeout_seconds: null,
        model_routing: null
      },
      issues: []
    };
  }

  if (profile !== APPROVED_BOUNDED_REAL_REVIEWER_PROFILE) {
    return {
      status: "fail",
      execution_mode: "blocked",
      profile,
      issues: [issue("unsupported_reviewer_execution_profile", "reviewer execution_profile is not supported", "execution_profile")]
    };
  }

  const issues = [];
  if (mockOutput) {
    issues.push(issue("mock_output_for_real_reviewer", "bounded real reviewer profile must not include mock reviewer output", "reviewer_mock_status"));
  }

  const maxExternalReviewerCalls = numberValue(input.max_external_reviewer_calls ?? input.maxExternalReviewerCalls ?? 1);
  if (maxExternalReviewerCalls !== 1) {
    issues.push(issue("invalid_real_reviewer_budget", "bounded real reviewer profile currently allows exactly one external reviewer call per projected action", "max_external_reviewer_calls"));
  }

  const providerCostMode = normalizeToken(input.provider_cost_mode || input.providerCostMode || "bounded");
  if (providerCostMode !== "bounded") {
    issues.push(issue("invalid_real_reviewer_cost_mode", "bounded real reviewer profile requires provider_cost_mode=bounded", "provider_cost_mode"));
  }

  const timeout = boundedTimeout(input.timeout_seconds ?? input.timeoutSeconds ?? 90);
  issues.push(...timeout.issues);
  const routing = modelRoutingPlan(input);
  issues.push(...(routing.issues || []));

  return {
    status: issues.length ? "fail" : "pass",
    execution_mode: issues.length ? "blocked" : "bounded_real_reviewer",
    profile,
    controls: {
      executor_mode: "claude_deepseek",
      max_external_reviewer_calls: maxExternalReviewerCalls,
      provider_cost_mode: providerCostMode,
      timeout_seconds: timeout.value,
      model_routing: {
        selected_model: routing.selected_model || null,
        preferred_model: routing.preferred_model || null,
        roles: routing.roles || []
      }
    },
    issues
  };
}

export function evaluateReviewerProviderHealthPreflight(workflowState = {}, policy = {}) {
  if (policy?.controls?.executor_mode !== "claude_deepseek") {
    return { status: "pass", issues: [] };
  }

  const health = latestProviderHealthFact(workflowState);
  if (!health) {
    return {
      status: "fail",
      issues: [issue("reviewer_provider_health_preflight_required", "bounded real reviewer profile requires a latest healthy provider health fact", "manifest.events")]
    };
  }

  if (normalizeToken(health.provider_health) !== "healthy" || normalizeToken(health.recovery_status) === "blocked") {
    return {
      status: "fail",
      issues: [issue("reviewer_provider_unhealthy", "bounded real reviewer profile cannot run while provider health is not healthy", "reviewer_provider_health.provider_health")]
    };
  }

  return { status: "pass", issues: [] };
}

export {
  APPROVED_MOCK_REVIEWER_PROFILE,
  APPROVED_BOUNDED_REAL_REVIEWER_PROFILE
};
