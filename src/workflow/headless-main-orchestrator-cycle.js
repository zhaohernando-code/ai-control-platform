import { decideContinuation } from "./autonomous-continuation.js";
import { cleanupAgentLifecyclePool, recordAgentLifecycleFact } from "./agent-lifecycle-pool.js";
import { materializeContextPackCycleFromWorkflowState } from "./context-pack-cycle.js";
import {
  prepareContinuationFromProjectStatus,
  recordProjectStatusContinuationPrepared
} from "./project-status-continuation.js";
import { runContextWorkPackages } from "./context-work-package-runner.js";
import { createWorkbenchProjection } from "./workbench-projection.js";
import {
  CHILD_WORKER_ROLE,
  HEADLESS_MAIN_ORCHESTRATOR_ROLE,
  createHeadlessWorkerSpawnFacts,
  selectHeadlessWorkPackages
} from "./headless-worker-planning.js";
import {
  recordHeadlessProcessHardening,
  rejectedPackageResults
} from "./headless-process-hardening.js";
import { publishHeadlessWorkflowSnapshot } from "./headless-snapshot-publisher.js";
import { createHeadlessProviderExecutor } from "./headless-provider-executor.js";
import {
  HEADLESS_CLI_ORCHESTRATOR_VERSION,
  asArray,
  continuationRunEvaluationFromProjectStatus,
  hasMaterializedContextCycle,
  issue,
  normalizeString,
  validateHeadlessInput
} from "./headless-orchestrator-utils.js";

function recordLifecycleFacts(workflowState = {}, facts = []) {
  let nextState = workflowState;
  const recorded = [];

  for (const factInput of facts) {
    const result = recordAgentLifecycleFact(nextState, factInput);
    if (result.status !== "pass") {
      return {
        status: "fail",
        issues: result.issues || [],
        facts: recorded,
        workflow_state: nextState
      };
    }
    nextState = result.workflow_state;
    recorded.push(result.fact);
  }

  return {
    status: "pass",
    issues: [],
    facts: recorded,
    workflow_state: nextState
  };
}

function continuationInput(projectStatus = {}, workflowState = {}, projection = {}) {
  return {
    project_status: projectStatus,
    run_evaluation: {
      status: projection.status,
      decision: projection.decision,
      blockers: projection.blockers,
      projection
    },
    workflow_state: workflowState
  };
}

export function runHeadlessCliMainOrchestrator(input = {}, options = {}) {
  const validation = validateHeadlessInput(input);
  if (validation.status !== "pass") {
    return {
      status: "blocked",
      phase: "input_validation",
      role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
      issues: validation.issues,
      workflow_state: input?.workflow_state || input?.workflowState || null
    };
  }

  const projectStatus = input.project_status || input.projectStatus;
  const createdAt = normalizeString(options.created_at || options.createdAt) || new Date().toISOString();
  let workflowState = input.workflow_state || input.workflowState;
  const steps = [];

  const prepared = prepareContinuationFromProjectStatus(projectStatus, {
    workflow_state: workflowState,
    run_evaluation: continuationRunEvaluationFromProjectStatus(projectStatus)
  });
  const recordedPreparation = recordProjectStatusContinuationPrepared(workflowState, prepared, { created_at: createdAt });
  if (recordedPreparation.status !== "pass") {
    return {
      status: "blocked",
      phase: "project_status_continuation_record",
      role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
      issues: recordedPreparation.issues || [],
      workflow_state: recordedPreparation.workflow_state || workflowState
    };
  }
  workflowState = recordedPreparation.workflow_state;
  steps.push({ phase: "project_status_continuation", status: prepared.status });

  if (!prepared.should_continue) {
    const projection = createWorkbenchProjection({
      ...workflowState,
      project_status: projectStatus,
      global_goals: projectStatus.global_goals
    });
    return {
      status: prepared.status === "complete" ? "complete" : "blocked",
      phase: "project_status_continuation",
      role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
      steps,
      projection,
      continuation: prepared.decision,
      workflow_state: workflowState,
      issues: prepared.issues || []
    };
  }

  if (hasMaterializedContextCycle(workflowState) && selectHeadlessWorkPackages(workflowState, options).length > 0) {
    steps.push({
      phase: "context_pack_cycle",
      status: "existing",
      work_package_count: asArray(workflowState?.manifest?.work_packages).length
    });
  } else {
    const materialized = materializeContextPackCycleFromWorkflowState(workflowState, {
      cycle_id: normalizeString(options.cycle_id || options.cycleId),
      created_at: createdAt
    });
    if (materialized.status !== "ready") {
      return {
        status: "blocked",
        phase: "context_pack_cycle",
        role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
        steps,
        issues: materialized.issues || [],
        workflow_state: materialized.workflow_state || workflowState
      };
    }
    workflowState = materialized.workflow_state;
    steps.push({
      phase: "context_pack_cycle",
      status: "ready",
      work_package_count: asArray(materialized.work_packages).length
    });
  }

  const selected = selectHeadlessWorkPackages(workflowState, options);
  if (selected.length === 0) {
    return {
      status: "blocked",
      phase: "no_dispatchable_work_packages",
      role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
      steps,
      issues: [issue("no_dispatchable_work_packages", "headless orchestrator found no dispatchable child work packages", "workflow_state.manifest.work_packages")],
      workflow_state: workflowState
    };
  }

  const spawned = recordLifecycleFacts(workflowState, createHeadlessWorkerSpawnFacts(workflowState, selected, { ...options, created_at: createdAt }));
  if (spawned.status !== "pass") {
    return {
      status: "blocked",
      phase: "child_worker_lifecycle_spawn",
      role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
      steps,
      issues: spawned.issues,
      workflow_state: spawned.workflow_state
    };
  }
  workflowState = spawned.workflow_state;
  steps.push({
    phase: "child_worker_spawn",
    status: "pass",
    fact_count: spawned.facts.length
  });

  const runResult = runContextWorkPackages(workflowState, {
    ...options,
    created_at: createdAt,
    max_package_count: selected.length,
    execution_mode: "provider_model_routed",
    execution_profile: "verified_provider_multi_agent",
    provider_executor: createHeadlessProviderExecutor({
      ...options,
      created_at: createdAt,
      workflow_state: workflowState,
      acceptance_gates: workflowState.manifest.context_pack.acceptance_gates
    })
  });

  if (runResult.status !== "pass") {
    const hardening = recordHeadlessProcessHardening(workflowState, rejectedPackageResults(runResult), {
      ...options,
      created_at: createdAt
    });
    const closed = cleanupAgentLifecyclePool(hardening.workflow_state || workflowState, {
      created_at: createdAt,
      failure: "headless main orchestrator rejected child worker output"
    });
    return {
      status: "blocked",
      phase: "child_worker_acceptance",
      role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
      steps,
      issues: runResult.issues || [],
      hardening: {
        status: hardening.status,
        finding: hardening.finding,
        plan: hardening.plan
      },
      lifecycle_cleanup: {
        status: closed.status,
        facts: closed.facts || [],
        before: closed.before || null,
        after: closed.after || null
      },
      child_run: runResult,
      workflow_state: closed.workflow_state || hardening.workflow_state || workflowState
    };
  }

  workflowState = runResult.workflow_state;
  steps.push({
    phase: "context_work_packages_run",
    status: "pass",
    executed_count: runResult.executed_count
  });

  const closed = cleanupAgentLifecyclePool(workflowState, {
    created_at: createdAt,
    timeout_threshold_ms: options.timeout_threshold_ms ?? options.timeoutThresholdMs
  });
  if (!["pass", "cleanup_required"].includes(closed.status)) {
    return {
      status: "blocked",
      phase: "child_worker_lifecycle_close",
      role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
      steps,
      issues: closed.issues || [],
      workflow_state: closed.workflow_state || workflowState
    };
  }
  workflowState = closed.workflow_state;
  steps.push({
    phase: "child_worker_lifecycle_close",
    status: closed.status,
    fact_count: closed.facts.length
  });

  const projection = createWorkbenchProjection({
    ...workflowState,
    project_status: projectStatus,
    global_goals: projectStatus.global_goals
  });
  const continuation = decideContinuation(continuationInput(projectStatus, workflowState, projection));
  const snapshotPublish = publishHeadlessWorkflowSnapshot(workflowState, {
    ...options,
    created_at: createdAt
  });
  if (snapshotPublish.status === "fail") {
    return {
      status: "blocked",
      phase: "headless_snapshot_publish",
      role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
      steps,
      issues: snapshotPublish.issues || [],
      projection: snapshotPublish.projection || projection,
      continuation,
      snapshot_publish: snapshotPublish,
      workflow_state: workflowState
    };
  }
  workflowState = snapshotPublish.workflow_state || workflowState;
  const persistedProjection = snapshotPublish.projection || projection;
  if (snapshotPublish.status === "created") {
    steps.push({
      phase: "headless_snapshot_publish",
      status: "created",
      snapshot_id: snapshotPublish.item?.id || null
    });
  }

  return {
    status: "pass",
    phase: "headless_cli_orchestrator_cycle",
    version: HEADLESS_CLI_ORCHESTRATOR_VERSION,
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    child_role: CHILD_WORKER_ROLE,
    steps,
    context_pack: workflowState.manifest.context_pack,
    child_run: runResult,
    lifecycle_cleanup: {
      status: closed.status,
      facts: closed.facts,
      before: closed.before,
      after: closed.after
    },
    projection: persistedProjection,
    snapshot_publish: snapshotPublish,
    continuation,
    must_continue: continuation.should_continue === true ||
      Boolean(continuation.next_step) ||
      asArray(continuation.next_work_packages).length > 0 ||
      persistedProjection.next_action_readout?.action !== "wait_for_driver_event",
    workflow_state: workflowState,
    issues: []
  };
}
