import assert from "node:assert/strict";
import test from "node:test";
import {
  extractContinuationDispatchShape,
  validateContinuationDispatchContract
} from "../src/workflow/continuation-dispatch-contract.js";

// T1 — live contract: a well-formed decision with work packages passes validation.
test("continuation-dispatch contract: well-formed decision with work packages passes", () => {
  const wellFormedDecision = {
    status: "pass",
    action: "continue",
    should_continue: true,
    next_work_packages: [
      {
        id: "pkg-1",
        action: "run_reviewer_scope_shard",
        depends_on: [],
        owned_files: ["src/"]
      },
      {
        id: "pkg-2",
        action: "cleanup_agent_lifecycle_pool",
        depends_on: ["pkg-1"],
        owned_files: []
      }
    ]
  };

  const validation = validateContinuationDispatchContract(wellFormedDecision);

  assert.equal(validation.status, "pass",
    `well-formed decision failed contract:\n${JSON.stringify(validation.issues, null, 2)}`);
});

// T2 — shape extraction: verify the extractor pulls the expected fields.
test("continuation-dispatch contract: extractContinuationDispatchShape extracts expected fields", () => {
  const decision = {
    status: "pass",
    action: "continue",
    should_continue: true,
    next_work_packages: [
      { id: "pkg-1", action: "run_reviewer_scope_shard", depends_on: [] }
    ],
    // Extra fields that createSchedulerDispatchPlan doesn't read
    blockers: [],
    next_step: "some step",
    snapshot_publish_plan: null
  };

  const shape = extractContinuationDispatchShape(decision);

  assert.ok(shape, "extractor should return a shape object");
  assert.ok("next_work_packages" in shape, "shape must include next_work_packages");
  assert.ok("should_continue" in shape, "shape must include should_continue");
  assert.ok("action" in shape, "shape must include action");
  assert.ok("status" in shape, "shape must include status");
});

// T3 — missing required field: next_work_packages array is required.
test("continuation-dispatch contract: missing next_work_packages fails", () => {
  const decision = {
    status: "pass",
    action: "continue",
    should_continue: true
    // next_work_packages is missing
  };

  const validation = validateContinuationDispatchContract(decision);

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some(i => i.code === "missing_or_invalid_next_work_packages"));
});

// T4 — work package without action: action field is required.
test("continuation-dispatch contract: work package without action fails", () => {
  const decision = {
    status: "pass",
    next_work_packages: [
      {
        id: "pkg-1",
        // action is missing
        depends_on: []
      }
    ]
  };

  const validation = validateContinuationDispatchContract(decision);

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some(i => i.code === "missing_work_package_action"));
});

// T5 — work package without id: id field is required.
test("continuation-dispatch contract: work package without id fails", () => {
  const decision = {
    status: "pass",
    next_work_packages: [
      {
        // id is missing
        action: "run_reviewer_scope_shard",
        depends_on: []
      }
    ]
  };

  const validation = validateContinuationDispatchContract(decision);

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some(i => i.code === "missing_work_package_id"));
});

// T6 — invalid depends_on type: depends_on must be an array if present.
test("continuation-dispatch contract: invalid depends_on type fails", () => {
  const decision = {
    status: "pass",
    next_work_packages: [
      {
        id: "pkg-1",
        action: "run_reviewer_scope_shard",
        depends_on: "not-an-array" // should be array
      }
    ]
  };

  const validation = validateContinuationDispatchContract(decision);

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some(i => i.code === "invalid_depends_on_type"));
});

// T7 — invalid dependency id: depends_on entries must be non-empty strings.
test("continuation-dispatch contract: empty dependency id fails", () => {
  const decision = {
    status: "pass",
    next_work_packages: [
      {
        id: "pkg-1",
        action: "run_reviewer_scope_shard",
        depends_on: ["", "valid-id"] // first entry is empty
      }
    ]
  };

  const validation = validateContinuationDispatchContract(decision);

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some(i => i.code === "invalid_dependency_id"));
});

// T8 — empty work packages array: empty array is valid (no dispatchable work).
test("continuation-dispatch contract: empty next_work_packages array is valid", () => {
  const decision = {
    status: "pass",
    action: "continue",
    next_work_packages: [] // empty is valid
  };

  const validation = validateContinuationDispatchContract(decision);

  assert.equal(validation.status, "pass");
});

// T9 — optional depends_on: depends_on can be omitted or null.
test("continuation-dispatch contract: optional depends_on can be omitted or null", () => {
  const decision1 = {
    status: "pass",
    next_work_packages: [
      {
        id: "pkg-1",
        action: "run_reviewer_scope_shard"
        // depends_on omitted
      }
    ]
  };

  const validation1 = validateContinuationDispatchContract(decision1);
  assert.equal(validation1.status, "pass");

  const decision2 = {
    status: "pass",
    next_work_packages: [
      {
        id: "pkg-1",
        action: "run_reviewer_scope_shard",
        depends_on: null
      }
    ]
  };

  const validation2 = validateContinuationDispatchContract(decision2);
  assert.equal(validation2.status, "pass");
});

// T10 — non-object decision: decision must be an object.
test("continuation-dispatch contract: non-object decision fails", () => {
  const validation1 = validateContinuationDispatchContract(null);
  assert.equal(validation1.status, "fail");
  assert.ok(validation1.issues.some(i => i.code === "invalid_decision_type"));

  const validation2 = validateContinuationDispatchContract("not an object");
  assert.equal(validation2.status, "fail");
  assert.ok(validation2.issues.some(i => i.code === "invalid_decision_type"));
});

// T11 — non-object work package: work packages must be objects.
test("continuation-dispatch contract: non-object work package fails", () => {
  const decision = {
    status: "pass",
    next_work_packages: [
      "not an object" // should be object
    ]
  };

  const validation = validateContinuationDispatchContract(decision);

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some(i => i.code === "invalid_work_package_type"));
});

// T12 — multiple work packages: validates all packages in the array.
test("continuation-dispatch contract: validates all work packages in array", () => {
  const decision = {
    status: "pass",
    next_work_packages: [
      {
        id: "pkg-1",
        action: "run_reviewer_scope_shard",
        depends_on: []
      },
      {
        // pkg-2 is missing id
        action: "cleanup_agent_lifecycle_pool",
        depends_on: []
      },
      {
        id: "pkg-3",
        // pkg-3 is missing action
        depends_on: []
      }
    ]
  };

  const validation = validateContinuationDispatchContract(decision);

  assert.equal(validation.status, "fail");
  // Should have issues for both pkg-2 (missing id) and pkg-3 (missing action)
  const missingIdIssues = validation.issues.filter(i => i.code === "missing_work_package_id");
  const missingActionIssues = validation.issues.filter(i => i.code === "missing_work_package_action");
  assert.equal(missingIdIssues.length, 1, "should have 1 missing id issue");
  assert.equal(missingActionIssues.length, 1, "should have 1 missing action issue");
});
