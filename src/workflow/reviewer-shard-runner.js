import {
  recordReviewerShardAggregate,
  recordReviewerShardResult,
  shardResultsFromWorkflowState
} from "./reviewer-shard-results.js";
import { recordReviewerProviderHealthFact } from "./reviewer-provider-health.js";
import { promptSafeReviewerShard, promptSafetyPreamble } from "./external-prompt-safety.js";

const REVIEWER_SHARD_LOOP_ARTIFACT_VERSION = "reviewer-shard-loop-run.v1";

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

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function findingCategory(finding = {}) {
  return normalizeString(finding.category || finding.type || finding.code).toLowerCase();
}

function hasReviewerTimeoutFinding(findings = []) {
  return asArray(findings).some((finding) => findingCategory(finding) === "reviewer_timeout");
}

function reviewerRequestFromShard(shard = {}, splitPlan = {}) {
  return {
    run_id: shard.run_id || splitPlan.run_id,
    cycle_id: shard.cycle_id || splitPlan.cycle_id,
    provider: {
      provider: shard.provider || splitPlan.provider,
      model: shard.model || splitPlan.model,
      tooling: shard.dispatch_mode === "no_tools" ? "none" : "read-only"
    },
    scope: shard.scope || splitPlan.split_reason || "Reviewer shard timeout recovery",
    files: asArray(shard.files),
    questions: asArray(shard.questions),
    forbidden_actions: asArray(shard.forbidden_actions),
    output_contract: shard.output_contract || "Return structured reviewer findings.",
    read_only: true,
    allowed_tools: asArray(shard.allowed_tools)
  };
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
  const safeShard = promptSafeReviewerShard(shard);
  const files = asArray(safeShard.files).map((file) => `- ${file}`).join("\n") || "- (none)";
  const questions = asArray(safeShard.questions).map((question) => `- ${question}`).join("\n") || "- (none)";
  const forbidden = asArray(safeShard.forbidden_actions).map((action) => `- ${action}`).join("\n") || "- Do not modify files.";
  const tools = asArray(safeShard.allowed_tools).join(", ") || "none";

  return [
    "你是 AI Control Platform 的只读 reviewer shard。",
    "",
    promptSafetyPreamble(),
    "",
    `Shard: ${normalizeString(safeShard.id) || "unknown"}`,
    `Provider: ${normalizeString(safeShard.provider) || "unknown"}`,
    `Model: ${normalizeString(safeShard.model) || "unknown"}`,
    `Profile: ${normalizeString(safeShard.profile) || "quick"}`,
    `Allowed tools: ${tools}`,
    "",
    "Files:",
    files,
    "",
    "Questions:",
    questions,
    "",
    "Scope:",
    normalizeString(safeShard.scope) || "(none)",
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
    executor_provenance: execution?.provenance || execution?.executor_provenance || execution?.executorProvenance,
    created_at: input.created_at || execution?.created_at
  });
  if (recorded.status !== "pass") return recorded;

  let nextWorkflowState = recorded.workflow_state;
  let providerHealth = null;
  if (input.record_provider_health_on_timeout === true || input.recordProviderHealthOnTimeout === true) {
    if (hasReviewerTimeoutFinding(recorded.fact.findings)) {
      const health = recordReviewerProviderHealthFact(nextWorkflowState, {
        request: reviewerRequestFromShard(shard, pending.split_plan),
        smoke_status: input.provider_smoke_status || input.providerSmokeStatus,
        tools: shard.allowed_tools,
        created_at: input.provider_health_created_at || input.providerHealthCreatedAt || input.created_at
      });
      if (health.status !== "pass") return health;
      providerHealth = health.fact;
      nextWorkflowState = health.workflow_state;
    }
  }

  const nextPending = getPendingReviewerShards(nextWorkflowState);
  if (nextPending.status === "pass" && nextPending.pending_shards === 0) {
    const aggregate = recordReviewerShardAggregate(nextWorkflowState, {
      created_at: input.aggregate_created_at || input.created_at
    });
    if (aggregate.status !== "pass") return aggregate;
    return {
      status: "pass",
      phase: "aggregated",
      shard,
      prompt,
      result: recorded.fact,
      provider_health: providerHealth,
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
    provider_health: providerHealth,
    pending_shards: nextPending.pending_shards,
    workflow_state: nextWorkflowState
  };
}

export async function runReviewerShardsUntilAggregate(workflowState = {}, input = {}) {
  const maxShards = Math.max(1, Number(input.max_shards || input.maxShards || 20) || 20);
  const stopOnProviderHealth = input.stop_on_provider_health !== false && input.stopOnProviderHealth !== false;
  let state = workflowState;
  const runs = [];

  for (let index = 0; index < maxShards; index += 1) {
    const pending = getPendingReviewerShards(state);
    if (pending.status !== "pass") return pending;
    if (pending.pending_shards === 0) {
      return {
        status: "pass",
        phase: "no_pending_shards",
        runs,
        workflow_state: state
      };
    }

    const result = await runReviewerShard(state, {
      ...input,
      shard_id: input.shard_id || input.shardId || pending.shards[0]?.id
    });
    if (result.status !== "pass") return result;
    runs.push({
      phase: result.phase,
      shard_id: result.result?.shard_id,
      shard_status: result.result?.status,
      provider_health: result.provider_health || null,
      aggregate: result.aggregate || null
    });
    state = result.workflow_state;

    if (result.phase === "aggregated") {
      return {
        status: "pass",
        phase: "aggregated",
        runs,
        aggregate: result.aggregate,
        workflow_state: state
      };
    }

    if (stopOnProviderHealth && result.provider_health) {
      return {
        status: "pass",
        phase: "provider_health_recorded",
        runs,
        provider_health: result.provider_health,
        workflow_state: state
      };
    }

    if (input.shard_id || input.shardId) {
      return {
        status: "pass",
        phase: result.phase,
        runs,
        workflow_state: state
      };
    }
  }

  return {
    status: "fail",
    issues: [issue("reviewer_shard_loop_exhausted", `reviewer shard loop exceeded ${maxShards} shard(s)`, "max_shards")],
    runs,
    workflow_state: state
  };
}

function manifestIdentity(workflowState = {}) {
  return {
    run_id: normalizeString(workflowState?.manifest?.run_id),
    cycle_id: normalizeString(workflowState?.manifest?.cycle_id)
  };
}

function runnerInputSummary(input = {}) {
  return {
    shard_id: normalizeString(input.shard_id || input.shardId) || null,
    max_shards: Number(input.max_shards || input.maxShards || 20) || 20,
    record_provider_health_on_timeout: input.record_provider_health_on_timeout === true || input.recordProviderHealthOnTimeout === true,
    provider_smoke_status: normalizeString(input.provider_smoke_status || input.providerSmokeStatus) || null,
    stop_on_provider_health: input.stop_on_provider_health !== false && input.stopOnProviderHealth !== false
  };
}

export function createReviewerShardLoopRunArtifact(workflowState = {}, runnerInput = {}, result = {}, options = {}) {
  const outputIdentity = manifestIdentity(result.workflow_state);
  const inputIdentity = manifestIdentity(workflowState);
  return {
    version: REVIEWER_SHARD_LOOP_ARTIFACT_VERSION,
    run_id: outputIdentity.run_id || inputIdentity.run_id || null,
    cycle_id: outputIdentity.cycle_id || inputIdentity.cycle_id || null,
    status: result.status || "fail",
    phase: result.phase || null,
    created_at: options.created_at || new Date().toISOString(),
    input: {
      workflow_state: workflowState,
      runner: runnerInputSummary(runnerInput)
    },
    result: {
      status: result.status || "fail",
      phase: result.phase || null,
      issues: result.issues || [],
      runs: result.runs || [],
      aggregate: result.aggregate || null,
      provider_health: result.provider_health || null,
      pending_shards: result.pending_shards ?? result.aggregate?.pending_shards ?? null,
      workflow_state: result.workflow_state || null
    }
  };
}

export function validateReviewerShardLoopRunArtifact(artifact = {}) {
  const issues = [];
  if (!isObject(artifact)) {
    return {
      status: "fail",
      issues: [issue("invalid_reviewer_shard_loop_artifact", "artifact must be an object", "")]
    };
  }

  if (artifact.version !== REVIEWER_SHARD_LOOP_ARTIFACT_VERSION) {
    issues.push(issue("invalid_artifact_version", `version must be ${REVIEWER_SHARD_LOOP_ARTIFACT_VERSION}`, "version"));
  }
  if (!["pass", "fail"].includes(artifact.status)) {
    issues.push(issue("invalid_artifact_status", "status must be pass or fail", "status"));
  }
  if (!normalizeString(artifact.phase)) {
    issues.push(issue("missing_artifact_phase", "phase is required", "phase"));
  }
  if (!normalizeString(artifact.created_at)) {
    issues.push(issue("missing_artifact_created_at", "created_at is required", "created_at"));
  }
  if (!normalizeString(artifact.run_id)) {
    issues.push(issue("missing_artifact_run_id", "run_id is required", "run_id"));
  }
  if (!normalizeString(artifact.cycle_id)) {
    issues.push(issue("missing_artifact_cycle_id", "cycle_id is required", "cycle_id"));
  }
  if (!isObject(artifact.input?.workflow_state)) {
    issues.push(issue("missing_input_workflow_state", "input.workflow_state must be an object", "input.workflow_state"));
  }
  if (!isObject(artifact.input?.runner)) {
    issues.push(issue("missing_input_runner", "input.runner must be an object", "input.runner"));
  }
  if (!isObject(artifact.result)) {
    issues.push(issue("missing_artifact_result", "result must be an object", "result"));
  }

  const expectedRunId = normalizeString(artifact.run_id);
  const expectedCycleId = normalizeString(artifact.cycle_id);
  const inputIdentity = manifestIdentity(artifact.input?.workflow_state);
  const outputIdentity = manifestIdentity(artifact.result?.workflow_state);
  if (inputIdentity.run_id && inputIdentity.run_id !== expectedRunId) {
    issues.push(issue("input_run_id_mismatch", "input workflow state run_id must match artifact run_id", "input.workflow_state.manifest.run_id"));
  }
  if (inputIdentity.cycle_id && inputIdentity.cycle_id !== expectedCycleId) {
    issues.push(issue("input_cycle_id_mismatch", "input workflow state cycle_id must match artifact cycle_id", "input.workflow_state.manifest.cycle_id"));
  }
  if (outputIdentity.run_id && outputIdentity.run_id !== expectedRunId) {
    issues.push(issue("result_run_id_mismatch", "result workflow state run_id must match artifact run_id", "result.workflow_state.manifest.run_id"));
  }
  if (outputIdentity.cycle_id && outputIdentity.cycle_id !== expectedCycleId) {
    issues.push(issue("result_cycle_id_mismatch", "result workflow state cycle_id must match artifact cycle_id", "result.workflow_state.manifest.cycle_id"));
  }

  const result = artifact.result || {};
  if (result.status !== artifact.status) {
    issues.push(issue("artifact_status_mismatch", "artifact status must match result.status", "result.status"));
  }
  if (result.phase !== artifact.phase) {
    issues.push(issue("artifact_phase_mismatch", "artifact phase must match result.phase", "result.phase"));
  }
  if (artifact.status === "pass" && !isObject(result.workflow_state)) {
    issues.push(issue("missing_result_workflow_state", "pass artifact must include result.workflow_state", "result.workflow_state"));
  }
  if (artifact.phase === "aggregated" && Number(result.aggregate?.pending_shards || 0) !== 0) {
    issues.push(issue("aggregate_still_pending", "aggregated artifact must have zero pending shards", "result.aggregate.pending_shards"));
  }
  if (artifact.phase === "provider_health_recorded" && !isObject(result.provider_health)) {
    issues.push(issue("missing_provider_health", "provider_health_recorded artifact must include provider health fact", "result.provider_health"));
  }

  return {
    status: issues.length ? "fail" : "pass",
    issues
  };
}

export function prepareReviewerShardLoopContinuationInput(artifact = {}, options = {}) {
  const validation = validateReviewerShardLoopRunArtifact(artifact);
  if (validation.status !== "pass") {
    return {
      status: "blocked",
      phase: "reviewer_shard_loop_replay_validation",
      should_continue: false,
      issues: validation.issues,
      continuation_input: null
    };
  }

  if (artifact.status !== "pass" || !isObject(artifact.result?.workflow_state)) {
    return {
      status: "blocked",
      phase: "reviewer_shard_loop_replay_validation",
      should_continue: false,
      issues: [issue("non_reusable_reviewer_shard_loop_artifact", "only pass artifacts with result.workflow_state can prepare continuation input", "status")],
      continuation_input: null
    };
  }

  const nextStep = normalizeString(options.next_step || options.nextStep) ||
    "Continue after reviewer shard loop artifact validation.";
  const nextWorkPackage = {
    id: "reviewer-shard-loop-continuation",
    title: nextStep,
    action: "continue_reviewer_shard_loop",
    owned_files: [
      "src/workflow/reviewer-shard-runner.js",
      "src/workflow/autonomous-continuation.js",
      "tools/prepare-reviewer-shard-loop-continuation.mjs",
      "test/reviewer-shard-runner.test.js",
      "test/autonomous-continuation.test.js"
    ],
    reason: "reviewer shard loop completed and produced a durable continuation step"
  };
  return {
    status: "ready",
    phase: "reviewer_shard_loop_continuation",
    should_continue: true,
    issues: [],
    continuation_input: {
      project_status: {
        project: "ai-control-platform",
        blockers: [],
        next_step: nextStep,
        next_work_packages: [nextWorkPackage]
      },
      run_evaluation: {
        status: "pass",
        source: REVIEWER_SHARD_LOOP_ARTIFACT_VERSION,
        artifact_phase: artifact.phase,
        next_work_packages: [nextWorkPackage]
      },
      workflow_state: artifact.result.workflow_state
    },
    reviewer_shard_loop: {
      run_id: artifact.run_id,
      cycle_id: artifact.cycle_id,
      phase: artifact.phase,
      aggregate_status: artifact.result.aggregate?.status || null,
      provider_health_status: artifact.result.provider_health?.provider_health || null,
      run_count: asArray(artifact.result.runs).length
    }
  };
}

export { REVIEWER_SHARD_LOOP_ARTIFACT_VERSION };
