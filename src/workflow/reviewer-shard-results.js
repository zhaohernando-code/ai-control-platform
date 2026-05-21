import { recordArtifact } from "./artifact-ledger.js";
import { createReviewerGateRequest, normalizeReviewerFindings } from "./llm-reviewer-gate.js";
import { appendRunEvent } from "./run-manifest.js";

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
  return value && typeof value === "object" && !Array.isArray(value);
}

function safeIdPart(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function issue(code, message, path) {
  return { code, message, path };
}

function statusOf(value) {
  const status = normalizeToken(value?.status || value?.result || value?.outcome || value);
  if (["pass", "passed", "ok", "success", "succeeded", "completed", "complete"].includes(status)) return "pass";
  if (["fail", "failed", "error", "errored", "blocked", "timeout", "timed_out"].includes(status)) return "fail";
  return status || "pending";
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

function nextFactId(workflowState = {}, prefixName, explicitId = "") {
  const runId = safeIdPart(workflowState?.manifest?.run_id);
  const cycleId = safeIdPart(workflowState?.manifest?.cycle_id);
  const prefix = explicitId || `${prefixName}-${runId}-${cycleId}`;
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

function latestScopeSplitPlan(workflowState = {}) {
  const events = asArray(workflowState?.manifest?.events)
    .filter((event) => event?.type === "reviewer_scope_split");
  return events.at(-1)?.metadata || null;
}

function splitPlanFrom(input = {}, workflowState = {}) {
  return input.split_plan || input.splitPlan || latestScopeSplitPlan(workflowState);
}

function shardFrom(input = {}, splitPlan = {}) {
  if (input.shard && isObject(input.shard)) return input.shard;
  const shardId = normalizeString(input.shard_id || input.shardId);
  return asArray(splitPlan?.shards).find((item) => item?.id === shardId) || null;
}

function requestFromShard(shard = {}, splitPlan = {}) {
  return createReviewerGateRequest({
    run_id: shard.run_id || splitPlan.run_id,
    cycle_id: shard.cycle_id || splitPlan.cycle_id,
    provider: {
      provider: shard.provider || splitPlan.provider,
      model: shard.model || splitPlan.model,
      tooling: shard.dispatch_mode === "no_tools" ? "none" : "read-only"
    },
    scope: shard.scope || splitPlan.scope || splitPlan.split_reason || "Reviewer scope shard",
    files: shard.files,
    questions: shard.questions,
    forbidden_actions: shard.forbidden_actions,
    output_contract: shard.output_contract,
    read_only: true,
    allowed_tools: shard.allowed_tools || []
  });
}

function enrichFinding(finding, shard = {}) {
  const evidence = finding.evidence && typeof finding.evidence === "object" && !Array.isArray(finding.evidence)
    ? finding.evidence
    : {};
  return {
    ...finding,
    evidence: {
      ...evidence,
      shard_id: shard.id,
      files: asArray(shard.files)
    }
  };
}

function dedupeFindings(findings) {
  const seen = new Set();
  const result = [];
  for (const finding of asArray(findings)) {
    const id = normalizeString(finding.finding_id || finding.id || finding.code || finding.message);
    const key = id || JSON.stringify(finding);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(finding);
  }
  return result;
}

export function createReviewerShardResult(input = {}) {
  const splitPlan = splitPlanFrom(input);
  const shard = shardFrom(input, splitPlan || {});
  const issues = [];

  if (!splitPlan) {
    issues.push(issue("missing_reviewer_scope_split", "reviewer scope split plan is required", "split_plan"));
  }
  if (!shard) {
    issues.push(issue("missing_reviewer_scope_shard", "reviewer scope shard is required", "shard_id"));
  }

  const request = shard ? requestFromShard(shard, splitPlan || {}) : createReviewerGateRequest(input.request || input);
  const normalizedFindings = normalizeReviewerFindings(asArray(input.findings || input.review_findings).map((finding) => enrichFinding(finding, shard || {})), request);
  const explicitStatus = normalizeToken(input.status || input.result || input.outcome);
  const status = issues.length > 0
    ? "fail"
    : (explicitStatus ? statusOf(explicitStatus) : (normalizedFindings.some((finding) => finding.status === "fail") ? "fail" : "pass"));
  const createdAt = normalizeString(input.created_at) || new Date().toISOString();

  return {
    id: normalizeString(input.id),
    type: "reviewer_shard_result",
    status,
    run_id: request.run_id || splitPlan?.run_id || null,
    cycle_id: request.cycle_id || splitPlan?.cycle_id || null,
    provider: request.provider.provider,
    model: request.provider.model,
    shard_id: shard?.id || normalizeString(input.shard_id || input.shardId) || null,
    files: asArray(shard?.files),
    questions: asArray(shard?.questions),
    findings: normalizedFindings,
    finding_count: normalizedFindings.length,
    failed_finding_count: normalizedFindings.filter((finding) => finding.status === "fail").length,
    created_at: createdAt,
    issues
  };
}

export function createReviewerShardAggregate(input = {}) {
  const splitPlan = splitPlanFrom(input);
  const shardResults = asArray(input.shard_results || input.shardResults || input.results);
  const expectedShardIds = asArray(splitPlan?.shards).map((shard) => shard.id).filter(Boolean);
  const resultsByShard = new Map(shardResults.map((result) => [normalizeString(result.shard_id || result.shardId), result]));
  const completedShardIds = expectedShardIds.filter((id) => resultsByShard.has(id));
  const pendingShardIds = expectedShardIds.filter((id) => !resultsByShard.has(id));
  const mergedFindings = dedupeFindings(shardResults.flatMap((result) => asArray(result.findings)));
  const failedFindingCount = mergedFindings.filter((finding) => finding.status === "fail").length;
  const failedResultCount = shardResults.filter((result) => statusOf(result) === "fail").length;
  const issues = [];

  if (!splitPlan) {
    issues.push(issue("missing_reviewer_scope_split", "reviewer scope split plan is required", "split_plan"));
  }
  if (expectedShardIds.length > 0) {
    for (const result of shardResults) {
      const shardId = normalizeString(result.shard_id || result.shardId);
      if (shardId && !expectedShardIds.includes(shardId)) {
        issues.push(issue("unknown_reviewer_scope_shard", `${shardId} is not in the latest split plan`, `shard_results.${shardId}`));
      }
    }
  }

  let status = "pending";
  if (issues.length > 0) status = "fail";
  else if (pendingShardIds.length > 0) status = "pending";
  else if (failedFindingCount > 0 || failedResultCount > 0) status = "fail";
  else status = "pass";

  return {
    id: normalizeString(input.id),
    type: "reviewer_shard_aggregate",
    status,
    run_id: splitPlan?.run_id || null,
    cycle_id: splitPlan?.cycle_id || null,
    provider: splitPlan?.provider || null,
    model: splitPlan?.model || null,
    total_shards: expectedShardIds.length,
    completed_shards: completedShardIds.length,
    pending_shards: pendingShardIds.length,
    pending_shard_ids: pendingShardIds,
    shard_result_count: shardResults.length,
    failed_result_count: failedResultCount,
    finding_count: mergedFindings.length,
    failed_finding_count: failedFindingCount,
    merged_findings: mergedFindings,
    created_at: normalizeString(input.created_at) || new Date().toISOString(),
    issues
  };
}

function shardResultsFromWorkflowState(workflowState = {}) {
  const events = asArray(workflowState?.manifest?.events)
    .filter((event) => event?.type === "reviewer_shard_result");
  const artifacts = [
    ...asArray(workflowState?.artifact_ledger?.artifacts || workflowState?.artifactLedger?.artifacts),
    ...asArray(workflowState?.manifest?.artifacts)
  ];

  return events.map((event) => {
    const artifact = artifacts.find((entry) => entry?.id === event.artifact_id);
    return artifact?.metadata || event.metadata;
  }).filter(Boolean);
}

function appendUniqueReviewFindings(manifest = {}, findings = []) {
  return {
    ...manifest,
    review_findings: dedupeFindings([
      ...asArray(manifest.review_findings),
      ...asArray(findings)
    ])
  };
}

export function recordReviewerShardResult(workflowState = {}, input = {}) {
  if (!isObject(workflowState)) {
    return {
      status: "fail",
      issues: [issue("invalid_workflow_state", "workflow state must be an object", "workflow_state")]
    };
  }

  const identityIssues = workflowStateIdentityIssues(workflowState);
  if (identityIssues.length > 0) {
    return { status: "fail", issues: identityIssues };
  }

  const result = createReviewerShardResult({
    split_plan: latestScopeSplitPlan(workflowState),
    ...input
  });
  if (result.issues.length > 0) {
    return { status: "fail", issues: result.issues };
  }

  const id = nextFactId(workflowState, `reviewer-shard-result-${safeIdPart(result.shard_id)}`, result.id);
  const fact = { ...result, id };
  const artifact = {
    id,
    type: "review",
    status: fact.status,
    uri: `codex://reviewer-shard-result/${encodeURIComponent(fact.run_id)}/${encodeURIComponent(fact.cycle_id)}/${encodeURIComponent(id)}`,
    producer: "reviewer-shard-result",
    created_at: fact.created_at,
    metadata: fact
  };
  const manifest = appendRunEvent(workflowState.manifest, {
    id: `event-${id}`,
    type: "reviewer_shard_result",
    status: fact.status,
    artifact_id: id,
    message: `${fact.shard_id} reviewer shard completed with ${fact.failed_finding_count} failed finding(s).`,
    created_at: fact.created_at,
    metadata: fact
  });
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
        artifacts: [...asArray(manifest.artifacts), artifact]
      },
      artifact_ledger: artifactLedger
    }
  };
}

export function recordReviewerShardAggregate(workflowState = {}, input = {}) {
  if (!isObject(workflowState)) {
    return {
      status: "fail",
      issues: [issue("invalid_workflow_state", "workflow state must be an object", "workflow_state")]
    };
  }

  const identityIssues = workflowStateIdentityIssues(workflowState);
  if (identityIssues.length > 0) {
    return { status: "fail", issues: identityIssues };
  }

  const aggregate = createReviewerShardAggregate({
    split_plan: latestScopeSplitPlan(workflowState),
    shard_results: shardResultsFromWorkflowState(workflowState),
    ...input
  });
  if (aggregate.issues.length > 0) {
    return { status: "fail", issues: aggregate.issues };
  }

  const id = nextFactId(workflowState, "reviewer-shard-aggregate", aggregate.id);
  const fact = { ...aggregate, id };
  const artifact = {
    id,
    type: "review",
    status: fact.status === "pending" ? "pass" : fact.status,
    uri: `codex://reviewer-shard-aggregate/${encodeURIComponent(fact.run_id)}/${encodeURIComponent(fact.cycle_id)}/${encodeURIComponent(id)}`,
    producer: "reviewer-shard-aggregate",
    created_at: fact.created_at,
    metadata: fact
  };
  const manifestWithEvent = appendRunEvent(workflowState.manifest, {
    id: `event-${id}`,
    type: "reviewer_shard_aggregate",
    status: fact.status,
    artifact_id: id,
    message: `Reviewer shard aggregate ${fact.completed_shards}/${fact.total_shards} completed with ${fact.failed_finding_count} failed finding(s).`,
    created_at: fact.created_at,
    metadata: fact
  });
  const manifest = fact.status === "pending"
    ? manifestWithEvent
    : appendUniqueReviewFindings(manifestWithEvent, fact.merged_findings);
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
        artifacts: [...asArray(manifest.artifacts), artifact]
      },
      artifact_ledger: artifactLedger
    }
  };
}

export { latestScopeSplitPlan, shardResultsFromWorkflowState };
