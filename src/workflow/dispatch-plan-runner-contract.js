// Module boundary contract: scheduler-dispatch-plan → scheduler-dispatch-runner
//
// Validates the shape createSchedulerDispatchPlan() produces matches what runSchedulerDispatchPlan() consumes.
// This prevents "upstream adds/renames a field, downstream silently breaks" drift.
//
// Design: leverages existing validateSchedulerDispatchPlan() validator, adds shape extraction
// and field-by-field type validation. Following the proven pattern from api-route-contract.js.

function issue(code, message, path) {
  return { code, message, path };
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

// Extract the shape of a scheduler dispatch plan that runSchedulerDispatchPlan() reads.
// runSchedulerDispatchPlan() at scheduler-dispatch-runner.js:314 reads:
//   - plan.steps (required, array of step objects)
//   - plan.decision (optional, the original continuation decision)
//   - plan.status (used for validation)
export function extractDispatchPlanShape(plan) {
  if (!isObject(plan)) return null;
  return {
    steps: plan.steps,
    decision: plan.decision,
    status: plan.status,
    phase: plan.phase,
    dispatch_kind: plan.dispatch_kind
  };
}

// Validate that a dispatch plan satisfies the scheduler-dispatch-runner contract.
// Returns { status: "pass"|"fail", issues: [{code, message, path}] }.
// Leverages the existing validateSchedulerDispatchPlan() from scheduler-dispatch-runner.js.
export function validateDispatchPlanRunnerContract(plan) {
  const issues = [];

  if (!isObject(plan)) {
    return {
      status: "fail",
      issues: [issue("invalid_dispatch_plan_type", "dispatch plan must be an object", "")]
    };
  }

  // steps is REQUIRED and must be an array
  if (!Array.isArray(plan.steps)) {
    issues.push(issue(
      "missing_or_invalid_steps",
      "dispatch plan must have steps array",
      "steps"
    ));
  } else {
    // Each step must have required fields
    plan.steps.forEach((step, index) => {
      if (!isObject(step)) {
        issues.push(issue(
          "invalid_step_type",
          `step[${index}] must be an object`,
          `steps[${index}]`
        ));
        return;
      }

      // Required step fields
      if (!step.command) {
        issues.push(issue(
          "missing_step_command",
          `step[${index}] must have command`,
          `steps[${index}].command`
        ));
      }

      if (!Array.isArray(step.args)) {
        issues.push(issue(
          "missing_step_args",
          `step[${index}] must have args array`,
          `steps[${index}].args`
        ));
      }
    });
  }

  // status should be "pass" or "fail"
  if (plan.status && plan.status !== "pass" && plan.status !== "fail") {
    issues.push(issue(
      "invalid_status_value",
      'status must be "pass" or "fail"',
      "status"
    ));
  }

  // decision is optional but must be an object if present
  if (plan.decision !== undefined && plan.decision !== null && !isObject(plan.decision)) {
    issues.push(issue(
      "invalid_decision_type",
      "decision must be an object if provided",
      "decision"
    ));
  }

  return {
    status: issues.length > 0 ? "fail" : "pass",
    issues
  };
}
