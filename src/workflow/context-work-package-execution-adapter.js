import { buildModelCollaborationPlan, summarizeModelRouting } from "./model-router.js";

export const CONTEXT_WORK_PACKAGE_EXECUTION_ADAPTER_VERSION = "context-work-package-execution-adapter.v1";
export const BOUNDED_MOCK_MULTI_AGENT_PROFILE = "bounded_mock_multi_agent";
export const LOCAL_BOUNDED_EXECUTION_PROFILE = "local_bounded";
export const PROVIDER_MODEL_ROUTED_MODE = "provider_model_routed";
export const COMPLETION_AUTHORITY_NONE = "none";
export const COMPLETION_AUTHORITY_EXECUTOR = "executor";

const SUPPORTED_PROFILES = new Set([BOUNDED_MOCK_MULTI_AGENT_PROFILE]);
const PROVIDER_ROUTED_MODES = new Set([
  PROVIDER_MODEL_ROUTED_MODE,
  "provider_routed",
  "model_routed",
  "multi_agent"
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

function compactStrings(value) {
  return asArray(value).map(normalizeString).filter(Boolean);
}

function issue(code, message, path) {
  return { code, message, path };
}

function completionAuthority({ allowed = false, authority = COMPLETION_AUTHORITY_NONE, reason, evidence_kind = "none" } = {}) {
  return {
    allows_work_package_completion: allowed === true,
    authority,
    evidence_kind,
    reason: normalizeString(reason)
  };
}

function requestedMode(options = {}) {
  return normalizeToken(options.execution_mode || options.executionMode || options.mode);
}

function explicitExecutionIdentities(options = {}) {
  return [
    { path: "execution_mode", value: options.execution_mode || options.executionMode || options.mode },
    { path: "execution_profile", value: options.execution_profile || options.executionProfile },
    { path: "adapter_profile", value: options.adapter_profile || options.adapterProfile },
    { path: "executor_profile", value: options.executor_profile || options.executorProfile },
    { path: "executor_kind", value: options.executor_kind || options.executorKind }
  ]
    .map((entry) => ({ ...entry, token: normalizeToken(entry.value) }))
    .filter((entry) => entry.token);
}

function isLocalBoundedToken(token) {
  return token === LOCAL_BOUNDED_EXECUTION_PROFILE;
}

function isMockOrSimulationToken(token) {
  return token.includes("mock") || token.includes("simulat");
}

function isProviderLikeMode(token) {
  return PROVIDER_ROUTED_MODES.has(token) ||
    token.includes("provider") ||
    token.includes("model_routed") ||
    token.includes("multi_agent");
}

function hasExplicitNonLocalExecutionIdentity(options = {}) {
  return explicitExecutionIdentities(options).some((entry) => !isLocalBoundedToken(entry.token));
}

export function requestedExecutionProfile(options = {}) {
  return normalizeToken(
    options.execution_profile ||
      options.executionProfile ||
      options.adapter_profile ||
      options.adapterProfile ||
      options.profile ||
      options.executor_profile ||
      options.executorProfile ||
      options.executor_kind ||
      options.executorKind
  );
}

export function isProviderModelRoutedExecutionRequested(options = {}) {
  const mode = requestedMode(options);
  const profile = requestedExecutionProfile(options);
  if (mode && !isLocalBoundedToken(mode)) return true;
  if (isProviderLikeMode(mode)) return true;
  if (profile && !isLocalBoundedToken(profile)) return true;
  if (hasExplicitNonLocalExecutionIdentity(options)) return true;
  return profile === BOUNDED_MOCK_MULTI_AGENT_PROFILE;
}

function profileValidation(options = {}) {
  const mode = requestedMode(options);
  const profile = requestedExecutionProfile(options);
  const explicitNonLocal = explicitExecutionIdentities(options).filter((entry) => !isLocalBoundedToken(entry.token));

  if (!isProviderModelRoutedExecutionRequested(options)) {
    return {
      status: "blocked",
      issues: [issue("provider_model_routed_mode_not_requested", "provider/model-routed execution was not requested", "execution_mode")]
    };
  }

  const unsupportedMode = mode && !isLocalBoundedToken(mode) && !PROVIDER_ROUTED_MODES.has(mode);
  if (unsupportedMode && !isProviderLikeMode(mode)) {
    return {
      status: "blocked",
      issues: [
        issue(
          "unsupported_execution_mode",
          `unsupported execution mode cannot fall back to local_bounded: ${mode}`,
          "execution_mode"
        )
      ]
    };
  }

  if (PROVIDER_ROUTED_MODES.has(mode) && !profile) {
    return {
      status: "blocked",
      issues: [
        issue(
          "missing_execution_profile",
          "provider/model-routed execution requires an explicit supported execution profile",
          "execution_profile"
        )
      ]
    };
  }

  if (!profile && explicitNonLocal.length > 0) {
    return {
      status: "blocked",
      issues: [
        issue(
          "unsupported_execution_identity",
          `explicit execution identity cannot fall back to local_bounded: ${explicitNonLocal[0].token}`,
          explicitNonLocal[0].path
        )
      ]
    };
  }

  if (!SUPPORTED_PROFILES.has(profile)) {
    return {
      status: "blocked",
      issues: [
        issue(
          "unsupported_execution_profile",
          `${isMockOrSimulationToken(profile) ? "mock/simulation" : "unsupported"} execution profile cannot fall back to local_bounded: ${profile || "missing"}`,
          "execution_profile"
        )
      ]
    };
  }

  return {
    status: "pass",
    profile,
    mode: PROVIDER_MODEL_ROUTED_MODE,
    issues: []
  };
}

function riskFor(workPackage = {}, options = {}) {
  return normalizeToken(workPackage.risk || workPackage.risk_level || options.risk || options.risk_level || "medium");
}

function budgetFor(workPackage = {}, options = {}) {
  return normalizeToken(
    workPackage.budget_tier ||
      workPackage.budget ||
      workPackage.model_budget ||
      options.budget_tier ||
      options.budgetTier ||
      options.budget ||
      "medium"
  );
}

function tagsFor(workPackage = {}, options = {}) {
  const tags = [
    ...compactStrings(options.tags),
    ...compactStrings(workPackage.tags),
    ...compactStrings(workPackage.capabilities),
    "context_work_package",
    "boundary_sensitive"
  ];
  if (workPackage.action) tags.push(normalizeToken(workPackage.action));
  return Array.from(new Set(tags.map(normalizeToken).filter(Boolean)));
}

function routingRequestFor(workflowState = {}, workPackage = {}, options = {}) {
  const contextPack = workflowState?.manifest?.context_pack || {};
  const goal = normalizeString(
    workPackage.title ||
      workPackage.summary ||
      workPackage.id ||
      workflowState?.manifest?.goal ||
      contextPack.requirement_summary
  );

  return {
    goal,
    stage: normalizeToken(workPackage.stage || options.stage || "implementation"),
    risk: riskFor(workPackage, options),
    budget_tier: budgetFor(workPackage, options),
    host: normalizeString(contextPack.host || options.host || "platform_core"),
    tags: tagsFor(workPackage, options),
    context_pack: contextPack,
    codex_plan_pressure: options.codex_plan_pressure === true || options.cost_pressure === true
  };
}

function compactRole(role = {}) {
  return {
    role: role.role,
    model_id: role.model_id,
    purpose: role.purpose,
    cost_tier: role.profile?.cost_tier || null,
    accuracy_tier: role.profile?.accuracy_tier || null,
    latency_tier: role.profile?.latency_tier || null
  };
}

export function buildContextWorkPackageExecutionPlan(workflowState = {}, selectedWorkPackages = [], options = {}) {
  const validation = profileValidation(options);
  if (validation.status !== "pass") {
    return {
      status: "blocked",
      phase: "execution_profile_validation",
      issues: validation.issues,
      execution_mode: PROVIDER_MODEL_ROUTED_MODE,
      execution_profile: requestedExecutionProfile(options) || null,
      package_plans: []
    };
  }

  const packagePlans = selectedWorkPackages.map((workPackage) => {
    const routingRequest = routingRequestFor(workflowState, workPackage, options);
    const collaborationPlan = buildModelCollaborationPlan(routingRequest);
    return {
      work_package_id: workPackage.id,
      title: workPackage.title,
      risk: routingRequest.risk,
      budget_tier: routingRequest.budget_tier,
      routing_request: routingRequest,
      collaboration_plan: {
        status: collaborationPlan.status,
        issues: collaborationPlan.issues,
        selected_model: collaborationPlan.selected_model,
        preferred_model: collaborationPlan.preferred_model,
        roles: asArray(collaborationPlan.roles).map(compactRole),
        routing_reasons: collaborationPlan.routing_reasons,
        guardrails: collaborationPlan.guardrails
      },
      routing_summary: summarizeModelRouting(collaborationPlan)
    };
  });

  const issues = packagePlans.flatMap((plan) =>
    asArray(plan.collaboration_plan.issues).map((item) => ({
      ...item,
      path: `package_plans.${plan.work_package_id}.${item.path || "model_routing"}`
    }))
  );

  return {
    status: issues.length ? "blocked" : "pass",
    phase: issues.length ? "model_routing" : "execution_plan_ready",
    version: CONTEXT_WORK_PACKAGE_EXECUTION_ADAPTER_VERSION,
    execution_mode: validation.mode,
    execution_profile: validation.profile,
    adapter_id: validation.profile,
    package_count: packagePlans.length,
    package_plans: packagePlans,
    model_routing: {
      strategy: "per_work_package_buildModelCollaborationPlan",
      package_plans: packagePlans.map((plan) => ({
        work_package_id: plan.work_package_id,
        risk: plan.risk,
        budget_tier: plan.budget_tier,
        selected_model: plan.collaboration_plan.selected_model,
        preferred_model: plan.collaboration_plan.preferred_model,
        roles: plan.collaboration_plan.roles,
        routing_reasons: plan.collaboration_plan.routing_reasons,
        guardrails: plan.collaboration_plan.guardrails,
        summary: plan.routing_summary
      }))
    },
    issues
  };
}

function mockPackageResult(plan = {}, createdAt) {
  const primaryRole = asArray(plan.collaboration_plan?.roles).find((role) => role.role === "primary") ||
    asArray(plan.collaboration_plan?.roles)[0] ||
    {};

  return {
    work_package_id: plan.work_package_id,
    status: "validated",
    result: "simulated_pass",
    completed_at: null,
    validated_at: createdAt,
    allows_work_package_completion: false,
    completion_authority: completionAuthority({
      allowed: false,
      authority: COMPLETION_AUTHORITY_NONE,
      evidence_kind: "deterministic_simulation",
      reason: "bounded mock multi-agent validates the execution plan only; it is not real executor evidence"
    }),
    executor_id: `${BOUNDED_MOCK_MULTI_AGENT_PROFILE}:${primaryRole.model_id || "unknown"}`,
    executor_profile: BOUNDED_MOCK_MULTI_AGENT_PROFILE,
    selected_model: plan.collaboration_plan?.selected_model || null,
    model_roles: asArray(plan.collaboration_plan?.roles).map((role) => ({
      role: role.role,
      model_id: role.model_id,
      reason: role.purpose
    })),
    evidence: {
      deterministic: true,
      external_calls: 0,
      simulation: true,
      message: "bounded mock multi-agent validated the routed package without external provider calls"
    }
  };
}

export function executeContextWorkPackagesWithAdapter(workflowState = {}, selectedWorkPackages = [], options = {}) {
  const createdAt = normalizeString(options.created_at || options.createdAt) || new Date().toISOString();
  const executionPlan = buildContextWorkPackageExecutionPlan(workflowState, selectedWorkPackages, options);

  if (executionPlan.status !== "pass") {
    return {
      status: "blocked",
      phase: executionPlan.phase,
      issues: executionPlan.issues,
      allows_work_package_completion: false,
      completion_authority: completionAuthority({
        allowed: false,
        authority: COMPLETION_AUTHORITY_NONE,
        evidence_kind: "validation_failed",
        reason: "adapter did not produce a valid execution plan"
      }),
      execution_plan: executionPlan,
      package_results: [],
      executor_provenance: null
    };
  }

  const packageResults = executionPlan.package_plans.map((plan) => mockPackageResult(plan, createdAt));

  return {
    status: "validated",
    phase: "simulated_execution",
    allows_work_package_completion: false,
    completion_authority: completionAuthority({
      allowed: false,
      authority: COMPLETION_AUTHORITY_NONE,
      evidence_kind: "deterministic_simulation",
      reason: "bounded mock multi-agent is simulation-only and cannot complete work packages"
    }),
    execution_plan: executionPlan,
    package_results: packageResults,
    executor_provenance: {
      adapter_id: BOUNDED_MOCK_MULTI_AGENT_PROFILE,
      adapter_version: CONTEXT_WORK_PACKAGE_EXECUTION_ADAPTER_VERSION,
      execution_mode: PROVIDER_MODEL_ROUTED_MODE,
      execution_profile: BOUNDED_MOCK_MULTI_AGENT_PROFILE,
      executor_kind: "deterministic_mock_multi_agent",
      external_calls: 0,
      deterministic: true,
      created_at: createdAt
    },
    issues: [
      issue(
        "simulation_has_no_completion_authority",
        "bounded mock multi-agent produced a deterministic simulation, not completion evidence",
        "completion_authority"
      )
    ]
  };
}
