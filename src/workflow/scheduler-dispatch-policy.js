import { recordArtifact } from "./artifact-ledger.js";
import { appendRunEvent } from "./run-manifest.js";

const SCHEDULER_DISPATCH_POLICY_VERSION = "scheduler-dispatch-policy.v1";

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

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeIdPart(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function planUsesReviewerMock(plan = {}) {
  return asArray(plan.steps).some((step) => asArray(step.args).includes("--mock-status"));
}

function reviewerShardCount(plan = {}) {
  const firstStep = asArray(plan.steps).find((step) => normalizeString(step.id) === "run-reviewer-shard-loop");
  return asArray(firstStep?.work_package_ids).length;
}

function policyStatus(policy = {}) {
  return normalizeString(policy.status) === "pass" ? "pass" : "fail";
}

function nextPolicyArtifactId(workflowState = {}, options = {}) {
  const explicit = normalizeString(options.artifact_id || options.artifactId);
  if (explicit) return explicit;

  const prefix = `scheduler-dispatch-policy-${safeIdPart(workflowState?.manifest?.run_id)}-${safeIdPart(workflowState?.manifest?.cycle_id)}`;
  const used = new Set([
    ...asArray(workflowState?.manifest?.events).map((event) => normalizeString(event?.artifact_id)).filter(Boolean),
    ...asArray(workflowState?.artifact_ledger?.artifacts || workflowState?.artifactLedger?.artifacts)
      .map((artifact) => normalizeString(artifact?.id))
      .filter(Boolean)
  ]);
  let index = 1;
  let id = `${prefix}-${String(index).padStart(3, "0")}`;
  while (used.has(id)) {
    index += 1;
    id = `${prefix}-${String(index).padStart(3, "0")}`;
  }
  return id;
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

export function recordSchedulerDispatchPolicyDecision(workflowState = {}, policy = {}, options = {}) {
  if (!isObject(workflowState)) {
    return {
      status: "fail",
      issues: [issue("invalid_workflow_state", "workflow state must be an object", "workflow_state")]
    };
  }

  const runId = normalizeString(workflowState?.manifest?.run_id);
  const cycleId = normalizeString(workflowState?.manifest?.cycle_id);
  if (!runId || !cycleId) {
    return {
      status: "fail",
      issues: [issue("missing_workflow_identity", "workflow state manifest run_id and cycle_id are required", "workflow_state.manifest")]
    };
  }

  const createdAt = normalizeString(options.created_at || options.createdAt) || new Date().toISOString();
  const id = nextPolicyArtifactId(workflowState, options);
  const status = policyStatus(policy);
  const plan = options.plan || {};
  const artifact = {
    id,
    type: "evaluation",
    status,
    uri: `scheduler-dispatch://policy/${encodeURIComponent(runId)}/${encodeURIComponent(cycleId)}/${encodeURIComponent(id)}`,
    producer: "scheduler-dispatch-policy",
    created_at: createdAt,
    metadata: {
      type: "scheduler_dispatch_policy",
      version: SCHEDULER_DISPATCH_POLICY_VERSION,
      run_id: runId,
      cycle_id: cycleId,
      status,
      execution_mode: policy.execution_mode || null,
      controls: policy.controls || {},
      issues: asArray(policy.issues),
      plan_status: plan.status || null,
      plan_phase: plan.phase || null,
      plan_step_count: asArray(plan.steps).length
    }
  };

  const manifest = appendRunEvent(workflowState.manifest, {
    id: `event-${id}`,
    type: "scheduler_dispatch_policy",
    status,
    artifact_id: id,
    message: `scheduler dispatch policy ${policy.execution_mode || "unknown"} ${status}`,
    created_at: createdAt,
    metadata: artifact.metadata
  });
  const baseLedger = workflowState.artifact_ledger || workflowState.artifactLedger || {};
  const artifactLedger = recordArtifact({
    ...baseLedger,
    artifacts: Array.isArray(baseLedger.artifacts) ? baseLedger.artifacts : []
  }, artifact);

  return {
    status: "pass",
    artifact,
    workflow_state: {
      ...workflowState,
      manifest: {
        ...manifest,
        artifacts: [...asArray(manifest.artifacts), artifact]
      },
      artifact_ledger: artifactLedger
    }
  };
}

export { SCHEDULER_DISPATCH_POLICY_VERSION };
