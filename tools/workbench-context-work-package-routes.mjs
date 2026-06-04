export async function handleContextWorkPackageRoutes(routeContext = {}) {
  const {
    url, req, res, jsonBodyLimitBytes, jsonResponse, readJsonBody, readServerHistory,
    readWorkflowState, writeWorkflowState, writeProjectStatusState, projectStatusPath, stateStore,
    stateDbPath, workbenchProjection, contextWorkPackageRunOptions, backgroundContextWorkPackageRequested,
    stageContextWorkPackageDispatch, isSqliteSnapshotPath, sqliteSnapshotIdFromInputPath,
    backgroundContextWorkPackageOutputPath, contextWorkPackageBackgroundLauncher, options,
    runContextWorkPackages, createMainlineAlreadySatisfiedEvaluator, root, contextWorkPackageProviderExecutor
  } = routeContext;

  if (!(url.pathname === "/api/workbench/context-work-packages-run" && req.method === "POST")) {
    return false;
  }

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
  const runOptions = contextWorkPackageRunOptions(input, projection);
  if (backgroundContextWorkPackageRequested(input)) {
    if (!stateStore || !stateDbPath || !isSqliteSnapshotPath(item.input_path)) {
      jsonResponse(res, 409, {
        status: "blocked",
        error: "background context work package dispatch requires sqlite live state",
        item,
        issues: [{
          code: "background_dispatch_requires_sqlite_state",
          message: "background context work package dispatch requires a sqlite workflow snapshot so the child runner can update state without blocking the API",
          path: "state_store"
        }],
        projection
      });
      return true;
    }

    const dispatchRunId = `context-work-package-dispatch-${selectedId}-${Date.now()}`;
    const staged = stageContextWorkPackageDispatch(workflowState, {
      ...runOptions,
      dispatch_run_id: dispatchRunId
    });
    if (staged.status !== "pass") {
      jsonResponse(res, 409, {
        status: staged.status,
        error: "context work package dispatch could not be started",
        issues: staged.issues || [],
        item,
        phase: staged.phase,
        fixed_development_mode_gate: staged.fixed_development_mode_gate || staged.gate_result || null,
        work_package_execution_governance: staged.work_package_execution_governance ||
          (staged.phase === "work_package_execution_governance" ? staged.gate_result : null),
        projection
      });
      return true;
    }

    writeWorkflowState(item, staged.workflow_state);
    if (staged.workflow_state.project_status) {
      writeProjectStatusState(projectStatusPath, staged.workflow_state.project_status, stateStore);
    }
    const stagedProjection = workbenchProjection(staged.workflow_state);
    const backgroundJob = contextWorkPackageBackgroundLauncher({
      state_db: stateDbPath,
      snapshot_id: sqliteSnapshotIdFromInputPath(item.input_path),
      output_path: backgroundContextWorkPackageOutputPath(dispatchRunId),
      selected_work_package_ids: staged.selected_work_package_ids,
      dispatch_run_id: dispatchRunId,
      created_at: input.created_at || input.createdAt || new Date().toISOString(),
      timeout_seconds: options.contextWorkPackageProviderTimeoutSeconds ||
        options.context_work_package_provider_timeout_seconds ||
        process.env.AI_CONTROL_WORKBENCH_CONTEXT_PROVIDER_TIMEOUT_SECONDS,
      idle_timeout_seconds: options.contextWorkPackageProviderIdleTimeoutSeconds ||
        options.context_work_package_provider_idle_timeout_seconds ||
        process.env.AI_CONTROL_WORKBENCH_CONTEXT_PROVIDER_IDLE_TIMEOUT_SECONDS,
      channels_path: options.agentChannelsPath ||
        options.agent_channels_path ||
        process.env.AI_CONTROL_WORKBENCH_AGENT_CHANNELS_PATH,
      profiles_path: options.agentProfilesPath ||
        options.agent_profiles_path ||
        process.env.AI_CONTROL_WORKBENCH_AGENT_PROFILES_PATH
    });
    jsonResponse(res, 202, {
      status: "accepted",
      phase: staged.phase,
      item,
      dispatch_run_id: dispatchRunId,
      selected_work_package_ids: staged.selected_work_package_ids,
      background_job: backgroundJob,
      projection: stagedProjection
    });
    return true;
  }

  const result = runContextWorkPackages(workflowState, {
    ...runOptions,
    already_satisfied_evaluator: createMainlineAlreadySatisfiedEvaluator({ root }),
    provider_executor: contextWorkPackageProviderExecutor
  });
  if (result.status !== "pass") {
    jsonResponse(res, 409, {
      status: result.status,
      error: result.status === "validated"
        ? "context work package run validated without completion authority"
        : "context work package run failed",
      issues: result.issues || [],
      item,
      phase: result.phase,
      fixed_development_mode_gate: result.fixed_development_mode_gate || result.gate_result || null,
      work_package_execution_governance: result.work_package_execution_governance ||
        (result.phase === "work_package_execution_governance" ? result.gate_result : null),
      execution_plan: result.execution_plan || null,
      package_results: result.package_results || [],
      executor_provenance: result.executor_provenance || null,
      allows_work_package_completion: result.allows_work_package_completion === true,
      completion_authority: result.completion_authority || null,
      projection: workbenchProjection(workflowState)
    });
    return true;
  }

  writeWorkflowState(item, { ...workflowState, ...result.workflow_state });
  if (result.workflow_state?.project_status) {
    writeProjectStatusState(projectStatusPath, result.workflow_state.project_status, stateStore);
  }
  jsonResponse(res, 201, {
    status: "created",
    item,
    phase: result.phase,
    executed_count: result.executed_count,
    executed_work_packages: result.executed_work_packages,
    artifact: result.artifact,
    projection: workbenchProjection(result.workflow_state)
  });
  return true;
}
