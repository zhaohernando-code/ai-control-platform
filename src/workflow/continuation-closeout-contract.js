// Module boundary contract: autonomous-continuation → closeout-runner
//
// Validates the shape decideContinuation() produces matches what runCloseoutPlan() consumes.
// This prevents "upstream adds/renames a field, downstream silently breaks" drift.
//
// Design: shape validation (field presence + types), not value validation. Following the
// proven pattern from api-route-contract.js (門禁治理 phase 3) — zero mutation of the
// producer/consumer modules, extract and validate actual shapes, fail-closed on missing fields.

function issue(code, message, path) {
  return { code, message, path };
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

// Extract the subset of decideContinuation() output that runCloseoutPlan() actually reads.
// runCloseoutPlan() at closeout-runner.js:276 reads:
//   - input.snapshot_publish_plan (required, passed to executeSnapshotPublishPlan)
//   - input.model_plan (optional, passed to enrichedOptions)
//   - input.project_status (optional, passed to enrichedOptions)
// All other fields in the decision object are ignored by closeout-runner.
export function extractContinuationCloseoutShape(decision) {
  if (!isObject(decision)) return null;
  return {
    snapshot_publish_plan: decision.snapshot_publish_plan,
    model_plan: decision.model_plan,
    project_status: decision.project_status
  };
}

// Validate that a continuation decision satisfies the closeout-runner contract.
// Returns { status: "pass"|"fail", issues: [{code, message, path}] }.
export function validateContinuationCloseoutContract(decision) {
  const issues = [];

  if (!isObject(decision)) {
    return {
      status: "fail",
      issues: [issue("invalid_decision_type", "continuation decision must be an object", "")]
    };
  }

  // snapshot_publish_plan is REQUIRED by runCloseoutPlan (returns fail if missing)
  if (!decision.snapshot_publish_plan) {
    issues.push(issue(
      "missing_snapshot_publish_plan",
      "closeout requires snapshot_publish_plan",
      "snapshot_publish_plan"
    ));
  } else {
    // Must be an object with action: "publish_workbench_snapshot"
    if (!isObject(decision.snapshot_publish_plan)) {
      issues.push(issue(
        "invalid_snapshot_publish_plan_type",
        "snapshot_publish_plan must be an object",
        "snapshot_publish_plan"
      ));
    } else if (decision.snapshot_publish_plan.action !== "publish_workbench_snapshot") {
      issues.push(issue(
        "invalid_snapshot_action",
        'snapshot_publish_plan.action must be "publish_workbench_snapshot"',
        "snapshot_publish_plan.action"
      ));
    }
  }

  // model_plan is OPTIONAL but must be an object if present (passed to enrichedOptions)
  if (decision.model_plan !== undefined && decision.model_plan !== null) {
    if (!isObject(decision.model_plan)) {
      issues.push(issue(
        "invalid_model_plan_type",
        "model_plan must be an object if provided",
        "model_plan"
      ));
    }
  }

  // project_status is OPTIONAL but must be an object if present (passed to enrichedOptions)
  if (decision.project_status !== undefined && decision.project_status !== null) {
    if (!isObject(decision.project_status)) {
      issues.push(issue(
        "invalid_project_status_type",
        "project_status must be an object if provided",
        "project_status"
      ));
    }
  }

  return {
    status: issues.length > 0 ? "fail" : "pass",
    issues
  };
}
