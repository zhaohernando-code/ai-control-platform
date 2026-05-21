import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { recordArtifact } from "./artifact-ledger.js";
import { prepareAutonomousContinuationFromLoopArtifact } from "./autonomous-orchestrator.js";
import { appendRunEvent } from "./run-manifest.js";
import { SCHEDULER_DISPATCH_RUN_VERSION } from "./scheduler-dispatch-runner.js";

const SCHEDULER_DISPATCH_CONTINUATION_VERSION = "scheduler-dispatch-continuation.v1";
const SCHEDULER_NEXT_CYCLE_ENQUEUE_VERSION = "scheduler-next-cycle-enqueue.v1";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function issue(code, message, path) {
  return { code, message, path };
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeIdPart(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function closeoutLoopOutput(runArtifact = {}) {
  return asArray(runArtifact?.result?.steps)
    .find((step) => step?.id === "run-autonomous-closeout-loop")
    ?.outputs?.autonomous_closeout_loop_artifact || null;
}

function blocked(issues, runArtifact = {}) {
  return {
    status: "blocked",
    phase: "scheduler_dispatch_continuation",
    should_continue: false,
    issues,
    blockers: [
      {
        id: "scheduler_dispatch_continuation",
        category: "scheduler_dispatch_replay_invalid",
        status: "blocked",
        message: "scheduler dispatch run artifact cannot produce next continuation",
        issues
      }
    ],
    scheduler_dispatch: {
      run_id: runArtifact?.run_id || null,
      cycle_id: runArtifact?.cycle_id || null,
      status: runArtifact?.status || null,
      phase: runArtifact?.phase || null
    },
    continuation_input: null,
    context_pack_seed: null,
    snapshot_publish_plan: null,
    next_decision: null
  };
}

function nextArtifactId(workflowState = {}, prefix, options = {}) {
  const explicit = normalizeString(options.artifact_id || options.artifactId);
  if (explicit) return explicit;

  const fullPrefix = `${prefix}-${safeIdPart(workflowState?.manifest?.run_id)}-${safeIdPart(workflowState?.manifest?.cycle_id)}`;
  const used = new Set([
    ...asArray(workflowState?.manifest?.events).map((event) => normalizeString(event?.artifact_id)).filter(Boolean),
    ...asArray(workflowState?.artifact_ledger?.artifacts || workflowState?.artifactLedger?.artifacts)
      .map((artifact) => normalizeString(artifact?.id))
      .filter(Boolean)
  ]);
  let index = 1;
  let id = `${fullPrefix}-${String(index).padStart(3, "0")}`;
  while (used.has(id)) {
    index += 1;
    id = `${fullPrefix}-${String(index).padStart(3, "0")}`;
  }
  return id;
}

function nextSchedulerContinuationArtifactId(workflowState = {}, options = {}) {
  return nextArtifactId(workflowState, "scheduler-dispatch-continuation", options);
}

function nextSchedulerEnqueueArtifactId(workflowState = {}, options = {}) {
  return nextArtifactId(workflowState, "scheduler-next-cycle-enqueue", options);
}

export function prepareSchedulerDispatchContinuationFromRunArtifact(runArtifact = {}) {
  if (!runArtifact || typeof runArtifact !== "object" || Array.isArray(runArtifact)) {
    return blocked([issue("invalid_scheduler_dispatch_run_artifact", "scheduler dispatch run artifact must be an object", "run_artifact")]);
  }
  if (runArtifact.version !== SCHEDULER_DISPATCH_RUN_VERSION) {
    return blocked([issue("invalid_scheduler_dispatch_run_version", "run artifact version must be scheduler-dispatch-run.v1", "version")], runArtifact);
  }
  if (runArtifact.status !== "pass") {
    return blocked([issue("non_reusable_scheduler_dispatch_status", "only pass scheduler dispatch artifacts can produce next continuation", "status")], runArtifact);
  }

  const output = closeoutLoopOutput(runArtifact);
  if (!output?.path) {
    return blocked([issue("missing_closeout_loop_output_path", "scheduler dispatch run must include run-autonomous-closeout-loop output path", "result.steps")], runArtifact);
  }
  if (output.status && output.status !== "available") {
    return blocked([issue("unavailable_closeout_loop_output", "run-autonomous-closeout-loop output must be available", "result.steps.outputs.autonomous_closeout_loop_artifact")], runArtifact);
  }

  let closeoutArtifact;
  try {
    closeoutArtifact = JSON.parse(readFileSync(resolve(output.path), "utf8"));
  } catch (error) {
    return blocked([issue("closeout_loop_artifact_read_failed", error.message, "result.steps.outputs.autonomous_closeout_loop_artifact.path")], runArtifact);
  }

  const prepared = prepareAutonomousContinuationFromLoopArtifact(closeoutArtifact);
  if (prepared.status !== "ready") {
    return blocked(prepared.issues || [issue("closeout_loop_artifact_not_reusable", "closeout loop artifact cannot resume scheduler continuation", "closeout_loop_artifact")], runArtifact);
  }

  return {
    ...prepared,
    phase: "scheduler_dispatch_continuation",
    scheduler_dispatch: {
      run_id: runArtifact.run_id || null,
      cycle_id: runArtifact.cycle_id || null,
      status: runArtifact.status,
      phase: runArtifact.phase,
      closeout_loop_artifact_path: output.path,
      next_work_package_count: asArray(prepared.next_decision?.next_work_packages).length
    }
  };
}

export function recordSchedulerDispatchContinuationPrepared(workflowState = {}, prepared = {}, options = {}) {
  if (!isObject(workflowState)) {
    return {
      status: "fail",
      issues: [issue("invalid_workflow_state", "workflow state must be an object", "workflow_state")]
    };
  }

  const runId = normalizeString(workflowState?.manifest?.run_id);
  const cycleId = normalizeString(workflowState?.manifest?.cycle_id);
  if (!runId || !cycleId) {
    return {
      status: "fail",
      issues: [issue("missing_workflow_identity", "workflow state manifest run_id and cycle_id are required", "workflow_state.manifest")]
    };
  }

  const preparedRunId = normalizeString(prepared?.scheduler_dispatch?.run_id);
  const preparedCycleId = normalizeString(prepared?.scheduler_dispatch?.cycle_id);
  if ((preparedRunId && preparedRunId !== runId) || (preparedCycleId && preparedCycleId !== cycleId)) {
    return {
      status: "fail",
      issues: [issue("scheduler_continuation_identity_mismatch", "scheduler dispatch continuation identity must match workflow state", "prepared.scheduler_dispatch")]
    };
  }

  const ready = prepared?.status === "ready";
  const id = nextSchedulerContinuationArtifactId(workflowState, options);
  const createdAt = normalizeString(options.created_at || options.createdAt) || new Date().toISOString();
  const issues = asArray(prepared?.issues);
  const nextWorkPackages = asArray(prepared?.next_decision?.next_work_packages);
  const continuationInput = prepared?.continuation_input || {};
  const artifact = {
    id,
    type: "evaluation",
    status: ready ? "pass" : "fail",
    uri: `scheduler-dispatch://continuation/${encodeURIComponent(runId)}/${encodeURIComponent(cycleId)}/${encodeURIComponent(id)}`,
    producer: "scheduler-dispatch-continuation",
    created_at: createdAt,
    metadata: {
      version: SCHEDULER_DISPATCH_CONTINUATION_VERSION,
      type: "scheduler_dispatch_continuation",
      status: prepared?.status || "blocked",
      phase: prepared?.phase || "scheduler_dispatch_continuation",
      run_id: runId,
      cycle_id: cycleId,
      source_artifact_id: normalizeString(options.source_artifact_id || options.sourceArtifactId) || null,
      continuation_input_path: normalizeString(options.continuation_input_path || options.continuationInputPath) || null,
      next_step: continuationInput?.project_status?.next_step || null,
      next_work_package_count: nextWorkPackages.length,
      should_continue: prepared?.should_continue ?? null,
      scheduler_dispatch: prepared?.scheduler_dispatch || null,
      issues
    }
  };
  const eventStatus = ready ? "ready" : "blocked";
  const manifest = appendRunEvent(workflowState.manifest, {
    id: `event-${id}`,
    type: "scheduler_dispatch_continuation",
    status: eventStatus,
    artifact_id: id,
    message: ready
      ? "scheduler dispatch continuation input prepared"
      : "scheduler dispatch continuation input blocked",
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
    fact: artifact.metadata,
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

export function recordSchedulerNextCycleEnqueue(workflowState = {}, prepared = {}, options = {}) {
  if (!isObject(workflowState)) {
    return {
      status: "fail",
      issues: [issue("invalid_workflow_state", "workflow state must be an object", "workflow_state")]
    };
  }
  if (prepared?.status !== "ready") {
    return {
      status: "fail",
      issues: [issue("scheduler_continuation_not_ready", "only ready scheduler continuation can be enqueued", "prepared.status")]
    };
  }

  const runId = normalizeString(workflowState?.manifest?.run_id);
  const cycleId = normalizeString(workflowState?.manifest?.cycle_id);
  if (!runId || !cycleId) {
    return {
      status: "fail",
      issues: [issue("missing_workflow_identity", "workflow state manifest run_id and cycle_id are required", "workflow_state.manifest")]
    };
  }

  const preparedRunId = normalizeString(prepared?.scheduler_dispatch?.run_id);
  const preparedCycleId = normalizeString(prepared?.scheduler_dispatch?.cycle_id);
  if ((preparedRunId && preparedRunId !== runId) || (preparedCycleId && preparedCycleId !== cycleId)) {
    return {
      status: "fail",
      issues: [issue("scheduler_enqueue_identity_mismatch", "scheduler enqueue identity must match workflow state", "prepared.scheduler_dispatch")]
    };
  }

  const id = nextSchedulerEnqueueArtifactId(workflowState, options);
  const createdAt = normalizeString(options.created_at || options.createdAt) || new Date().toISOString();
  const nextWorkPackages = asArray(prepared?.next_decision?.next_work_packages);
  const continuationInput = prepared?.continuation_input || {};
  const artifact = {
    id,
    type: "evaluation",
    status: "pass",
    uri: `scheduler-dispatch://next-cycle/${encodeURIComponent(runId)}/${encodeURIComponent(cycleId)}/${encodeURIComponent(id)}`,
    producer: "workbench-server",
    created_at: createdAt,
    metadata: {
      version: SCHEDULER_NEXT_CYCLE_ENQUEUE_VERSION,
      type: "scheduler_next_cycle_enqueue",
      status: "queued",
      run_id: runId,
      cycle_id: cycleId,
      source_artifact_id: normalizeString(options.source_artifact_id || options.sourceArtifactId) || null,
      continuation_artifact_id: normalizeString(options.continuation_artifact_id || options.continuationArtifactId) || null,
      continuation_input_path: normalizeString(options.continuation_input_path || options.continuationInputPath) || null,
      snapshot_id: normalizeString(options.snapshot_id || options.snapshotId) || null,
      next_step: continuationInput?.project_status?.next_step || null,
      next_work_package_count: nextWorkPackages.length,
      should_continue: prepared?.should_continue ?? null
    }
  };
  const manifest = appendRunEvent(workflowState.manifest, {
    id: `event-${id}`,
    type: "scheduler_next_cycle_enqueue",
    status: "queued",
    artifact_id: id,
    message: "scheduler next cycle enqueued from continuation input",
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
    fact: artifact.metadata,
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

export {
  closeoutLoopOutput,
  SCHEDULER_DISPATCH_CONTINUATION_VERSION,
  SCHEDULER_NEXT_CYCLE_ENQUEUE_VERSION
};
