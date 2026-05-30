import assert from "node:assert/strict";
import test from "node:test";

import { createWorkbenchProjection } from "../src/workflow/workbench-projection.js";

// P0-3: createWorkbenchProjection must be a PURE function of its input — it returns a
// projection and mutates NONE of the objects passed in (manifest, artifact_ledger,
// operator_event_ledger, task_dag). The audit suspected projection performed in-place
// mutation; verified against code it does not (appendRunEvent/recordArtifact are pure),
// and these tests LOCK that so a future edit can't silently reintroduce a side effect.

function deepFreeze(obj) {
  if (obj && typeof obj === "object") {
    Object.values(obj).forEach(deepFreeze);
    Object.freeze(obj);
  }
  return obj;
}

function sampleInput() {
  return {
    manifest: {
      run_id: "run-1",
      cycle_id: "cycle-1",
      goal: "g",
      events: [{ id: "e1", type: "note", created_at: "2026-05-30T00:00:00.000Z" }],
      work_packages: [{ id: "wp1", status: "done" }]
    },
    artifact_ledger: {
      run_id: "run-1",
      cycle_id: "cycle-1",
      artifacts: [{ id: "a1", status: "pass", type: "patch", producer: "x" }]
    },
    operator_event_ledger: {
      version: "operator-events.v1",
      events: [{ id: "op1", type: "validate", run_id: "run-1", cycle_id: "cycle-1", created_at: "2026-05-30T00:01:00.000Z" }]
    }
  };
}

test("P0-3: projection does not mutate its input objects (deep-frozen input still works)", () => {
  const input = deepFreeze(sampleInput());
  // If projection mutated any input, this throws (frozen) — purity is enforced by Object.freeze.
  assert.doesNotThrow(() => createWorkbenchProjection(input));
});

test("P0-3: projection is deterministic — same input yields same output", () => {
  const a = createWorkbenchProjection(sampleInput());
  const b = createWorkbenchProjection(sampleInput());
  // strip any wall-clock fields if present, then compare structurally
  assert.deepEqual(a.project_management, b.project_management);
  assert.equal(a.status, b.status);
});

test("P0-3: input manifest.events array is not appended to in place", () => {
  const input = sampleInput();
  const before = input.manifest.events.length;
  createWorkbenchProjection(input);
  assert.equal(input.manifest.events.length, before, "operator-event ingestion must not mutate the caller's manifest.events");
  assert.equal(input.artifact_ledger.artifacts.length, 1, "must not mutate the caller's artifact ledger");
});
