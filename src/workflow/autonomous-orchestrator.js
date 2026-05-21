import { decideContinuation } from "./autonomous-continuation.js";
import { runCloseoutPlan } from "./closeout-runner.js";
import { createWorkbenchProjection } from "./workbench-projection.js";
import { validateWorkbenchProjectionSchema } from "./workbench-projection-schema.js";

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

function continuationInputFromProjection(input, workflowState, projection) {
  return {
    project_status: input.next_project_status || input.nextProjectStatus || input.project_status || input.projectStatus,
    run_evaluation: {
      status: projection.status,
      decision: projection.decision,
      blockers: projection.blockers,
      projection
    },
    workflow_state: workflowState
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

  const closeout = await runCloseoutPlan({ snapshot_publish_plan: decision.snapshot_publish_plan }, options.closeout || options);
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

export {
  AUTONOMOUS_LOOP_ARTIFACT_VERSION,
  createAutonomousLoopRunArtifact,
  runAutonomousCloseoutLoop,
  validateAutonomousLoopRunArtifact
};
