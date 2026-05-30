import assert from "node:assert/strict";
import test from "node:test";

import {
  separateProjectStatus,
  durableProjectStatus,
  hasDerivedStatusFields,
  DERIVED_STATUS_FIELDS,
  DURABLE_STATUS_FIELDS
} from "../src/workflow/project-status-fields.js";

const sample = {
  project: "ai-control-platform",
  current_phase: "closeout",
  global_goals: [{ id: "g1" }],
  blockers: [],
  next_step: "ship",
  updated_at: "2026-05-30T00:00:00.000Z",
  latest_update: "ran probe",
  latest_public_live_route_probe: { route_url: "https://x", captured_at: "2026-05-30T00:00:00.000Z" },
  workbench_live_route_evidence: { status: "pass" }
};

test("separateProjectStatus splits derived runtime fields from durable intent", () => {
  const { durable, derived } = separateProjectStatus(sample);
  assert.equal(durable.project, "ai-control-platform");
  assert.equal(durable.current_phase, "closeout");
  assert.deepEqual(durable.global_goals, [{ id: "g1" }]);
  assert.equal("updated_at" in durable, false, "timestamp is derived, not durable");
  assert.equal("latest_public_live_route_probe" in durable, false, "probe evidence is derived");
  assert.equal(derived.updated_at, "2026-05-30T00:00:00.000Z");
  assert.ok(derived.workbench_live_route_evidence);
});

test("durableProjectStatus drops all derived fields (what gets committed)", () => {
  const durable = durableProjectStatus(sample);
  for (const f of DERIVED_STATUS_FIELDS) assert.equal(f in durable, false, `${f} must not be committed`);
});

test("unknown/new fields are preserved as durable (fail-safe, never dropped)", () => {
  const { durable, derived } = separateProjectStatus({ brand_new_intent_field: 42 });
  assert.equal(durable.brand_new_intent_field, 42, "unknown field kept as intent");
  assert.equal(Object.keys(derived).length, 0);
});

test("hasDerivedStatusFields detects log-style churn fields", () => {
  assert.equal(hasDerivedStatusFields(sample), true);
  assert.equal(hasDerivedStatusFields(durableProjectStatus(sample)), false, "durable view is clean");
  assert.equal(hasDerivedStatusFields({ project: "p", global_goals: [] }), false);
});

test("the two field lists do not overlap", () => {
  const derivedSet = new Set(DERIVED_STATUS_FIELDS);
  for (const f of DURABLE_STATUS_FIELDS) assert.equal(derivedSet.has(f), false, `${f} cannot be both durable and derived`);
});

test("separateProjectStatus does not mutate its input", () => {
  const input = { project: "p", updated_at: "t" };
  separateProjectStatus(input);
  assert.deepEqual(Object.keys(input).sort(), ["project", "updated_at"]);
});
