import { projectionPublishIssues, snapshotIssues } from "./workbench-snapshots.js";
import { createWorkbenchProjection } from "./workbench-projection.js";
import { evaluateRunResult } from "./autonomous-run.js";
import { evaluateGlobalGoalCompletion } from "./global-goal-completion.js";

const CONTINUE = "continue";
const RERUN = "rerun";
const ROLLBACK = "rollback";
const STOP_FOR_HUMAN = "stop_for_human";
const COMPLETE = "complete";

const STOP_STATUSES = new Set(["human_intervention", "blocked", "stop_for_human"]);
const RERUN_STATUSES = new Set(["rerun", "retry"]);
const ROLLBACK_STATUSES = new Set(["rollback"]);

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

function statusOf(value) {
  return normalizeToken(value?.status || value?.decision || value?.action || value);
}

function blockersFrom(input) {
  const runEvaluation = runEvaluationFrom(input);
  const globalGoalCompletion = evaluateGlobalGoalCompletion(input);
  return [
    ...asArray(input?.blockers),
    ...asArray(input?.project_status?.blockers),
    ...asArray(runEvaluation?.blockers),
    ...asArray(runEvaluation?.projection?.blockers),
    ...asArray(globalGoalCompletion.blocked_goals).map((goal) => ({
      id: goal.id,
      category: "global_goal_blocked",
      message: `${goal.title} is blocked`,
      requires_human: true
    }))
  ].filter(Boolean);
}

function hasHumanBlocker(input) {
  return blockersFrom(input).some((blocker) => {
    const category = normalizeToken(blocker.category || blocker.code || blocker.type || blocker.id);
    return Boolean(
      blocker.requires_human ||
        blocker.requiresHuman ||
        category.includes("credential") ||
        category.includes("secret") ||
        category.includes("destructive") ||
        category.includes("requirement_conflict") ||
        category.includes("recovery_exhausted")
    );
  });
}

function nextStepFrom(input) {
  const runEvaluation = runEvaluationFrom(input);
  return normalizeString(
    input?.next_step ||
      input?.nextStep ||
      input?.project_status?.next_step ||
      input?.projectStatus?.next_step ||
      runEvaluation?.next_step
  );
}

function nextWorkPackagesFrom(input) {
  const runEvaluation = runEvaluationFrom(input);
  const providerPackages = reviewerProviderWorkPackagesFrom(input);
  const scopeSplitPackages = reviewerScopeSplitWorkPackagesFrom(input);
  const globalGoalCompletion = evaluateGlobalGoalCompletion(input);
  const directPackages = [
    ...asArray(input?.next_work_packages),
    ...asArray(input?.nextWorkPackages),
    ...asArray(runEvaluation?.next_work_packages),
    ...asArray(runEvaluation?.projection?.next_work_packages),
    ...providerPackages,
    ...scopeSplitPackages
  ];
  if (directPackages.length > 0 || nextStepFrom(input)) {
    return directPackages;
  }
  return asArray(globalGoalCompletion.next_work_packages);
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

function reviewerShardAggregateEvaluation(input = {}) {
  const aggregate = latestReviewerShardAggregate(input);
  const workflowState = workflowStateFrom(input);
  const manifest = workflowState?.manifest;
  if (!aggregate || !manifest) return null;
  if (normalizeToken(aggregate.status) === "pending" || Number(aggregate.pending_shards || 0) > 0) return null;

  return evaluateRunResult({
    ...manifest,
    review_findings: asArray(aggregate.merged_findings)
  });
}

function runEvaluationFrom(input = {}) {
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

function reviewerProviderWorkPackagesFrom(input = {}) {
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

function reviewerScopeSplitWorkPackagesFrom(input = {}) {
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

function projectStatus(input) {
  return input?.project_status || input?.projectStatus || {};
}

function continuationReasons(input, action) {
  const reasons = [];
  const nextStep = nextStepFrom(input);
  const nextWorkPackages = nextWorkPackagesFrom(input);
  const runStatus = statusOf(runEvaluationFrom(input) || input?.decision || input?.status);
  const globalGoalCompletion = evaluateGlobalGoalCompletion(input);

  if (runStatus) reasons.push(`run_status=${runStatus}`);
  if (nextStep) reasons.push("project_status.next_step is present");
  if (nextWorkPackages.length > 0) reasons.push(`next_work_packages=${nextWorkPackages.length}`);
  if (globalGoalCompletion.status !== "not_configured") {
    reasons.push(`global_goals=${globalGoalCompletion.completed}/${globalGoalCompletion.total}`);
  }
  if (action === STOP_FOR_HUMAN) reasons.push("human blocker or explicit human_intervention status");
  if (action === COMPLETE) reasons.push("all configured global goals are complete");
  if (action === CONTINUE && !nextStep && nextWorkPackages.length === 0) reasons.push("continuation fallback keeps the autonomous loop alive");

  return reasons;
}

function createContextPackSeed(input, action) {
  const status = projectStatus(input);
  const nextStep = nextStepFrom(input);
  const nextWorkPackages = nextWorkPackagesFrom(input);

  return {
    requirement_summary: nextStep || nextWorkPackages[0]?.title || "Continue autonomous platform development from the latest project status.",
    host: "platform_core",
    target_project_id: status.project || input?.target_project_id || "ai-control-platform",
    non_goals: [
      "Do not modify managed business projects unless the task is an explicit integration adapter.",
      "Do not treat a completed cycle summary as a stopping condition.",
      "Do not rely on chat history as the only durable state."
    ],
    forbidden_actions: [
      "Do not stop while next_step or next_work_packages are available and no human blocker exists.",
      "Do not write platform-core code into managed business projects.",
      "Do not skip main-process evaluation gates."
    ],
    owned_files: compactStrings(input?.owned_files || input?.ownedFiles),
    acceptance_gates: compactStrings(input?.acceptance_gates || input?.acceptanceGates || ["npm test", "npm run check:onboarding"]),
    rollback_conditions: compactStrings(input?.rollback_conditions || input?.rollbackConditions || [
      "host boundary violation",
      "goal alignment violation",
      "work package writes outside owned files"
    ]),
    subtasks: nextWorkPackages.map((workPackage, index) => ({
      id: normalizeString(workPackage.id || workPackage.work_package_id) || `continuation-${index + 1}`,
      title: normalizeString(workPackage.title || workPackage.reason || workPackage.action) || `Continuation ${index + 1}`,
      owned_files: compactStrings(workPackage.owned_files || workPackage.ownedFiles),
      depends_on: compactStrings(workPackage.depends_on || workPackage.dependencies)
    })),
    continuation_action: action
  };
}

function snapshotIdFrom(input) {
  return normalizeString(input?.snapshot_id || input?.snapshotId) ||
    normalizeString(input?.manifest?.run_id) ||
    normalizeString(input?.run_id) ||
    normalizeString(input?.run_evaluation?.run_id) ||
    "latest-autonomous-run";
}

function workflowStateFrom(input) {
  return input?.workflow_state || input?.workflowState || null;
}

function createSnapshotPublishPlan(input) {
  const workflowState = workflowStateFrom(input);
  if (!workflowState) return { plan: null, issues: [] };

  const plan = {
    action: "publish_workbench_snapshot",
    endpoint: "/api/workbench/snapshots",
    id: snapshotIdFrom({ ...input, ...workflowState }),
    label: normalizeString(input?.snapshot_label || input?.snapshotLabel) || "Autonomous run closeout snapshot",
    input: workflowState
  };
  const issues = [
    ...snapshotIssues(plan),
    ...projectionPublishIssues(createWorkbenchProjection(workflowState))
  ];

  if (issues.length > 0) {
    return { plan: null, issues };
  }

  return { plan, issues: [] };
}

export function validateContinuationInput(input = {}) {
  const issues = [];

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      status: "fail",
      issues: [issue("invalid_continuation_input", "continuation input must be an object", "")]
    };
  }

  const status = projectStatus(input);
  if (status.project && status.project !== "ai-control-platform") {
    issues.push(issue("project_mismatch", "platform continuation must target ai-control-platform", "project_status.project"));
  }

  return {
    status: issues.length ? "fail" : "pass",
    issues
  };
}

export function decideContinuation(input = {}) {
  const validation = validateContinuationInput(input);
  const runEvaluation = runEvaluationFrom(input);
  const runStatus = statusOf(runEvaluation || input.decision || input.status);
  const hasBlocker = hasHumanBlocker(input);
  const nextStep = nextStepFrom(input);
  const nextWorkPackages = nextWorkPackagesFrom(input);
  const globalGoalCompletion = evaluateGlobalGoalCompletion(input);
  let action = CONTINUE;

  if (validation.status !== "pass") {
    action = STOP_FOR_HUMAN;
  } else if (hasBlocker || STOP_STATUSES.has(runStatus)) {
    action = STOP_FOR_HUMAN;
  } else if (globalGoalCompletion.status === "blocked") {
    action = STOP_FOR_HUMAN;
  } else if (ROLLBACK_STATUSES.has(runStatus)) {
    action = ROLLBACK;
  } else if (RERUN_STATUSES.has(runStatus) || nextWorkPackages.length > 0) {
    action = RERUN_STATUSES.has(runStatus) ? RERUN : CONTINUE;
  } else if (nextStep) {
    action = CONTINUE;
  } else if (globalGoalCompletion.status === "complete") {
    action = COMPLETE;
  }
  const snapshotPlan = action === STOP_FOR_HUMAN ? { plan: null, issues: [] } : createSnapshotPublishPlan(input);

  return {
    status: validation.status === "pass" ? "pass" : "fail",
    action,
    should_continue: action !== STOP_FOR_HUMAN && action !== COMPLETE,
    reasons: continuationReasons(input, action),
    blockers: blockersFrom(input),
    next_step: nextStep || null,
    next_work_packages: nextWorkPackages,
    global_goal_completion: globalGoalCompletion,
    context_pack_seed: action === STOP_FOR_HUMAN || action === COMPLETE ? null : createContextPackSeed(input, action),
    snapshot_publish_plan: snapshotPlan.plan,
    snapshot_publish_issues: snapshotPlan.issues,
    validation
  };
}

export function assertShouldContinue(input = {}) {
  const decision = decideContinuation(input);

  if (!decision.should_continue) {
    const error = new Error(decision.action === COMPLETE
      ? "autonomous continuation completed all configured global goals"
      : "autonomous continuation stopped for human intervention");
    error.code = decision.action === COMPLETE
      ? "AUTONOMOUS_CONTINUATION_COMPLETE"
      : "AUTONOMOUS_CONTINUATION_STOPPED";
    error.decision = decision;
    throw error;
  }

  return decision;
}

export { COMPLETE, CONTINUE, RERUN, ROLLBACK, STOP_FOR_HUMAN };
