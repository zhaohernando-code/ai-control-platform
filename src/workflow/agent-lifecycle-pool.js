import { recordArtifact } from "./artifact-ledger.js";
import { appendRunEvent } from "./run-manifest.js";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeToken(value) {
  return normalizeString(value).toLowerCase();
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function safeIdPart(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function issue(code, message, path) {
  return { code, message, path };
}

function workflowStateIdentityIssues(workflowState = {}) {
  const manifestRunId = normalizeString(workflowState?.manifest?.run_id);
  const manifestCycleId = normalizeString(workflowState?.manifest?.cycle_id);
  const ledger = workflowState?.artifact_ledger || workflowState?.artifactLedger || {};
  const ledgerRunId = normalizeString(ledger.run_id);
  const ledgerCycleId = normalizeString(ledger.cycle_id);
  const issues = [];

  if (!manifestRunId || !manifestCycleId) {
    issues.push(issue("missing_manifest_identity", "manifest run_id and cycle_id are required", "manifest"));
  }
  if (!ledgerRunId || !ledgerCycleId) {
    issues.push(issue("missing_artifact_ledger_identity", "artifact ledger run_id and cycle_id are required", "artifact_ledger"));
  }
  if (manifestRunId && ledgerRunId && manifestRunId !== ledgerRunId) {
    issues.push(issue("workflow_state_run_mismatch", "manifest run_id does not match artifact ledger run_id", "artifact_ledger.run_id"));
  }
  if (manifestCycleId && ledgerCycleId && manifestCycleId !== ledgerCycleId) {
    issues.push(issue("workflow_state_cycle_mismatch", "manifest cycle_id does not match artifact ledger cycle_id", "artifact_ledger.cycle_id"));
  }

  return issues;
}

const FACT_TYPES = new Map([
  ["workerspawned", "WorkerSpawned"],
  ["worker_spawned", "WorkerSpawned"],
  ["workercompleted", "WorkerCompleted"],
  ["worker_completed", "WorkerCompleted"],
  ["workerheartbeat", "WorkerHeartbeat"],
  ["worker_heartbeat", "WorkerHeartbeat"],
  ["workertimeout", "WorkerTimeout"],
  ["worker_timeout", "WorkerTimeout"],
  ["workerevaluation", "WorkerEvaluation"],
  ["worker_evaluation", "WorkerEvaluation"],
  ["workerclosed", "WorkerClosed"],
  ["worker_closed", "WorkerClosed"],
  ["pooliterationclosed", "PoolIterationClosed"],
  ["pool_iteration_closed", "PoolIterationClosed"]
]);

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
        "worker_heartbeat",
        "workerheartbeat",
        "worker_timeout",
        "workertimeout",
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

function latestPoolRecords(manifest = {}, artifactLedger = {}) {
  const records = lifecycleRecords(manifest, artifactLedger);
  const poolId = latestPoolId(records);
  return {
    records,
    pool_id: records.length === 0 ? null : poolId,
    pool_records: records.filter((record) => (record.pool_id || "default") === poolId)
  };
}

function addWorker(workers, workerId) {
  if (!workerId) return null;
  if (!workers.has(workerId)) {
    workers.set(workerId, {
      worker_id: workerId,
      spawned: false,
      completed: false,
      timed_out: false,
      heartbeat_count: 0,
      latest_heartbeat_at: null,
      latest_timeout_at: null,
      latest_issue: null,
      spawned_at: null,
      evaluated: false,
      closed: false
    });
  }
  return workers.get(workerId);
}

function latestWorkers(manifest = {}, artifactLedger = {}) {
  const { pool_id: poolId, pool_records: poolRecords } = latestPoolRecords(manifest, artifactLedger);
  const workers = new Map();
  for (const record of poolRecords) {
    const worker = addWorker(workers, record.worker_id);
    if (!worker) continue;
    const recordCreatedAt = record.event?.created_at || record.artifact?.created_at || record.metadata?.created_at || null;
    if (record.kind === "worker_spawned" || record.kind === "workerspawned") {
      worker.spawned = true;
      worker.spawned_at = recordCreatedAt || worker.spawned_at;
    }
    if (record.kind === "worker_completed" || record.kind === "workercompleted") worker.completed = true;
    if (record.kind === "worker_heartbeat" || record.kind === "workerheartbeat") {
      worker.heartbeat_count += 1;
      worker.latest_heartbeat_at = recordCreatedAt || worker.latest_heartbeat_at;
    }
    if (record.kind === "worker_timeout" || record.kind === "workertimeout") {
      worker.timed_out = true;
      worker.latest_timeout_at = recordCreatedAt || worker.latest_timeout_at;
      worker.latest_issue = lifecycleIssue(record.event, record.metadata) || worker.latest_issue;
    }
    if (record.kind === "worker_evaluation" || record.kind === "workerevaluation") worker.evaluated = true;
    if (record.kind === "worker_closed" || record.kind === "workerclosed") worker.closed = true;
  }
  return { pool_id: poolId, workers: Array.from(workers.values()) };
}

function canonicalFactType(value) {
  return FACT_TYPES.get(normalizeToken(value).replace(/[^a-z0-9]+/g, "_")) || null;
}

function statusOf(input = {}) {
  const status = normalizeToken(input.status || input.result || input.outcome);
  if (["pass", "passed", "ok", "success", "succeeded", "completed", "complete"].includes(status)) return "pass";
  if (["fail", "failed", "error", "errored", "blocked", "timeout", "timed_out"].includes(status)) return "fail";
  return status || "pass";
}

function nextFactId(workflowState = {}, fact = {}) {
  const prefix = fact.id || `agent-lifecycle-${safeIdPart(fact.event_type)}-${safeIdPart(fact.pool_id || "default")}-${safeIdPart(fact.worker_id || "pool")}`;
  const artifacts = workflowState?.artifact_ledger?.artifacts || workflowState?.artifactLedger?.artifacts || [];
  const events = workflowState?.manifest?.events || [];
  const usedIds = new Set([
    ...artifacts.map((item) => item?.id).filter(Boolean),
    ...events.map((item) => normalizeString(item?.artifact_id)).filter(Boolean)
  ]);
  if (fact.id && !usedIds.has(fact.id)) return fact.id;

  let index = 1;
  let id = `${prefix}-${String(index).padStart(3, "0")}`;
  while (usedIds.has(id)) {
    index += 1;
    id = `${prefix}-${String(index).padStart(3, "0")}`;
  }
  return id;
}

export function createAgentLifecycleFact(input = {}) {
  const eventType = canonicalFactType(input.event_type || input.eventType || input.type || input.kind);
  const issues = [];
  if (!eventType) {
    issues.push(issue("unsupported_agent_lifecycle_fact_type", "event_type must be WorkerSpawned, WorkerCompleted, WorkerHeartbeat, WorkerTimeout, WorkerEvaluation, WorkerClosed, or PoolIterationClosed", "event_type"));
  }

  const poolId = normalizeString(input.pool_id || input.poolId || input.iteration_id || input.iterationId) || "default";
  const workerId = normalizeString(input.worker_id || input.workerId || input.child_id || input.childId || input.agent_id || input.agentId);
  if (eventType && eventType !== "PoolIterationClosed" && !workerId) {
    issues.push(issue("missing_agent_lifecycle_worker_id", "worker_id is required for worker lifecycle facts", "worker_id"));
  }

  const createdAt = normalizeString(input.created_at || input.createdAt) || new Date().toISOString();
  const message = normalizeString(input.message) || (
    eventType === "PoolIterationClosed"
      ? `agent lifecycle pool ${poolId} iteration closed`
      : `${workerId} ${eventType || "agent lifecycle fact"}`
  );
  const issueInput = input.issue || input.blocker || null;
  const issuesList = [
    ...asArray(input.issues),
    ...(issueInput ? [typeof issueInput === "object" ? issueInput : issue("agent_lifecycle_blocker", normalizeString(issueInput), "message")] : [])
  ];

  return {
    id: normalizeString(input.id),
    type: "agent_lifecycle_pool",
    event_type: eventType || normalizeString(input.event_type || input.eventType || input.type),
    status: statusOf(input),
    pool_id: poolId,
    worker_id: workerId || null,
    message,
    created_at: createdAt,
    issues: issuesList,
    cleanup: input.cleanup && typeof input.cleanup === "object" && !Array.isArray(input.cleanup) ? input.cleanup : undefined,
    source: input.source && typeof input.source === "object" && !Array.isArray(input.source) ? input.source : undefined,
    validation_issues: issues
  };
}

export function recordAgentLifecycleFact(workflowState = {}, input = {}) {
  if (!isObject(workflowState)) {
    return {
      status: "fail",
      issues: [issue("invalid_workflow_state", "workflow state must be an object", "workflow_state")]
    };
  }

  const identityIssues = workflowStateIdentityIssues(workflowState);
  if (identityIssues.length > 0) return { status: "fail", issues: identityIssues };

  const baseFact = createAgentLifecycleFact(input);
  if (baseFact.validation_issues.length > 0) {
    return { status: "fail", issues: baseFact.validation_issues };
  }

  const id = nextFactId(workflowState, baseFact);
  const fact = { ...baseFact, id };
  delete fact.validation_issues;
  const artifact = {
    id,
    type: fact.event_type === "WorkerEvaluation" ? "evaluation" : "review",
    status: fact.status,
    uri: `codex://agent-lifecycle-pool/${encodeURIComponent(fact.pool_id)}/${encodeURIComponent(id)}`,
    producer: "agent-lifecycle-pool",
    created_at: fact.created_at,
    metadata: {
      ...fact,
      lifecycle_event: fact.event_type,
      pool_id: fact.pool_id,
      worker_id: fact.worker_id || undefined
    }
  };
  const manifest = appendRunEvent(workflowState.manifest, {
    id: `event-${id}`,
    type: fact.event_type,
    status: fact.status,
    artifact_id: id,
    message: fact.message,
    created_at: fact.created_at,
    metadata: artifact.metadata
  });
  const baseLedger = workflowState.artifact_ledger || workflowState.artifactLedger || {};
  const artifactLedger = recordArtifact({
    ...baseLedger,
    artifacts: Array.isArray(baseLedger.artifacts) ? baseLedger.artifacts : []
  }, artifact);

  return {
    status: "pass",
    fact,
    workflow_state: {
      ...workflowState,
      manifest: {
        ...manifest,
        artifacts: [...asArray(manifest.artifacts), artifact]
      },
      artifact_ledger: artifactLedger
    }
  };
}

export function cleanupAgentLifecyclePool(workflowState = {}, input = {}) {
  if (!isObject(workflowState)) {
    return {
      status: "fail",
      issues: [issue("invalid_workflow_state", "workflow state must be an object", "workflow_state")]
    };
  }

  const before = summarizeAgentLifecyclePool(workflowState.manifest, workflowState.artifact_ledger || workflowState.artifactLedger);
  if (!before.pool_id) {
    return {
      status: "pass",
      facts: [],
      before,
      after: before,
      workflow_state: workflowState
    };
  }

  const createdAt = normalizeString(input.created_at || input.createdAt || input.now) || new Date().toISOString();
  const timeoutThresholdMs = Number(input.timeout_threshold_ms ?? input.timeoutThresholdMs ?? input.worker_timeout_ms ?? input.workerTimeoutMs ?? NaN);
  const hasTimeoutThreshold = Number.isFinite(timeoutThresholdMs) && timeoutThresholdMs >= 0;
  const nowMs = Date.parse(normalizeString(input.now || input.created_at || input.createdAt) || createdAt);
  const failureMessage = normalizeString(input.failure || input.blocked || input.message);
  let nextState = workflowState;
  const facts = [];

  if (failureMessage) {
    const { workers } = latestWorkers(nextState.manifest, nextState.artifact_ledger || nextState.artifactLedger);
    const worker = workers.find((entry) => entry.completed && !entry.evaluated) ||
      workers.find((entry) => entry.spawned && !entry.closed) ||
      workers.at(-1) || {};
    const workerId = worker.worker_id || "pool";
    const cleanupFacts = [
      {
        event_type: "WorkerCompleted",
        pool_id: before.pool_id,
        worker_id: workerId,
        status: "pass",
        message: `${workerId} marked terminal during agent lifecycle cleanup`,
        created_at: createdAt,
        cleanup: { automatic: true, blocked: true, reason: "failure_cleanup", failure_message: failureMessage }
      },
      {
        event_type: "WorkerEvaluation",
        pool_id: before.pool_id,
        worker_id: workerId,
        status: "fail",
        message: failureMessage,
        issues: [issue("agent_lifecycle_cleanup_blocked", failureMessage, "cleanup")],
        created_at: createdAt,
        cleanup: { automatic: true, blocked: true, reason: "failure_cleanup", failure_message: failureMessage }
      },
      {
        event_type: "WorkerClosed",
        pool_id: before.pool_id,
        worker_id: workerId,
        status: "pass",
        message: `${workerId} closed during agent lifecycle cleanup`,
        created_at: createdAt,
        cleanup: { automatic: true, blocked: true, reason: "failure_cleanup", failure_message: failureMessage }
      },
      {
        event_type: "PoolIterationClosed",
        pool_id: before.pool_id,
        status: "pass",
        message: `agent lifecycle pool ${before.pool_id} iteration closed during cleanup`,
        created_at: createdAt,
        cleanup: { automatic: true, blocked: true, reason: "failure_cleanup", failure_message: failureMessage }
      }
    ];
    for (const factInput of cleanupFacts) {
      const result = recordAgentLifecycleFact(nextState, factInput);
      if (result.status !== "pass") return result;
      nextState = result.workflow_state;
      facts.push(result.fact);
    }
    return {
      status: "blocked",
      facts,
      before,
      after: summarizeAgentLifecyclePool(nextState.manifest, nextState.artifact_ledger),
      workflow_state: nextState
    };
  }

  const { workers } = latestWorkers(nextState.manifest, nextState.artifact_ledger || nextState.artifactLedger);
  for (const worker of workers.filter((entry) => entry.spawned && !entry.completed && !entry.timed_out)) {
    const latestSignalAt = worker.latest_heartbeat_at || worker.spawned_at;
    const latestSignalMs = Date.parse(latestSignalAt || "");
    const isSilentTimeout = hasTimeoutThreshold && Number.isFinite(nowMs) && Number.isFinite(latestSignalMs) && nowMs - latestSignalMs > timeoutThresholdMs;
    if (isSilentTimeout) {
      const timeoutMessage = `${worker.worker_id} timed out without heartbeat or completion`;
      const result = recordAgentLifecycleFact(nextState, {
        event_type: "WorkerTimeout",
        pool_id: before.pool_id,
        worker_id: worker.worker_id,
        status: "fail",
        message: timeoutMessage,
        issues: [issue("agent_lifecycle_worker_timeout", timeoutMessage, "cleanup.timeout_threshold_ms")],
        created_at: createdAt,
        cleanup: {
          automatic: true,
          reason: "worker_timeout",
          timeout_threshold_ms: timeoutThresholdMs,
          latest_signal_at: latestSignalAt || null
        }
      });
      if (result.status !== "pass") return result;
      nextState = result.workflow_state;
      facts.push(result.fact);
      continue;
    }
    if (hasTimeoutThreshold) continue;
    const result = recordAgentLifecycleFact(nextState, {
      event_type: "WorkerCompleted",
      pool_id: before.pool_id,
      worker_id: worker.worker_id,
      status: "pass",
      message: `${worker.worker_id} marked terminal during agent lifecycle cleanup`,
      created_at: createdAt,
      cleanup: { automatic: true, reason: "missing_completion" }
    });
    if (result.status !== "pass") return result;
    nextState = result.workflow_state;
    facts.push(result.fact);
  }

  const afterCompletion = latestWorkers(nextState.manifest, nextState.artifact_ledger || nextState.artifactLedger);
  for (const worker of afterCompletion.workers.filter((entry) => (entry.completed || entry.timed_out) && !entry.evaluated)) {
    const result = recordAgentLifecycleFact(nextState, {
      event_type: "WorkerEvaluation",
      pool_id: before.pool_id,
      worker_id: worker.worker_id,
      status: worker.timed_out ? "fail" : "pass",
      message: worker.timed_out
        ? `${worker.worker_id} timeout evaluated during agent lifecycle cleanup`
        : `${worker.worker_id} evaluated during agent lifecycle cleanup`,
      created_at: createdAt,
      issues: worker.timed_out ? [issue("agent_lifecycle_worker_timeout", worker.latest_issue || "worker timed out", "worker_timeout")] : [],
      cleanup: { automatic: true, reason: worker.timed_out ? "timeout_evaluation" : "missing_evaluation" }
    });
    if (result.status !== "pass") return result;
    nextState = result.workflow_state;
    facts.push(result.fact);
  }

  const afterEvaluation = latestWorkers(nextState.manifest, nextState.artifact_ledger || nextState.artifactLedger);
  for (const worker of afterEvaluation.workers.filter((entry) => entry.spawned && !entry.closed)) {
    const result = recordAgentLifecycleFact(nextState, {
      event_type: "WorkerClosed",
      pool_id: before.pool_id,
      worker_id: worker.worker_id,
      status: "pass",
      message: `${worker.worker_id} closed during agent lifecycle cleanup`,
      created_at: createdAt,
      cleanup: { automatic: true, reason: "missing_close" }
    });
    if (result.status !== "pass") return result;
    nextState = result.workflow_state;
    facts.push(result.fact);
  }

  const afterWorkerCleanup = summarizeAgentLifecyclePool(nextState.manifest, nextState.artifact_ledger || nextState.artifactLedger);
  if (afterWorkerCleanup.timed_out === 0 && afterWorkerCleanup.open === 0 && afterWorkerCleanup.unevaluated === 0 && afterWorkerCleanup.unclosed === 0 && !afterWorkerCleanup.iteration_closed) {
    const result = recordAgentLifecycleFact(nextState, {
      event_type: "PoolIterationClosed",
      pool_id: before.pool_id,
      status: "pass",
      message: `agent lifecycle pool ${before.pool_id} iteration closed during cleanup`,
      created_at: createdAt,
      cleanup: { automatic: true, reason: "missing_iteration_close" }
    });
    if (result.status !== "pass") return result;
    nextState = result.workflow_state;
    facts.push(result.fact);
  }

  const after = summarizeAgentLifecyclePool(nextState.manifest, nextState.artifact_ledger || nextState.artifactLedger);
  return {
    status: after.status === "pass" ? "pass" : "cleanup_required",
    facts,
    before,
    after,
    workflow_state: nextState
  };
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
      timed_out: 0,
      heartbeat_count: 0,
      latest_heartbeat_at: null,
      latest_timeout_at: null,
      timed_out_workers: [],
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
  let latestHeartbeatAt = null;
  let latestTimeoutAt = null;
  let heartbeatCount = 0;
  let blocked = false;

  for (const record of poolRecords) {
    const worker = addWorker(workers, record.worker_id);
    const recordCreatedAt = record.event?.created_at || record.artifact?.created_at || record.metadata?.created_at || null;
    if (record.kind === "worker_spawned" || record.kind === "workerspawned") {
      worker.spawned = true;
      worker.spawned_at = recordCreatedAt || worker.spawned_at;
    }
    if (record.kind === "worker_completed" || record.kind === "workercompleted") worker.completed = true;
    if (record.kind === "worker_heartbeat" || record.kind === "workerheartbeat") {
      worker.heartbeat_count += 1;
      heartbeatCount += 1;
      worker.latest_heartbeat_at = recordCreatedAt || worker.latest_heartbeat_at;
      latestHeartbeatAt = recordCreatedAt || latestHeartbeatAt;
    }
    if (record.kind === "worker_timeout" || record.kind === "workertimeout") {
      worker.timed_out = true;
      worker.latest_timeout_at = recordCreatedAt || worker.latest_timeout_at;
      latestTimeoutAt = recordCreatedAt || latestTimeoutAt;
      worker.latest_issue = lifecycleIssue(record.event, record.metadata) || worker.latest_issue;
    }
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
  const timedOut = workerList.filter((worker) => worker.timed_out).length;
  const evaluated = workerList.filter((worker) => worker.evaluated).length;
  const closed = workerList.filter((worker) => worker.closed).length;
  const open = workerList.filter((worker) => worker.spawned && !worker.completed && !worker.timed_out).length;
  const unevaluated = workerList.filter((worker) => (worker.completed || worker.timed_out) && !worker.evaluated).length;
  const unclosed = workerList.filter((worker) => worker.spawned && !worker.closed).length;
  const latest = poolRecords.at(-1);
  const timedOutWorkers = workerList
    .filter((worker) => worker.timed_out)
    .map((worker) => ({
      worker_id: worker.worker_id,
      latest_timeout_at: worker.latest_timeout_at,
      latest_issue: worker.latest_issue
    }));
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
    timed_out: timedOut,
    heartbeat_count: heartbeatCount,
    latest_heartbeat_at: latestHeartbeatAt,
    latest_timeout_at: latestTimeoutAt,
    timed_out_workers: timedOutWorkers,
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
