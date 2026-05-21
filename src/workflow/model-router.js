const MODEL_PROFILES = {
  gpt: {
    model_id: "gpt",
    family: "gpt",
    cost_tier: "high",
    accuracy_tier: "very_high",
    latency_tier: "medium",
    strengths: ["complex_planning", "high_risk_code", "architecture", "final_arbitration"]
  },
  "deepseek-v4-pro": {
    model_id: "deepseek-v4-pro",
    family: "deepseek",
    cost_tier: "medium",
    accuracy_tier: "high",
    latency_tier: "medium",
    strengths: ["independent_review", "code_audit", "reasoning", "second_opinion"]
  },
  "deepseek-v4-flash": {
    model_id: "deepseek-v4-flash",
    family: "deepseek",
    cost_tier: "low",
    accuracy_tier: "medium",
    latency_tier: "low",
    strengths: ["classification", "summarization", "routing", "low_risk_batch_checks"]
  }
};

const RISK_ORDER = ["low", "medium", "high", "critical"];
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
  const host = normalizeToken(request.host || request.context_pack?.host);

  if (riskRank(risk) >= riskRank("critical")) return "gpt";
  if (riskRank(risk) >= riskRank("high") && host === "platform_core") return "gpt";
  if (hasAnyTag(tags, ["architecture", "recovery", "security", "destructive_action", "final_arbitration"])) return "gpt";
  if (hasAnyTag(tags, ["independent_review", "code_audit", "reviewer", "second_opinion"])) return "deepseek-v4-pro";
  if (hasAnyTag(tags, ["classification", "summarization", "routing", "batch_check", "low_risk"])) return "deepseek-v4-flash";
  return STAGE_DEFAULTS[stage] || "deepseek-v4-pro";
}

function collaborationRolesFor(request, primaryModelId) {
  const risk = normalizeToken(request.risk || request.risk_level);
  const stage = normalizeToken(request.stage || request.task_type || request.phase);
  const requiresIndependentReview = request.requires_independent_review === true ||
    hasAnyTag(request.tags, ["independent_review", "code_audit", "boundary_sensitive"]) ||
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

  return {
    status: validation.status,
    issues: validation.issues,
    selected_model: selectedModel,
    preferred_model: preferredModel,
    downgraded_for_budget: downgradedForBudget,
    model_profile: MODEL_PROFILES[selectedModel],
    reasons: [
      `stage=${normalizeToken(request.stage || request.task_type || request.phase) || "unspecified"}`,
      `risk=${normalizeToken(request.risk || request.risk_level || "medium")}`,
      `budget=${normalizeToken(request.budget_tier || "high")}`,
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
    roles,
    routing_reasons: selection.reasons,
    guardrails: {
      reviewer_default_read_only: true,
      high_risk_requires_independent_review: true,
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

  return {
    status: plan?.status || "unknown",
    selected_model: plan?.selected_model || null,
    preferred_model: plan?.preferred_model || null,
    role_count: roles.length,
    by_model: byModel,
    has_independent_reviewer: roles.some((role) => role.role === "independent_reviewer"),
    has_arbiter: roles.some((role) => role.role === "arbiter")
  };
}

export { MODEL_PROFILES, RISK_ORDER, STAGE_DEFAULTS };
