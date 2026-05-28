const MODEL_PROFILES = {
  gpt: {
    model_id: "gpt",
    family: "gpt",
    cost_tier: "high",
    accuracy_tier: "very_high",
    latency_tier: "medium",
    strengths: ["complex_planning", "high_risk_code", "architecture", "final_arbitration"]
  },
  "gpt-5.5": {
    model_id: "gpt-5.5",
    family: "gpt",
    cost_tier: "high",
    accuracy_tier: "very_high",
    latency_tier: "medium",
    strengths: ["complex_planning", "repo_code_landing", "architecture", "final_arbitration"]
  },
  "gpt-5.3-codex-spark": {
    model_id: "gpt-5.3-codex-spark",
    family: "gpt",
    cost_tier: "medium",
    accuracy_tier: "high",
    latency_tier: "medium",
    strengths: ["repo_code_landing", "fixture_acceptance", "implementation"]
  },
  "claude-opus-4-7": {
    model_id: "claude-opus-4-7",
    family: "claude",
    cost_tier: "high",
    accuracy_tier: "very_high",
    latency_tier: "medium",
    strengths: ["architecture", "complex_planning", "deep_review"]
  },
  "claude-sonnet-4-6": {
    model_id: "claude-sonnet-4-6",
    family: "claude",
    cost_tier: "medium",
    accuracy_tier: "high",
    latency_tier: "medium",
    strengths: ["structured_planning", "repo_code_landing", "review", "implementation"]
  },
  "claude-haiku-4-5-20251001": {
    model_id: "claude-haiku-4-5-20251001",
    family: "claude",
    cost_tier: "low",
    accuracy_tier: "medium",
    latency_tier: "low",
    strengths: ["fallback", "summarization", "routing"]
  },
  "deepseek-v4-pro": {
    model_id: "deepseek-v4-pro",
    family: "deepseek",
    cost_tier: "medium",
    accuracy_tier: "high",
    latency_tier: "medium",
    strengths: ["independent_review", "code_audit", "reasoning", "second_opinion"]
  },
  "deepseek-v4-pro[1m]": {
    model_id: "deepseek-v4-pro[1m]",
    family: "deepseek",
    cost_tier: "medium",
    accuracy_tier: "high",
    latency_tier: "medium",
    strengths: ["independent_review", "bounded_execution", "code_audit", "second_opinion"]
  },
  "deepseek-v4-flash": {
    model_id: "deepseek-v4-flash",
    family: "deepseek",
    cost_tier: "low",
    accuracy_tier: "medium",
    latency_tier: "low",
    strengths: ["classification", "summarization", "routing", "low_risk_batch_checks"]
  },
  "mimo-v2.5-pro": {
    model_id: "mimo-v2.5-pro",
    family: "mimo",
    cost_tier: "medium",
    accuracy_tier: "medium",
    latency_tier: "medium",
    strengths: ["anthropic_compatible_fallback", "structured_planning", "bounded_execution"]
  },
  "mimo-v2.5": {
    model_id: "mimo-v2.5",
    family: "mimo",
    cost_tier: "low",
    accuracy_tier: "medium",
    latency_tier: "low",
    strengths: ["fallback", "summarization", "routing"]
  }
};

const RISK_ORDER = ["low", "medium", "high", "critical"];
const MODEL_ROUTING_STRATEGIES = new Set(["balanced", "ds_expanded", "cost_saving"]);
const STAGE_DEFAULTS = {
  intake: "deepseek-v4-flash",
  classification: "deepseek-v4-flash",
  summarization: "deepseek-v4-flash",
  context_pack: "deepseek-v4-pro",
  planning: "gpt",
  implementation: "gpt",
  review: "deepseek-v4-pro",
  final_review: "gpt",
  recovery: "gpt",
  regression_triage: "deepseek-v4-flash"
};

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

function riskRank(value) {
  const index = RISK_ORDER.indexOf(normalizeToken(value));
  return index === -1 ? 1 : index;
}

function hasAnyTag(tags, expected) {
  const normalized = new Set(compactStrings(tags).map(normalizeToken));
  return expected.some((tag) => normalized.has(tag));
}

function numericValue(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function hasPlanPressure(request) {
  const tags = request.tags || request.capabilities || [];
  return request.codex_plan_pressure === true ||
    request.cost_pressure === true ||
    hasAnyTag(tags, ["codex_plan_pressure", "plan_budget_pressure", "process_guard"]);
}

function routingStrategy(request = {}) {
  const explicit = normalizeToken(
    request.model_routing_strategy ||
      request.modelRoutingStrategy ||
      request.routing_strategy ||
      request.routingStrategy ||
      request.ds_participation_mode ||
      request.dsParticipationMode
  );
  if (["ds_first", "ds-first", "expanded", "deepseek_expanded"].includes(explicit)) return "ds_expanded";
  if (["cost", "cost_sensitive", "cost-sensitive", "cost_saving"].includes(explicit)) return "cost_saving";
  if (explicit) return explicit;
  return hasPlanPressure(request) ? "ds_expanded" : "balanced";
}

function dsRatioBoost(request = {}) {
  const explicit = numericValue(request.ds_ratio_boost || request.dsRatioBoost);
  if (explicit !== null) return explicit;
  const strategy = routingStrategy(request);
  if (strategy === "cost_saving") return 3;
  if (strategy === "ds_expanded") return 2;
  return 1;
}

function isDsExpanded(request = {}) {
  return routingStrategy(request) !== "balanced" || dsRatioBoost(request) > 1;
}

function requiresGptPrimary(request = {}) {
  const risk = normalizeToken(request.risk || request.risk_level);
  const tags = request.tags || request.capabilities || [];
  const host = normalizeToken(request.host || request.context_pack?.host);
  return riskRank(risk) >= riskRank("critical") ||
    (riskRank(risk) >= riskRank("high") && host === "platform_core") ||
    hasAnyTag(tags, ["architecture", "recovery", "security", "destructive_action", "final_arbitration"]);
}

function budgetAllows(modelId, budgetTier) {
  const profile = MODEL_PROFILES[modelId];
  const budget = normalizeToken(budgetTier || "high");
  if (!profile) return false;
  if (budget === "low") return profile.cost_tier === "low";
  if (budget === "medium") return profile.cost_tier !== "high";
  return true;
}

function chooseFallbackForBudget(preferredModel, budgetTier) {
  if (budgetAllows(preferredModel, budgetTier)) return preferredModel;
  if (budgetAllows("deepseek-v4-pro", budgetTier)) return "deepseek-v4-pro";
  return "deepseek-v4-flash";
}

function baseModelFor(request) {
  const stage = normalizeToken(request.stage || request.task_type || request.phase);
  const risk = normalizeToken(request.risk || request.risk_level);
  const tags = request.tags || request.capabilities || [];

  if (requiresGptPrimary(request)) return "gpt";
  if (hasAnyTag(tags, ["independent_review", "code_audit", "reviewer", "second_opinion"])) return "deepseek-v4-pro";
  if (hasAnyTag(tags, ["classification", "summarization", "routing", "batch_check", "low_risk"])) return "deepseek-v4-flash";
  if (
    isDsExpanded(request) &&
    ["context_pack", "planning", "implementation"].includes(stage) &&
    riskRank(risk) <= riskRank("medium")
  ) {
    return "deepseek-v4-pro";
  }
  return STAGE_DEFAULTS[stage] || "deepseek-v4-pro";
}

function collaborationRolesFor(request, primaryModelId) {
  const risk = normalizeToken(request.risk || request.risk_level);
  const stage = normalizeToken(request.stage || request.task_type || request.phase);
  const tags = request.tags || [];
  const codexPlanPressure = hasPlanPressure(request);
  const dsExpanded = isDsExpanded(request);
  const requiresIndependentReview = request.requires_independent_review === true ||
    hasAnyTag(tags, ["independent_review", "code_audit", "boundary_sensitive"]) ||
    riskRank(risk) >= riskRank("high");
  const roles = [
    {
      role: "primary",
      model_id: primaryModelId,
      purpose: "produce the main plan or implementation output"
    }
  ];

  if (["intake", "classification", "summarization", "regression_triage"].includes(stage)) {
    roles.unshift({
      role: "scout",
      model_id: "deepseek-v4-flash",
      purpose: "classify, summarize, or prefilter low-risk input"
    });
  }

  if (
    dsExpanded &&
    !["intake", "classification", "summarization", "regression_triage"].includes(stage) &&
    ["context_pack", "planning", "implementation", "recovery", "review", "final_review"].includes(stage)
  ) {
    roles.unshift({
      role: "scout",
      model_id: "deepseek-v4-flash",
      purpose: "compress context and surface low-cost routing signals before the primary model runs"
    });
  }

  if (
    (codexPlanPressure || dsExpanded) &&
    primaryModelId !== "deepseek-v4-pro" &&
    ["planning", "implementation", "recovery", "review", "final_review"].includes(stage)
  ) {
    const primaryIndex = roles.findIndex((role) => role.role === "primary");
    roles.splice(primaryIndex >= 0 ? primaryIndex : 0, 0, {
      role: "process_guard",
      model_id: "deepseek-v4-pro",
      purpose: "preflight process drift, replay safety, and gate completeness before GPT spends implementation or arbitration budget"
    });
  }

  if (requiresIndependentReview && primaryModelId !== "deepseek-v4-pro") {
    roles.push({
      role: "independent_reviewer",
      model_id: "deepseek-v4-pro",
      purpose: "perform read-only second-opinion review"
    });
  }

  if (requiresIndependentReview && primaryModelId === "deepseek-v4-pro") {
    roles.push({
      role: "arbiter",
      model_id: "gpt",
      purpose: "arbitrate high-risk reviewer findings before merge"
    });
  }

  return roles;
}

export function validateModelRoutingRequest(request) {
  const issues = [];

  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return {
      status: "fail",
      issues: [issue("invalid_model_routing_request", "model routing request must be an object", "")]
    };
  }

  if (!normalizeString(request.goal || request.requirement || request.summary)) {
    issues.push(issue("missing_goal", "model routing request must include goal, requirement, or summary", "goal"));
  }

  const risk = normalizeToken(request.risk || request.risk_level || "medium");
  if (!RISK_ORDER.includes(risk)) {
    issues.push(issue("invalid_risk", `risk must be one of: ${RISK_ORDER.join(", ")}`, "risk"));
  }

  const budget = normalizeToken(request.budget_tier || "high");
  if (!["low", "medium", "high"].includes(budget)) {
    issues.push(issue("invalid_budget_tier", "budget_tier must be low, medium, or high", "budget_tier"));
  }

  const strategy = routingStrategy(request);
  if (!MODEL_ROUTING_STRATEGIES.has(strategy)) {
    issues.push(issue("invalid_model_routing_strategy", "model_routing_strategy must be balanced, ds_expanded, or cost_saving", "model_routing_strategy"));
  }

  const boost = dsRatioBoost(request);
  if (boost < 1 || boost > 5) {
    issues.push(issue("invalid_ds_ratio_boost", "ds_ratio_boost must be between 1 and 5", "ds_ratio_boost"));
  }

  return {
    status: issues.length ? "fail" : "pass",
    issues
  };
}

export function selectModelForTask(request = {}) {
  const validation = validateModelRoutingRequest(request);
  const preferredModel = baseModelFor(request);
  const selectedModel = chooseFallbackForBudget(preferredModel, request.budget_tier);
  const downgradedForBudget = selectedModel !== preferredModel;
  const strategy = routingStrategy(request);
  const boost = dsRatioBoost(request);

  return {
    status: validation.status,
    issues: validation.issues,
    selected_model: selectedModel,
    preferred_model: preferredModel,
    model_routing_strategy: strategy,
    ds_ratio_boost: boost,
    downgraded_for_budget: downgradedForBudget,
    model_profile: MODEL_PROFILES[selectedModel],
    reasons: [
      `stage=${normalizeToken(request.stage || request.task_type || request.phase) || "unspecified"}`,
      `risk=${normalizeToken(request.risk || request.risk_level || "medium")}`,
      `budget=${normalizeToken(request.budget_tier || "high")}`,
      `strategy=${strategy}`,
      `ds_ratio_boost=${boost}`,
      downgradedForBudget ? `budget downgraded ${preferredModel} to ${selectedModel}` : `selected ${selectedModel}`
    ]
  };
}

export function buildModelCollaborationPlan(request = {}) {
  const selection = selectModelForTask(request);
  const roles = collaborationRolesFor(request, selection.selected_model).map((role) => ({
    ...role,
    profile: MODEL_PROFILES[role.model_id]
  }));

  return {
    status: selection.status,
    issues: selection.issues,
    goal: normalizeString(request.goal || request.requirement || request.summary),
    selected_model: selection.selected_model,
    preferred_model: selection.preferred_model,
    model_routing_strategy: selection.model_routing_strategy,
    ds_ratio_boost: selection.ds_ratio_boost,
    roles,
    routing_reasons: selection.reasons,
    guardrails: {
      reviewer_default_read_only: true,
      high_risk_requires_independent_review: true,
      codex_plan_pressure_uses_deepseek_pro: roles.some((role) => role.role === "process_guard" && role.model_id === "deepseek-v4-pro"),
      ds_expansion_is_configurable: selection.model_routing_strategy !== "balanced" || selection.ds_ratio_boost > 1,
      gpt_primary_required_for_high_risk_platform_core: requiresGptPrimary(request),
      budget_downgrade_must_be_recorded: selection.downgraded_for_budget
    }
  };
}

export function summarizeModelRouting(plan) {
  const roles = asArray(plan?.roles);
  const byModel = roles.reduce((summary, role) => {
    summary[role.model_id] = (summary[role.model_id] || 0) + 1;
    return summary;
  }, {});
  const dsRoleCount = roles.filter((role) => normalizeString(role.model_id).startsWith("deepseek")).length;
  const gptRoleCount = roles.filter((role) => normalizeString(role.model_id).startsWith("gpt")).length;

  return {
    status: plan?.status || "unknown",
    selected_model: plan?.selected_model || null,
    preferred_model: plan?.preferred_model || null,
    model_routing_strategy: plan?.model_routing_strategy || "balanced",
    ds_ratio_boost: plan?.ds_ratio_boost ?? 1,
    role_count: roles.length,
    by_model: byModel,
    ds_role_count: dsRoleCount,
    gpt_role_count: gptRoleCount,
    ds_primary: normalizeString(plan?.selected_model).startsWith("deepseek"),
    has_process_guard: roles.some((role) => role.role === "process_guard"),
    has_independent_reviewer: roles.some((role) => role.role === "independent_reviewer"),
    has_arbiter: roles.some((role) => role.role === "arbiter")
  };
}

export { MODEL_PROFILES, MODEL_ROUTING_STRATEGIES, RISK_ORDER, STAGE_DEFAULTS };
