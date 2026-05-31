import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  extractContinuationCloseoutShape,
  validateContinuationCloseoutContract
} from "../src/workflow/continuation-closeout-contract.js";
import { decideContinuation } from "../src/workflow/autonomous-continuation.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

// T1 — live contract: a well-formed decision object passes the closeout contract.
// This tests the contract shape itself, not decideContinuation()'s complex logic.
test("continuation-closeout contract: well-formed decision passes validation", () => {
  const wellFormedDecision = {
    status: "pass",
    action: "continue",
    should_continue: true,
    snapshot_publish_plan: {
      action: "publish_workbench_snapshot",
      endpoint: "/api/workbench/snapshots",
      id: "test-snapshot",
      input: { manifest: { run_id: "test" } }
    },
    model_plan: { model: "test-model" },
    project_status: { project: "ai-control-platform" },
    next_work_packages: [],
    blockers: []
  };

  const validation = validateContinuationCloseoutContract(wellFormedDecision);

  assert.equal(validation.status, "pass",
    `well-formed decision failed contract:\n${JSON.stringify(validation.issues, null, 2)}`);
});

// T2 — shape extraction: verify the extractor pulls the expected fields.
test("continuation-closeout contract: extractContinuationCloseoutShape extracts expected fields", () => {
  const decision = {
    status: "pass",
    action: "continue",
    should_continue: true,
    snapshot_publish_plan: { action: "publish_workbench_snapshot", input: {} },
    model_plan: { model: "test" },
    project_status: { project: "ai-control-platform" },
    next_work_packages: [],
    blockers: [],
    // Extra fields that closeout-runner doesn't read
    next_step: "some step",
    validation: { status: "pass" }
  };

  const shape = extractContinuationCloseoutShape(decision);

  assert.ok(shape, "extractor should return a shape object");
  assert.ok("snapshot_publish_plan" in shape, "shape must include snapshot_publish_plan");
  assert.ok("model_plan" in shape, "shape must include model_plan");
  assert.ok("project_status" in shape, "shape must include project_status");
  assert.equal(Object.keys(shape).length, 3, "shape should only include the 3 fields closeout reads");
});

// T3 — missing required field: snapshot_publish_plan is required.
test("continuation-closeout contract: missing snapshot_publish_plan fails", () => {
  const decision = {
    status: "pass",
    action: "continue",
    model_plan: { model: "test" },
    project_status: { project: "ai-control-platform" }
    // snapshot_publish_plan is missing
  };

  const validation = validateContinuationCloseoutContract(decision);

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some(i => i.code === "missing_snapshot_publish_plan"));
});

// T4 — invalid snapshot action: snapshot_publish_plan.action must be "publish_workbench_snapshot".
test("continuation-closeout contract: wrong snapshot_publish_plan.action fails", () => {
  const decision = {
    status: "pass",
    snapshot_publish_plan: {
      action: "wrong_action", // should be "publish_workbench_snapshot"
      input: {}
    }
  };

  const validation = validateContinuationCloseoutContract(decision);

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some(i => i.code === "invalid_snapshot_action"));
});

// T5 — invalid optional field types: model_plan and project_status must be objects if present.
test("continuation-closeout contract: invalid optional field types fail", () => {
  const decision1 = {
    snapshot_publish_plan: { action: "publish_workbench_snapshot", input: {} },
    model_plan: "not an object" // should be object
  };

  const validation1 = validateContinuationCloseoutContract(decision1);
  assert.equal(validation1.status, "fail");
  assert.ok(validation1.issues.some(i => i.code === "invalid_model_plan_type"));

  const decision2 = {
    snapshot_publish_plan: { action: "publish_workbench_snapshot", input: {} },
    project_status: ["not", "an", "object"] // should be object
  };

  const validation2 = validateContinuationCloseoutContract(decision2);
  assert.equal(validation2.status, "fail");
  assert.ok(validation2.issues.some(i => i.code === "invalid_project_status_type"));
});

// T6 — valid with optional fields: optional fields can be omitted or null.
test("continuation-closeout contract: optional fields can be omitted or null", () => {
  const decision1 = {
    snapshot_publish_plan: { action: "publish_workbench_snapshot", input: {} }
    // model_plan and project_status omitted
  };

  const validation1 = validateContinuationCloseoutContract(decision1);
  assert.equal(validation1.status, "pass");

  const decision2 = {
    snapshot_publish_plan: { action: "publish_workbench_snapshot", input: {} },
    model_plan: null,
    project_status: null
  };

  const validation2 = validateContinuationCloseoutContract(decision2);
  assert.equal(validation2.status, "pass");
});

// T7 — invalid decision type: decision must be an object.
test("continuation-closeout contract: non-object decision fails", () => {
  const validation1 = validateContinuationCloseoutContract(null);
  assert.equal(validation1.status, "fail");
  assert.ok(validation1.issues.some(i => i.code === "invalid_decision_type"));

  const validation2 = validateContinuationCloseoutContract("not an object");
  assert.equal(validation2.status, "fail");
  assert.ok(validation2.issues.some(i => i.code === "invalid_decision_type"));
});
