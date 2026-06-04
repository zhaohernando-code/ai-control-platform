import { evaluateGlobalGoalCompletion } from "./global-goal-completion.js";
import { summarizeAgentLifecyclePool } from "./agent-lifecycle-pool.js";
import {
  createFrontendAcceptanceRepairWorkPackage,
  summarizeFrontendAcceptance
} from "./frontend-acceptance.js";
import { createSelfGovernanceReport } from "./self-governance.js";
import { summarizeGovernanceAuditSkillTrial } from "./governance-audit-skill-trial.js";
import { createCodeReviewCoverageDispatch } from "./code-review-coverage-dispatch.js";
import {
  createRequirementPlanWorkPackages,
  normalizeRequirementPlanWorkPackagesGranularity
} from "./requirement-intake.js";
import { WORK_ITEM_COMPLETE_SYNONYMS } from "./status-vocabulary.js";
import {
  asArray,
  compactStrings,
  isObject,
  normalizeString,
  normalizeToken,
  projectStatus,
  statusOf,
  uniqueStrings,
  workflowStateFrom
} from "./autonomous-continuation-utils.js";
import {
  latestCompletedReviewerShardAggregate,
  reviewerProviderWorkPackagesFrom,
  reviewerScopeSplitWorkPackagesFrom,
  runEvaluationFrom
} from "./autonomous-continuation-reviewer.js";

export function nextWorkPackagesFrom(input) {
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
  // Work-package terminality = shared work-item-complete set (pass synonyms + done +
  // accepted/closed). Shared so ok/success/succeeded agree with the scheduler — the old
  // inline copy dropped them, leaving a "succeeded" package looking incomplete here.
  const completeStatuses = new Set(WORK_ITEM_COMPLETE_SYNONYMS);
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

export function acceptanceGatesFromWorkPackage(workPackage = {}) {
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
