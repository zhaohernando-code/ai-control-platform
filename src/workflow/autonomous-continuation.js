import { projectionPublishIssues, snapshotIssues } from "./workbench-snapshots.js";
import { createWorkbenchProjection } from "./workbench-projection.js";
import { evaluateGlobalGoalCompletion } from "./global-goal-completion.js";
import {
  asArray,
  compactStrings,
  COMPLETE,
  CONTINUE,
  DEFAULT_NEXT_STEP_OWNED_FILES,
  isObject,
  issue,
  normalizeString,
  normalizeToken,
  projectStatus,
  RERUN,
  RERUN_STATUSES,
  ROLLBACK,
  ROLLBACK_STATUSES,
  statusOf,
  STOP_FOR_HUMAN,
  STOP_STATUSES,
  uniqueStrings,
  workflowStateFrom
} from "./autonomous-continuation-utils.js";
import {
  reviewerSmokeStallBlockers,
  runEvaluationFrom
} from "./autonomous-continuation-reviewer.js";
import {
  acceptanceGatesFromWorkPackage,
  nextWorkPackagesFrom
} from "./autonomous-continuation-work-packages.js";

export {
  COMPLETE,
  CONTINUE,
  RERUN,
  ROLLBACK,
  STOP_FOR_HUMAN
} from "./autonomous-continuation-utils.js";
export {
  REVIEWER_SMOKE_STALL_THRESHOLD,
  reviewerProviderSmokeStall
} from "./autonomous-continuation-reviewer.js";

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

function validateContinuationInput(input = {}) {
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

function decideContinuation(input = {}) {
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

function assertShouldContinue(input = {}) {
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

export { assertShouldContinue, decideContinuation, validateContinuationInput };
