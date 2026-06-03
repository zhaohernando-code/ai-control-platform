export async function handleSchedulerLoopRoutes(context) {
  const {
    url,
    req,
    res,
    jsonBodyLimitBytes,
    jsonResponse,
    readJsonBody,
    readServerHistory,
    readWorkflowState,
    writeWorkflowState,
    workbenchProjection,
    runSchedulerLoopDriver,
    createWorkbenchLoopClient,
    workbenchBaseUrlFromRequest,
    createSchedulerLoopRunArtifact,
    recordAutonomousSchedulerLoopRunArtifact,
    buildSchedulerLoopRunRegistry,
    evaluateSchedulerLoopRecovery,
    recordSchedulerLoopResumeAttempt,
    executeProjectedNextAction
  } = context;

  if (url.pathname === "/api/workbench/autonomous-scheduler-loop" && req.method === "POST") {
    const history = readServerHistory();
    const selectedId = url.searchParams.get("id") || history.latest;
    const item = history.items.find((entry) => entry.id === selectedId);
    if (!item?.input_path) {
      jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
      return true;
    }

    const input = await readJsonBody(req, { maxBytes: jsonBodyLimitBytes });
    const maxIterations = Number(input.max_iterations || input.maxIterations || 1);
    const loopInput = {
      start_projection_id: selectedId,
      max_iterations: maxIterations,
      execution_profile: input.execution_profile || input.executionProfile || "approved_mock_non_dry_run",
      execution_strategy: input.execution_strategy || input.executionStrategy || "scheduler_dispatch_chain",
      reviewer_mock_status: input.reviewer_mock_status || input.reviewerMockStatus,
      reviewer_mock_findings_json: input.reviewer_mock_findings_json || input.reviewerMockFindingsJson,
      max_external_reviewer_calls: input.max_external_reviewer_calls ?? input.maxExternalReviewerCalls,
      provider_cost_mode: input.provider_cost_mode || input.providerCostMode,
      budget_tier: input.budget_tier || input.budgetTier,
      risk: input.risk || input.risk_level || input.riskLevel,
      timeout_seconds: input.timeout_seconds || input.timeoutSeconds,
      record_provider_health_on_timeout: input.record_provider_health_on_timeout ?? input.recordProviderHealthOnTimeout,
      snapshot_prefix: input.snapshot_prefix || input.snapshotPrefix || "autonomous-loop",
      created_at: input.created_at || input.createdAt
    };
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
      jsonResponse(res, 400, { error: "autonomous scheduler loop record failed", issues: recorded.issues });
      return true;
    }
    writeWorkflowState(item, { ...latestWorkflowState, ...recorded.workflow_state });

    jsonResponse(res, loopResult.status === "pass" ? 201 : 400, {
      status: loopResult.status === "pass" ? "created" : "failed",
      item,
      result: loopResult,
      artifact: recorded.artifact,
      projection: workbenchProjection(recorded.workflow_state)
    });
    return true;
  }

  if (url.pathname === "/api/workbench/autonomous-scheduler-loop-resume" && req.method === "POST") {
    const history = readServerHistory();
    const selectedId = url.searchParams.get("id") || history.latest;
    const item = history.items.find((entry) => entry.id === selectedId);
    if (!item?.input_path) {
      jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
      return true;
    }

    const input = await readJsonBody(req, { maxBytes: jsonBodyLimitBytes });
    const sourceWorkflowState = readWorkflowState(item);
    const registry = buildSchedulerLoopRunRegistry(sourceWorkflowState);
    const recovery = evaluateSchedulerLoopRecovery(registry);
    const sourceProjection = workbenchProjection(sourceWorkflowState);
    if (recovery.status !== "ready" || !recovery.resume_projection_id) {
      const blockedAttempt = recordSchedulerLoopResumeAttempt(sourceWorkflowState, {
        status: "blocked",
        source_projection_id: selectedId,
        recovery_status: recovery.status,
        recovery_action: recovery.action,
        issues: recovery.issues || []
      }, {
        created_at: input.created_at || input.createdAt
      });
      if (blockedAttempt.status === "pass") {
        writeWorkflowState(item, { ...sourceWorkflowState, ...blockedAttempt.workflow_state });
      }
      jsonResponse(res, 409, {
        error: "autonomous scheduler loop is not resumable",
        recovery,
        resume_attempt: blockedAttempt.artifact || null,
        projection: blockedAttempt.status === "pass"
          ? workbenchProjection(blockedAttempt.workflow_state)
          : sourceProjection
      });
      return true;
    }

    const targetId = recovery.resume_projection_id;
    const targetItem = history.items.find((entry) => entry.id === targetId);
    if (!targetItem?.input_path) {
      const blockedAttempt = recordSchedulerLoopResumeAttempt(sourceWorkflowState, {
        status: "blocked",
        source_projection_id: selectedId,
        resume_projection_id: targetId,
        recovery_status: recovery.status,
        recovery_action: recovery.action,
        issues: [{ code: "resume_input_missing", message: `resume workflow state input not found: ${targetId}`, path: "recovery.resume_projection_id" }]
      }, {
        created_at: input.created_at || input.createdAt
      });
      if (blockedAttempt.status === "pass") {
        writeWorkflowState(item, { ...sourceWorkflowState, ...blockedAttempt.workflow_state });
      }
      jsonResponse(res, 400, {
        error: `resume workflow state input not found: ${targetId}`,
        recovery,
        resume_attempt: blockedAttempt.artifact || null,
        projection: blockedAttempt.status === "pass"
          ? workbenchProjection(blockedAttempt.workflow_state)
          : sourceProjection
      });
      return true;
    }

    const loopInput = {
      start_projection_id: targetId,
      max_iterations: Number(input.max_iterations || input.maxIterations || 1),
      execution_profile: input.execution_profile || input.executionProfile || "approved_mock_non_dry_run",
      execution_strategy: input.execution_strategy || input.executionStrategy || "scheduler_dispatch_chain",
      reviewer_mock_status: input.reviewer_mock_status || input.reviewerMockStatus,
      reviewer_mock_findings_json: input.reviewer_mock_findings_json || input.reviewerMockFindingsJson,
      max_external_reviewer_calls: input.max_external_reviewer_calls ?? input.maxExternalReviewerCalls,
      provider_cost_mode: input.provider_cost_mode || input.providerCostMode,
      budget_tier: input.budget_tier || input.budgetTier,
      risk: input.risk || input.risk_level || input.riskLevel,
      timeout_seconds: input.timeout_seconds || input.timeoutSeconds,
      record_provider_health_on_timeout: input.record_provider_health_on_timeout ?? input.recordProviderHealthOnTimeout,
      snapshot_prefix: input.snapshot_prefix || input.snapshotPrefix || "resume-loop",
      created_at: input.created_at || input.createdAt
    };
    const loopResult = await runSchedulerLoopDriver(loopInput, {
      client: createWorkbenchLoopClient(workbenchBaseUrlFromRequest(req))
    });
    const loopArtifact = createSchedulerLoopRunArtifact(loopInput, loopResult, {
      created_at: input.created_at || input.createdAt
    });

    const targetWorkflowState = readWorkflowState(targetItem);
    const recorded = recordAutonomousSchedulerLoopRunArtifact(targetWorkflowState, loopArtifact, {
      created_at: input.created_at || input.createdAt
    });
    if (recorded.status !== "pass") {
      jsonResponse(res, 400, { error: "autonomous scheduler loop resume record failed", issues: recorded.issues });
      return true;
    }
    writeWorkflowState(targetItem, { ...targetWorkflowState, ...recorded.workflow_state });

    const resumeAttempt = recordSchedulerLoopResumeAttempt(sourceWorkflowState, {
      status: loopResult.status === "pass" ? "pass" : "fail",
      source_projection_id: selectedId,
      resume_projection_id: targetId,
      recovery_status: recovery.status,
      recovery_action: recovery.action,
      loop_status: loopResult.status,
      loop_phase: loopResult.phase,
      loop_artifact_id: recorded.artifact.id,
      issues: loopResult.issues || []
    }, {
      created_at: input.created_at || input.createdAt
    });
    if (resumeAttempt.status !== "pass") {
      jsonResponse(res, 400, { error: "scheduler loop resume attempt record failed", issues: resumeAttempt.issues });
      return true;
    }
    writeWorkflowState(item, { ...sourceWorkflowState, ...resumeAttempt.workflow_state });

    jsonResponse(res, loopResult.status === "pass" ? 201 : 400, {
      status: loopResult.status === "pass" ? "created" : "failed",
      source_item: item,
      item: targetItem,
      recovery,
      result: loopResult,
      artifact: recorded.artifact,
      resume_attempt: resumeAttempt.artifact,
      source_projection: workbenchProjection(resumeAttempt.workflow_state),
      projection: workbenchProjection(recorded.workflow_state)
    });
    return true;
  }

  if (url.pathname === "/api/workbench/next-action" && req.method === "POST") {
    const history = readServerHistory();
    const selectedId = url.searchParams.get("id") || history.latest;
    const item = history.items.find((entry) => entry.id === selectedId);
    if (!item?.input_path) {
      jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
      return true;
    }

    const input = await readJsonBody(req, { maxBytes: jsonBodyLimitBytes });
    const workflowState = readWorkflowState(item);
    const projection = workbenchProjection(workflowState);
    const executed = await executeProjectedNextAction({ req, selectedId, projection, input });
    if (executed.status !== "executed") {
      jsonResponse(res, executed.http_status || 409, {
        error: executed.error,
        issues: executed.issues || [],
        item,
        next_action_readout: projection.next_action_readout,
        result: executed.result || null,
        projection
      });
      return true;
    }
    const updatedWorkflowState = readWorkflowState(item);
    const updatedProjection = workbenchProjection(updatedWorkflowState);

    jsonResponse(res, 201, {
      status: "executed",
      action: executed.action,
      item,
      next_action_readout: projection.next_action_readout,
      result: executed.result,
      projection: updatedProjection,
      previous_projection: projection
    });
    return true;
  }

  return false;
}
