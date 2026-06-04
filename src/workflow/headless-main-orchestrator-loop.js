import { HEADLESS_MAIN_ORCHESTRATOR_ROLE } from "./headless-worker-planning.js";
import { snapshotPersistenceConfig } from "./headless-snapshot-publisher.js";
import {
  boundedHeadlessLoopIterations,
  executeHeadlessProjectedNextAction,
  nextProjectedActionOptions,
  recordHeadlessProjectedActionProgress,
  serviceProjectedActionConfigured
} from "./headless-projected-next-action.js";
import { runHeadlessCliMainOrchestrator } from "./headless-main-orchestrator-cycle.js";
import { asArray, issue, normalizeString, safeIdPart } from "./headless-orchestrator-utils.js";

export function runHeadlessCliMainOrchestratorLoop(input = {}, options = {}) {
  const bounded = boundedHeadlessLoopIterations(options.max_iterations || options.maxIterations || 1);
  if (bounded.status !== "pass") {
    return {
      status: "blocked",
      phase: "input_validation",
      role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
      issues: bounded.issues,
      iterations: []
    };
  }

  const iterations = [];
  let currentInput = input;
  let loopOptions = { ...options };
  let lastResult = null;
  let currentWorkbenchProjectionId = normalizeString(options.workbench_projection_id || options.workbenchProjectionId);
  for (let index = 0; index < bounded.value; index += 1) {
    if (serviceProjectedActionConfigured(loopOptions)) {
      const iterationOptions = currentWorkbenchProjectionId
        ? { ...loopOptions, current_workbench_projection_id: currentWorkbenchProjectionId }
        : loopOptions;
      const serviceProjectedAction = executeHeadlessProjectedNextAction({
        status: "pass",
        phase: "service_projected_next_action",
        workflow_state: currentInput.workflow_state || currentInput.workflowState,
        projection: null,
        must_continue: true
      }, iterationOptions, index);
      if (serviceProjectedAction.status !== "not_configured") {
        const progress = recordHeadlessProjectedActionProgress(
          serviceProjectedAction.workflow_state || currentInput.workflow_state || currentInput.workflowState,
          serviceProjectedAction,
          loopOptions
        );
        if (progress.status === "pass") {
          serviceProjectedAction.workflow_state = progress.workflow_state;
        }
        if (serviceProjectedAction.next_projection_id) {
          currentWorkbenchProjectionId = serviceProjectedAction.next_projection_id;
          loopOptions = nextProjectedActionOptions(loopOptions, serviceProjectedAction);
        } else {
          loopOptions = nextProjectedActionOptions(loopOptions, serviceProjectedAction);
        }
        lastResult = {
          status: serviceProjectedAction.status === "blocked" ? "blocked" : "pass",
          phase: "headless_projected_next_action",
          role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
          projected_next_action: serviceProjectedAction,
          workflow_state: serviceProjectedAction.workflow_state || currentInput.workflow_state || currentInput.workflowState,
          projection: serviceProjectedAction.projection,
          must_continue: serviceProjectedAction.status !== "stopped",
          issues: serviceProjectedAction.issues || []
        };
        iterations.push({
          index: index + 1,
          status: lastResult.status,
          phase: lastResult.phase,
          run_id: lastResult.workflow_state?.manifest?.run_id || null,
          cycle_id: lastResult.workflow_state?.manifest?.cycle_id || null,
          snapshot_status: "not_configured",
          snapshot_id: null,
          next_action: serviceProjectedAction.projection?.next_action_readout?.action || null,
          projected_next_action_status: serviceProjectedAction.status,
          projected_next_action: serviceProjectedAction.action || null,
          projected_next_projection_id: serviceProjectedAction.next_projection_id || null,
          workbench_projection_id: currentWorkbenchProjectionId || null,
          must_continue: lastResult.must_continue === true,
          issue_count: asArray(lastResult.issues).length
        });
        if (serviceProjectedAction.status === "blocked") {
          return {
            status: "blocked",
            phase: "headless_projected_next_action",
            role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
            iterations,
            last_result: lastResult,
            projected_next_action: serviceProjectedAction,
            issues: serviceProjectedAction.issues || []
          };
        }
        currentInput = {
          ...currentInput,
          role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
          workflow_state: lastResult.workflow_state,
          project_status: input.project_status || input.projectStatus,
          projection_history: currentInput.projection_history || currentInput.projectionHistory
        };
        if (!lastResult.must_continue) {
          return {
            status: "complete",
            phase: "headless_loop_complete",
            role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
            iterations,
            last_result: lastResult,
            issues: []
          };
        }
        continue;
      }
    }

    const sourceCycleId = currentInput?.workflow_state?.manifest?.cycle_id || currentInput?.workflowState?.manifest?.cycle_id;
    const cycleSeed = normalizeString(options.cycle_id || options.cycleId) || `${safeIdPart(sourceCycleId)}-headless`;
    const run = runHeadlessCliMainOrchestrator(currentInput, {
      ...loopOptions,
      cycle_id: `${safeIdPart(cycleSeed)}-${String(index + 1).padStart(2, "0")}`,
      snapshot_id: normalizeString(loopOptions.snapshot_id || loopOptions.snapshotId)
        ? `${safeIdPart(loopOptions.snapshot_id || loopOptions.snapshotId)}-${String(index + 1).padStart(2, "0")}`
        : "",
      snapshot_prefix: normalizeString(loopOptions.snapshot_prefix || loopOptions.snapshotPrefix) || "headless-loop"
    });
    lastResult = run;
    const persisted = run.snapshot_publish?.status === "created";
    const iterationOptions = currentWorkbenchProjectionId
      ? { ...options, current_workbench_projection_id: currentWorkbenchProjectionId }
      : options;
    const projectedAction = executeHeadlessProjectedNextAction(run, iterationOptions, index);
    iterations.push({
      index: index + 1,
      status: run.status,
      phase: run.phase,
      run_id: run.workflow_state?.manifest?.run_id || null,
      cycle_id: run.workflow_state?.manifest?.cycle_id || null,
      snapshot_status: run.snapshot_publish?.status || "not_configured",
      snapshot_id: run.snapshot_publish?.item?.id || null,
      next_action: run.projection?.next_action_readout?.action || null,
      projected_next_action_status: projectedAction.status,
      projected_next_action: projectedAction.action || null,
      projected_next_projection_id: projectedAction.next_projection_id || null,
      workbench_projection_id: currentWorkbenchProjectionId || null,
      must_continue: run.must_continue === true,
      issue_count: asArray(run.issues).length
    });
    if (projectedAction.next_projection_id) {
      currentWorkbenchProjectionId = projectedAction.next_projection_id;
      loopOptions = nextProjectedActionOptions(loopOptions, projectedAction);
    }

    if (run.status !== "pass") {
      return {
        status: "blocked",
        phase: run.phase,
        role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
        iterations,
        last_result: run,
        issues: run.issues || []
      };
    }
    if (snapshotPersistenceConfig(options).status === "configured" && !persisted) {
      return {
        status: "blocked",
        phase: "headless_loop_snapshot_persistence",
        role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
        iterations,
        last_result: run,
        issues: [issue("headless_loop_snapshot_not_persisted", "configured headless loop must persist every iteration snapshot before continuing", "snapshot_publish.status")]
      };
    }
    if (projectedAction.status === "blocked") {
      return {
        status: "blocked",
        phase: "headless_projected_next_action",
        role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
        iterations,
        last_result: run,
        projected_next_action: projectedAction,
        issues: projectedAction.issues || []
      };
    }
    if (projectedAction.status !== "not_configured") {
      const progress = recordHeadlessProjectedActionProgress(
        projectedAction.workflow_state || run.workflow_state,
        projectedAction,
        loopOptions
      );
      if (progress.status === "pass") {
        projectedAction.workflow_state = progress.workflow_state;
      }
      lastResult = {
        ...run,
        projected_next_action: projectedAction,
        workflow_state: projectedAction.workflow_state || run.workflow_state,
        projection: projectedAction.projection || run.projection
      };
      loopOptions = nextProjectedActionOptions(loopOptions, projectedAction);
    }
    if (!run.must_continue) {
      return {
        status: "complete",
        phase: "headless_loop_complete",
        role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
        iterations,
        last_result: lastResult,
        issues: []
      };
    }

    currentInput = {
      ...currentInput,
      role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
      workflow_state: projectedAction.workflow_state || run.workflow_state,
      project_status: input.project_status || input.projectStatus,
      projection_history: run.snapshot_publish?.history || currentInput.projection_history || currentInput.projectionHistory
    };
  }

  return {
    status: "pass",
    phase: "headless_loop_iteration_limit_reached",
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    iterations,
    last_result: lastResult,
    issues: []
  };
}
