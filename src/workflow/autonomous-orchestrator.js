import { decideContinuation } from "./autonomous-continuation.js";
import { runCloseoutPlan } from "./closeout-runner.js";
import { createWorkbenchProjection } from "./workbench-projection.js";

function issue(code, message, path) {
  return { code, message, path };
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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

export { runAutonomousCloseoutLoop };
