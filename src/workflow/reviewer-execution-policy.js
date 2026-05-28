import { buildModelCollaborationPlan } from "./model-router.js";

const APPROVED_MOCK_REVIEWER_PROFILE = "approved_mock_non_dry_run";
const APPROVED_BOUNDED_REAL_REVIEWER_PROFILE = "approved_bounded_real_reviewer";
const MAX_EXPANDED_REVIEWER_WALL_CLOCK_SECONDS = 240;

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

function normalizeTokenList(input) {
  if (Array.isArray(input)) return input.map(normalizeToken).filter(Boolean);
  return normalizeString(input)
    .split(",")
    .map(normalizeToken)
    .filter(Boolean);
}

function dsParticipationMode(input = {}) {
  const explicit = normalizeToken(
    input.ds_participation_mode ||
      input.dsParticipationMode ||
      input.model_routing_strategy ||
      input.modelRoutingStrategy ||
      input.routing_strategy ||
      input.routingStrategy
  );
  if (["expanded", "ds_expanded", "ds_first", "ds-first", "cost_saving", "cost-sensitive"].includes(explicit)) return "expanded";
  return "balanced";
}

function maxRealReviewerCallsFor(input = {}) {
  return dsParticipationMode(input) === "expanded" ? 2 : 1;
}

function boundedTimeout(value, input = {}) {
  const timeout = numberValue(value ?? 90);
  const maxTimeout = dsParticipationMode(input) === "expanded" ? 150 : 120;
  if (timeout === null || timeout < 30 || timeout > maxTimeout) {
    return {
      value: null,
      issues: [issue("invalid_reviewer_timeout", `real reviewer timeout_seconds must be between 30 and ${maxTimeout}`, "timeout_seconds")]
    };
  }
  return { value: timeout, issues: [] };
}

function modelRoutingPlan(input = {}) {
  const tags = [
    "independent_review",
    "code_audit",
    "boundary_sensitive",
    ...normalizeTokenList(input.tags || input.capabilities)
  ];
  if (dsParticipationMode(input) === "expanded") tags.push("codex_plan_pressure");

  return buildModelCollaborationPlan({
    goal: "projected next-action reviewer shard execution",
    stage: "review",
    risk: normalizeToken(input.risk || input.risk_level || "medium"),
    budget_tier: normalizeToken(input.budget_tier || "medium"),
    model_routing_strategy: dsParticipationMode(input) === "expanded" ? "ds_expanded" : "balanced",
    ds_ratio_boost: input.ds_ratio_boost || input.dsRatioBoost,
    tags
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

  const maxAllowedReviewerCalls = maxRealReviewerCallsFor(input);
  const maxExternalReviewerCalls = numberValue(input.max_external_reviewer_calls ?? input.maxExternalReviewerCalls ?? 1);
  if (maxExternalReviewerCalls === null || maxExternalReviewerCalls < 1 || maxExternalReviewerCalls > maxAllowedReviewerCalls) {
    issues.push(issue(
      "invalid_real_reviewer_budget",
      `bounded real reviewer profile allows 1-${maxAllowedReviewerCalls} external reviewer call(s) for the current DS participation mode`,
      "max_external_reviewer_calls"
    ));
  }

  const providerCostMode = normalizeToken(input.provider_cost_mode || input.providerCostMode || "bounded");
  if (providerCostMode !== "bounded") {
    issues.push(issue("invalid_real_reviewer_cost_mode", "bounded real reviewer profile requires provider_cost_mode=bounded", "provider_cost_mode"));
  }

  const timeout = boundedTimeout(input.timeout_seconds ?? input.timeoutSeconds ?? 90, input);
  issues.push(...timeout.issues);
  if (timeout.value !== null && maxExternalReviewerCalls !== null && maxExternalReviewerCalls * timeout.value > MAX_EXPANDED_REVIEWER_WALL_CLOCK_SECONDS) {
    issues.push(issue(
      "invalid_reviewer_cumulative_timeout",
      `expanded DS reviewer budget must stay at or below ${MAX_EXPANDED_REVIEWER_WALL_CLOCK_SECONDS}s cumulative wall-clock`,
      "timeout_seconds"
    ));
  }
  const routing = modelRoutingPlan(input);
  issues.push(...(routing.issues || []));

  return {
    status: issues.length ? "fail" : "pass",
    execution_mode: issues.length ? "blocked" : "bounded_real_reviewer",
    profile,
    controls: {
      executor_mode: "agent_invocation",
      max_external_reviewer_calls: maxExternalReviewerCalls,
      max_allowed_external_reviewer_calls: maxAllowedReviewerCalls,
      ds_participation_mode: dsParticipationMode(input),
      provider_cost_mode: providerCostMode,
      timeout_seconds: timeout.value,
      model_routing: {
        selected_model: routing.selected_model || null,
        preferred_model: routing.preferred_model || null,
        model_routing_strategy: routing.model_routing_strategy || null,
        ds_ratio_boost: routing.ds_ratio_boost ?? null,
        roles: routing.roles || []
      }
    },
    issues
  };
}

export function evaluateReviewerProviderHealthPreflight(workflowState = {}, policy = {}) {
  if (policy?.controls?.executor_mode !== "agent_invocation") {
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
