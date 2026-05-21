import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createWorkbenchProjection } from "../src/workflow/workbench-projection.js";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("current session workbench fixture is generated from durable input", () => {
  const input = readJson("docs/examples/current-session-workbench-input.json");
  const expectedProjection = readJson("docs/examples/current-session-workbench-projection.json");
  const projection = createWorkbenchProjection(input);

  assert.deepEqual(projection, expectedProjection);
  assert.equal(projection.projection_version, "workbench.v1");
  assert.equal(projection.status, "rerun");
  assert.equal(projection.model_routing.selected_model, "gpt");
  assert.equal(projection.reviewer_gate.recommended_decision_signal, "rerun");
  assert.equal(projection.operator_events.status, "pass");
  assert.equal(projection.operator_events.applied_run_events, 1);
  assert.equal(projection.manifest.event_count, 5);
  assert.equal(projection.one_screen.counters.artifacts, 5);
  assert.equal(projection.reviewer_provider_health.provider_health, "healthy");
  assert.equal(projection.reviewer_provider_health.next_action, "rerun_without_tools");
  assert.equal(projection.reviewer_scope_split.shard_count, 2);
  assert.equal(projection.reviewer_scope_split.next_shard, "reviewer-scope-shard-001");
});
