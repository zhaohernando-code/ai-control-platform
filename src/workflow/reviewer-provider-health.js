import { recordArtifact } from "./artifact-ledger.js";
import { classifyReviewerTimeoutRecovery, createReviewerGateRequest } from "./llm-reviewer-gate.js";
import { appendRunEvent } from "./run-manifest.js";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function safeIdPart(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function issue(code, message, path) {
  return { code, message, path };
}

function workflowStateIdentityIssues(workflowState = {}) {
  const manifestRunId = normalizeString(workflowState?.manifest?.run_id);
  const manifestCycleId = normalizeString(workflowState?.manifest?.cycle_id);
  const ledger = workflowState?.artifact_ledger || workflowState?.artifactLedger || {};
  const ledgerRunId = normalizeString(ledger.run_id);
  const ledgerCycleId = normalizeString(ledger.cycle_id);
  const issues = [];

  if (!manifestRunId || !manifestCycleId) {
    issues.push(issue("missing_manifest_identity", "manifest run_id and cycle_id are required", "manifest"));
  }
  if (!ledgerRunId || !ledgerCycleId) {
    issues.push(issue("missing_artifact_ledger_identity", "artifact ledger run_id and cycle_id are required", "artifact_ledger"));
  }
  if (manifestRunId && ledgerRunId && manifestRunId !== ledgerRunId) {
    issues.push(issue("workflow_state_run_mismatch", "manifest run_id does not match artifact ledger run_id", "artifact_ledger.run_id"));
  }
  if (manifestCycleId && ledgerCycleId && manifestCycleId !== ledgerCycleId) {
    issues.push(issue("workflow_state_cycle_mismatch", "manifest cycle_id does not match artifact ledger cycle_id", "artifact_ledger.cycle_id"));
  }

  return issues;
}

function nextFactId(workflowState = {}, explicitId = "") {
  const runId = safeIdPart(workflowState?.manifest?.run_id);
  const cycleId = safeIdPart(workflowState?.manifest?.cycle_id);
  const prefix = explicitId || `reviewer-provider-health-${runId}-${cycleId}`;
  const artifacts = workflowState?.artifact_ledger?.artifacts || workflowState?.artifactLedger?.artifacts || [];
  const events = workflowState?.manifest?.events || [];
  const usedIds = new Set([
    ...artifacts.map((item) => item?.id).filter(Boolean),
    ...events.map((item) => normalizeString(item?.artifact_id)).filter(Boolean)
  ]);
  if (explicitId && !usedIds.has(explicitId)) return explicitId;

  let index = 1;
  let id = `${prefix}-${String(index).padStart(3, "0")}`;
  while (usedIds.has(id)) {
    index += 1;
    id = `${prefix}-${String(index).padStart(3, "0")}`;
  }
  return id;
}

function scheduledActionsFor(recovery = {}) {
  if (recovery.status === "needs_smoke_check") return ["provider_smoke_check"];
  if (recovery.status === "blocked") return ["fallback_model_or_defer_external_review"];
  if (recovery.retry_strategy === "rerun_without_tools_or_split_scope") return ["rerun_without_tools", "split_scope"];
  if (recovery.retry_strategy === "split_scope") return ["split_scope"];
  return [];
}

export function createReviewerProviderHealthFact(input = {}) {
  const request = createReviewerGateRequest(input.request || input);
  const recovery = classifyReviewerTimeoutRecovery({
    request,
    smoke_status: input.smoke_status || input.smokeStatus || input.provider_smoke_status,
    tools: input.tools || input.allowed_tools || request.allowed_tools
  });
  const runId = normalizeString(input.run_id || request.run_id);
  const cycleId = normalizeString(input.cycle_id || request.cycle_id);
  const createdAt = normalizeString(input.created_at) || new Date().toISOString();
  const status = recovery.status === "blocked" ? "fail" : "pass";

  return {
    id: normalizeString(input.id),
    type: "reviewer_provider_health",
    status,
    run_id: runId,
    cycle_id: cycleId,
    provider: request.provider.provider,
    model: request.provider.model,
    provider_health: recovery.provider_health,
    recovery_status: recovery.status,
    retry_strategy: recovery.retry_strategy,
    scheduled_actions: scheduledActionsFor(recovery),
    created_at: createdAt,
    reason: recovery.reason,
    invocation_policy: recovery.invocation_policy,
    source: {
      category: "reviewer_timeout",
      smoke_status: normalizeString(input.smoke_status || input.smokeStatus || input.provider_smoke_status) || null,
      tools: asArray(input.tools || input.allowed_tools || request.allowed_tools)
    }
  };
}

export function createReviewerRetrySchedule(input = {}) {
  const fact = createReviewerProviderHealthFact(input);

  return {
    status: fact.recovery_status,
    provider_health: fact.provider_health,
    retry_strategy: fact.retry_strategy,
    scheduled_actions: fact.scheduled_actions,
    next_action: fact.scheduled_actions[0] || null,
    fact
  };
}

export function recordReviewerProviderHealthFact(workflowState = {}, input = {}) {
  if (!isObject(workflowState)) {
    return {
      status: "fail",
      issues: [issue("invalid_workflow_state", "workflow state must be an object", "workflow_state")]
    };
  }

  const identityIssues = workflowStateIdentityIssues(workflowState);
  if (identityIssues.length > 0) {
    return {
      status: "fail",
      issues: identityIssues
    };
  }

  const baseFact = createReviewerProviderHealthFact({
    run_id: workflowState.manifest.run_id,
    cycle_id: workflowState.manifest.cycle_id,
    ...input
  });
  const id = nextFactId(workflowState, baseFact.id);
  const fact = { ...baseFact, id };
  const artifact = {
    id,
    type: "evaluation",
    status: fact.status,
    uri: `codex://reviewer-provider-health/${encodeURIComponent(fact.run_id)}/${encodeURIComponent(fact.cycle_id)}/${encodeURIComponent(id)}`,
    producer: "reviewer-provider-health",
    created_at: fact.created_at,
    metadata: fact
  };
  const manifest = appendRunEvent(workflowState.manifest, {
    id: `event-${id}`,
    type: "reviewer_provider_health",
    status: fact.recovery_status,
    artifact_id: id,
    message: fact.reason,
    created_at: fact.created_at,
    metadata: fact
  });
  const manifestArtifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  const baseLedger = workflowState.artifact_ledger || workflowState.artifactLedger || {};
  const artifactLedger = recordArtifact({
    ...baseLedger,
    artifacts: Array.isArray(baseLedger.artifacts) ? baseLedger.artifacts : []
  }, artifact);

  return {
    status: "pass",
    fact,
    workflow_state: {
      ...workflowState,
      manifest: {
        ...manifest,
        artifacts: [...manifestArtifacts, artifact]
      },
      artifact_ledger: artifactLedger
    }
  };
}

export { scheduledActionsFor };
