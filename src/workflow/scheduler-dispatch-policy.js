function asArray(value) {
  return Array.isArray(value) ? value : [];
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

function numberValue(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function planUsesReviewerMock(plan = {}) {
  return asArray(plan.steps).some((step) => asArray(step.args).includes("--mock-status"));
}

function reviewerShardCount(plan = {}) {
  const firstStep = asArray(plan.steps).find((step) => normalizeString(step.id) === "run-reviewer-shard-loop");
  return asArray(firstStep?.work_package_ids).length;
}

export function evaluateSchedulerDispatchControlPolicy(input = {}, plan = {}) {
  const dryRun = input.dry_run !== false && input.dryRun !== false;
  const steps = asArray(plan.steps);
  const issues = [];

  if (dryRun) {
    return {
      status: "pass",
      execution_mode: "dry_run",
      issues,
      controls: {
        max_steps: steps.length,
        reviewer_cost_mode: planUsesReviewerMock(plan) ? "mocked" : "not_executed"
      }
    };
  }

  const authorization = normalizeToken(input.operator_authorization ?? input.operatorAuthorization ?? input.authorization);
  if (authorization !== "approved_non_dry_run") {
    issues.push(issue("missing_operator_authorization", "non-dry-run scheduler dispatch requires approved_non_dry_run authorization", "operator_authorization"));
  }

  const maxSteps = numberValue(input.max_steps ?? input.maxSteps);
  if (maxSteps === null) {
    issues.push(issue("missing_max_steps", "non-dry-run scheduler dispatch requires max_steps", "max_steps"));
  } else if (maxSteps < steps.length || maxSteps > 3) {
    issues.push(issue("invalid_max_steps", "max_steps must cover the plan and stay at or below 3", "max_steps"));
  }

  const usesMock = planUsesReviewerMock(plan);
  const maxExternalReviewerCalls = numberValue(input.max_external_reviewer_calls ?? input.maxExternalReviewerCalls);
  if (usesMock) {
    if (maxExternalReviewerCalls !== null && maxExternalReviewerCalls !== 0) {
      issues.push(issue("invalid_mock_reviewer_budget", "mocked reviewer dispatch must set max_external_reviewer_calls to 0 when provided", "max_external_reviewer_calls"));
    }
  } else {
    const shardCount = reviewerShardCount(plan);
    if (maxExternalReviewerCalls === null) {
      issues.push(issue("missing_reviewer_budget", "non-mocked reviewer dispatch requires max_external_reviewer_calls", "max_external_reviewer_calls"));
    } else if (maxExternalReviewerCalls < 1 || maxExternalReviewerCalls > Math.max(1, shardCount)) {
      issues.push(issue("invalid_reviewer_budget", "max_external_reviewer_calls must be positive and no larger than planned reviewer shards", "max_external_reviewer_calls"));
    }
  }

  const providerCostMode = normalizeToken(input.provider_cost_mode ?? input.providerCostMode ?? (usesMock ? "mocked" : ""));
  if (!["mocked", "bounded"].includes(providerCostMode)) {
    issues.push(issue("missing_provider_cost_mode", "non-dry-run scheduler dispatch requires provider_cost_mode mocked or bounded", "provider_cost_mode"));
  }
  if (!usesMock && providerCostMode !== "bounded") {
    issues.push(issue("invalid_provider_cost_mode", "non-mocked reviewer dispatch must use bounded provider_cost_mode", "provider_cost_mode"));
  }

  return {
    status: issues.length ? "fail" : "pass",
    execution_mode: issues.length ? "blocked" : "execute",
    issues,
    controls: {
      max_steps: maxSteps,
      max_external_reviewer_calls: maxExternalReviewerCalls,
      provider_cost_mode: providerCostMode,
      reviewer_cost_mode: usesMock ? "mocked" : "bounded"
    }
  };
}
