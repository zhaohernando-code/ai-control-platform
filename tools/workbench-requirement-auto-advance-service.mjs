import {
  createSchedulerLoopRunArtifact,
  recordAutonomousSchedulerLoopRunArtifact,
  runSchedulerLoopDriver
} from "../src/workflow/autonomous-scheduler-loop.js";
import { VERIFIED_PROVIDER_MULTI_AGENT_PROFILE } from "../src/workflow/context-work-package-execution-adapter.js";
import { completeRequirementInProjectStatus } from "../src/workflow/requirement-intake.js";
import { createWorkbenchLoopClient, workbenchBaseUrlFromRequest } from "./workbench-loop-client.mjs";
import {
  normalizeString,
  readProjectStatus,
  workflowStateWithProjectStatus,
  writeProjectStatusState
} from "./workbench-requirement-service-utils.mjs";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function requirementAutoAdvanceEnabled(input = {}) {
  return input.auto_advance !== false && input.autoAdvance !== false;
}

export function requirementAutoAdvanceAllowedAfterPlanReview(input = {}) {
  return input.auto_advance_after_plan_review === true ||
    input.autoAdvanceAfterPlanReview === true ||
    input.plan_review_approved === true ||
    input.planReviewApproved === true;
}

function requirementAutoAdvanceInput(selectedId, input = {}) {
  return {
    start_projection_id: selectedId,
    max_iterations: Math.min(Math.max(Number(input.auto_advance_max_iterations || input.autoAdvanceMaxIterations || 3), 1), 5),
    execution_profile: input.execution_profile || input.executionProfile || "approved_mock_non_dry_run",
    execution_strategy: "projected_next_action",
    context_work_package_execution_profile: input.context_work_package_execution_profile ||
      input.contextWorkPackageExecutionProfile ||
      VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    execution_cwd: input.execution_cwd || input.executionCwd,
    primary_worktree_path: input.primary_worktree_path || input.primaryWorktreePath,
    worker_workspaces_root: input.worker_workspaces_root || input.workerWorkspacesRoot,
    add_dir: input.add_dir || input.addDir,
    snapshot_prefix: input.snapshot_prefix || input.snapshotPrefix || "requirement-intake-auto",
    created_at: input.created_at || input.createdAt
  };
}

function workPackageBelongsToRequirement(workPackage = {}, requirementId = "") {
  const id = normalizeString(requirementId);
  if (!id || !workPackage || typeof workPackage !== "object") return false;
  return normalizeString(workPackage.global_goal_id || workPackage.globalGoalId) === id ||
    normalizeString(workPackage.source?.requirement_id || workPackage.source?.requirementId) === id;
}

function requirementImplementationComplete(workflowState = {}, requirementId = "") {
  const packages = asArray(workflowState?.manifest?.work_packages || workflowState?.manifest?.workPackages)
    .filter((workPackage) => workPackageBelongsToRequirement(workPackage, requirementId));
  const completedStatuses = new Set(["completed", "complete", "pass", "passed", "done"]);
  return packages.length > 0 && packages.every((workPackage) => completedStatuses.has(normalizeString(workPackage.status).toLowerCase()));
}

function completeRequirementAfterAutoAdvance({
  requirementId,
  loopResult,
  input,
  readServerHistory,
  readWorkflowState,
  writeWorkflowState,
  projectStatusPath,
  stateStore,
  workbenchProjection
}) {
  if (loopResult?.status !== "pass" || !normalizeString(requirementId)) {
    return { completed: false, item: null, projection: null };
  }
  const history = readServerHistory();
  const latestItem = history.items?.find((entry) => entry.id === history.latest) || null;
  if (!latestItem?.input_path) {
    return { completed: false, item: null, projection: null };
  }
  const latestWorkflowState = readWorkflowState(latestItem);
  if (!requirementImplementationComplete(latestWorkflowState, requirementId)) {
    return {
      completed: false,
      item: latestItem,
      projection: workbenchProjection(latestWorkflowState)
    };
  }

  const currentProjectStatus = readProjectStatus(projectStatusPath, stateStore) || latestWorkflowState.project_status;
  const completed = completeRequirementInProjectStatus(currentProjectStatus || {}, {
    requirement_id: requirementId
  }, {
    completed_at: input.created_at || input.createdAt
  });
  if (completed.status !== "pass") {
    return {
      completed: false,
      item: latestItem,
      issues: completed.issues || [],
      projection: workbenchProjection(latestWorkflowState)
    };
  }
  const nextWorkflowState = workflowStateWithProjectStatus(latestWorkflowState, completed.project_status);
  writeProjectStatusState(projectStatusPath, completed.project_status, stateStore);
  writeWorkflowState(latestItem, nextWorkflowState);
  return {
    completed: true,
    item: latestItem,
    requirement: completed.requirement,
    plan_review: completed.plan_review,
    projection: workbenchProjection(nextWorkflowState)
  };
}

export async function runRequirementAutoAdvance({
  req,
  selectedId,
  input,
  requirementId,
  item,
  readWorkflowState,
  writeWorkflowState,
  readServerHistory,
  allowedHistoryRoots,
  projectStatusPath,
  stateStore,
  workbenchProjection,
  projectionById
}) {
  if (!requirementAutoAdvanceEnabled(input)) {
    return {
      status: "disabled",
      result: null,
      artifact: null,
      projection: workbenchProjection(readWorkflowState(item))
    };
  }

  const loopInput = requirementAutoAdvanceInput(selectedId, input);
  const loopResult = await runSchedulerLoopDriver(loopInput, {
    client: createWorkbenchLoopClient(workbenchBaseUrlFromRequest(req))
  });
  const loopArtifact = createSchedulerLoopRunArtifact(loopInput, loopResult, {
    created_at: input.created_at || input.createdAt
  });
  const latestWorkflowState = readWorkflowState(item);
  const recorded = recordAutonomousSchedulerLoopRunArtifact(latestWorkflowState, loopArtifact, {
    created_at: input.created_at || input.createdAt
  });
  if (recorded.status !== "pass") {
    return {
      status: "failed",
      result: loopResult,
      artifact: loopArtifact,
      issues: recorded.issues,
      projection: workbenchProjection(latestWorkflowState)
    };
  }

  writeWorkflowState(item, { ...latestWorkflowState, ...recorded.workflow_state });
  const history = readServerHistory();
  let projection = workbenchProjection(recorded.workflow_state);
  try {
    projection = typeof projectionById === "function"
      ? projectionById(history.latest, history, allowedHistoryRoots, projectStatusPath, stateStore).projection
      : workbenchProjection(recorded.workflow_state);
  } catch {
    projection = workbenchProjection(recorded.workflow_state);
  }
  const completion = completeRequirementAfterAutoAdvance({
    requirementId,
    loopResult,
    input,
    readServerHistory,
    readWorkflowState,
    writeWorkflowState,
    projectStatusPath,
    stateStore,
    workbenchProjection
  });
  if (completion.projection) {
    projection = completion.projection;
  }

  return {
    status: loopResult.status === "pass" ? "created" : "failed",
    result: loopResult,
    artifact: loopArtifact,
    issues: loopResult.issues || [],
    requirement_completion: {
      status: completion.completed ? "completed" : "not_completed",
      requirement_id: normalizeString(requirementId) || null,
      item_id: completion.item?.id || null,
      requirement: completion.requirement || null,
      plan_review: completion.plan_review || null,
      issues: completion.issues || []
    },
    projection
  };
}
