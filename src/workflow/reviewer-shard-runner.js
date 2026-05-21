import {
  recordReviewerShardAggregate,
  recordReviewerShardResult,
  shardResultsFromWorkflowState
} from "./reviewer-shard-results.js";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function statusOf(value) {
  return normalizeString(value?.status || value?.result || value?.outcome || value).toLowerCase();
}

function issue(code, message, path) {
  return { code, message, path };
}

function latestScopeSplitPlan(workflowState = {}) {
  const events = asArray(workflowState?.manifest?.events)
    .filter((event) => event?.type === "reviewer_scope_split");
  return events.at(-1)?.metadata || null;
}

function completedShardIds(workflowState = {}) {
  return new Set(shardResultsFromWorkflowState(workflowState)
    .map((result) => normalizeString(result?.shard_id || result?.shardId))
    .filter(Boolean));
}

export function getPendingReviewerShards(workflowState = {}) {
  const splitPlan = latestScopeSplitPlan(workflowState);
  if (!splitPlan || splitPlan.status === "fail") {
    return {
      status: "fail",
      issues: [issue("missing_active_reviewer_scope_split", "active reviewer scope split plan is required", "manifest.events")],
      split_plan: splitPlan,
      shards: []
    };
  }

  const done = completedShardIds(workflowState);
  const shards = asArray(splitPlan.shards)
    .filter((shard) => statusOf(shard) !== "completed" && statusOf(shard) !== "pass")
    .filter((shard) => !done.has(normalizeString(shard.id)));

  return {
    status: "pass",
    split_plan: splitPlan,
    total_shards: asArray(splitPlan.shards).length,
    completed_shards: done.size,
    pending_shards: shards.length,
    shards,
    issues: []
  };
}

export function createReviewerShardPrompt(shard = {}) {
  const files = asArray(shard.files).map((file) => `- ${file}`).join("\n") || "- (none)";
  const questions = asArray(shard.questions).map((question) => `- ${question}`).join("\n") || "- (none)";
  const forbidden = asArray(shard.forbidden_actions).map((action) => `- ${action}`).join("\n") || "- Do not modify files.";
  const tools = asArray(shard.allowed_tools).join(", ") || "none";

  return [
    "你是 AI Control Platform 的只读 reviewer shard。",
    "",
    `Shard: ${normalizeString(shard.id) || "unknown"}`,
    `Provider: ${normalizeString(shard.provider) || "unknown"}`,
    `Model: ${normalizeString(shard.model) || "unknown"}`,
    `Profile: ${normalizeString(shard.profile) || "quick"}`,
    `Allowed tools: ${tools}`,
    "",
    "Files:",
    files,
    "",
    "Questions:",
    questions,
    "",
    "Scope:",
    normalizeString(shard.prompt_excerpt || shard.scope) || "(none)",
    "",
    "Forbidden actions:",
    forbidden,
    "",
    "Return JSON findings only. Each finding must include id, status, severity, category, and message."
  ].join("\n");
}

export async function runReviewerShard(workflowState = {}, input = {}) {
  const pending = getPendingReviewerShards(workflowState);
  if (pending.status !== "pass") return pending;

  const shardId = normalizeString(input.shard_id || input.shardId) || pending.shards[0]?.id;
  const shard = pending.shards.find((item) => item.id === shardId);
  if (!shard) {
    return {
      status: "fail",
      issues: [issue("reviewer_shard_not_pending", `${shardId || "requested shard"} is not pending`, "shard_id")]
    };
  }

  if (typeof input.executor !== "function") {
    return {
      status: "fail",
      issues: [issue("missing_reviewer_shard_executor", "reviewer shard executor function is required", "executor")]
    };
  }

  const prompt = createReviewerShardPrompt(shard);
  let execution;
  try {
    execution = await input.executor({
      shard,
      prompt,
      split_plan: pending.split_plan
    });
  } catch (error) {
    execution = {
      status: "fail",
      findings: [
        {
          id: `${shard.id}-executor-error`,
          status: "fail",
          severity: "medium",
          category: "reviewer_executor",
          message: error.message
        }
      ]
    };
  }

  const recorded = recordReviewerShardResult(workflowState, {
    shard_id: shard.id,
    status: execution?.status,
    findings: execution?.findings || execution?.review_findings || [],
    created_at: input.created_at || execution?.created_at
  });
  if (recorded.status !== "pass") return recorded;

  const nextPending = getPendingReviewerShards(recorded.workflow_state);
  if (nextPending.status === "pass" && nextPending.pending_shards === 0) {
    const aggregate = recordReviewerShardAggregate(recorded.workflow_state, {
      created_at: input.aggregate_created_at || input.created_at
    });
    if (aggregate.status !== "pass") return aggregate;
    return {
      status: "pass",
      phase: "aggregated",
      shard,
      prompt,
      result: recorded.fact,
      aggregate: aggregate.fact,
      workflow_state: aggregate.workflow_state
    };
  }

  return {
    status: "pass",
    phase: "shard_recorded",
    shard,
    prompt,
    result: recorded.fact,
    pending_shards: nextPending.pending_shards,
    workflow_state: recorded.workflow_state
  };
}
