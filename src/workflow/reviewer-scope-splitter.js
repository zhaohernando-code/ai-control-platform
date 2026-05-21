import { recordArtifact } from "./artifact-ledger.js";
import {
  createReviewerGateRequest,
  createReviewerInvocationPolicy,
  validateReviewerGateRequest
} from "./llm-reviewer-gate.js";
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

function chunkArray(items, limit) {
  const size = Math.max(1, Number(limit) || 1);
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks.length > 0 ? chunks : [[]];
}

function chunkText(text, limit) {
  const value = normalizeString(text);
  const size = Math.max(1, Number(limit) || value.length || 1);
  if (!value) return [{ index: 1, text: "", chars: 0 }];

  const chunks = [];
  for (let index = 0; index < value.length; index += size) {
    const segment = value.slice(index, index + size);
    chunks.push({
      index: chunks.length + 1,
      text: segment,
      chars: segment.length
    });
  }
  return chunks;
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

function nextPlanId(workflowState = {}, explicitId = "") {
  const runId = safeIdPart(workflowState?.manifest?.run_id);
  const cycleId = safeIdPart(workflowState?.manifest?.cycle_id);
  const prefix = explicitId || `reviewer-scope-split-${runId}-${cycleId}`;
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

function shardAllowedTools(request, input = {}) {
  const mode = normalizeToken(input.mode || input.dispatch_mode || input.retry_strategy);
  if (input.no_tools === true || mode === "rerun_without_tools" || mode === "no_tools") return [];
  if (Array.isArray(input.allowed_tools || input.allowedTools)) return asArray(input.allowed_tools || input.allowedTools).map(normalizeString).filter(Boolean);
  return asArray(request.allowed_tools).map(normalizeString).filter(Boolean);
}

function effectiveShardLimits(policy, input = {}) {
  const mode = normalizeToken(input.mode || input.dispatch_mode || input.retry_strategy);
  const forceFileSplit = input.force_file_split === true ||
    input.forceFileSplit === true ||
    mode === "tool_timeout_recovery" ||
    mode === "rerun_without_tools_or_split_scope";
  const limits = policy.scope_limits;

  return {
    max_files: forceFileSplit
      ? Math.min(limits.max_files, Math.max(1, Number(input.max_files_per_shard || input.maxFilesPerShard || 1) || 1))
      : limits.max_files,
    max_questions: Math.min(limits.max_questions, Math.max(1, Number(input.max_questions_per_shard || input.maxQuestionsPerShard || limits.max_questions) || limits.max_questions)),
    max_prompt_chars: Math.min(limits.max_prompt_chars, Math.max(1, Number(input.max_prompt_chars_per_shard || input.maxPromptCharsPerShard || limits.max_prompt_chars) || limits.max_prompt_chars)),
    force_file_split: forceFileSplit
  };
}

function shardId(index) {
  return `reviewer-scope-shard-${String(index + 1).padStart(3, "0")}`;
}

export function createReviewerScopeSplitPlan(input = {}) {
  const request = createReviewerGateRequest(input.request || input);
  const policy = createReviewerInvocationPolicy({
    request,
    profile: input.profile || input.review_profile || input.mode || input.stage,
    prompt: input.prompt || input.prompt_text || input.scope || request.scope,
    timeout_seconds: input.timeout_seconds || input.timeoutSeconds,
    effort: input.effort
  });
  const promptText = normalizeString(input.prompt || input.prompt_text || input.scope || request.scope);
  const validation = validateReviewerGateRequest({
    ...request,
    allowed_tools: shardAllowedTools(request, input)
  });
  const limits = effectiveShardLimits(policy, input);
  const fileChunks = chunkArray(request.files, limits.max_files);
  const questionChunks = chunkArray(request.questions, limits.max_questions);
  const promptChunks = chunkText(promptText, limits.max_prompt_chars);
  const allowedTools = shardAllowedTools(request, input);
  const issues = [...validation.issues];
  const shards = [];

  for (const files of fileChunks) {
    for (const questions of questionChunks) {
      for (const promptSegment of promptChunks) {
        const index = shards.length;
        shards.push({
          id: shardId(index),
          status: "pending",
          run_id: request.run_id || null,
          cycle_id: request.cycle_id || null,
          provider: request.provider.provider,
          model: request.provider.model,
          profile: policy.profile,
          dispatch_mode: allowedTools.length > 0 ? "read_only_tools" : "no_tools",
          read_only: true,
          allowed_tools: allowedTools,
          files,
          questions,
          scope: request.scope,
          prompt_excerpt: promptSegment.text,
          prompt_chars: promptSegment.chars,
          prompt_segment: {
            index: promptSegment.index,
            total: promptChunks.length
          },
          output_contract: request.output_contract,
          forbidden_actions: request.forbidden_actions,
          timeout_seconds: policy.timeout_seconds,
          effort: policy.effort,
          scope_limits: {
            max_files: limits.max_files,
            max_questions: limits.max_questions,
            max_prompt_chars: limits.max_prompt_chars,
            force_file_split: limits.force_file_split
          }
        });
      }
    }
  }

  return {
    id: normalizeString(input.id),
    type: "reviewer_scope_split",
    status: issues.length > 0 ? "fail" : "pass",
    run_id: request.run_id || null,
    cycle_id: request.cycle_id || null,
    provider: request.provider.provider,
    model: request.provider.model,
    profile: policy.profile,
    split_required: policy.split_required || shards.length > 1 || limits.force_file_split,
    split_reason: policy.split_reason ||
      (limits.force_file_split
        ? "reviewer tool timeout recovery forces smaller file shards before retry"
        : (shards.length > 1 ? "reviewer request was split into bounded shards" : null)),
    prompt_split_required: promptChunks.length > 1,
    shard_count: shards.length,
    pending_shards: shards.length,
    shards,
    invocation_policy: policy,
    effective_scope_limits: limits,
    created_at: normalizeString(input.created_at) || new Date().toISOString(),
    issues
  };
}

export function createReviewerScopeSplitFact(input = {}) {
  const plan = createReviewerScopeSplitPlan(input);
  return {
    id: plan.id,
    type: "reviewer_scope_split",
    status: plan.status,
    run_id: plan.run_id,
    cycle_id: plan.cycle_id,
    provider: plan.provider,
    model: plan.model,
    profile: plan.profile,
    split_required: plan.split_required,
    split_reason: plan.split_reason,
    prompt_split_required: plan.prompt_split_required,
    shard_count: plan.shard_count,
    pending_shards: plan.pending_shards,
    shard_ids: plan.shards.map((shard) => shard.id),
    scheduled_actions: plan.status === "pass" ? plan.shards.map((shard) => `run_${shard.id}`) : [],
    created_at: plan.created_at,
    issues: plan.issues,
    invocation_policy: plan.invocation_policy,
    effective_scope_limits: plan.effective_scope_limits,
    shards: plan.shards
  };
}

export function recordReviewerScopeSplitPlan(workflowState = {}, input = {}) {
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

  const basePlan = createReviewerScopeSplitPlan({
    run_id: workflowState.manifest.run_id,
    cycle_id: workflowState.manifest.cycle_id,
    ...input
  });
  const id = nextPlanId(workflowState, basePlan.id);
  const plan = { ...basePlan, id };
  const artifact = {
    id,
    type: "evaluation",
    status: plan.status,
    uri: `codex://reviewer-scope-split/${encodeURIComponent(plan.run_id)}/${encodeURIComponent(plan.cycle_id)}/${encodeURIComponent(id)}`,
    producer: "reviewer-scope-splitter",
    created_at: plan.created_at,
    metadata: plan
  };
  const manifest = appendRunEvent(workflowState.manifest, {
    id: `event-${id}`,
    type: "reviewer_scope_split",
    status: plan.status === "pass" ? "planned" : "fail",
    artifact_id: id,
    message: plan.split_required
      ? `Reviewer scope split into ${plan.shard_count} bounded shard(s).`
      : "Reviewer scope is within bounded invocation limits.",
    created_at: plan.created_at,
    metadata: plan
  });
  const manifestArtifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  const baseLedger = workflowState.artifact_ledger || workflowState.artifactLedger || {};
  const artifactLedger = recordArtifact({
    ...baseLedger,
    artifacts: Array.isArray(baseLedger.artifacts) ? baseLedger.artifacts : []
  }, artifact);

  return {
    status: "pass",
    plan,
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
