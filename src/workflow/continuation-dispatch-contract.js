// Module boundary contract: autonomous-continuation → scheduler-dispatch-plan
//
// Validates the shape decideContinuation() produces matches what createSchedulerDispatchPlan() consumes.
// This prevents "upstream adds/renames a field, downstream silently breaks" drift.
//
// Design: validates next_work_packages array shape (action, id, depends_on fields).
// Following the proven pattern from api-route-contract.js.

function issue(code, message, path) {
  return { code, message, path };
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeString(value) {
  return String(value || "").trim();
}

// Known work package action types that createSchedulerDispatchPlan() filters for
const KNOWN_SCHEDULER_ACTIONS = new Set([
  "run_reviewer_scope_shard",
  "cleanup_agent_lifecycle_pool"
]);

// Extract the shape of a continuation decision that createSchedulerDispatchPlan() reads.
// createSchedulerDispatchPlan() at scheduler-dispatch-plan.js:67 reads:
//   - decision.next_work_packages (array, filtered by action type)
//   - Full decision object can be passed (it extracts next_work_packages)
export function extractContinuationDispatchShape(decision) {
  if (!isObject(decision)) return null;
  return {
    next_work_packages: decision.next_work_packages,
    should_continue: decision.should_continue,
    action: decision.action,
    status: decision.status
  };
}

// Validate that a continuation decision satisfies the scheduler-dispatch-plan contract.
// Returns { status: "pass"|"fail", issues: [{code, message, path}] }.
export function validateContinuationDispatchContract(decision) {
  const issues = [];

  if (!isObject(decision)) {
    return {
      status: "fail",
      issues: [issue("invalid_decision_type", "continuation decision must be an object", "")]
    };
  }

  // next_work_packages is REQUIRED and must be an array
  if (!Array.isArray(decision.next_work_packages)) {
    issues.push(issue(
      "missing_or_invalid_next_work_packages",
      "decision must have next_work_packages array",
      "next_work_packages"
    ));
    // Can't validate further without an array
    return {
      status: "fail",
      issues
    };
  }

  // Validate each work package in the array
  decision.next_work_packages.forEach((pkg, index) => {
    if (!isObject(pkg)) {
      issues.push(issue(
        "invalid_work_package_type",
        `work_package[${index}] must be an object`,
        `next_work_packages[${index}]`
      ));
      return;
    }

    // action is REQUIRED for scheduler filtering
    const action = normalizeString(pkg.action);
    if (!action) {
      issues.push(issue(
        "missing_work_package_action",
        `work_package[${index}] must have action field`,
        `next_work_packages[${index}].action`
      ));
    }

    // id is REQUIRED for dependency tracking
    const id = normalizeString(pkg.id);
    if (!id) {
      issues.push(issue(
        "missing_work_package_id",
        `work_package[${index}] must have id field`,
        `next_work_packages[${index}].id`
      ));
    }

    // depends_on must be an array if present
    if (pkg.depends_on !== undefined && pkg.depends_on !== null && !Array.isArray(pkg.depends_on)) {
      issues.push(issue(
        "invalid_depends_on_type",
        `work_package[${index}].depends_on must be an array if present`,
        `next_work_packages[${index}].depends_on`
      ));
    }

    // Validate depends_on references (if present)
    if (Array.isArray(pkg.depends_on)) {
      pkg.depends_on.forEach((depId, depIndex) => {
        if (!normalizeString(depId)) {
          issues.push(issue(
            "invalid_dependency_id",
            `work_package[${index}].depends_on[${depIndex}] must be a non-empty string`,
            `next_work_packages[${index}].depends_on[${depIndex}]`
          ));
        }
      });
    }
  });

  return {
    status: issues.length > 0 ? "fail" : "pass",
    issues
  };
}
