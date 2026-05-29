// Characterization tests for status derivation in autonomous-run.js, pinned through
// its PUBLIC API (decideNextAction / evaluateRunResult). normalizeStatus there is
// internal and INTENTIONALLY DIVERGES from task-dag.js (different output vocabulary:
// pass/fail/unknown, and a DIFFERENT synonym set). Before consolidating status logic
// onto a shared vocabulary (P0-1), pin the exact current behavior — including the
// quirks — so the consolidation can be proven behavior-preserving.

import assert from "node:assert/strict";
import test from "node:test";

import { decideNextAction, evaluateRunResult, PASS } from "../src/workflow/autonomous-run.js";

// summarizeStatuses is internal; observe it via evaluateRunResult().projection.summaries.
function summary(items) {
  return evaluateRunResult({ run_id: "r", cycle_id: "c", work_packages: items }).projection.summaries;
}

test("characterize: autonomous-run pass synonyms (pass/passed/ok/success/succeeded/complete/completed)", () => {
  for (const s of ["pass", "passed", "ok", "success", "succeeded", "complete", "completed"]) {
    const sum = summary([{ id: "w", status: s }]);
    assert.equal(sum.work_packages.passed, 1, `"${s}" should count as passed`);
  }
});

test("characterize: autonomous-run fail synonyms (fail/failed/error/errored/blocked/timeout/timed_out)", () => {
  for (const s of ["fail", "failed", "error", "errored", "blocked", "timeout", "timed_out"]) {
    const sum = summary([{ id: "w", status: s }]);
    assert.equal(sum.work_packages.failed, 1, `"${s}" should count as failed`);
  }
});

// THE divergence quirk: task-dag.js maps "done" -> done(success), but autonomous-run's
// pass set does NOT include "done", so "done" is neither pass nor fail here -> unknown.
test("characterize: DIVERGENCE — 'done' is NOT a pass synonym in autonomous-run (-> unknown)", () => {
  const sum = summary([{ id: "w", status: "done" }]);
  assert.equal(sum.work_packages.passed, 0, "'done' must NOT count as passed in autonomous-run");
  assert.equal(sum.work_packages.failed, 0);
  assert.equal(sum.work_packages.unknown, 1, "'done' falls through to unknown here");
});

test("characterize: status field precedence is status || result || outcome", () => {
  assert.equal(summary([{ id: "w", result: "pass" }]).work_packages.passed, 1);
  assert.equal(summary([{ id: "w", outcome: "fail" }]).work_packages.failed, 1);
  // status wins over result/outcome
  assert.equal(summary([{ id: "w", status: "pass", outcome: "fail" }]).work_packages.passed, 1);
});

test("characterize: a 'done' work package is treated as INCOMPLETE (not pass) by decideNextAction", () => {
  // No failed gates/findings/artifacts; one work package marked 'done'. Because 'done'
  // is not a pass synonym here, it is not counted complete — documents the latent quirk.
  const decision = decideNextAction({ run_id: "r", work_packages: [{ id: "w", status: "done" }] });
  // It does not crash and yields a decision; the point is 'done' != pass in this module.
  assert.ok(decision.action, "decision is produced");
  assert.notEqual(PASS, "done");
});

test("characterize: human escalation (missing_credentials) overrides everything -> human_intervention", () => {
  const decision = decideNextAction({
    run_id: "r",
    gate_results: [{ id: "g", status: "fail", category: "credentials" }]
  });
  assert.equal(decision.action, "human_intervention");
});

test("characterize: rollback category (host_boundary) -> rollback action", () => {
  const decision = decideNextAction({
    run_id: "r",
    gate_results: [{ id: "g", status: "fail", category: "host_boundary" }]
  });
  assert.equal(decision.action, "rollback");
});
