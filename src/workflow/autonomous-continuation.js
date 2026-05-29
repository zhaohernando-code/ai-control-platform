import { projectionPublishIssues, snapshotIssues } from "./workbench-snapshots.js";
import { createWorkbenchProjection } from "./workbench-projection.js";
import { evaluateRunResult } from "./autonomous-run.js";
import { evaluateGlobalGoalCompletion } from "./global-goal-completion.js";
import { summarizeAgentLifecyclePool } from "./agent-lifecycle-pool.js";
import {
  createFrontendAcceptanceRepairWorkPackage,
  summarizeFrontendAcceptance
} from "./frontend-acceptance.js";
import { createSelfGovernanceReport } from "./self-governance.js";
import {
  summarizeGovernanceAuditSkillTrial
} from "./governance-audit-skill-trial.js";
import { createCodeReviewCoverageDispatch } from "./code-review-coverage-dispatch.js";
import {
  createRequirementPlanWorkPackages,
  normalizeRequirementPlanWorkPackagesGranularity
} from "./requirement-intake.js";

const CONTINUE = "continue";
const RERUN = "rerun";
const ROLLBACK = "rollback";
const STOP_FOR_HUMAN = "stop_for_human";
const COMPLETE = "complete";

const STOP_STATUSES = new Set(["human_intervention", "blocked", "stop_for_human"]);
const RERUN_STATUSES = new Set(["rerun", "retry"]);
const ROLLBACK_STATUSES = new Set(["rollback"]);
const DEFAULT_NEXT_STEP_OWNED_FILES = [
  "PROJECT_STATUS.json",
  "src/workflow",
  "docs/contracts",
  "docs/examples/process-hardening-current.json"
];

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

function uniqueStrings(value) {
  return [...new Set(compactStrings(value))];
}

function issue(code, message, path) {
  return { code, message, path };
}

function statusOf(value) {
  return normalizeToken(value?.status || value?.decision || value?.action || value);
}

function reviewerSmokeStallBlockers(input) {
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
    })),
    ...reviewerSmokeStallBlockers(input)
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
  const aggregate = latestCompletedReviewerShardAggregate(input);
  const providerPackages = aggregate ? [] : reviewerProviderWorkPackagesFrom(input);
  const scopeSplitPackages = aggregate ? [] : reviewerScopeSplitWorkPackagesFrom(input);
  const lifecyclePoolPackages = agentLifecyclePoolWorkPackagesFrom(input);
  const frontendRepairPackages = frontendAcceptanceRepairWorkPackagesFrom(input);
  const governanceAuditRepairPackages = governanceAuditRepairWorkPackagesFrom(input);
  const selfGovernancePackages = selfGovernanceWorkPackagesFrom(input);
  const codeReviewCoveragePackages = codeReviewCoverageWorkPackagesFrom(input);
  const globalGoalCompletion = evaluateGlobalGoalCompletion(input);
  const directPackages = [
    ...asArray(input?.next_work_packages),
    ...asArray(input?.nextWorkPackages),
    ...asArray(input?.project_status?.next_work_packages),
    ...asArray(input?.projectStatus?.next_work_packages),
    ...asArray(runEvaluation?.next_work_packages),
    ...asArray(runEvaluation?.projection?.next_work_packages),
    ...providerPackages,
    ...scopeSplitPackages,
    ...lifecyclePoolPackages,
    ...frontendRepairPackages,
    ...governanceAuditRepairPackages,
    ...selfGovernancePackages,
    ...codeReviewCoveragePackages
  ];
  const expandedDirectPackages = filterCompletedWorkPackages(
    normalizeRequirementPlanWorkPackages(expandRequirementPlanWorkPackages(input, directPackages)),
    input
  );
  if (expandedDirectPackages.length > 0) {
    return dedupeWorkPackages(expandedDirectPackages);
  }
  return dedupeWorkPackages(globalGoalCompletion.next_work_packages);
}

function normalizeRequirementPlanWorkPackages(workPackages = []) {
  return normalizeRequirementPlanWorkPackagesGranularity(workPackages);
}

function completedWorkPackageIds(input = {}) {
  const workflowState = workflowStateFrom(input) || input;
  // Work-package terminality: broader than a pass/fail verdict (accepted/closed count as
  // done) but narrower than goal terminality (no canceled/shipped). Intentionally NOT the
  // shared status-vocabulary set — see status-vocabulary.js + global-goal-completion.js.
  const completeStatuses = new Set(["complete", "completed", "done", "pass", "passed", "accepted", "closed"]);
  return new Set([
    ...asArray(workflowState?.manifest?.work_packages),
    ...asArray(workflowState?.task_dag || workflowState?.taskDag)
  ]
    .filter((workPackage) => completeStatuses.has(normalizeToken(workPackage?.status || workPackage?.result)))
    .map((workPackage) => workPackageId(workPackage))
    .filter(Boolean));
}

function filterCompletedWorkPackages(workPackages = [], input = {}) {
  const completedIds = completedWorkPackageIds(input);
  if (completedIds.size === 0) return workPackages;
  return asArray(workPackages)
    .filter((workPackage) => !completedIds.has(workPackageId(workPackage)))
    .map((workPackage) => {
      const dependsOn = compactStrings(workPackage.depends_on || workPackage.dependencies)
        .filter((dependencyId) => !completedIds.has(dependencyId));
      if (dependsOn.length === compactStrings(workPackage.depends_on || workPackage.dependencies).length) {
        return workPackage;
      }
      return {
        ...workPackage,
        depends_on: dependsOn
      };
    });
}

function requirementIdForWorkPackage(workPackage = {}) {
  return normalizeString(
    workPackage.source?.requirement_id ||
      workPackage.source?.requirementId ||
      workPackage.global_goal_id ||
      workPackage.globalGoalId
  );
}

function approvedPlanReviewFor(projectStatus = {}, requirementId = "") {
  const review = isObject(projectStatus?.plan_reviews) ? projectStatus.plan_reviews[requirementId] : null;
  const phase = normalizeToken(review?.phase || review?.status);
  return phase === "in_development" ? review : null;
}

function expandRequirementPlanWorkPackages(input = {}, workPackages = []) {
  const status = projectStatus(input);
  return asArray(workPackages).flatMap((workPackage) => {
    if (normalizeString(workPackage?.action) !== "continue_requirement_intake") return [workPackage];
    const requirementId = requirementIdForWorkPackage(workPackage);
    if (!approvedPlanReviewFor(status, requirementId)) return [workPackage];
    const planPackages = createRequirementPlanWorkPackages(status, requirementId, workPackage);
    return planPackages.length > 0 ? planPackages : [workPackage];
  });
}

function workPackageId(workPackage = {}, fallback = "") {
  return normalizeString(workPackage.id || workPackage.work_package_id || workPackage.workPackageId || fallback);
}

function acceptanceGatesFromWorkPackage(workPackage = {}) {
  return uniqueStrings([
    ...compactStrings(workPackage.acceptance_gates || workPackage.acceptanceGates),
    ...compactStrings(workPackage.source?.acceptance_gates || workPackage.source?.acceptanceGates)
  ]);
}

function mergeWorkPackages(current = {}, incoming = {}) {
  const merged = { ...current, ...incoming };
  const ownedFiles = uniqueStrings([
    ...compactStrings(current.owned_files || current.ownedFiles),
    ...compactStrings(incoming.owned_files || incoming.ownedFiles)
  ]);
  const acceptanceGates = uniqueStrings([
    ...acceptanceGatesFromWorkPackage(current),
    ...acceptanceGatesFromWorkPackage(incoming)
  ]);
  const dependsOn = uniqueStrings([
    ...compactStrings(current.depends_on || current.dependencies),
    ...compactStrings(incoming.depends_on || incoming.dependencies)
  ]);

  for (const field of ["id", "work_package_id", "title", "action", "global_goal_id", "globalGoalId", "reason"]) {
    if (!normalizeString(merged[field]) && normalizeString(current[field])) {
      merged[field] = current[field];
    }
  }
  if (!merged.frontend_acceptance && !merged.frontendAcceptance) {
    merged.frontend_acceptance = current.frontend_acceptance || current.frontendAcceptance;
  }
  if (current.source || incoming.source) {
    merged.source = { ...(current.source || {}), ...(incoming.source || {}) };
  }
  if (ownedFiles.length > 0) merged.owned_files = ownedFiles;
  if (acceptanceGates.length > 0) merged.acceptance_gates = acceptanceGates;
  if (dependsOn.length > 0) merged.depends_on = dependsOn;

  return merged;
}

function dedupeWorkPackages(workPackages = []) {
  const orderedKeys = [];
  const byKey = new Map();

  asArray(workPackages).filter(Boolean).forEach((workPackage, index) => {
    const key = workPackageId(workPackage, `continuation-${index + 1}`);
    if (!byKey.has(key)) {
      orderedKeys.push(key);
      byKey.set(key, workPackage);
      return;
    }
    byKey.set(key, mergeWorkPackages(byKey.get(key), workPackage));
  });

  return orderedKeys.map((key) => byKey.get(key));
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

function latestCompletedReviewerShardAggregate(input = {}) {
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

const REVIEWER_SMOKE_STALL_THRESHOLD = 2;

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

function reviewerProviderSmokeStall(input = {}) {
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

function reviewerProviderWorkPackagesFrom(input = {}) {
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

function selfGovernanceWorkPackagesFrom(input = {}) {
  const report = createSelfGovernanceReport({
    ...input,
    workflow_state: workflowStateFrom(input) || input?.workflow_state
  });
  return report.status === "available" ? asArray(report.next_work_packages) : [];
}

function codeReviewCoverageWorkPackagesFrom(input = {}) {
  const dispatch = createCodeReviewCoverageDispatch({
    ...input,
    workflow_state: workflowStateFrom(input) || input?.workflow_state
  });
  return dispatch.status === "needs_dispatch" ? asArray(dispatch.supplemental_work_packages) : [];
}

function agentLifecyclePoolFrom(input = {}) {
  const explicit = input?.agent_lifecycle_pool || input?.agentLifecyclePool || input?.workflow_state?.agent_lifecycle_pool;
  if (explicit) return explicit;
  const workflowState = workflowStateFrom(input);
  return summarizeAgentLifecyclePool(workflowState?.manifest, workflowState?.artifact_ledger || workflowState?.artifactLedger);
}

function timedOutWorkersFrom(pool = {}) {
  const workers = asArray(pool?.timed_out_workers || pool?.timedOutWorkers);
  if (workers.length > 0) return workers;

  const workerId = normalizeString(pool?.timed_out_worker || pool?.timedOutWorker || pool?.worker_id || pool?.workerId);
  return workerId ? [{ worker_id: workerId }] : [];
}

function retryWorkerOwnedFiles(worker = {}, pool = {}) {
  const declared = compactStrings(worker.owned_files || worker.ownedFiles || pool.owned_files || pool.ownedFiles);
  return declared.length > 0
    ? declared
    : [
        "src/workflow/agent-lifecycle-pool.js",
        "src/workflow/autonomous-continuation.js",
        "docs/examples/process-hardening-current.json",
        "test/agent-lifecycle-pool.test.js",
        "test/autonomous-continuation.test.js"
      ];
}

function agentLifecyclePoolWorkPackagesFrom(input = {}) {
  const pool = agentLifecyclePoolFrom(input);
  const status = normalizeToken(pool?.status);
  const timedOutCount = Number(pool?.timed_out || pool?.timedOut || 0);
  const timedOutWorkers = timedOutWorkersFrom(pool);
  if (timedOutCount > 0) {
    const retryWorker = timedOutWorkers[0] || {};
    const workerId = normalizeString(retryWorker.worker_id || retryWorker.workerId || retryWorker.id) || "timed-out-worker";
    const poolId = normalizeString(pool.pool_id || pool.poolId || "latest");

    return [
      {
        id: `agent-worker-retry-${poolId.replace(/[^a-zA-Z0-9_-]+/g, "-")}-${workerId.replace(/[^a-zA-Z0-9_-]+/g, "-")}`,
        title: `Retry timed-out agent worker ${workerId}`,
        action: "retry_agent_worker",
        owned_files: retryWorkerOwnedFiles(retryWorker, pool),
        reason: pool.latest_issue || `agent lifecycle pool ${poolId} has ${timedOutCount} timed-out worker(s); retry the smallest worker slice before whole-pool cleanup`,
        pool_id: poolId,
        worker_id: workerId,
        retry_worker: {
          ...retryWorker,
          worker_id: workerId,
          pool_id: poolId
        },
        retry_workers: timedOutWorkers,
        timed_out_workers: timedOutWorkers
      }
    ];
  }

  const needsCleanup = status === "cleanup_required" ||
    status === "blocked" ||
    status === "open" ||
    status === "unevaluated" ||
    status === "unclosed" ||
    Number(pool?.open || 0) > 0 ||
    Number(pool?.unevaluated || 0) > 0 ||
    Number(pool?.unclosed || 0) > 0;

  if (!needsCleanup) return [];

  return [
    {
      id: `agent-lifecycle-pool-cleanup-${normalizeString(pool.pool_id || "latest").replace(/[^a-zA-Z0-9_-]+/g, "-")}`,
      title: "Clean up agent lifecycle pool",
      action: "cleanup_agent_lifecycle_pool",
      owned_files: [
        "src/workflow/agent-lifecycle-pool.js",
        "src/workflow/workbench-projection.js",
        "src/workflow/autonomous-continuation.js",
        "src/workflow/process-hardening.js",
        "docs/examples/process-hardening-current.json",
        "test/agent-lifecycle-pool.test.js",
        "test/autonomous-continuation.test.js",
        "test/workbench-projection.test.js",
        "test/process-hardening.test.js"
      ],
      reason: pool.latest_issue || `agent lifecycle pool ${status || "cleanup_required"}: open=${pool.open || 0}, unevaluated=${pool.unevaluated || 0}, unclosed=${pool.unclosed || 0}`
    }
  ];
}

function frontendAcceptanceRepairWorkPackagesFrom(input = {}) {
  const explicit = input?.frontend_acceptance || input?.frontendAcceptance || input?.workflow_state?.frontend_acceptance;
  const workflowState = workflowStateFrom(input);
  const summary = explicit || summarizeFrontendAcceptance(
    workflowState?.manifest,
    workflowState?.artifact_ledger || workflowState?.artifactLedger
  );
  const workPackage = summary?.repair_work_package || summary?.repairWorkPackage || createFrontendAcceptanceRepairWorkPackage(summary);

  return workPackage ? [workPackage] : [];
}

function governanceAuditRepairWorkPackagesFrom(input = {}) {
  const explicit = input?.governance_audit || input?.governanceAudit || input?.workflow_state?.governance_audit;
  const workflowState = workflowStateFrom(input);
  const summary = explicit || summarizeGovernanceAuditSkillTrial(
    workflowState?.manifest,
    workflowState?.artifact_ledger || workflowState?.artifactLedger
  );
  const workPackage = summary?.repair_work_package || summary?.repairWorkPackage;
  return workPackage ? [workPackage] : [];
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
  const nextWorkPackages = nextWorkPackagesWithNextStepFallback(input);
  const explicitOwnedFiles = compactStrings(input?.owned_files || input?.ownedFiles);
  const workPackageOwnedFiles = compactStrings(nextWorkPackages.flatMap((workPackage) => workPackage.owned_files || workPackage.ownedFiles));
  const explicitAcceptanceGates = compactStrings(input?.acceptance_gates || input?.acceptanceGates);
  const workPackageAcceptanceGates = uniqueStrings(nextWorkPackages.flatMap(acceptanceGatesFromWorkPackage));
  const acceptanceGates = uniqueStrings([...explicitAcceptanceGates, ...workPackageAcceptanceGates]);

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
    owned_files: [...new Set([...explicitOwnedFiles, ...workPackageOwnedFiles])],
    acceptance_gates: acceptanceGates.length > 0 ? acceptanceGates : ["npm test", "npm run check:onboarding"],
    rollback_conditions: compactStrings(input?.rollback_conditions || input?.rollbackConditions || [
      "host boundary violation",
      "goal alignment violation",
      "work package writes outside owned files"
    ]),
    subtasks: nextWorkPackages.map((workPackage, index) => ({
      id: normalizeString(workPackage.id || workPackage.work_package_id) || `continuation-${index + 1}`,
      title: normalizeString(workPackage.title || workPackage.reason || workPackage.action) || `Continuation ${index + 1}`,
      action: normalizeString(workPackage.action),
      global_goal_id: normalizeString(workPackage.global_goal_id || workPackage.globalGoalId),
      owned_files: compactStrings(workPackage.owned_files || workPackage.ownedFiles),
      depends_on: compactStrings(workPackage.depends_on || workPackage.dependencies),
      source: {
        ...(isObject(workPackage.source) ? workPackage.source : {}),
        global_goal_id: normalizeString(workPackage.global_goal_id || workPackage.globalGoalId),
        pool_id: normalizeString(workPackage.pool_id || workPackage.poolId),
        worker_id: normalizeString(workPackage.worker_id || workPackage.workerId),
        retry_worker: workPackage.retry_worker || workPackage.retryWorker || null,
        retry_workers: asArray(workPackage.retry_workers || workPackage.retryWorkers),
        timed_out_workers: asArray(workPackage.timed_out_workers || workPackage.timedOutWorkers),
        frontend_acceptance: workPackage.frontend_acceptance || workPackage.frontendAcceptance || null,
        governance_audit: workPackage.governance_audit || workPackage.governanceAudit || null,
        code_review_coverage: workPackage.code_review_coverage || workPackage.codeReviewCoverage || null,
        acceptance_gates: acceptanceGatesFromWorkPackage(workPackage),
        reason: normalizeString(workPackage.reason)
      }
    })),
    continuation_action: action
  };
}

function nextWorkPackagesWithNextStepFallback(input) {
  const packages = nextWorkPackagesFrom(input);
  if (packages.length > 0) return packages;

  const nextStep = nextStepFrom(input);
  if (!nextStep) return [];

  return [
    {
      id: "project-status-next-step",
      title: nextStep,
      action: "continue_next_step",
      owned_files: defaultNextStepOwnedFiles(input),
      reason: "PROJECT_STATUS.next_step requires a bounded continuation package"
    }
  ];
}

function defaultNextStepOwnedFiles(input = {}) {
  const explicit = compactStrings(input?.owned_files || input?.ownedFiles);
  if (explicit.length > 0) return explicit;

  const globalGoalCompletion = evaluateGlobalGoalCompletion(input);
  const goalOwnedFiles = compactStrings(globalGoalCompletion.next_work_packages.flatMap((workPackage) => workPackage.owned_files || workPackage.ownedFiles));
  if (goalOwnedFiles.length > 0) return [...new Set(goalOwnedFiles)];

  return DEFAULT_NEXT_STEP_OWNED_FILES;
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

  // Ensure complete context for projection validation.
  // Use OR-fallback so explicit input context takes precedence,
  // but undefined input does not erase the workflow-state's own model_plan / project_status.
  const projectionInput = {
    ...workflowState,
    model_plan: input?.model_plan || input?.modelPlan || workflowState?.model_plan,
    project_status: input?.project_status || input?.projectStatus || workflowState?.project_status
  };

  const plan = {
    action: "publish_workbench_snapshot",
    endpoint: "/api/workbench/snapshots",
    id: snapshotIdFrom({ ...input, ...workflowState }),
    label: normalizeString(input?.snapshot_label || input?.snapshotLabel) || "Autonomous run closeout snapshot",
    input: workflowState,
    // Include context for closeout execution
    model_plan: input?.model_plan || input?.modelPlan,
    project_status: input?.project_status || input?.projectStatus
  };

  const issues = [
    ...snapshotIssues(plan),
    ...projectionPublishIssues(createWorkbenchProjection(projectionInput))
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

export { COMPLETE, CONTINUE, RERUN, ROLLBACK, STOP_FOR_HUMAN, REVIEWER_SMOKE_STALL_THRESHOLD, reviewerProviderSmokeStall };
