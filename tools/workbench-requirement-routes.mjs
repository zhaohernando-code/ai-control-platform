import {
  applyGeneratedRequirementPlan,
  closeRequirementInProjectStatus,
  parseRequirementPlanGenerationOutput,
  recordRequirementIntakeSubmitted,
  resetRequirementPlanGeneration,
  submitRequirementToProjectStatus,
  updateRequirementPlanReview
} from "../src/workflow/requirement-intake.js";
import { sqliteSnapshotInputPath } from "../src/workflow/workbench-state-store.js";

export async function handleRequirementRoutes(context) {
  const {
    url,
    req,
    res,
    jsonBodyLimitBytes,
    jsonResponse,
    readJsonBody,
    readServerHistory,
    writeServerHistory,
    readWorkflowState,
    writeWorkflowState,
    readProjectStatus,
    writeProjectStatusState,
    createInitialWorkflowState,
    projectStatusPath,
    stateStore,
    safeSnapshotIdPart,
    requirementPlanGenerationRunsInBackground,
    startRequirementPlanGenerationInBackground,
    generateRequirementPlanIfRequested,
    requirementPlanGenerator,
    requirementAutoAdvanceAllowedAfterPlanReview,
    workflowStateWithProjectStatus,
    workbenchProjection,
    runRequirementAutoAdvance,
    allowedHistoryRoots,
    normalizeString,
    requirementAutoAdvanceEnabled
  } = context;

  if (url.pathname === "/api/workbench/requirements" && req.method === "POST") {
    const input = await readJsonBody(req, { maxBytes: jsonBodyLimitBytes });
    const history = readServerHistory();
    const selectedId = url.searchParams.get("id") || history.latest;

    let workflowState;
    let item;

    if (selectedId && history.items) {
      item = history.items.find((entry) => entry.id === selectedId);
      if (item?.input_path) {
        workflowState = readWorkflowState(item);
      }
    }

    if (!workflowState) {
      const runId = `requirement-submission-${Date.now()}`;
      const cycleId = `cycle-${Date.now()}`;
      workflowState = createInitialWorkflowState(runId, cycleId, projectStatusPath, stateStore);
    }
    const currentProjectStatus = readProjectStatus(projectStatusPath, stateStore) || workflowState.project_status;
    const submitted = submitRequirementToProjectStatus(currentProjectStatus || {}, input, {
      created_at: input.created_at || input.createdAt,
      requirement_id: input.requirement_id || input.requirementId
    });
    if (submitted.status !== "pass") {
      jsonResponse(res, 400, { error: "invalid requirement submission", issues: submitted.issues });
      return true;
    }

    const submittedRecorded = recordRequirementIntakeSubmitted(workflowState, submitted, {
      created_at: input.created_at || input.createdAt
    });
    if (submittedRecorded.status !== "pass") {
      jsonResponse(res, 400, { error: "requirement intake record failed", issues: submittedRecorded.issues });
      return true;
    }

    const recordedWorkflowState = { ...workflowState, ...submittedRecorded.workflow_state };
    writeProjectStatusState(projectStatusPath, submitted.project_status, stateStore);

    if (!item) {
      const requirementId = submitted.requirement?.id || `requirement-${Date.now()}`;
      const snapshotId = `requirement-intake-submission-${safeSnapshotIdPart(requirementId)}-${Date.now()}`;
      const createdAt = new Date().toISOString();
      const inputPath = stateStore
        ? sqliteSnapshotInputPath(snapshotId)
        : `docs/examples/snapshots/${snapshotId}.workbench-input.json`;
      const newItem = {
        id: snapshotId,
        label: `需求提交: ${submitted.requirement?.title || "未命名"}`,
        input_path: inputPath,
        projection_path: null,
        created_at: createdAt,
        status: "pending"
      };
      item = newItem;
      history.items.unshift(newItem);
      history.latest = snapshotId;
      writeServerHistory(history);
    }

    writeWorkflowState(item, recordedWorkflowState);

    if (requirementPlanGenerationRunsInBackground(input)) {
      const projection = workbenchProjection(recordedWorkflowState);
      startRequirementPlanGenerationInBackground({
        submitted,
        input,
        item,
        readWorkflowState,
        writeWorkflowState,
        projectStatusPath,
        stateStore,
        requirementPlanGenerator
      });
      jsonResponse(res, 201, {
        status: "created",
        item,
        requirement: submitted.requirement,
        plan_review: submitted.plan_review,
        plan_generation: { status: "scheduled", issues: [] },
        artifact: submittedRecorded.artifact,
        next_action_readout: projection.next_action_readout,
        projection,
        submitted_projection: projection,
        auto_advance: {
          status: "waiting_for_plan_generation",
          result: null,
          artifact: null,
          projection,
          reason: "requirement plan generation is running in the task flow after task creation"
        }
      });
      return true;
    }

    const planGeneration = await generateRequirementPlanIfRequested(submitted, input, {
      requirementPlanGenerator
    });
    let effectiveSubmission = planGeneration.submission;
    if (
      effectiveSubmission.plan_review?.phase === "ready_for_review" &&
      requirementAutoAdvanceAllowedAfterPlanReview(input)
    ) {
      const approved = updateRequirementPlanReview(effectiveSubmission.project_status, {
        requirement_id: effectiveSubmission.requirement.id,
        action: "approve",
        note: "auto advance was explicitly allowed for an already-approved plan review",
        created_at: input.created_at || input.createdAt
      }, {
        created_at: input.created_at || input.createdAt
      });
      if (approved.status !== "pass") {
        jsonResponse(res, 400, { error: "plan review approval failed", issues: approved.issues });
        return true;
      }
      effectiveSubmission = {
        ...effectiveSubmission,
        plan_review: approved.plan_review,
        project_status: approved.project_status
      };
    }

    const effectiveWorkflowState = workflowStateWithProjectStatus(
      submittedRecorded.workflow_state,
      effectiveSubmission.project_status
    );
    writeProjectStatusState(projectStatusPath, effectiveSubmission.project_status, stateStore);
    writeWorkflowState(item, effectiveWorkflowState);
    const projection = workbenchProjection(effectiveWorkflowState);
    const planReviewPhase = effectiveSubmission.plan_review?.phase;
    const planReviewPending = planReviewPhase === "ready_for_review" &&
      !requirementAutoAdvanceAllowedAfterPlanReview(input);
    const planGenerationPending = planReviewPhase === "pending_plan_generation";
    const planGenerationFailed = planReviewPhase === "plan_generation_failed";
    const auto_advance = planReviewPending
      ? {
        status: "waiting_for_plan_review",
        result: null,
        artifact: null,
        projection,
        reason: "requirement plan review must be approved before automatic development can continue"
      }
      : planGenerationPending
        ? {
          status: "waiting_for_plan_generation",
          result: null,
          artifact: null,
          projection,
          reason: "requirement plan must be generated by a model before review or development can continue"
        }
      : planGenerationFailed
        ? {
          status: "plan_generation_failed",
          result: null,
          artifact: null,
          projection,
          reason: effectiveSubmission.plan_review?.generation_error?.message ||
            "requirement plan generation failed and must be retried or repaired"
        }
      : await runRequirementAutoAdvance({
        req,
        selectedId,
        input,
        requirementId: effectiveSubmission.requirement?.id,
        item,
        readWorkflowState,
        writeWorkflowState,
        readServerHistory,
        allowedHistoryRoots,
        projectStatusPath,
        stateStore,
        workbenchProjection
      });
    jsonResponse(res, 201, {
      status: "created",
      item,
      requirement: auto_advance.requirement_completion?.requirement || effectiveSubmission.requirement,
      plan_review: auto_advance.requirement_completion?.plan_review || effectiveSubmission.plan_review,
      plan_generation: {
        status: planGeneration.status,
        issues: planGeneration.issues || []
      },
      artifact: submittedRecorded.artifact,
      next_action_readout: auto_advance.projection?.next_action_readout || projection.next_action_readout,
      projection: auto_advance.projection || projection,
      submitted_projection: projection,
      auto_advance
    });
    return true;
  }

  if (url.pathname === "/api/workbench/requirements/retry-plan" && req.method === "POST") {
    const history = readServerHistory();
    const selectedId = url.searchParams.get("id") || history.latest;
    const item = history.items.find((entry) => entry.id === selectedId);
    if (!item?.input_path) {
      jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
      return true;
    }

    const input = await readJsonBody(req, { maxBytes: jsonBodyLimitBytes });
    const workflowState = readWorkflowState(item);
    const currentProjectStatus = readProjectStatus(projectStatusPath, stateStore) || workflowState.project_status;
    const reset = resetRequirementPlanGeneration(currentProjectStatus || {}, input, {
      created_at: input.created_at || input.createdAt
    });
    if (reset.status !== "pass") {
      jsonResponse(res, 400, { error: "invalid requirement plan retry", issues: reset.issues || [] });
      return true;
    }

    const nextWorkflowState = workflowStateWithProjectStatus(workflowState, reset.project_status);
    writeProjectStatusState(projectStatusPath, reset.project_status, stateStore);
    writeWorkflowState(item, nextWorkflowState);
    const projection = workbenchProjection(nextWorkflowState);
    const suppliedGeneratedPlan = input.generated_plan || input.generatedPlan;
    if (suppliedGeneratedPlan) {
      const parsedPlan = parseRequirementPlanGenerationOutput(reset.requirement, suppliedGeneratedPlan);
      if (parsedPlan.status !== "pass") {
        jsonResponse(res, 400, { error: "invalid supplied requirement plan", issues: parsedPlan.issues || [] });
        return true;
      }
      const applied = applyGeneratedRequirementPlan(reset.project_status, {
        requirement_id: reset.requirement.id,
        generated_plan: parsedPlan,
        generator: {
          kind: "operator_supplied_requirement_plan",
          command: null,
          role: "operator",
          model: null,
          timed_out: false
        }
      }, {
        created_at: input.created_at || input.createdAt
      });
      if (applied.status !== "pass") {
        jsonResponse(res, 400, { error: "supplied requirement plan apply failed", issues: applied.issues || [] });
        return true;
      }
      const appliedWorkflowState = workflowStateWithProjectStatus(workflowState, applied.project_status);
      writeProjectStatusState(projectStatusPath, applied.project_status, stateStore);
      writeWorkflowState(item, appliedWorkflowState);
      const appliedProjection = workbenchProjection(appliedWorkflowState);
      jsonResponse(res, 201, {
        status: "generated",
        item,
        requirement: applied.requirement,
        plan_review: applied.plan_review,
        plan_generation: { status: "generated", issues: [] },
        projection: appliedProjection,
        auto_advance: {
          status: "waiting_for_plan_review",
          result: null,
          artifact: null,
          projection: appliedProjection,
          reason: "supplied requirement plan is ready for review"
        }
      });
      return true;
    }
    startRequirementPlanGenerationInBackground({
      submitted: {
        status: "pass",
        requirement: reset.requirement,
        plan_review: reset.plan_review,
        project_status: reset.project_status
      },
      input,
      item,
      readWorkflowState,
      writeWorkflowState,
      projectStatusPath,
      stateStore,
      requirementPlanGenerator
    });
    jsonResponse(res, 202, {
      status: "scheduled",
      item,
      requirement: reset.requirement,
      plan_review: reset.plan_review,
      plan_generation: { status: "scheduled", issues: [] },
      projection,
      auto_advance: {
        status: "waiting_for_plan_generation",
        result: null,
        artifact: null,
        projection,
        reason: "requirement plan generation retry is running in the task flow"
      }
    });
    return true;
  }

  if (url.pathname === "/api/workbench/requirements/close" && req.method === "POST") {
    const history = readServerHistory();
    const selectedId = url.searchParams.get("id") || history.latest;
    const item = history.items.find((entry) => entry.id === selectedId);
    if (!item?.input_path) {
      jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
      return true;
    }

    const input = await readJsonBody(req, { maxBytes: jsonBodyLimitBytes });
    const workflowState = readWorkflowState(item);
    const currentProjectStatus = readProjectStatus(projectStatusPath, stateStore) || workflowState.project_status;
    const closed = closeRequirementInProjectStatus(currentProjectStatus || {}, input, {
      created_at: input.created_at || input.createdAt
    });
    if (closed.status !== "pass") {
      jsonResponse(res, 400, { error: "invalid requirement close", issues: closed.issues || [] });
      return true;
    }

    const nextWorkflowState = workflowStateWithProjectStatus(workflowState, closed.project_status);
    writeProjectStatusState(projectStatusPath, closed.project_status, stateStore);
    writeWorkflowState(item, nextWorkflowState);
    const projection = workbenchProjection(nextWorkflowState);
    jsonResponse(res, 201, {
      status: "closed",
      item,
      requirement: closed.requirement,
      plan_review: closed.plan_review,
      projection
    });
    return true;
  }

  if (url.pathname === "/api/workbench/plan-reviews" && req.method === "POST") {
    const history = readServerHistory();
    const selectedId = url.searchParams.get("id") || history.latest;
    const item = history.items.find((entry) => entry.id === selectedId);
    if (!item?.input_path) {
      jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
      return true;
    }

    const input = await readJsonBody(req, { maxBytes: jsonBodyLimitBytes });
    const workflowState = readWorkflowState(item);
    const currentProjectStatus = readProjectStatus(projectStatusPath, stateStore) || workflowState.project_status;
    const updated = updateRequirementPlanReview(currentProjectStatus || {}, input, {
      created_at: input.created_at || input.createdAt
    });
    if (updated.status !== "pass") {
      jsonResponse(res, 400, { error: "invalid plan review update", issues: updated.issues });
      return true;
    }

    const nextWorkflowState = {
      ...workflowState,
      project_status: updated.project_status,
      global_goals: Array.isArray(updated.project_status.global_goals) ? updated.project_status.global_goals : workflowState.global_goals
    };
    writeProjectStatusState(projectStatusPath, updated.project_status, stateStore);
    writeWorkflowState(item, nextWorkflowState);
    const projection = workbenchProjection(nextWorkflowState);
    const shouldAutoAdvanceAfterApproval = normalizeString(input.action).toLowerCase() === "approve" &&
      requirementAutoAdvanceEnabled(input);
    const auto_advance = shouldAutoAdvanceAfterApproval
      ? await runRequirementAutoAdvance({
        req,
        selectedId,
        input: {
          ...input,
          auto_advance_after_plan_review: true
        },
        requirementId: input.requirement_id || input.requirementId,
        item,
        readWorkflowState,
        writeWorkflowState,
        readServerHistory,
        allowedHistoryRoots,
        projectStatusPath,
        stateStore,
        workbenchProjection
      })
      : {
        status: "disabled",
        result: null,
        artifact: null,
        projection
      };
    jsonResponse(res, 201, {
      status: "updated",
      item,
      plan_review: auto_advance.requirement_completion?.plan_review || updated.plan_review,
      projection: auto_advance.projection || projection,
      submitted_projection: projection,
      auto_advance
    });
    return true;
  }

  return false;
}
