export async function handleSchedulerDispatchRoutes(context) {
  const {
    url,
    req,
    res,
    root,
    snapshotsRoot,
    serverHistoryPath,
    jsonBodyLimitBytes,
    jsonResponse,
    readJsonBody,
    readJson,
    readServerHistory,
    readWorkflowState,
    writeWorkflowState,
    publishSnapshot,
    workbenchProjection,
    createSchedulerDispatchPlan,
    schedulerPlanInputFromWorkflowState,
    schedulerPlanOptionsFromRequest,
    normalizeSchedulerDispatchControlRequest,
    evaluateSchedulerDispatchControlPolicy,
    recordSchedulerDispatchPolicyDecision,
    runSchedulerDispatchPlan,
    createSchedulerDispatchRunArtifact,
    readSchedulerWorkflowStateOutput,
    recordSchedulerDispatchRunArtifact,
    prepareSchedulerDispatchContinuationFromRunArtifact,
    writePreparedSchedulerContinuation,
    recordSchedulerDispatchContinuationPrepared,
    metadataPath,
    latestSchedulerDispatchRun,
    safeGeneratedContinuationPath,
    schedulerContinuationOutputPath,
    generatedContinuationInputIssues,
    latestArtifactForEvent,
    normalizeString,
    recordSchedulerNextCycleEnqueue,
    schedulerDispatchRunIssues,
    schedulerDispatchRunArtifactFromInput,
    resolve
  } = context;

  if (url.pathname === "/api/workbench/scheduler-dispatch-plan" && req.method === "POST") {
    const history = readServerHistory();
    const selectedId = url.searchParams.get("id") || history.latest;
    const item = history.items.find((entry) => entry.id === selectedId);
    if (!item?.input_path) {
      jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
      return true;
    }

    const input = await readJsonBody(req, { maxBytes: jsonBodyLimitBytes });
    const workflowState = readWorkflowState(item);
    const plan = createSchedulerDispatchPlan(
      schedulerPlanInputFromWorkflowState(workflowState, input),
      schedulerPlanOptionsFromRequest(req, item, selectedId, input, workflowState)
    );
    if (plan.status !== "pass") {
      jsonResponse(res, 400, { error: "scheduler dispatch plan failed", issues: plan.issues });
      return true;
    }

    jsonResponse(res, 201, { status: "created", item, plan });
    return true;
  }

  if (url.pathname === "/api/workbench/scheduler-dispatch" && req.method === "POST") {
    const history = readServerHistory();
    const selectedId = url.searchParams.get("id") || history.latest;
    const item = history.items.find((entry) => entry.id === selectedId);
    if (!item?.input_path) {
      jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
      return true;
    }

    const input = await readJsonBody(req, { maxBytes: jsonBodyLimitBytes });
    const normalizedControl = normalizeSchedulerDispatchControlRequest(input);
    if (normalizedControl.status !== "pass") {
      jsonResponse(res, 400, { error: "scheduler dispatch control request rejected", issues: normalizedControl.issues });
      return true;
    }
    const controlInput = normalizedControl.input;
    const workflowState = readWorkflowState(item);
    const plan = createSchedulerDispatchPlan(
      schedulerPlanInputFromWorkflowState(workflowState, controlInput),
      schedulerPlanOptionsFromRequest(req, item, selectedId, controlInput, workflowState)
    );
    if (plan.status !== "pass") {
      jsonResponse(res, 400, { error: "scheduler dispatch plan failed", issues: plan.issues });
      return true;
    }

    const policy = evaluateSchedulerDispatchControlPolicy(controlInput, plan);
    const policyRecorded = recordSchedulerDispatchPolicyDecision(workflowState, policy, {
      created_at: controlInput.created_at || controlInput.createdAt,
      plan
    });
    if (policyRecorded.status !== "pass") {
      jsonResponse(res, 400, { error: "scheduler dispatch policy record failed", issues: policyRecorded.issues });
      return true;
    }
    writeWorkflowState(item, { ...workflowState, ...policyRecorded.workflow_state });

    if (policy.status !== "pass") {
      jsonResponse(res, 400, {
        error: "scheduler dispatch policy rejected",
        issues: policy.issues,
        policy,
        control: normalizedControl,
        artifact: policyRecorded.artifact,
        projection: workbenchProjection(policyRecorded.workflow_state)
      });
      return true;
    }

    const runResult = await runSchedulerDispatchPlan(plan, { dry_run: policy.execution_mode === "dry_run" });
    const runArtifact = createSchedulerDispatchRunArtifact(plan, runResult, {
      created_at: controlInput.created_at || controlInput.createdAt
    });
    let workflowStateForRunRecord = policyRecorded.workflow_state;
    if (
      policy.execution_mode !== "dry_run" &&
      plan.dispatch_kind === "agent_lifecycle_cleanup" &&
      runResult.status === "pass"
    ) {
      const cleanupOutput = readSchedulerWorkflowStateOutput(runResult);
      if (cleanupOutput.status !== "pass") {
        jsonResponse(res, 400, {
          error: "scheduler dispatch cleanup output unavailable",
          issues: cleanupOutput.issues || [],
          projection: workbenchProjection(policyRecorded.workflow_state)
        });
        return true;
      }
      workflowStateForRunRecord = cleanupOutput.workflow_state;
    }

    const recorded = recordSchedulerDispatchRunArtifact(workflowStateForRunRecord, runArtifact, {
      created_at: controlInput.created_at || controlInput.createdAt
    });
    if (recorded.status !== "pass") {
      jsonResponse(res, 400, { error: "scheduler dispatch run record failed", issues: recorded.issues });
      return true;
    }

    let nextWorkflowState = recorded.workflow_state;
    let continuation = null;
    if (policy.execution_mode !== "dry_run" && plan.dispatch_kind !== "agent_lifecycle_cleanup") {
      continuation = prepareSchedulerDispatchContinuationFromRunArtifact(runArtifact);
      if (continuation.status !== "ready") {
        jsonResponse(res, 400, {
          error: "scheduler dispatch continuation preparation failed",
          issues: continuation.issues || [],
          continuation,
          projection: workbenchProjection(nextWorkflowState)
        });
        return true;
      }
      const continuationOutputPath = writePreparedSchedulerContinuation(runArtifact, continuation, [
        resolve(root, "tmp"),
        snapshotsRoot
      ]);
      const continuationRecorded = recordSchedulerDispatchContinuationPrepared(nextWorkflowState, continuation, {
        created_at: controlInput.created_at || controlInput.createdAt,
        source_artifact_id: recorded.artifact.id,
        continuation_input_path: metadataPath(continuationOutputPath)
      });
      if (continuationRecorded.status !== "pass") {
        jsonResponse(res, 400, { error: "scheduler dispatch continuation record failed", issues: continuationRecorded.issues });
        return true;
      }
      nextWorkflowState = continuationRecorded.workflow_state;
    }

    writeWorkflowState(item, { ...workflowState, ...nextWorkflowState });
    jsonResponse(res, 201, {
      status: "created",
      item,
      plan,
      policy,
      control: normalizedControl,
      result: runResult,
      artifact: recorded.artifact,
      continuation,
      projection: workbenchProjection(nextWorkflowState)
    });
    return true;
  }

  if (url.pathname === "/api/workbench/scheduler-next-cycle" && req.method === "POST") {
    const history = readServerHistory();
    const selectedId = url.searchParams.get("id") || history.latest;
    const item = history.items.find((entry) => entry.id === selectedId);
    if (!item?.input_path) {
      jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
      return true;
    }

    const input = await readJsonBody(req, { maxBytes: jsonBodyLimitBytes });
    const workflowState = readWorkflowState(item);
    const latestRun = latestSchedulerDispatchRun(workflowState);
    if (!latestRun.metadata) {
      jsonResponse(res, 400, { error: "scheduler dispatch run artifact not found" });
      return true;
    }

    const continuation = prepareSchedulerDispatchContinuationFromRunArtifact(latestRun.metadata);
    if (continuation.status !== "ready") {
      jsonResponse(res, 400, {
        error: "scheduler dispatch continuation preparation failed",
        issues: continuation.issues || [],
        continuation
      });
      return true;
    }

    let continuationOutputPath;
    let generatedInput;
    try {
      continuationOutputPath = safeGeneratedContinuationPath(
        schedulerContinuationOutputPath(latestRun.metadata),
        [resolve(root, "tmp"), snapshotsRoot]
      );
      generatedInput = readJson(continuationOutputPath);
    } catch (error) {
      if (error.code === "ENOENT") {
        jsonResponse(res, 400, { error: "scheduler dispatch generated continuation input not found" });
        return true;
      }
      throw error;
    }
    const generatedIssues = generatedContinuationInputIssues(generatedInput, continuation);
    if (generatedIssues.length > 0) {
      jsonResponse(res, 400, { error: "generated continuation input validation failed", issues: generatedIssues });
      return true;
    }

    const createdAt = input.created_at || input.createdAt;
    const sourceArtifactId = latestRun.artifact?.id || latestRun.event?.artifact_id;
    const continuationInputPath = metadataPath(continuationOutputPath);
    const existingContinuation = latestArtifactForEvent(workflowState, "scheduler_dispatch_continuation");
    const existingContinuationMatchesRun = existingContinuation.metadata?.status === "ready" &&
      existingContinuation.metadata?.source_artifact_id === sourceArtifactId &&
      existingContinuation.metadata?.continuation_input_path === continuationInputPath;
    const continuationRecorded = existingContinuationMatchesRun
      ? {
        status: "pass",
        artifact: existingContinuation.artifact,
        workflow_state: workflowState
      }
      : recordSchedulerDispatchContinuationPrepared(workflowState, continuation, {
        created_at: createdAt,
        source_artifact_id: sourceArtifactId,
        continuation_input_path: continuationInputPath
      });
    if (continuationRecorded.status !== "pass") {
      jsonResponse(res, 400, { error: "scheduler dispatch continuation record failed", issues: continuationRecorded.issues });
      return true;
    }

    const requestedSnapshotId = normalizeString(input.snapshot_id || input.snapshotId);
    const snapshotId = requestedSnapshotId || `next-cycle-${selectedId}-${Date.now()}`;
    const enqueued = recordSchedulerNextCycleEnqueue(continuationRecorded.workflow_state, continuation, {
      created_at: createdAt,
      source_artifact_id: sourceArtifactId,
      continuation_artifact_id: continuationRecorded.artifact.id,
      continuation_input_path: continuationInputPath,
      snapshot_id: snapshotId
    });
    if (enqueued.status !== "pass") {
      jsonResponse(res, 400, { error: "scheduler next cycle enqueue record failed", issues: enqueued.issues });
      return true;
    }

    const published = publishSnapshot({
      id: snapshotId,
      label: input.label || `Next cycle from ${selectedId}`,
      input: generatedInput.workflow_state,
      created_at: createdAt
    }, {
      root,
      historyPath: serverHistoryPath,
      snapshotsRoot
    });
    if (published.status === "fail") {
      jsonResponse(res, 400, { error: "scheduler next cycle snapshot publish failed", issues: published.issues });
      return true;
    }

    writeWorkflowState(item, { ...workflowState, ...enqueued.workflow_state });
    jsonResponse(res, 201, {
      status: "queued",
      item,
      continuation,
      continuation_artifact: continuationRecorded.artifact,
      enqueue_artifact: enqueued.artifact,
      next_item: published.item,
      projection: published.projection,
      current_projection: workbenchProjection(enqueued.workflow_state)
    });
    return true;
  }

  if (url.pathname === "/api/workbench/scheduler-dispatch-run" && req.method === "POST") {
    const history = readServerHistory();
    const selectedId = url.searchParams.get("id") || history.latest;
    const item = history.items.find((entry) => entry.id === selectedId);
    if (!item?.input_path) {
      jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
      return true;
    }

    const input = await readJsonBody(req, { maxBytes: jsonBodyLimitBytes });
    const issues = schedulerDispatchRunIssues(input);
    if (issues.length > 0) {
      jsonResponse(res, 400, { error: "invalid scheduler dispatch run artifact", issues });
      return true;
    }
    const workflowState = readWorkflowState(item);
    const result = recordSchedulerDispatchRunArtifact(
      workflowState,
      schedulerDispatchRunArtifactFromInput(input),
      { created_at: input.created_at }
    );
    if (result.status !== "pass") {
      jsonResponse(res, 400, { error: "scheduler dispatch run record failed", issues: result.issues });
      return true;
    }

    writeWorkflowState(item, { ...workflowState, ...result.workflow_state });
    jsonResponse(res, 201, {
      status: "created",
      item,
      artifact: result.artifact,
      projection: workbenchProjection(result.workflow_state)
    });
    return true;
  }

  return false;
}
