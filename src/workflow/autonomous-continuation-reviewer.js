import { evaluateRunResult } from "./autonomous-run.js";
import {
  asArray,
  compactStrings,
  normalizeString,
  normalizeToken,
  ROLLBACK_STATUSES,
  statusOf,
  STOP_STATUSES,
  workflowStateFrom
} from "./autonomous-continuation-utils.js";

export const REVIEWER_SMOKE_STALL_THRESHOLD = 2;

export function reviewerSmokeStallBlockers(input) {
  const stall = reviewerProviderSmokeStall(input);
  if (!stall.stalled) return [];
  return [{
    id: "reviewer_provider_smoke_stalled",
    category: "recovery_exhausted",
    message: stall.reason,
    requires_human: true,
    smoke_check_count: stall.smoke_check_count,
    threshold: REVIEWER_SMOKE_STALL_THRESHOLD
  }];
}

function explicitRunEvaluation(input = {}) {
  return input?.run_evaluation || input?.runEvaluation || null;
}

function latestReviewerShardAggregate(input = {}) {
  const explicit = input?.reviewer_shard_aggregate || input?.reviewerShardAggregate;
  if (explicit) return explicit;

  const events = asArray(input?.workflow_state?.manifest?.events)
    .filter((event) => event?.type === "reviewer_shard_aggregate");
  return events.at(-1)?.metadata || null;
}

export function latestCompletedReviewerShardAggregate(input = {}) {
  const aggregate = latestReviewerShardAggregate(input);
  if (!aggregate) return null;
  if (normalizeToken(aggregate.status) === "pending" || Number(aggregate.pending_shards || 0) > 0) return null;
  return aggregate;
}

function reviewerShardAggregateEvaluation(input = {}) {
  const aggregate = latestCompletedReviewerShardAggregate(input);
  const workflowState = workflowStateFrom(input);
  const manifest = workflowState?.manifest;
  if (!aggregate || !manifest) return null;

  return evaluateRunResult({
    ...manifest,
    artifacts: asArray(manifest.artifacts).filter((artifact) => !preAggregateReviewerRecoveryArtifact(artifact)),
    review_findings: asArray(aggregate.merged_findings)
  });
}

function preAggregateReviewerRecoveryArtifact(artifact = {}) {
  const metadata = artifact.metadata || {};
  const type = normalizeToken(metadata.type || artifact.type || artifact.producer);
  const category = normalizeToken(metadata.category || metadata.source?.category || artifact.category);
  const producer = normalizeToken(artifact.producer || metadata.producer);
  return Boolean(
    type === "reviewer_gate" ||
      type === "reviewer_provider_health" ||
      type === "reviewer_scope_split" ||
      type === "reviewer_shard_result" ||
      category === "reviewer_timeout" ||
      producer === "reviewer-provider-health" ||
      producer === "reviewer-scope-splitter" ||
      producer === "reviewer-shard-result" ||
      producer === "reviewer-shard-aggregate" ||
      normalizeString(artifact.id).includes("reviewer-timeout")
  );
}

export function runEvaluationFrom(input = {}) {
  const explicit = explicitRunEvaluation(input);
  const explicitStatus = statusOf(explicit);
  if (STOP_STATUSES.has(explicitStatus) || ROLLBACK_STATUSES.has(explicitStatus)) {
    return explicit;
  }

  return reviewerShardAggregateEvaluation(input) || explicit;
}

function latestReviewerProviderHealth(input = {}) {
  const explicit = input?.reviewer_provider_health || input?.provider_health || input?.workflow_state?.reviewer_provider_health;
  if (explicit) return explicit;

  const events = asArray(input?.workflow_state?.manifest?.events)
    .filter((event) => event?.type === "reviewer_provider_health");
  return events.at(-1)?.metadata || null;
}

function latestReviewerScopeSplit(input = {}) {
  const explicit = input?.reviewer_scope_split || input?.scope_split || input?.workflow_state?.reviewer_scope_split;
  if (explicit) return explicit;

  const events = asArray(input?.workflow_state?.manifest?.events)
    .filter((event) => event?.type === "reviewer_scope_split");
  return events.at(-1)?.metadata || null;
}

function reviewerShardResultIds(input = {}) {
  return new Set(asArray(input?.workflow_state?.manifest?.events)
    .filter((event) => event?.type === "reviewer_shard_result")
    .map((event) => normalizeString(event?.metadata?.shard_id || event?.metadata?.shardId))
    .filter(Boolean));
}

function providerHealthActionTitle(action) {
  return {
    provider_smoke_check: "Run reviewer provider smoke check",
    rerun_without_tools: "Rerun DeepSeek reviewer without tools",
    split_scope: "Split reviewer scope into smaller checks",
    fallback_model_or_defer_external_review: "Fallback reviewer model or defer external review"
  }[action] || `Handle reviewer provider action ${action}`;
}

function providerHealthOwnedFiles(action) {
  if (action === "fallback_model_or_defer_external_review") {
    return ["src/workflow/model-router.js", "src/workflow/reviewer-provider-health.js"];
  }
  return ["src/workflow/llm-reviewer-gate.js", "src/workflow/reviewer-provider-health.js"];
}

function reviewerProviderHealthEvents(input = {}) {
  return asArray(input?.workflow_state?.manifest?.events)
    .filter((event) => event?.type === "reviewer_provider_health");
}

function isNeedsSmokeCheckEvent(event = {}) {
  const meta = event?.metadata || {};
  if (normalizeToken(meta.recovery_status) === "needs_smoke_check") return true;
  const actions = asArray(meta.scheduled_actions || meta.scheduledActions);
  return actions.length === 1 && normalizeToken(actions[0]) === "provider_smoke_check";
}

export function reviewerProviderSmokeStall(input = {}) {
  const events = reviewerProviderHealthEvents(input);
  if (events.length === 0) {
    return { stalled: false, smoke_check_count: 0, reason: null };
  }
  let trailing = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (isNeedsSmokeCheckEvent(events[i])) {
      trailing += 1;
    } else {
      break;
    }
  }
  if (trailing < REVIEWER_SMOKE_STALL_THRESHOLD) {
    return { stalled: false, smoke_check_count: trailing, reason: null };
  }
  return {
    stalled: true,
    smoke_check_count: trailing,
    reason: `reviewer provider smoke check generated ${trailing} consecutive times without resolution; stop scheduling reviewer work until a human resolves provider health`
  };
}

export function reviewerProviderWorkPackagesFrom(input = {}) {
  const stall = reviewerProviderSmokeStall(input);
  if (stall.stalled) return [];

  const health = latestReviewerProviderHealth(input);
  const splitPlan = latestReviewerScopeSplit(input);
  const hasConcreteSplitShards = asArray(splitPlan?.shards).length > 0 && splitPlan?.status !== "fail";
  const actions = asArray(health?.scheduled_actions || health?.scheduledActions);
  const nextAction = normalizeString(health?.next_action || health?.nextAction);
  const scheduledActions = actions.length > 0 ? actions : (nextAction ? [nextAction] : []);

  return scheduledActions
    .filter((action) => !(action === "split_scope" && hasConcreteSplitShards))
    .map((action) => ({
      id: `reviewer-provider-${normalizeString(action).replace(/_/g, "-")}`,
      title: providerHealthActionTitle(action),
      action,
      owned_files: providerHealthOwnedFiles(action),
      reason: health?.reason || health?.retry_strategy || "reviewer provider health requires scheduler follow-up"
    }));
}

export function reviewerScopeSplitWorkPackagesFrom(input = {}) {
  const splitPlan = latestReviewerScopeSplit(input);
  const completedShardIds = reviewerShardResultIds(input);
  if (!splitPlan || splitPlan.status === "fail") return [];

  return asArray(splitPlan.shards)
    .filter((shard) => statusOf(shard) !== "completed" && statusOf(shard) !== "pass")
    .filter((shard) => !completedShardIds.has(normalizeString(shard.id)))
    .map((shard) => ({
      id: normalizeString(shard.id),
      title: `Run bounded reviewer shard ${normalizeString(shard.id).replace(/^reviewer-scope-shard-/, "")}`,
      action: "run_reviewer_scope_shard",
      shard_id: normalizeString(shard.id),
      owned_files: compactStrings(shard.files),
      reason: splitPlan.split_reason || "reviewer scope split plan requires per-shard external review",
      reviewer: {
        provider: shard.provider || splitPlan.provider,
        model: shard.model || splitPlan.model,
        profile: shard.profile || splitPlan.profile,
        allowed_tools: asArray(shard.allowed_tools),
        dispatch_mode: shard.dispatch_mode
      }
    }))
    .filter((workPackage) => workPackage.id);
}
