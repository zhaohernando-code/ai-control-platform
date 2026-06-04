import { recordAgentLifecycleFact } from "./agent-lifecycle-pool.js";
import { asArray, normalizeString, safeIdPart } from "./context-work-package-runner-shared.js";

function retryAgentWorkerId(node = {}) {
  return normalizeString(
    node.source?.retry_worker?.worker_id ||
      node.source?.retryWorker?.worker_id ||
      node.source?.worker_id ||
      node.source?.workerId ||
      node.id
  );
}

function retryAgentPoolId(node = {}) {
  return normalizeString(
    node.source?.retry_worker?.pool_id ||
      node.source?.retryWorker?.pool_id ||
      node.source?.pool_id ||
      node.source?.poolId
  ) || "default";
}

function contextWorkerId(node = {}, index = 0) {
  return `child-${safeIdPart(node.id || node.work_package_id || index + 1)}`;
}

function contextWorkerPoolId(workflowState = {}, options = {}) {
  return normalizeString(options.pool_id || options.poolId) ||
    `context-work-package-${safeIdPart(workflowState?.manifest?.run_id)}-${safeIdPart(workflowState?.manifest?.cycle_id)}`;
}

function nonRetryAgentFactsForNode(workflowState = {}, node = {}, index = 0, createdAt, options = {}) {
  if (normalizeString(node.action) === "retry_agent_worker") return [];
  const workerId = contextWorkerId(node, index);
  const poolId = contextWorkerPoolId(workflowState, options);
  const baseSource = {
    action: normalizeString(node.action) || "run_context_work_package",
    work_package_id: node.id,
    owned_files: asArray(node.owned_files),
    executor_kind: normalizeString(options.executor_kind || options.executorKind) || "local_bounded",
    execution_mode: normalizeString(options.execution_mode || options.executionMode) || "local_bounded",
    execution_profile: normalizeString(options.execution_profile || options.executionProfile) ||
      normalizeString(options.executor_kind || options.executorKind) ||
      "local_bounded"
  };

  return [
    {
      event_type: "WorkerSpawned",
      pool_id: poolId,
      worker_id: workerId,
      status: "pass",
      message: `${workerId} spawned for context work package ${node.id}`,
      created_at: createdAt,
      source: baseSource
    },
    {
      event_type: "WorkerHeartbeat",
      pool_id: poolId,
      worker_id: workerId,
      status: "pass",
      message: `${workerId} heartbeat recorded before bounded execution`,
      created_at: createdAt,
      source: baseSource
    },
    {
      event_type: "WorkerCompleted",
      pool_id: poolId,
      worker_id: workerId,
      status: "pass",
      message: `${workerId} completed context work package ${node.id}`,
      created_at: createdAt,
      source: baseSource
    },
    {
      event_type: "WorkerEvaluation",
      pool_id: poolId,
      worker_id: workerId,
      status: "pass",
      message: `${workerId} evaluation recorded as pass`,
      created_at: createdAt,
      source: baseSource
    },
    {
      event_type: "WorkerClosed",
      pool_id: poolId,
      worker_id: workerId,
      status: "pass",
      message: `${workerId} closed after evaluation`,
      created_at: createdAt,
      source: baseSource
    },
    {
      event_type: "PoolIterationClosed",
      pool_id: poolId,
      status: "pass",
      message: `agent lifecycle pool ${poolId} iteration closed after ${workerId}`,
      created_at: createdAt,
      source: baseSource
    }
  ];
}

function retryAgentFactsForNode(node = {}, createdAt) {
  if (normalizeString(node.action) !== "retry_agent_worker") return [];
  const workerId = retryAgentWorkerId(node);
  const poolId = retryAgentPoolId(node);
  if (!workerId) return [];
  const retryWorkerId = `${workerId}-retry`;
  const baseSource = {
    action: "retry_agent_worker",
    work_package_id: node.id,
    original_worker_id: workerId,
    retry_worker: node.source?.retry_worker || null,
    timed_out_workers: asArray(node.source?.timed_out_workers)
  };

  return [
    {
      event_type: "WorkerSpawned",
      pool_id: poolId,
      worker_id: retryWorkerId,
      status: "pass",
      message: `${retryWorkerId} spawned as retry for timed-out worker ${workerId}`,
      created_at: createdAt,
      source: baseSource
    },
    {
      event_type: "WorkerHeartbeat",
      pool_id: poolId,
      worker_id: retryWorkerId,
      status: "pass",
      message: `${retryWorkerId} retry heartbeat recorded by scheduler`,
      created_at: createdAt,
      source: baseSource
    },
    {
      event_type: "WorkerCompleted",
      pool_id: poolId,
      worker_id: retryWorkerId,
      status: "pass",
      message: `${retryWorkerId} retry completed after bounded execution`,
      created_at: createdAt,
      source: baseSource
    },
    {
      event_type: "WorkerEvaluation",
      pool_id: poolId,
      worker_id: retryWorkerId,
      status: "pass",
      message: `${retryWorkerId} retry evaluation recorded as pass`,
      created_at: createdAt,
      source: baseSource
    },
    {
      event_type: "WorkerClosed",
      pool_id: poolId,
      worker_id: retryWorkerId,
      status: "pass",
      message: `${retryWorkerId} retry closed after evaluation`,
      created_at: createdAt,
      source: baseSource
    },
    {
      event_type: "PoolIterationClosed",
      pool_id: poolId,
      status: "pass",
      message: `agent lifecycle pool ${poolId} iteration closed after ${retryWorkerId} retry`,
      created_at: createdAt,
      source: baseSource
    }
  ];
}

export function recordExecutedWorkPackageLifecycleFacts(workflowState = {}, selected = [], createdAt, options = {}) {
  let nextState = workflowState;
  const facts = [];
  const retryAgentWorkerFacts = [];

  for (const [index, node] of selected.entries()) {
    const factInputs = normalizeString(node.action) === "retry_agent_worker"
      ? retryAgentFactsForNode(node, createdAt)
      : nonRetryAgentFactsForNode(workflowState, node, index, createdAt, options);
    for (const factInput of factInputs) {
      const result = recordAgentLifecycleFact(nextState, factInput);
      if (result.status !== "pass") {
        return {
          status: "fail",
          issues: result.issues || [],
          facts,
          retry_agent_worker_facts: retryAgentWorkerFacts,
          workflow_state: nextState
        };
      }
      nextState = result.workflow_state;
      facts.push(result.fact);
      if (normalizeString(node.action) === "retry_agent_worker") retryAgentWorkerFacts.push(result.fact);
    }
  }
  return {
    status: "pass",
    facts,
    retry_agent_worker_facts: retryAgentWorkerFacts,
    workflow_state: nextState
  };
}

