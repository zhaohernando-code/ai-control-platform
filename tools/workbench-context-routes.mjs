export async function handleWorkbenchContextRoutes(routeContext = {}) {
  const {
    url, req, res, jsonBodyLimitBytes, jsonResponse, readJsonBody, readServerHistory,
    readWorkflowState, writeWorkflowState, readProjectStatus, writeProjectStatusState,
    projectStatusPath, stateStore, workbenchProjection, prepareContinuationFromProjectStatus,
    recordProjectStatusContinuationPrepared, materializeContextPackCycleFromWorkflowState,
    generatedContextPackSnapshotId, normalizeString, publishSnapshot, root, serverHistoryPath, snapshotsRoot
  } = routeContext;

  if (url.pathname === "/api/workbench/project-status-continuation" && req.method === "POST") {
    const history = readServerHistory();
    const selectedId = url.searchParams.get("id") || history.latest;
    const item = history.items.find((entry) => entry.id === selectedId);
    if (!item?.input_path) {
      jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
      return true;
    }

    const input = await readJsonBody(req, { maxBytes: jsonBodyLimitBytes });
    const workflowState = readWorkflowState(item);
    const projectStatus = readProjectStatus(projectStatusPath, stateStore) || workflowState.project_status;
    const prepared = prepareContinuationFromProjectStatus(projectStatus, { workflow_state: workflowState });
    const recorded = recordProjectStatusContinuationPrepared(workflowState, prepared, {
      created_at: input.created_at || input.createdAt
    });
    if (recorded.status !== "pass") {
      jsonResponse(res, 400, { error: "project status continuation record failed", issues: recorded.issues });
      return true;
    }

    writeWorkflowState(item, { ...workflowState, ...recorded.workflow_state });
    const statusCode = prepared.status === "ready" ? 201 : 409;
    jsonResponse(res, statusCode, {
      status: prepared.status === "ready" ? "created" : "blocked",
      item,
      continuation: prepared,
      artifact: recorded.artifact,
      projection: workbenchProjection(recorded.workflow_state)
    });
    return true;
  }

  if (url.pathname === "/api/workbench/context-pack-cycle" && req.method === "POST") {
    const history = readServerHistory();
    const selectedId = url.searchParams.get("id") || history.latest;
    const item = history.items.find((entry) => entry.id === selectedId);
    if (!item?.input_path) {
      jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
      return true;
    }

    const input = await readJsonBody(req, { maxBytes: jsonBodyLimitBytes });
    const workflowState = readWorkflowState(item);
    const materialized = materializeContextPackCycleFromWorkflowState(workflowState, {
      cycle_id: input.cycle_id || input.cycleId,
      created_at: input.created_at || input.createdAt
    });
    if (materialized.status !== "ready") {
      jsonResponse(res, 409, {
        error: "context pack cycle is not ready",
        issues: materialized.issues || [],
        item,
        projection: workbenchProjection(workflowState)
      });
      return true;
    }

    const snapshotId = normalizeString(input.snapshot_id || input.snapshotId) ||
      generatedContextPackSnapshotId(selectedId);
    const published = publishSnapshot({
      id: snapshotId,
      label: input.label || `Context pack cycle from ${selectedId}`,
      input: materialized.workflow_state,
      created_at: input.created_at || input.createdAt
    }, {
      root,
      historyPath: serverHistoryPath,
      snapshotsRoot
    });
    if (published.status === "fail") {
      jsonResponse(res, 400, { error: "context pack cycle snapshot publish failed", issues: published.issues });
      return true;
    }

    if (materialized.source_record?.status === "pass") {
      writeWorkflowState(item, { ...workflowState, ...materialized.source_record.workflow_state });
    }

    jsonResponse(res, 201, {
      status: "created",
      item,
      materialized: {
        status: materialized.status,
        phase: materialized.phase,
        work_package_count: materialized.work_packages.length,
        context_pack: materialized.context_pack
      },
      source_artifact: materialized.source_record?.artifact || null,
      next_item: published.item,
      projection: published.projection,
      current_projection: materialized.source_record?.status === "pass"
        ? workbenchProjection(materialized.source_record.workflow_state)
        : workbenchProjection(workflowState)
    });
    return true;
  }

  return false;
}
