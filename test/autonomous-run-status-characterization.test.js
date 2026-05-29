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

// The 'done' handling: task-dag emits "done" as its success label and 4 other modules
// treat "done" as complete. autonomous-run MUST agree — a 'done' work package is a
// completed one and must NOT be re-run. (This was previously a latent drift bug where
// 'done' counted as incomplete and triggered a spurious rerun; now fixed + pinned here.)
test("'done' work package counts as passed (aligned with task-dag + completion modules)", () => {
  const sum = summary([{ id: "w", status: "done" }]);
  assert.equal(sum.work_packages.passed, 1, "'done' must count as passed");
  assert.equal(sum.work_packages.unknown, 0);
});

test("a 'done' work package does NOT trigger a spurious rerun", () => {
  const decision = decideNextAction({ run_id: "r", work_packages: [{ id: "w", status: "done" }] });
  assert.notEqual(decision.action, "rerun", "a completed (done) package must not be re-run");
  // sibling check: 'completed' and 'done' must produce the SAME action (no drift)
  const completedDecision = decideNextAction({ run_id: "r", work_packages: [{ id: "w", status: "completed" }] });
  assert.equal(decision.action, completedDecision.action, "'done' and 'completed' must agree");
});

test("characterize: status field precedence is status || result || outcome", () => {
  assert.equal(summary([{ id: "w", result: "pass" }]).work_packages.passed, 1);
  assert.equal(summary([{ id: "w", outcome: "fail" }]).work_packages.failed, 1);
  // status wins over result/outcome
  assert.equal(summary([{ id: "w", status: "pass", outcome: "fail" }]).work_packages.passed, 1);
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
