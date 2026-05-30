// Reviewer + headless-child provider/shard summarizers, extracted from
// workbench-projection.js (P2-8 god-file split #2). Each turns a run manifest +
// artifact ledger into a projection sub-summary. Pure; depends only on local array/
// string normalization. Called once each from createWorkbenchProjection.

function asArray(value) {
  return Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : value === null || value === undefined ? "" : String(value).trim();
}

export function summarizeReviewerProviderHealth(manifest = {}, artifactLedger = {}) {
  const events = asArray(manifest?.events).filter((event) => event?.type === "reviewer_provider_health");
  const latestEvent = events.at(-1) || null;
  if (!latestEvent) {
    return {
      status: "not_configured",
      provider_health: "unknown",
      retry_strategy: null,
      next_action: null,
      provider: null,
      model: null,
      event_id: null,
      artifact_id: null,
      created_at: null
    };
  }

  const artifacts = [
    ...asArray(artifactLedger?.artifacts),
    ...asArray(manifest?.artifacts)
  ];
  const artifact = artifacts.find((entry) => entry.id === latestEvent.artifact_id) || null;
  const metadata = artifact?.metadata || latestEvent.metadata || {};
  const scheduledActions = asArray(metadata.scheduled_actions);

  return {
    status: latestEvent.status || metadata.recovery_status || "unknown",
    provider_health: metadata.provider_health || "unknown",
    retry_strategy: metadata.retry_strategy || null,
    next_action: scheduledActions[0] || null,
    provider: metadata.provider || null,
    model: metadata.model || null,
    event_id: latestEvent.id || null,
    artifact_id: latestEvent.artifact_id || artifact?.id || null,
    created_at: latestEvent.created_at || artifact?.created_at || null
  };
}

export function summarizeReviewerScopeSplit(manifest = {}, artifactLedger = {}) {
  const events = asArray(manifest?.events).filter((event) => event?.type === "reviewer_scope_split");
  const latestEvent = events.at(-1) || null;
  if (!latestEvent) {
    return {
      status: "not_configured",
      shard_count: 0,
      pending_shards: 0,
      next_shard: null,
      split_required: false,
      provider: null,
      model: null,
      event_id: null,
      artifact_id: null,
      created_at: null
    };
  }

  const artifacts = [
    ...asArray(artifactLedger?.artifacts),
    ...asArray(manifest?.artifacts)
  ];
  const artifact = artifacts.find((entry) => entry.id === latestEvent.artifact_id) || null;
  const metadata = artifact?.metadata || latestEvent.metadata || {};
  const shards = asArray(metadata.shards);
  const pendingShards = shards.filter((shard) => {
    const status = normalizeString(shard?.status).toLowerCase();
    return status !== "completed" && status !== "pass";
  });

  return {
    status: latestEvent.status || metadata.status || "unknown",
    shard_count: metadata.shard_count || shards.length,
    pending_shards: metadata.pending_shards || pendingShards.length,
    next_shard: pendingShards[0]?.id || null,
    shard_ids: shards.map((shard) => normalizeString(shard?.id)).filter(Boolean),
    split_required: Boolean(metadata.split_required),
    provider: metadata.provider || null,
    model: metadata.model || null,
    event_id: latestEvent.id || null,
    artifact_id: latestEvent.artifact_id || artifact?.id || null,
    created_at: latestEvent.created_at || artifact?.created_at || null
  };
}

export function summarizeReviewerShardReview(manifest = {}, artifactLedger = {}) {
  const split = summarizeReviewerScopeSplit(manifest, artifactLedger);
  const resultEvents = asArray(manifest?.events).filter((event) => event?.type === "reviewer_shard_result");
  const aggregateEvents = asArray(manifest?.events).filter((event) => event?.type === "reviewer_shard_aggregate");
  const latestResult = resultEvents.at(-1) || null;
  const latestAggregate = aggregateEvents.at(-1) || null;
  const artifacts = [
    ...asArray(artifactLedger?.artifacts),
    ...asArray(manifest?.artifacts)
  ];
  const resultArtifact = latestResult
    ? artifacts.find((entry) => entry.id === latestResult.artifact_id) || null
    : null;
  const resultMetadata = resultArtifact?.metadata || latestResult?.metadata || {};
  const provenance = resultMetadata.executor_provenance || {};
  const aggregateArtifact = latestAggregate
    ? artifacts.find((entry) => entry.id === latestAggregate.artifact_id) || null
    : null;
  const aggregate = aggregateArtifact?.metadata || latestAggregate?.metadata || null;

  if (!aggregate && resultEvents.length === 0) {
    return {
      status: "not_configured",
      total_shards: split.shard_count || 0,
      completed_shards: 0,
      pending_shards: split.pending_shards || split.shard_count || 0,
      failed_finding_count: 0,
      finding_count: 0,
      next_shard: split.next_shard || null,
      latest_executor_kind: null,
      latest_execution_profile: null,
      latest_provider: null,
      latest_model: null,
      latest_external_call_budget_used: 0,
      event_id: null,
      artifact_id: null,
      created_at: null
    };
  }

  const completedIds = new Set(resultEvents.map((event) => normalizeString(event?.metadata?.shard_id)).filter(Boolean));
  const pendingFromSplit = Math.max(0, (split.shard_count || 0) - completedIds.size);
  const pendingShardIds = asArray(split.shard_ids).filter((id) => !completedIds.has(normalizeString(id)));

  return {
    status: aggregate?.status || (pendingFromSplit > 0 ? "pending" : "pass"),
    total_shards: aggregate?.total_shards || split.shard_count || completedIds.size,
    completed_shards: aggregate?.completed_shards || completedIds.size,
    pending_shards: aggregate?.pending_shards ?? pendingFromSplit,
    failed_finding_count: aggregate?.failed_finding_count || 0,
    finding_count: aggregate?.finding_count || 0,
    next_shard: aggregate?.pending_shard_ids?.[0] || pendingShardIds[0] || (pendingFromSplit > 0 ? split.next_shard : null),
    latest_executor_kind: provenance.executor_kind || null,
    latest_execution_profile: provenance.execution_profile || null,
    latest_provider: provenance.provider || resultMetadata.provider || null,
    latest_model: provenance.model || resultMetadata.model || null,
    latest_external_call_budget_used: provenance.external_call_budget_used ?? 0,
    event_id: latestAggregate?.id || null,
    artifact_id: latestAggregate?.artifact_id || aggregateArtifact?.id || null,
    created_at: latestAggregate?.created_at || aggregateArtifact?.created_at || null
  };
}

export function summarizeHeadlessChildProvider(manifest = {}, artifactLedger = {}) {
  const events = asArray(manifest?.events).filter((event) => event?.type === "context_work_packages_run");
  const latestEvent = events.at(-1) || null;
  if (!latestEvent) {
    return {
      status: "not_configured",
      provider: null,
      model: null,
      command_runner_kind: null,
      executor_kind: null,
      mock_child_worker: false,
      max_attempts: 0,
      split_retry: false,
      package_count: 0,
      accepted_count: 0,
      rejected_count: 0,
      attempt_count: 0,
      retry_attempt_count: 0,
      split_retry_attempt_count: 0,
      latest_attempt_status: null,
      event_id: null,
      artifact_id: null,
      created_at: null
    };
  }

  const artifacts = [
    ...asArray(artifactLedger?.artifacts),
    ...asArray(manifest?.artifacts)
  ];
  const artifact = artifacts.find((entry) => entry.id === latestEvent.artifact_id) || null;
  const metadata = artifact?.metadata || latestEvent.metadata || {};
  const provenance = metadata.executor_provenance || {};
  const retryPolicy = provenance.retry_policy || {};
  const packageResults = asArray(metadata.package_results);
  const attempts = packageResults.flatMap((result) => (
    asArray(result?.completion_evidence?.child_output?.command_evidence?.attempts)
      .map((attempt) => ({ ...attempt, work_package_id: result.work_package_id || result.workPackageId || null }))
  ));
  const explicitMockChildWorker = packageResults.some((result) => {
    const childOutput = result?.completion_evidence?.child_output || {};
    return childOutput.mock_allowed === true ||
      childOutput.command_evidence?.mock_allowed === true ||
      childOutput.completion_evidence?.mock_allowed === true;
  });

  return {
    status: latestEvent.status || metadata.status || artifact?.status || "unknown",
    provider: provenance.provider || null,
    model: provenance.model || null,
    command_runner_kind: provenance.command_runner_kind || null,
    executor_kind: provenance.executor_kind || null,
    mock_child_worker: explicitMockChildWorker ||
      provenance.mock_child_worker === true ||
      provenance.mockChildWorker === true ||
      normalizeString(provenance.command_runner_kind || provenance.commandRunnerKind) === "mock_child_worker",
    max_attempts: Number(retryPolicy.max_attempts || retryPolicy.maxAttempts || 0),
    split_retry: retryPolicy.split_retry === true || retryPolicy.splitRetry === true,
    package_count: packageResults.length,
    accepted_count: packageResults.filter((result) => result?.status === "pass").length,
    rejected_count: packageResults.filter((result) => result?.status && result.status !== "pass").length,
    attempt_count: attempts.length,
    retry_attempt_count: attempts.filter((attempt) => Number(attempt?.attempt || 0) > 1).length,
    split_retry_attempt_count: attempts.filter((attempt) => attempt?.split_retry === true).length,
    latest_attempt_status: attempts.at(-1)?.status || null,
    event_id: latestEvent.id || null,
    artifact_id: latestEvent.artifact_id || artifact?.id || null,
    created_at: latestEvent.created_at || artifact?.created_at || null
  };
}

export function summarizeHeadlessProjectedActionProgress(manifest = {}, artifactLedger = {}) {
  const events = asArray(manifest?.events).filter((event) => event?.type === "headless_projected_action_progress");
  const latestEvent = events.at(-1) || null;
  if (!latestEvent) {
    return {
      status: "not_configured",
      action: null,
      next_projection_id: null,
      has_workflow_state: false,
      has_projection: false,
      issue_count: 0,
      latest_issue: null,
      event_id: null,
      artifact_id: null,
      created_at: null
    };
  }

  const artifacts = [
    ...asArray(artifactLedger?.artifacts),
    ...asArray(manifest?.artifacts)
  ];
  const artifact = artifacts.find((entry) => entry.id === latestEvent.artifact_id) || null;
  const metadata = artifact?.metadata || latestEvent.metadata || {};
  const issues = asArray(metadata.issues);

  return {
    status: metadata.status || latestEvent.status || artifact?.status || "unknown",
    action: metadata.action || null,
    next_projection_id: metadata.next_projection_id || null,
    has_workflow_state: metadata.has_workflow_state === true,
    has_projection: metadata.has_projection === true,
    issue_count: issues.length,
    latest_issue: issues[0]?.message || issues[0]?.code || null,
    event_id: latestEvent.id || null,
    artifact_id: latestEvent.artifact_id || artifact?.id || null,
    created_at: latestEvent.created_at || artifact?.created_at || null
  };
}
