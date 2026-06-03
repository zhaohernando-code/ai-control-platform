import { recordArtifact } from "./artifact-ledger.js";
import { appendRunEvent } from "./run-manifest.js";
import {
  localWorkbenchBaseUrl,
  workbenchNextActionRunnerFrom,
  workbenchProjectionFrom
} from "./headless-projected-workbench-client.js";

const HEADLESS_CLI_ORCHESTRATOR_VERSION = "headless-cli-orchestrator.v1";
export const MAX_HEADLESS_LOOP_ITERATIONS = 5;
const HEADLESS_PROJECTED_NEXT_ACTIONS = new Set([
  "enqueue_scheduler_next_cycle",
  "prepare_project_status_continuation",
  "continue_after_reviewer_aggregate",
  "create_context_pack_from_seed",
  "run_context_work_packages",
  "run_reviewer_scope_shard",
  "cleanup_agent_lifecycle_pool",
  "resume_autonomous_scheduler_loop",
  "run_autonomous_scheduler_loop"
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function issue(code, message, path) {
  return { code, message, path };
}

function safeIdPart(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

export function boundedHeadlessLoopIterations(value) {
  const parsed = Number(value || 1);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_HEADLESS_LOOP_ITERATIONS) {
    return {
      status: "fail",
      value: null,
      issues: [issue(
        "invalid_headless_loop_iterations",
        `max_iterations must be an integer between 1 and ${MAX_HEADLESS_LOOP_ITERATIONS}`,
        "max_iterations"
      )]
    };
  }
  return { status: "pass", value: parsed, issues: [] };
}

function projectedNextActionRunnerFrom(options = {}) {
  if (typeof options.projected_next_action_runner === "function") return options.projected_next_action_runner;
  if (typeof options.projectedNextActionRunner === "function") return options.projectedNextActionRunner;
  return workbenchNextActionRunnerFrom(options);
}

export function projectedNextActionMode(options = {}) {
  return normalizeString(options.execution_strategy || options.executionStrategy) === "projected_next_action" ||
    normalizeString(options.headless_loop_strategy || options.headlessLoopStrategy) === "projected_next_action";
}

function isTerminalProjectedAction(action = "") {
  return !action ||
    action === "wait_for_driver_event" ||
    action === "inspect_scheduler_loop" ||
    action === "inspect_resume_target" ||
    action === "inspect_latest_driver";
}

function projectedActionProgressEvidence(result = {}) {
  return Boolean(
    result?.workflow_state ||
      result?.workflowState ||
      result?.projection ||
      result?.result?.projection ||
      result?.result?.current_projection ||
      result?.result?.next_item?.id ||
      result?.next_item?.id
  );
}

export function executeHeadlessProjectedNextAction(run = {}, options = {}, index = 0) {
  if (!projectedNextActionMode(options)) {
    return {
      status: "not_configured",
      workflow_state: run.workflow_state,
      projection: run.projection
    };
  }

  if (normalizeString(options.workbench_base_url || options.workbenchBaseUrl)) {
    localWorkbenchBaseUrl(options.workbench_base_url || options.workbenchBaseUrl);
  }

  let serviceProjection = null;
  if (!options.projected_next_action_readout && !options.projectedNextActionReadout) {
    try {
      serviceProjection = workbenchProjectionFrom(options);
    } catch (error) {
      if (normalizeString(options.workbench_base_url || options.workbenchBaseUrl)) {
        return {
          status: "blocked",
          action: null,
          issues: [
            issue(
              "projected_service_projection_unavailable",
              error.message,
              "workbench_projection"
            )
          ],
          workflow_state: run.workflow_state,
          projection: run.projection
        };
      }
    }
  }
  const readout = options.projected_next_action_readout ||
    options.projectedNextActionReadout ||
    serviceProjection?.next_action_readout ||
    run.projection?.next_action_readout ||
    {};
  const action = normalizeString(readout.action);
  if (readout.status !== "ready" || isTerminalProjectedAction(action)) {
    return {
      status: "stopped",
      action,
      reason: readout.reason || "projected next action is terminal or not ready",
      workflow_state: run.workflow_state,
      projection: run.projection
    };
  }
  const runner = projectedNextActionRunnerFrom(options);
  if (!runner) {
    return {
      status: "not_configured",
      workflow_state: run.workflow_state,
      projection: run.projection
    };
  }
  if (!HEADLESS_PROJECTED_NEXT_ACTIONS.has(action)) {
    return {
      status: "blocked",
      action,
      issues: [issue("unsupported_projected_next_action", `${action || "none"} is not in the headless projected action allowlist`, "projection.next_action_readout.action")],
      workflow_state: run.workflow_state,
      projection: run.projection
    };
  }

  let result;
  try {
    result = runner({
      action,
      projection: run.projection,
      workflow_state: run.workflow_state,
      expected_action: action,
      iteration: index + 1,
      options
    });
  } catch (error) {
    return {
      status: "blocked",
      action,
      issues: [issue("projected_next_action_runner_failed", error.message, "projected_next_action_runner")],
      workflow_state: run.workflow_state,
      projection: run.projection
    };
  }

  if (!projectedActionProgressEvidence(result)) {
    return {
      status: "blocked",
      action,
      result,
      issues: [issue("projected_action_missing_progress_evidence", "projected next-action execution must return workflow_state, projection, or next_item.id", "projected_next_action_result")],
      workflow_state: run.workflow_state,
      projection: run.projection
    };
  }

  return {
    status: result.status || "executed",
    action,
    result,
    workflow_state: result.workflow_state || result.workflowState || run.workflow_state,
    projection: result.projection || result.result?.projection || result.result?.current_projection || serviceProjection || run.projection,
    next_projection_id: result.result?.next_item?.id || result.next_item?.id || null
  };
}

export function nextProjectedActionOptions(options = {}, projectedAction = {}) {
  const nextProjectionId = normalizeString(projectedAction.next_projection_id);
  if (!nextProjectionId) {
    return {
      ...options,
      projected_next_action_readout: null,
      projectedNextActionReadout: null
    };
  }
  return {
    ...options,
    workbench_projection_id: nextProjectionId,
    workbenchProjectionId: nextProjectionId,
    projected_next_action_readout: null,
    projectedNextActionReadout: null
  };
}

export function serviceProjectedActionConfigured(options = {}) {
  return projectedNextActionMode(options) &&
    Boolean(normalizeString(options.workbench_base_url || options.workbenchBaseUrl));
}

export function recordHeadlessProjectedActionProgress(workflowState = {}, projectedAction = {}, options = {}) {
  if (projectedAction.status === "not_configured") {
    return {
      status: "not_configured",
      workflow_state: workflowState
    };
  }

  const createdAt = normalizeString(options.created_at || options.createdAt) || new Date().toISOString();
  const id = normalizeString(options.projected_action_artifact_id || options.projectedActionArtifactId) ||
    `headless-projected-action-${safeIdPart(workflowState?.manifest?.run_id)}-${safeIdPart(workflowState?.manifest?.cycle_id)}-${safeIdPart(projectedAction.action || projectedAction.status)}-001`;
  const artifact = {
    id,
    type: "evaluation",
    status: projectedAction.status === "blocked" ? "fail" : "pass",
    uri: `headless-cli://projected-action/${encodeURIComponent(workflowState?.manifest?.run_id || "unknown")}/${encodeURIComponent(workflowState?.manifest?.cycle_id || "unknown")}/${encodeURIComponent(id)}`,
    producer: "headless-cli-orchestrator",
    created_at: createdAt,
    metadata: {
      version: HEADLESS_CLI_ORCHESTRATOR_VERSION,
      type: "headless_projected_action_progress",
      status: projectedAction.status,
      action: projectedAction.action || null,
      terminal_action: projectedAction.status === "stopped" ? projectedAction.action || null : null,
      terminal_reason: projectedAction.status === "stopped" ? projectedAction.reason || null : null,
      next_projection_id: projectedAction.next_projection_id || projectedAction.result?.result?.next_item?.id || projectedAction.result?.next_item?.id || null,
      has_workflow_state: Boolean(projectedAction.workflow_state || projectedAction.workflowState),
      has_projection: Boolean(projectedAction.projection),
      issues: asArray(projectedAction.issues),
      result_status: projectedAction.result?.status || null
    }
  };
  const manifest = appendRunEvent(workflowState.manifest, {
    id: `event-${id}`,
    type: "headless_projected_action_progress",
    status: artifact.status,
    artifact_id: id,
    message: `headless projected next-action ${projectedAction.action || "unknown"} ${projectedAction.status}`,
    created_at: createdAt,
    metadata: artifact.metadata
  });
  const baseLedger = workflowState.artifact_ledger || workflowState.artifactLedger || {};
  const artifactLedger = recordArtifact({
    ...baseLedger,
    artifacts: Array.isArray(baseLedger.artifacts) ? baseLedger.artifacts : []
  }, artifact);

  return {
    status: "pass",
    artifact,
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
