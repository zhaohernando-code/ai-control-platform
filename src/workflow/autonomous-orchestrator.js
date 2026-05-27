import { decideContinuation } from "./autonomous-continuation.js";
import { appendRunEvent } from "./run-manifest.js";
import { recordArtifact } from "./artifact-ledger.js";
import { runCloseoutPlan } from "./closeout-runner.js";
import { createWorkbenchProjection } from "./workbench-projection.js";
import { validateWorkbenchProjectionSchema } from "./workbench-projection-schema.js";
import { evaluateWorkPackageExecutionGovernance } from "./work-package-execution-governance.js";

const AUTONOMOUS_LOOP_ARTIFACT_VERSION = "autonomous-closeout-loop-run.v1";

function issue(code, message, path) {
  return { code, message, path };
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeString(value) {
  return String(value || "").trim();
}

function hasContinuingSnapshotPlan(decision) {
  return Boolean(
    isObject(decision) &&
      decision.should_continue === true &&
      decision.snapshot_publish_plan?.action === "publish_workbench_snapshot"
  );
}

function hasSnapshotPublishPlan(decision) {
  return decision?.snapshot_publish_plan?.action === "publish_workbench_snapshot";
}

function manifestIdentity(value) {
  const manifest = value?.manifest || value?.input?.manifest || value?.workflow_state?.manifest;
  return {
    run_id: normalizeString(manifest?.run_id),
    cycle_id: normalizeString(manifest?.cycle_id)
  };
}

function pushIdentityIssues(issues, identity, expected, path) {
  if (!isObject(expected) || !expected.run_id || !expected.cycle_id) return;
  if (!identity.run_id) {
    issues.push(issue("missing_identity_run_id", `${path} manifest.run_id is required`, `${path}.manifest.run_id`));
  } else if (identity.run_id !== expected.run_id) {
    issues.push(issue("identity_run_id_mismatch", `${path} manifest.run_id must match artifact run_id`, `${path}.manifest.run_id`));
  }
  if (!identity.cycle_id) {
    issues.push(issue("missing_identity_cycle_id", `${path} manifest.cycle_id is required`, `${path}.manifest.cycle_id`));
  } else if (identity.cycle_id !== expected.cycle_id) {
    issues.push(issue("identity_cycle_id_mismatch", `${path} manifest.cycle_id must match artifact cycle_id`, `${path}.manifest.cycle_id`));
  }
}

function workflowStateIdentityIssues(workflowState = {}) {
  const issues = [];
  const manifest = manifestIdentity(workflowState);
  const ledger = {
    run_id: normalizeString(workflowState?.artifact_ledger?.run_id || workflowState?.artifactLedger?.run_id),
    cycle_id: normalizeString(workflowState?.artifact_ledger?.cycle_id || workflowState?.artifactLedger?.cycle_id)
  };

  if (!manifest.run_id) issues.push(issue("missing_workflow_state_run_id", "workflow state manifest.run_id is required", "manifest.run_id"));
  if (!manifest.cycle_id) issues.push(issue("missing_workflow_state_cycle_id", "workflow state manifest.cycle_id is required", "manifest.cycle_id"));
  if (!ledger.run_id) issues.push(issue("missing_workflow_state_ledger_run_id", "workflow state artifact_ledger.run_id is required", "artifact_ledger.run_id"));
  if (!ledger.cycle_id) issues.push(issue("missing_workflow_state_ledger_cycle_id", "workflow state artifact_ledger.cycle_id is required", "artifact_ledger.cycle_id"));
  if (manifest.run_id && ledger.run_id && manifest.run_id !== ledger.run_id) {
    issues.push(issue("workflow_state_run_id_mismatch", "workflow state manifest and artifact_ledger run_id must match", "artifact_ledger.run_id"));
  }
  if (manifest.cycle_id && ledger.cycle_id && manifest.cycle_id !== ledger.cycle_id) {
    issues.push(issue("workflow_state_cycle_id_mismatch", "workflow state manifest and artifact_ledger cycle_id must match", "artifact_ledger.cycle_id"));
  }

  return issues;
}


function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function shouldHardExit(blockers = []) {
  return asArray(blockers).some(b => b?.category === "hard_exit");
}

function readWorkPackageStatusFromManifest(workflowState = {}) {
  const manifest = workflowState?.manifest || {};
  const packages = asArray(manifest.work_packages);
  return new Map(packages.map(wp => [wp?.id, wp?.status]).filter(([id]) => id));
}

function updateProjectStatusFromExecution(input, closeoutResult) {
  if (!input?.project_status || !closeoutResult?.closeout?.workflow_state) return input;
  
  const projectStatus = input.project_status;
  const manifestStatus = readWorkPackageStatusFromManifest(closeoutResult.closeout.workflow_state);
  
  const completedStatuses = new Set(["completed", "complete", "done", "passed", "pass"]);
  const updated = asArray(projectStatus.next_work_packages).map(wp => ({
    ...wp,
    status: manifestStatus.get(wp.id) || wp.status || "queued"
  }));
  
  const completed = updated.filter(wp => completedStatuses.has(wp.status));
  const pending = updated.filter(wp => !completed.includes(wp));
  
  return {
    ...input,
    project_status: {
      ...projectStatus,
      next_work_packages: pending,
      execution_trace: {
        ...(projectStatus.execution_trace || {}),
        completed_work_packages: [
          ...(projectStatus.execution_trace?.completed_work_packages || []),
          ...completed.map(wp => wp.id)
        ]
      }
    }
  };
}

function continuationInputFromProjection(input, workflowState, projection) {
  // CRITICAL: input.project_status is the source of truth, not workflow_state.project_status
  // which may be stale from a prior iteration
  const projectStatus = input.project_status || input.projectStatus || input.next_project_status || input.nextProjectStatus;
  const cleanWorkflowState = {
    ...workflowState,
    // Remove any stale project_status from workflow_state
    project_status: undefined,
    projectStatus: undefined
  };
  return {
    project_status: projectStatus,
    run_evaluation: {
      status: projection.status,
      decision: projection.decision,
      blockers: projection.blockers,
      projection
    },
    model_plan: input?.model_plan,
    reviewer_gate: input?.reviewer_gate,
    operator_event_ledger: input?.operator_event_ledger,
    goal: input?.goal,
    workflow_state: cleanWorkflowState
  };
}

function createAutonomousLoopRunArtifact(input = {}, result = {}, options = {}) {
  return {
    version: AUTONOMOUS_LOOP_ARTIFACT_VERSION,
    run_id: result.projection?.run_id || input.workflow_state?.manifest?.run_id || null,
    cycle_id: result.projection?.cycle_id || input.workflow_state?.manifest?.cycle_id || null,
    status: result.status || "fail",
    phase: result.phase || null,
    created_at: options.created_at || new Date().toISOString(),
    input,
    result: {
      status: result.status,
      phase: result.phase,
      issues: result.issues || [],
      decision: result.decision || null,
      closeout: result.closeout || null,
      projection: result.projection || null,
      next_decision: result.next_decision || null
    }
  };
}

function replayBlocker(validation) {
  return {
    id: "autonomous_loop_artifact_replay",
    category: "replay_artifact_invalid",
    status: "blocked",
    message: "autonomous closeout loop artifact failed replay validation",
    issues: validation.issues
  };
}

function safeIdPart(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function replayValidationArtifactId(workflowState = {}, options = {}) {
  const explicitId = normalizeString(options.artifact_id);

  const runId = safeIdPart(workflowState?.manifest?.run_id);
  const cycleId = safeIdPart(workflowState?.manifest?.cycle_id);
  const prefix = explicitId || `autonomous-loop-replay-validation-${runId}-${cycleId}`;
  const artifacts = workflowState?.artifact_ledger?.artifacts || workflowState?.artifactLedger?.artifacts || [];
  const events = workflowState?.manifest?.events || [];
  const usedIds = new Set([
    ...artifacts.map((item) => item?.id).filter(Boolean),
    ...events.map((item) => normalizeString(item?.artifact_id)).filter(Boolean)
  ]);
  if (explicitId && !usedIds.has(explicitId)) return explicitId;

  let index = 1;
  let id = `${prefix}-${String(index).padStart(3, "0")}`;
  while (usedIds.has(id)) {
    index += 1;
    id = `${prefix}-${String(index).padStart(3, "0")}`;
  }
  return id;
}

function replayValidationArtifact(workflowState = {}, issues = [], options = {}) {
  const runId = normalizeString(workflowState?.manifest?.run_id) || "unknown-run";
  const cycleId = normalizeString(workflowState?.manifest?.cycle_id) || "unknown-cycle";
  const createdAt = normalizeString(options.created_at) || new Date().toISOString();
  const id = replayValidationArtifactId(workflowState, options);

  return {
    id,
    type: "evaluation",
    status: "fail",
    uri: `autonomous-loop://replay-validation/${runId}/${cycleId}`,
    producer: "autonomous-orchestrator",
    created_at: createdAt,
    metadata: {
      run_id: runId,
      cycle_id: cycleId,
      replay_status: "blocked",
      issues
    }
  };
}

function recordReplayValidationBlocker(workflowState = {}, issues = [], options = {}) {
  if (!isObject(workflowState)) return null;
  if (workflowStateIdentityIssues(workflowState).length > 0) return null;
  const artifact = replayValidationArtifact(workflowState, issues, options);
  const manifest = appendRunEvent(workflowState.manifest || {}, {
    id: `event-${artifact.id}`,
    type: "autonomous_loop_replay_validation",
    status: "blocked",
    artifact_id: artifact.id,
    message: "autonomous loop replay validation blocked scheduler continuation",
    created_at: artifact.created_at,
    metadata: artifact.metadata
  });
  const manifestArtifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  const baseLedger = workflowState.artifact_ledger || workflowState.artifactLedger || {};
  const artifactLedger = recordArtifact({
    ...baseLedger,
    artifacts: Array.isArray(baseLedger.artifacts) ? baseLedger.artifacts : []
  }, artifact);

  return {
    ...workflowState,
    manifest: {
      ...manifest,
      artifacts: [...manifestArtifacts, artifact]
    },
    artifact_ledger: artifactLedger
  };
}

function replayBlockedResult(issues, options = {}) {
  const validation = {
    status: "fail",
    issues
  };
  const workflowState = recordReplayValidationBlocker(options.workflowState, issues, options);
  return {
    status: "blocked",
    phase: "replay_validation",
    should_continue: false,
    issues,
    blockers: [replayBlocker(validation)],
    continuation_input: null,
    context_pack_seed: null,
    snapshot_publish_plan: null,
    next_decision: null,
    workflow_state: workflowState
  };
}

function validateAutonomousLoopRunArtifact(artifact = {}) {
  const issues = [];
  if (!isObject(artifact)) {
    return {
      status: "fail",
      issues: [issue("invalid_autonomous_loop_artifact", "artifact must be an object", "")]
    };
  }

  if (artifact.version !== AUTONOMOUS_LOOP_ARTIFACT_VERSION) {
    issues.push(issue("invalid_artifact_version", `version must be ${AUTONOMOUS_LOOP_ARTIFACT_VERSION}`, "version"));
  }
  if (!["pass", "fail"].includes(artifact.status)) {
    issues.push(issue("invalid_artifact_status", "status must be pass or fail", "status"));
  }
  if (!normalizeString(artifact.phase)) {
    issues.push(issue("missing_artifact_phase", "phase is required", "phase"));
  }
  if (!normalizeString(artifact.created_at)) {
    issues.push(issue("missing_artifact_created_at", "created_at is required", "created_at"));
  }
  if (!normalizeString(artifact.run_id)) {
    issues.push(issue("missing_artifact_run_id", "run_id is required", "run_id"));
  }
  if (!normalizeString(artifact.cycle_id)) {
    issues.push(issue("missing_artifact_cycle_id", "cycle_id is required", "cycle_id"));
  }
  if (!isObject(artifact.input)) {
    issues.push(issue("missing_artifact_input", "input must be an object", "input"));
  }
  if (isObject(artifact.input) && artifact.input.project_status?.project !== "ai-control-platform") {
    issues.push(issue("invalid_artifact_project", "input project_status.project must be ai-control-platform", "input.project_status.project"));
  }
  if (isObject(artifact.input) && !isObject(artifact.input.workflow_state)) {
    issues.push(issue("missing_input_workflow_state", "input.workflow_state must be an object", "input.workflow_state"));
  }

  const expectedIdentity = {
    run_id: normalizeString(artifact.run_id),
    cycle_id: normalizeString(artifact.cycle_id)
  };
  if (isObject(artifact.input?.workflow_state)) {
    pushIdentityIssues(issues, manifestIdentity(artifact.input.workflow_state), expectedIdentity, "input.workflow_state");
  }
  if (!isObject(artifact.result)) {
    issues.push(issue("missing_artifact_result", "result must be an object", "result"));
  }

  const result = artifact.result;
  if (isObject(result)) {
    if (result.status !== artifact.status) {
      issues.push(issue("artifact_status_mismatch", "artifact status must match result.status", "result.status"));
    }
    if (result.phase !== artifact.phase) {
      issues.push(issue("artifact_phase_mismatch", "artifact phase must match result.phase", "result.phase"));
    }
    if (isObject(result.projection)) {
      const projectionValidation = validateWorkbenchProjectionSchema(result.projection);
      if (projectionValidation.status !== "pass") {
        issues.push(issue("invalid_artifact_projection", "result.projection must pass workbench projection schema", "result.projection"));
        issues.push(...projectionValidation.issues.map((entry) => ({
          ...entry,
          path: `result.projection.${entry.path}`.replace(/\.$/, "")
        })));
      }
      if (normalizeString(artifact.run_id) && result.projection.run_id !== artifact.run_id) {
        issues.push(issue("artifact_run_id_mismatch", "artifact run_id must match result.projection.run_id", "run_id"));
      }
      if (normalizeString(artifact.cycle_id) && result.projection.cycle_id !== artifact.cycle_id) {
        issues.push(issue("artifact_cycle_id_mismatch", "artifact cycle_id must match result.projection.cycle_id", "cycle_id"));
      }
    }
    if (isObject(result.decision?.snapshot_publish_plan?.input)) {
      pushIdentityIssues(
        issues,
        manifestIdentity(result.decision.snapshot_publish_plan.input),
        expectedIdentity,
        "result.decision.snapshot_publish_plan.input"
      );
    }
    if (isObject(result.closeout?.workflow_state)) {
      pushIdentityIssues(issues, manifestIdentity(result.closeout.workflow_state), expectedIdentity, "result.closeout.workflow_state");
    }
    if (isObject(result.next_decision?.snapshot_publish_plan?.input)) {
      pushIdentityIssues(
        issues,
        manifestIdentity(result.next_decision.snapshot_publish_plan.input),
        expectedIdentity,
        "result.next_decision.snapshot_publish_plan.input"
      );
    }
  }

  if (artifact.status === "pass") {
    if (artifact.phase !== "next_continuation") {
      issues.push(issue("invalid_pass_phase", "pass artifact phase must be next_continuation", "phase"));
    }
    if (Array.isArray(result?.issues) && result.issues.length > 0) {
      issues.push(issue("pass_artifact_has_issues", "pass artifact result.issues must be empty", "result.issues"));
    }
    if (result?.decision?.should_continue !== true) {
      issues.push(issue("missing_initial_continuation", "pass artifact must include continuing initial decision", "result.decision"));
    }
    if (!hasSnapshotPublishPlan(result?.decision)) {
      issues.push(issue(
        "invalid_initial_snapshot_publish_plan",
        "pass artifact must include initial publish_workbench_snapshot plan",
        "result.decision.snapshot_publish_plan"
      ));
    }
    if (result?.closeout?.status !== "created") {
      issues.push(issue("missing_created_closeout", "pass artifact must include created closeout result", "result.closeout.status"));
    }
    if (result?.closeout?.evidence_snapshot_publish?.status !== "created") {
      issues.push(issue(
        "missing_closeout_evidence_snapshot",
        "pass artifact must include created closeout evidence snapshot publish",
        "result.closeout.evidence_snapshot_publish.status"
      ));
    }
    if (!isObject(result?.projection?.closeout)) {
      issues.push(issue("missing_closeout_projection", "pass artifact must include projection.closeout", "result.projection.closeout"));
    } else {
      if (result.projection.closeout.status !== "pass") {
        issues.push(issue("invalid_closeout_projection_status", "pass artifact projection.closeout.status must be pass", "result.projection.closeout.status"));
      }
      if (result.projection.closeout.publish_status !== "created") {
        issues.push(issue(
          "invalid_closeout_publish_status",
          "pass artifact projection.closeout.publish_status must be created",
          "result.projection.closeout.publish_status"
        ));
      }
    }
    if (!hasContinuingSnapshotPlan(result?.next_decision)) {
      issues.push(issue("missing_next_continuation", "pass artifact must include continuing next_decision", "result.next_decision"));
    }
  }

  return {
    status: issues.length ? "fail" : "pass",
    issues
  };
}

function prepareAutonomousContinuationFromLoopArtifact(artifact = {}) {
  const validation = validateAutonomousLoopRunArtifact(artifact);
  if (validation.status !== "pass") {
    return replayBlockedResult(validation.issues, { workflowState: artifact?.input?.workflow_state });
  }

  const reuseIssues = [];
  if (artifact.status !== "pass") {
    reuseIssues.push(issue("non_reusable_artifact_status", "only pass autonomous loop artifacts can resume scheduler continuation", "status"));
  }
  if (artifact.phase !== "next_continuation") {
    reuseIssues.push(issue("non_reusable_artifact_phase", "only next_continuation artifacts can resume scheduler continuation", "phase"));
  }
  if (!isObject(artifact.result?.closeout?.workflow_state)) {
    reuseIssues.push(issue("missing_reusable_workflow_state", "result.closeout.workflow_state is required for scheduler continuation", "result.closeout.workflow_state"));
  }
  if (!isObject(artifact.result?.projection)) {
    reuseIssues.push(issue("missing_reusable_projection", "result.projection is required for scheduler continuation", "result.projection"));
  }
  if (!isObject(artifact.result?.next_decision?.context_pack_seed)) {
    reuseIssues.push(issue("missing_reusable_context_pack_seed", "result.next_decision.context_pack_seed is required for scheduler continuation", "result.next_decision.context_pack_seed"));
  }
  if (!isObject(artifact.result?.next_decision?.snapshot_publish_plan)) {
    reuseIssues.push(issue("missing_reusable_snapshot_publish_plan", "result.next_decision.snapshot_publish_plan is required for scheduler continuation", "result.next_decision.snapshot_publish_plan"));
  }
  if (!isObject(artifact.result?.decision?.snapshot_publish_plan)) {
    reuseIssues.push(issue("missing_initial_snapshot_publish_plan", "result.decision.snapshot_publish_plan is required for replay auditability", "result.decision.snapshot_publish_plan"));
  }

  if (reuseIssues.length > 0) {
    return replayBlockedResult(reuseIssues, { workflowState: artifact.input.workflow_state });
  }

  return {
    status: "ready",
    phase: "scheduler_continuation",
    should_continue: true,
    issues: [],
    blockers: [],
    workflow_state: null,
    continuation_input: continuationInputFromProjection(
      artifact.input,
      artifact.result.closeout.workflow_state,
      artifact.result.projection
    ),
    context_pack_seed: artifact.result.next_decision.context_pack_seed,
    snapshot_publish_plan: artifact.result.next_decision.snapshot_publish_plan,
    next_decision: artifact.result.next_decision
  };
}

async function runAutonomousCloseoutLoop(input = {}, options = {}) {
  if (!isObject(input)) {
    return {
      status: "fail",
      phase: "input",
      issues: [issue("invalid_autonomous_loop_input", "autonomous loop input must be an object", "")]
    };
  }

  const decision = decideContinuation(input);
  if (!decision.should_continue) {
    return {
      status: "fail",
      phase: "continuation",
      issues: decision.validation?.issues || [],
      decision
    };
  }
  if (!decision.snapshot_publish_plan) {
    return {
      status: "fail",
      phase: "snapshot_publish_plan",
      issues: decision.snapshot_publish_issues || [issue("missing_snapshot_publish_plan", "snapshot_publish_plan is required", "snapshot_publish_plan")],
      decision
    };
  }

  // Pass full context to closeout for projection validation
  const closeout = await runCloseoutPlan({
    snapshot_publish_plan: decision.snapshot_publish_plan,
    model_plan: input?.model_plan,
    project_status: input?.project_status
  }, options.closeout || options);
  if (closeout.status !== "created") {
    return {
      status: "fail",
      phase: "closeout",
      issues: closeout.issues || [],
      decision,
      closeout
    };
  }

  const projection = createWorkbenchProjection(closeout.workflow_state);
  const nextDecision = decideContinuation(continuationInputFromProjection(input, closeout.workflow_state, projection));

  // NEW: Governance gate check before continuation
  const selectedPackages = nextDecision.context_pack_seed?.selected_work_packages || [];
  if (selectedPackages.length > 0 && nextDecision.should_continue) {
    const govResult = evaluateWorkPackageExecutionGovernance({ selected_work_packages: selectedPackages });
    if (govResult.status !== "pass") {
      return {
        status: "fail",
        phase: "work_package_execution_governance",
        issues: govResult.issues,
        decision,
        closeout,
        projection,
        next_decision: nextDecision
      };
    }
  }

  return {
    status: nextDecision.should_continue ? "pass" : "fail",
    phase: nextDecision.should_continue ? "next_continuation" : "next_continuation_blocked",
    issues: nextDecision.should_continue ? [] : nextDecision.validation?.issues || [],
    decision,
    closeout,
    projection,
    next_decision: nextDecision
  };
}

const DEFAULT_MAX_CONTINUATION_ITERATIONS = 5;
const MAX_CONTINUATION_ITERATIONS_HARD_CAP = 25;

function normalizeMaxIterations(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_CONTINUATION_ITERATIONS;
  if (parsed > MAX_CONTINUATION_ITERATIONS_HARD_CAP) return MAX_CONTINUATION_ITERATIONS_HARD_CAP;
  return parsed;
}

async function runAutonomousContinuationCycle(input = {}, options = {}) {
  if (!isObject(input)) {
    return {
      status: "fail",
      phase: "input",
      stop_reason: "invalid_input",
      iterations: [],
      total_iterations: 0,
      last_result: null,
      issues: [issue("invalid_autonomous_cycle_input", "autonomous cycle input must be an object", "")]
    };
  }

  const maxIterations = normalizeMaxIterations(options.max_iterations ?? options.maxIterations);
  const iterations = [];
  let currentInput = input;
  let lastResult = null;
  let stopReason = "max_iterations_reached";

  for (let i = 0; i < maxIterations; i += 1) {
    // NEW: Check for hard-exit blockers at the start of each iteration
    if (shouldHardExit(currentInput.project_status?.blockers)) {
      stopReason = "blocked_by_hard_exit";
      break;
    }

    // Phase 1: Closeout and decision
    const closeoutResult = await runAutonomousCloseoutLoop(currentInput, options);
    
    if (closeoutResult.status !== "pass") {
      stopReason = "iteration_failed";
      lastResult = closeoutResult;
      iterations.push({
        iteration: i + 1,
        status: closeoutResult.status,
        phase: closeoutResult.phase,
        next_should_continue: false
      });
      break;
    }

    // Scheduler is external; work package execution is tracked via manifest

    // Phase 3: NEW - Update ProjectStatus based on manifest work_packages status
    currentInput = updateProjectStatusFromExecution(currentInput, closeoutResult);

    // Check continuation decision
    if (!closeoutResult.next_decision?.should_continue) {
      stopReason = "no_continuation_required";
      lastResult = closeoutResult;
      break;
    }

    if (!isObject(closeoutResult.closeout?.workflow_state) || !isObject(closeoutResult.projection)) {
      stopReason = "missing_projection_state";
      break;
    }

    // Prepare next iteration input
    currentInput = continuationInputFromProjection(
      currentInput,
      closeoutResult.closeout.workflow_state,
      closeoutResult.projection
    );

    lastResult = closeoutResult;
    iterations.push({
      iteration: i + 1,
      status: "pass",
      phase: "dispatch_and_closeout",
      next_should_continue: true
    });
  }

  return {
    status: lastResult?.status === "pass" ? "pass" : "fail",
    phase: stopReason,
    stop_reason: stopReason,
    iterations,
    total_iterations: iterations.length,
    max_iterations: maxIterations,
    last_result: lastResult,
    issues: stopReason === "iteration_failed" ? (lastResult?.issues || []) : []
  };
}
export {
  AUTONOMOUS_LOOP_ARTIFACT_VERSION,
  DEFAULT_MAX_CONTINUATION_ITERATIONS,
  MAX_CONTINUATION_ITERATIONS_HARD_CAP,
  createAutonomousLoopRunArtifact,
  prepareAutonomousContinuationFromLoopArtifact,
  recordReplayValidationBlocker,
  runAutonomousCloseoutLoop,
  runAutonomousContinuationCycle,
  validateAutonomousLoopRunArtifact
};
