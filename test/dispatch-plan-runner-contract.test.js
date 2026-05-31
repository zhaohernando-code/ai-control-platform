import assert from "node:assert/strict";
import test from "node:test";
import {
  extractDispatchPlanShape,
  validateDispatchPlanRunnerContract
} from "../src/workflow/dispatch-plan-runner-contract.js";
import { createSchedulerDispatchPlan } from "../src/workflow/scheduler-dispatch-plan.js";
import { validateSchedulerDispatchPlan } from "../src/workflow/scheduler-dispatch-runner.js";

// T1 — live contract: a well-formed dispatch plan passes validation.
test("dispatch-plan-runner contract: well-formed plan passes validation", () => {
  const wellFormedPlan = {
    status: "pass",
    phase: "scheduler_dispatch_plan",
    dispatch_kind: "reviewer_shard",
    steps: [
      {
        id: "step-1",
        command: "npm",
        args: ["run", "test"],
        depends_on: [],
        output_kind: "test_result",
        output_path: "/tmp/output.json"
      }
    ],
    decision: {
      status: "pass",
      action: "continue",
      next_work_packages: []
    }
  };

  const validation = validateDispatchPlanRunnerContract(wellFormedPlan);

  assert.equal(validation.status, "pass",
    `well-formed plan failed contract:\n${JSON.stringify(validation.issues, null, 2)}`);
});

// T2 — shape extraction: verify the extractor pulls the expected fields.
test("dispatch-plan-runner contract: extractDispatchPlanShape extracts expected fields", () => {
  const plan = {
    status: "pass",
    phase: "scheduler_dispatch_plan",
    dispatch_kind: "reviewer_shard",
    steps: [{ id: "step-1", command: "npm", args: ["test"] }],
    decision: { status: "pass" },
    // Extra fields that runner doesn't read
    issues: [],
    extra_field: "ignored"
  };

  const shape = extractDispatchPlanShape(plan);

  assert.ok(shape, "extractor should return a shape object");
  assert.ok("steps" in shape, "shape must include steps");
  assert.ok("decision" in shape, "shape must include decision");
  assert.ok("status" in shape, "shape must include status");
  assert.ok("phase" in shape, "shape must include phase");
  assert.ok("dispatch_kind" in shape, "shape must include dispatch_kind");
});

// T3 — missing required field: steps array is required.
test("dispatch-plan-runner contract: missing steps array fails", () => {
  const plan = {
    status: "pass",
    phase: "scheduler_dispatch_plan",
    decision: { status: "pass" }
    // steps is missing
  };

  const validation = validateDispatchPlanRunnerContract(plan);

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some(i => i.code === "missing_or_invalid_steps"));
});

// T4 — invalid step structure: steps must have command and args.
test("dispatch-plan-runner contract: step without command fails", () => {
  const plan = {
    status: "pass",
    steps: [
      {
        id: "step-1",
        // command is missing
        args: ["test"]
      }
    ]
  };

  const validation = validateDispatchPlanRunnerContract(plan);

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some(i => i.code === "missing_step_command"));
});

test("dispatch-plan-runner contract: step without args fails", () => {
  const plan = {
    status: "pass",
    steps: [
      {
        id: "step-1",
        command: "npm"
        // args is missing
      }
    ]
  };

  const validation = validateDispatchPlanRunnerContract(plan);

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some(i => i.code === "missing_step_args"));
});

// T5 — invalid status value: status must be "pass" or "fail".
test("dispatch-plan-runner contract: invalid status value fails", () => {
  const plan = {
    status: "unknown", // should be "pass" or "fail"
    steps: [{ id: "step-1", command: "npm", args: ["test"] }]
  };

  const validation = validateDispatchPlanRunnerContract(plan);

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some(i => i.code === "invalid_status_value"));
});

// T6 — optional decision field: decision can be omitted or null.
test("dispatch-plan-runner contract: optional decision can be omitted or null", () => {
  const plan1 = {
    status: "pass",
    steps: [{ id: "step-1", command: "npm", args: ["test"] }]
    // decision omitted
  };

  const validation1 = validateDispatchPlanRunnerContract(plan1);
  assert.equal(validation1.status, "pass");

  const plan2 = {
    status: "pass",
    steps: [{ id: "step-1", command: "npm", args: ["test"] }],
    decision: null
  };

  const validation2 = validateDispatchPlanRunnerContract(plan2);
  assert.equal(validation2.status, "pass");
});

// T7 — invalid decision type: decision must be an object if present.
test("dispatch-plan-runner contract: invalid decision type fails", () => {
  const plan = {
    status: "pass",
    steps: [{ id: "step-1", command: "npm", args: ["test"] }],
    decision: "not an object" // should be object
  };

  const validation = validateDispatchPlanRunnerContract(plan);

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some(i => i.code === "invalid_decision_type"));
});

// T8 — non-object plan: plan must be an object.
test("dispatch-plan-runner contract: non-object plan fails", () => {
  const validation1 = validateDispatchPlanRunnerContract(null);
  assert.equal(validation1.status, "fail");
  assert.ok(validation1.issues.some(i => i.code === "invalid_dispatch_plan_type"));

  const validation2 = validateDispatchPlanRunnerContract("not an object");
  assert.equal(validation2.status, "fail");
  assert.ok(validation2.issues.some(i => i.code === "invalid_dispatch_plan_type"));
});

// T9 — integration with existing validator: our contract should align with validateSchedulerDispatchPlan.
test("dispatch-plan-runner contract: aligns with existing validateSchedulerDispatchPlan", () => {
  // Use an allowed npm script from ALLOWED_NPM_SCRIPTS (run:reviewer-shard, etc.)
  const validPlan = {
    status: "pass",
    phase: "scheduler_dispatch_plan",
    dispatch_kind: "reviewer_shard",
    steps: [
      {
        id: "step-1",
        command: "npm",
        args: ["run", "run:reviewer-shard", "--", "--input", "/tmp/input.json", "--output", "/tmp/output.json"],
        depends_on: []
      }
    ],
    decision: { status: "pass" }
  };

  // Both validators should agree on valid plans
  const ourValidation = validateDispatchPlanRunnerContract(validPlan);
  const existingValidation = validateSchedulerDispatchPlan(validPlan);

  assert.equal(ourValidation.status, "pass", "our validator should pass");
  assert.equal(existingValidation.status, "pass", "existing validator should pass");
});
