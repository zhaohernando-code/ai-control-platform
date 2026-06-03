export async function handleWorkbenchBasicRoutes(context) {
  const {
    url,
    req,
    res,
    root,
    serverHistoryPath,
    snapshotsRoot,
    eventsPath,
    stateStore,
    jsonBodyLimitBytes,
    jsonResponse,
    readJsonBody,
    readServerHistory,
    readWorkflowState,
    publishSnapshot,
    snapshotIssues,
    readEvents,
    appendEvent,
    operatorEventIssues,
    normalizeEvent
  } = context;

  if (url.pathname === "/api/workbench/snapshot" && req.method === "GET") {
    const history = readServerHistory();
    const selectedId = url.searchParams.get("id") || history.latest;
    const item = history.items.find((entry) => entry.id === selectedId);
    if (!item?.input_path) {
      jsonResponse(res, 404, { error: `snapshot input not found: ${selectedId}` });
      return true;
    }
    jsonResponse(res, 200, readWorkflowState(item));
    return true;
  }

  if (url.pathname === "/api/workbench/snapshots" && req.method === "POST") {
    const input = await readJsonBody(req, { maxBytes: jsonBodyLimitBytes });
    const issues = snapshotIssues(input);
    if (issues.length > 0) {
      jsonResponse(res, 400, { error: "invalid workflow state snapshot", issues });
      return true;
    }
    const result = publishSnapshot(input, {
      root,
      historyPath: serverHistoryPath,
      snapshotsRoot
    });
    if (result.status === "fail") {
      jsonResponse(res, 400, { error: "workflow state snapshot publish failed", issues: result.issues });
      return true;
    }
    jsonResponse(res, 201, { status: result.status, item: result.item, projection: result.projection });
    return true;
  }

  if (url.pathname === "/api/workbench/events" && req.method === "GET") {
    jsonResponse(res, 200, readEvents(eventsPath, stateStore));
    return true;
  }

  if (url.pathname === "/api/workbench/events" && req.method === "POST") {
    const input = await readJsonBody(req, { maxBytes: jsonBodyLimitBytes });
    const issues = operatorEventIssues(input);
    if (issues.length > 0) {
      jsonResponse(res, 400, { error: "invalid operator event", issues });
      return true;
    }
    const event = normalizeEvent(input, url.searchParams.get("projection_id"));
    const ledger = appendEvent(eventsPath, event, stateStore);
    jsonResponse(res, 201, { status: "created", event, count: ledger.events.length });
    return true;
  }

  return false;
}
