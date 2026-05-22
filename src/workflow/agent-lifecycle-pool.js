function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeToken(value) {
  return normalizeString(value).toLowerCase();
}

function eventKind(event = {}) {
  return normalizeToken(event.type || event.event_type || event.kind).replace(/[^a-z0-9]+/g, "_");
}

function lifecycleKind(event = {}, metadata = {}) {
  const kind = eventKind(event);
  const explicit = normalizeToken(metadata.lifecycle_event || metadata.lifecycleEvent || metadata.kind).replace(/[^a-z0-9]+/g, "_");
  return explicit || kind;
}

function lifecyclePoolId(event = {}, metadata = {}) {
  return normalizeString(
    metadata.pool_id ||
      metadata.poolId ||
      metadata.iteration_id ||
      metadata.iterationId ||
      event.pool_id ||
      event.poolId ||
      event.iteration_id ||
      event.iterationId
  );
}

function lifecycleWorkerId(event = {}, metadata = {}) {
  return normalizeString(
    metadata.worker_id ||
      metadata.workerId ||
      metadata.child_id ||
      metadata.childId ||
      metadata.agent_id ||
      metadata.agentId ||
      event.worker_id ||
      event.workerId ||
      event.child_id ||
      event.childId ||
      event.agent_id ||
      event.agentId
  );
}

function lifecycleIssue(event = {}, metadata = {}) {
  const issue = asArray(metadata.issues || event.issues).at(-1) || metadata.issue || event.issue || null;
  if (issue && typeof issue === "object") {
    return normalizeString(issue.message || issue.code || issue.id);
  }
  return normalizeString(issue);
}

function artifactsFrom(manifest = {}, artifactLedger = {}) {
  return [
    ...asArray(artifactLedger?.artifacts),
    ...asArray(manifest?.artifacts)
  ];
}

function lifecycleRecords(manifest = {}, artifactLedger = {}) {
  const artifacts = artifactsFrom(manifest, artifactLedger);
  return asArray(manifest?.events)
    .map((event, index) => {
      const artifact = artifacts.find((entry) => entry.id === event?.artifact_id) || null;
      const metadata = artifact?.metadata || event?.metadata || {};
      const kind = lifecycleKind(event, metadata);
      if (![
        "worker_spawned",
        "workerspawned",
        "worker_completed",
        "workercompleted",
        "worker_evaluation",
        "workerevaluation",
        "worker_closed",
        "workerclosed",
        "pool_iteration_closed",
        "pooliterationclosed",
        "agent_lifecycle_pool"
      ].includes(kind)) {
        return null;
      }
      return {
        index,
        event,
        artifact,
        metadata,
        kind,
        pool_id: lifecyclePoolId(event, metadata),
        worker_id: lifecycleWorkerId(event, metadata)
      };
    })
    .filter(Boolean);
}

function latestPoolId(records) {
  const explicitPoolRecord = records.filter((record) => record.pool_id).at(-1);
  return explicitPoolRecord?.pool_id || "default";
}

function addWorker(workers, workerId) {
  if (!workerId) return null;
  if (!workers.has(workerId)) {
    workers.set(workerId, {
      worker_id: workerId,
      spawned: false,
      completed: false,
      evaluated: false,
      closed: false
    });
  }
  return workers.get(workerId);
}

export function summarizeAgentLifecyclePool(manifest = {}, artifactLedger = {}) {
  const records = lifecycleRecords(manifest, artifactLedger);
  if (records.length === 0) {
    return {
      status: "not_configured",
      pool_id: null,
      spawned: 0,
      completed: 0,
      evaluated: 0,
      closed: 0,
      open: 0,
      unevaluated: 0,
      unclosed: 0,
      iteration_closed: false,
      next_action: null,
      latest_issue: null,
      event_id: null,
      artifact_id: null,
      created_at: null
    };
  }

  const poolId = latestPoolId(records);
  const poolRecords = records.filter((record) => (record.pool_id || "default") === poolId);
  const workers = new Map();
  let iterationClosed = false;
  let latestIssue = null;
  let blocked = false;

  for (const record of poolRecords) {
    const worker = addWorker(workers, record.worker_id);
    if (record.kind === "worker_spawned" || record.kind === "workerspawned") worker.spawned = true;
    if (record.kind === "worker_completed" || record.kind === "workercompleted") worker.completed = true;
    if (record.kind === "worker_evaluation" || record.kind === "workerevaluation") worker.evaluated = true;
    if (record.kind === "worker_closed" || record.kind === "workerclosed") worker.closed = true;
    if (record.kind === "pool_iteration_closed" || record.kind === "pooliterationclosed") iterationClosed = true;

    const status = normalizeToken(record.event?.status || record.metadata?.status || record.artifact?.status);
    if (status === "blocked" || status === "fail" || status === "failed") blocked = true;
    latestIssue = lifecycleIssue(record.event, record.metadata) || latestIssue;
  }

  const workerList = Array.from(workers.values());
  const spawned = workerList.filter((worker) => worker.spawned).length;
  const completed = workerList.filter((worker) => worker.completed).length;
  const evaluated = workerList.filter((worker) => worker.evaluated).length;
  const closed = workerList.filter((worker) => worker.closed).length;
  const open = workerList.filter((worker) => worker.spawned && !worker.completed).length;
  const unevaluated = workerList.filter((worker) => worker.completed && !worker.evaluated).length;
  const unclosed = workerList.filter((worker) => worker.spawned && !worker.closed).length;
  const latest = poolRecords.at(-1);
  const status = blocked
    ? "blocked"
    : open > 0
      ? "open"
      : unevaluated > 0
        ? "unevaluated"
        : unclosed > 0
          ? "unclosed"
          : iterationClosed
            ? "pass"
            : "cleanup_required";

  return {
    status,
    pool_id: poolId,
    spawned,
    completed,
    evaluated,
    closed,
    open,
    unevaluated,
    unclosed,
    iteration_closed: iterationClosed,
    next_action: status === "pass" ? null : "cleanup_agent_lifecycle_pool",
    latest_issue: latestIssue,
    event_id: latest?.event?.id || null,
    artifact_id: latest?.event?.artifact_id || latest?.artifact?.id || null,
    created_at: latest?.event?.created_at || latest?.artifact?.created_at || null
  };
}
