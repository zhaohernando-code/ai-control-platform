import { buildModelCollaborationPlan, summarizeModelRouting } from "./model-router.js";

export const CONTEXT_WORK_PACKAGE_EXECUTION_ADAPTER_VERSION = "context-work-package-execution-adapter.v1";
export const BOUNDED_MOCK_MULTI_AGENT_PROFILE = "bounded_mock_multi_agent";
export const VERIFIED_PROVIDER_MULTI_AGENT_PROFILE = "verified_provider_multi_agent";
export const LOCAL_BOUNDED_EXECUTION_PROFILE = "local_bounded";
export const PROVIDER_MODEL_ROUTED_MODE = "provider_model_routed";
export const COMPLETION_AUTHORITY_NONE = "none";
export const COMPLETION_AUTHORITY_EXECUTOR = "executor";

const SUPPORTED_PROFILES = new Set([BOUNDED_MOCK_MULTI_AGENT_PROFILE, VERIFIED_PROVIDER_MULTI_AGENT_PROFILE]);
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

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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

function isNonExternalRunnerToken(token) {
  return token.includes("fake") ||
    token.includes("test") ||
    token.includes("mock") ||
    token.includes("simulat") ||
    token.includes("local") ||
    token.includes("deterministic");
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

function providerExecutorFromOptions(options = {}) {
  return [
    options.provider_executor,
    options.providerExecutor,
    options.realProviderExecutor,
    options.contextWorkPackageProviderExecutor,
    options.context_work_package_provider_executor
  ].find((candidate) => typeof candidate === "function") || null;
}

function completionEvidenceFrom(value) {
  if (typeof value === "string") return normalizeString(value) ? value : null;
  if (!isObject(value)) return null;
  if (normalizeString(value.summary || value.uri || value.artifact_id || value.artifactId || value.kind || value.type)) return value;
  if (Object.keys(value).length > 0) return value;
  return null;
}

function externalCallCountFrom(provenance = {}) {
  if (Array.isArray(provenance.external_calls)) return provenance.external_calls.length;
  const candidates = [
    provenance.external_calls,
    provenance.external_call_count,
    provenance.externalCallCount,
    provenance.external_call_budget_used,
    provenance.externalCallBudgetUsed
  ];
  for (const candidate of candidates) {
    const count = Number(candidate);
    if (Number.isFinite(count)) return count;
  }
  if (Array.isArray(provenance.calls)) return provenance.calls.length;
  if (Array.isArray(provenance.external_call_ids)) return provenance.external_call_ids.length;
  if (Array.isArray(provenance.externalCallIds)) return provenance.externalCallIds.length;
  return 0;
}

function normalizeExecutorProvenance(executorResult = {}, executionProfile, createdAt) {
  const raw = executorResult.executor_provenance ||
    executorResult.executorProvenance ||
    executorResult.provenance ||
    {};
  const issues = [];
  if (!isObject(raw)) {
    issues.push(issue("invalid_executor_provenance", "provider executor provenance must be an object", "executor_provenance"));
  }

  const provenance = isObject(raw) ? raw : {};
  const executorKind = normalizeToken(provenance.executor_kind || provenance.executorKind || provenance.provider_executor || provenance.providerExecutor);
  const provenanceProfile = normalizeToken(provenance.execution_profile || provenance.executionProfile || executionProfile);
  const provider = normalizeToken(provenance.provider || provenance.provider_id || provenance.providerId);
  const commandRunnerKind = normalizeToken(provenance.command_runner_kind || provenance.commandRunnerKind);
  const externalCalls = externalCallCountFrom(provenance);

  if (!executorKind) {
    issues.push(issue("missing_executor_kind", "provider executor provenance must name executor_kind", "executor_provenance.executor_kind"));
  }
  if (isLocalBoundedToken(executorKind) || isLocalBoundedToken(provenanceProfile)) {
    issues.push(issue("local_executor_provenance_not_allowed", "real provider profile cannot claim local_bounded executor provenance", "executor_provenance.executor_kind"));
  }
  if (isMockOrSimulationToken(executorKind) || isMockOrSimulationToken(provenanceProfile) || isMockOrSimulationToken(provider)) {
    issues.push(issue("mock_executor_provenance_not_allowed", "real provider profile cannot use mock or simulation executor provenance", "executor_provenance.executor_kind"));
  }
  if (commandRunnerKind && isNonExternalRunnerToken(commandRunnerKind)) {
    issues.push(issue("non_external_command_runner_provenance_not_allowed", "real provider profile cannot use fake/test/mock/simulation/local/deterministic command runner provenance for completion authority", "executor_provenance.command_runner_kind"));
  }
  if (provenance.deterministic === true) {
    issues.push(issue("deterministic_executor_provenance_not_allowed", "real provider profile requires non-deterministic external execution provenance", "executor_provenance.deterministic"));
  }
  if (externalCalls <= 0) {
    issues.push(issue("missing_external_call_provenance", "real provider profile requires at least one external provider call in provenance", "executor_provenance.external_calls"));
  }

  return {
    issues,
    provenance: {
      ...provenance,
      adapter_id: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
      adapter_version: CONTEXT_WORK_PACKAGE_EXECUTION_ADAPTER_VERSION,
      execution_mode: PROVIDER_MODEL_ROUTED_MODE,
      execution_profile: executionProfile,
      executor_kind: executorKind || null,
      command_runner_kind: commandRunnerKind || provenance.command_runner_kind || provenance.commandRunnerKind || null,
      external_calls: externalCalls,
      deterministic: provenance.deterministic === true,
      created_at: normalizeString(provenance.created_at || provenance.createdAt) || createdAt
    }
  };
}

function normalizeProviderPackageResults(executorResult = {}, executionPlan = {}, createdAt) {
  const rawResults = asArray(executorResult.package_results || executorResult.packageResults || executorResult.results);
  const selectedIds = new Set(asArray(executionPlan.package_plans).map((plan) => normalizeString(plan.work_package_id)));
  const seenIds = new Set();
  const rawById = new Map(
    rawResults
      .map((result) => [normalizeString(result?.work_package_id || result?.workPackageId || result?.id), result])
      .filter(([id]) => id)
  );
  const issues = [];

  if (rawResults.length === 0 && asArray(executionPlan.package_plans).length > 0) {
    issues.push(issue("missing_package_results", "provider executor must return package_results", "package_results"));
  }
  rawResults.forEach((raw, index) => {
    const id = normalizeString(raw?.work_package_id || raw?.workPackageId || raw?.id);
    const status = normalizeToken(raw?.status);
    if (!id) {
      issues.push(issue("missing_package_result_id", "provider executor package result must identify a work package", `package_results[${index}]`));
      return;
    }
    if (seenIds.has(id)) {
      issues.push(issue("duplicate_package_result", `provider executor returned duplicate package result for ${id}`, `package_results.${id}`));
    }
    seenIds.add(id);
    if (!selectedIds.has(id)) {
      issues.push(issue("unexpected_package_result", `provider executor returned package result outside selected work packages: ${id}`, `package_results.${id}`));
    }
    if (status !== "pass") {
      issues.push(issue("package_result_not_pass", `provider executor package result must be pass for ${id}`, `package_results.${id}.status`));
    }
  });

  const packageResults = asArray(executionPlan.package_plans).map((plan) => {
    const raw = rawById.get(normalizeString(plan.work_package_id)) || {};
    const status = normalizeToken(raw.status);
    const completionEvidence = completionEvidenceFrom(raw.completion_evidence || raw.completionEvidence);

    if (!rawById.has(normalizeString(plan.work_package_id))) {
      issues.push(issue("missing_package_result", `provider executor omitted package result for ${plan.work_package_id}`, `package_results.${plan.work_package_id}`));
    }
    if (rawById.has(normalizeString(plan.work_package_id)) && !completionEvidence) {
      issues.push(issue("missing_package_completion_evidence", `provider executor package result requires completion_evidence for ${plan.work_package_id}`, `package_results.${plan.work_package_id}.completion_evidence`));
    }

    return {
      ...raw,
      work_package_id: plan.work_package_id,
      status: status || "blocked",
      result: normalizeString(raw.result) || status || "blocked",
      completed_at: status === "pass" ? normalizeString(raw.completed_at || raw.completedAt) || createdAt : null,
      allows_work_package_completion: false,
      completion_authority: completionAuthority({
        allowed: false,
        authority: COMPLETION_AUTHORITY_NONE,
        evidence_kind: "pending_provider_executor_validation",
        reason: "provider executor result has not been validated for completion authority"
      }),
      completion_evidence: completionEvidence,
      selected_model: raw.selected_model || raw.selectedModel || plan.collaboration_plan?.selected_model || null,
      model_roles: raw.model_roles || asArray(plan.collaboration_plan?.roles).map((role) => ({
        role: role.role,
        model_id: role.model_id,
        reason: role.purpose
      }))
    };
  });

  return { issues, packageResults };
}

function withProviderCompletionAuthority(packageResults = [], executorProvenance = {}, createdAt) {
  return packageResults.map((result) => ({
    ...result,
    completed_at: result.completed_at || createdAt,
    allows_work_package_completion: true,
    completion_authority: completionAuthority({
      allowed: true,
      authority: COMPLETION_AUTHORITY_EXECUTOR,
      evidence_kind: "real_provider_execution",
      reason: "verified provider executor returned pass status, legal external-call provenance, and package completion evidence"
    }),
    executor_provenance: {
      executor_kind: executorProvenance.executor_kind,
      execution_profile: executorProvenance.execution_profile,
      external_calls: executorProvenance.external_calls
    }
  }));
}

function executeVerifiedProviderProfile(workflowState = {}, selectedWorkPackages = [], options = {}, executionPlan = {}, createdAt) {
  const providerExecutor = providerExecutorFromOptions(options);
  if (!providerExecutor) {
    return {
      status: "blocked",
      phase: "provider_executor_required",
      issues: [
        issue(
          "missing_provider_executor",
          "verified provider multi-agent profile requires a real provider executor injected by runner/server options",
          "provider_executor"
        )
      ],
      allows_work_package_completion: false,
      completion_authority: completionAuthority({
        allowed: false,
        authority: COMPLETION_AUTHORITY_NONE,
        evidence_kind: "missing_executor",
        reason: "real provider profile blocks closed without an injected executor"
      }),
      execution_plan: executionPlan,
      package_results: [],
      executor_provenance: null
    };
  }

  let executorResult;
  try {
    executorResult = providerExecutor({
      workflow_state: workflowState,
      selected_work_packages: selectedWorkPackages,
      execution_plan: executionPlan,
      options: {
        ...options,
        provider_executor: undefined,
        providerExecutor: undefined,
        realProviderExecutor: undefined,
        contextWorkPackageProviderExecutor: undefined,
        context_work_package_provider_executor: undefined
      }
    });
  } catch (error) {
    return {
      status: "fail",
      phase: "provider_executor_failed",
      issues: [
        issue("provider_executor_threw", `provider executor threw before returning completion evidence: ${error.message}`, "provider_executor")
      ],
      allows_work_package_completion: false,
      completion_authority: completionAuthority({
        allowed: false,
        authority: COMPLETION_AUTHORITY_NONE,
        evidence_kind: "executor_error",
        reason: "provider executor failed before adapter could validate completion evidence"
      }),
      execution_plan: executionPlan,
      package_results: [],
      executor_provenance: null
    };
  }

  if (!isObject(executorResult)) {
    return {
      status: "fail",
      phase: "provider_executor_result_validation",
      issues: [issue("invalid_provider_executor_result", "provider executor must return an object", "provider_executor.result")],
      allows_work_package_completion: false,
      completion_authority: completionAuthority({
        allowed: false,
        authority: COMPLETION_AUTHORITY_NONE,
        evidence_kind: "invalid_executor_result",
        reason: "provider executor result was not structured"
      }),
      execution_plan: executionPlan,
      package_results: [],
      executor_provenance: null
    };
  }

  const executorStatus = normalizeToken(executorResult.status);
  const topCompletionEvidence = completionEvidenceFrom(executorResult.completion_evidence || executorResult.completionEvidence);
  const provenance = normalizeExecutorProvenance(executorResult, VERIFIED_PROVIDER_MULTI_AGENT_PROFILE, createdAt);
  const normalizedPackages = normalizeProviderPackageResults(executorResult, executionPlan, createdAt);
  const validationIssues = [
    ...(executorStatus === "pass" ? [] : [
      issue("provider_executor_result_not_pass", "provider executor top-level status must be pass", "provider_executor.status")
    ]),
    ...(topCompletionEvidence ? [] : [
      issue("missing_completion_evidence", "provider executor top-level result requires completion_evidence", "provider_executor.completion_evidence")
    ]),
    ...provenance.issues,
    ...normalizedPackages.issues
  ];

  if (validationIssues.length > 0) {
    return {
      status: executorStatus === "fail" ? "fail" : "blocked",
      phase: "provider_executor_result_validation",
      issues: validationIssues,
      allows_work_package_completion: false,
      completion_authority: completionAuthority({
        allowed: false,
        authority: COMPLETION_AUTHORITY_NONE,
        evidence_kind: "provider_executor_validation_failed",
        reason: "provider executor did not return pass status, legal provenance, and completion evidence"
      }),
      execution_plan: executionPlan,
      package_results: normalizedPackages.packageResults,
      executor_provenance: provenance.provenance
    };
  }

  const packageResults = withProviderCompletionAuthority(normalizedPackages.packageResults, provenance.provenance, createdAt);
  return {
    status: "pass",
    phase: "provider_executor_completed",
    allows_work_package_completion: true,
    completion_authority: completionAuthority({
      allowed: true,
      authority: COMPLETION_AUTHORITY_EXECUTOR,
      evidence_kind: "real_provider_execution",
      reason: "verified provider executor returned pass status, legal external-call provenance, and completion evidence"
    }),
    completion_evidence: topCompletionEvidence,
    execution_plan: executionPlan,
    package_results: packageResults,
    executor_provenance: provenance.provenance,
    issues: []
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

  if (executionPlan.execution_profile === VERIFIED_PROVIDER_MULTI_AGENT_PROFILE) {
    return executeVerifiedProviderProfile(workflowState, selectedWorkPackages, options, executionPlan, createdAt);
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
