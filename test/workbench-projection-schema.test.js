import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createMobileWorkbenchProjection } from "../src/workflow/workbench-projection.js";
import {
  assertWorkbenchProjectionSchema,
  validateWorkbenchProjectionSchema
} from "../src/workflow/workbench-projection-schema.js";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("validates current PC workbench projection fixture", () => {
  const projection = readJson("docs/examples/current-session-workbench-projection.json");
  const validation = assertWorkbenchProjectionSchema(projection);

  assert.equal(validation.status, "pass");
});

test("validates mobile projection schema", () => {
  const input = readJson("docs/examples/current-session-workbench-input.json");
  const mobileProjection = createMobileWorkbenchProjection(input);
  const validation = validateWorkbenchProjectionSchema(mobileProjection);

  assert.equal(validation.status, "pass");
});

test("rejects projection with missing durable sections", () => {
  const projection = {
    projection_version: "workbench.v1",
    run_id: "run",
    cycle_id: "cycle",
    goal: "goal",
    status: "pass",
    decision: "pass",
    generated_at: "2026-05-21T00:00:00.000Z",
    reasons: [],
    blockers: []
  };
  const validation = validateWorkbenchProjectionSchema(projection);

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some((issue) => issue.code === "missing_object_field" && issue.path === "manifest"));
  assert.ok(validation.issues.some((issue) => issue.code === "missing_object_field" && issue.path === "model_routing"));
});

test("rejects unknown status and projection version", () => {
  const validation = validateWorkbenchProjectionSchema({
    projection_version: "workbench.v9",
    status: "unknown"
  });

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some((issue) => issue.code === "invalid_projection_version"));
  assert.ok(validation.issues.some((issue) => issue.code === "invalid_projection_status"));
});

test("rejects projections missing lifecycle heartbeat and timeout readout", () => {
  const projection = readJson("docs/examples/current-session-workbench-projection.json");
  const mobileProjection = createMobileWorkbenchProjection(readJson("docs/examples/current-session-workbench-input.json"));
  delete projection.agent_lifecycle_pool.timed_out;
  delete mobileProjection.agent_lifecycle_pool.heartbeat_count;

  const pcValidation = validateWorkbenchProjectionSchema(projection);
  const mobileValidation = validateWorkbenchProjectionSchema(mobileProjection);

  assert.equal(pcValidation.status, "fail");
  assert.ok(pcValidation.issues.some((issue) => issue.code === "missing_required_field" && issue.path === "agent_lifecycle_pool.timed_out"));
  assert.equal(mobileValidation.status, "fail");
  assert.ok(mobileValidation.issues.some((issue) => issue.code === "missing_required_field" && issue.path === "agent_lifecycle_pool.heartbeat_count"));
});
