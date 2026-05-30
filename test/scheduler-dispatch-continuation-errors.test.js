import assert from "node:assert/strict";
import test from "node:test";
import {
  recordSchedulerDispatchContinuationPrepared,
  recordSchedulerNextCycleEnqueue
} from "../src/workflow/scheduler-dispatch-continuation.js";

// Error-branch coverage for the two durable-fact recorders in scheduler-dispatch-continuation.js
// (baseline 35.44% branch — its fail branches at lines 142/151/160 and 230/236/245/254 were
// uncovered). These guard durable workflow facts, so each rejection path is a real invariant
// worth pinning. All branches are reachable with plain (pure) input — no subprocess/fs needed.

const validState = { manifest: { run_id: "run-1", cycle_id: "cycle-1" } };

// ---- recordSchedulerDispatchContinuationPrepared fail branches ----------------------------

test("recordSchedulerDispatchContinuationPrepared: non-object workflow state is rejected", () => {
  // Note: `undefined` hits the `= {}` default param and falls through to the identity check,
  // so it is NOT an invalid_workflow_state case — only genuinely non-object values are.
  for (const bad of [null, "x", 42, []]) {
    const r = recordSchedulerDispatchContinuationPrepared(bad, { status: "ready" });
    assert.equal(r.status, "fail");
    assert.equal(r.issues[0].code, "invalid_workflow_state");
  }
});

test("recordSchedulerDispatchContinuationPrepared: missing run_id/cycle_id is rejected", () => {
  const r = recordSchedulerDispatchContinuationPrepared({ manifest: { run_id: "run-1" } }, { status: "ready" });
  assert.equal(r.status, "fail");
  assert.equal(r.issues[0].code, "missing_workflow_identity");
});

test("recordSchedulerDispatchContinuationPrepared: identity mismatch with prepared is rejected", () => {
  const r = recordSchedulerDispatchContinuationPrepared(validState, {
    status: "ready",
    scheduler_dispatch: { run_id: "run-OTHER", cycle_id: "cycle-1" }
  });
  assert.equal(r.status, "fail");
  assert.equal(r.issues[0].code, "scheduler_continuation_identity_mismatch");
});

test("recordSchedulerDispatchContinuationPrepared: a matching ready prepared passes and records a durable fact", () => {
  const r = recordSchedulerDispatchContinuationPrepared(validState, {
    status: "ready",
    scheduler_dispatch: { run_id: "run-1", cycle_id: "cycle-1" }
  }, { created_at: "2026-05-31T00:00:00Z" });
  assert.equal(r.status, "pass");
  assert.equal(r.artifact.status, "pass");
  assert.equal(r.fact.run_id, "run-1");
});

// ---- recordSchedulerNextCycleEnqueue fail branches ----------------------------------------

test("recordSchedulerNextCycleEnqueue: non-object workflow state is rejected", () => {
  const r = recordSchedulerNextCycleEnqueue(null, { status: "ready" });
  assert.equal(r.status, "fail");
  assert.equal(r.issues[0].code, "invalid_workflow_state");
});

test("recordSchedulerNextCycleEnqueue: only a ready continuation can be enqueued", () => {
  const r = recordSchedulerNextCycleEnqueue(validState, { status: "blocked" });
  assert.equal(r.status, "fail");
  assert.equal(r.issues[0].code, "scheduler_continuation_not_ready");
});

test("recordSchedulerNextCycleEnqueue: missing run_id/cycle_id is rejected", () => {
  const r = recordSchedulerNextCycleEnqueue({ manifest: { cycle_id: "cycle-1" } }, { status: "ready" });
  assert.equal(r.status, "fail");
  assert.equal(r.issues[0].code, "missing_workflow_identity");
});

test("recordSchedulerNextCycleEnqueue: enqueue identity mismatch is rejected", () => {
  const r = recordSchedulerNextCycleEnqueue(validState, {
    status: "ready",
    scheduler_dispatch: { run_id: "run-1", cycle_id: "cycle-OTHER" }
  });
  assert.equal(r.status, "fail");
  assert.equal(r.issues[0].code, "scheduler_enqueue_identity_mismatch");
});
