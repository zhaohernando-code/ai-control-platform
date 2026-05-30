import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareContinuationFromProjectStatus,
  recordProjectStatusContinuationPrepared
} from "../src/workflow/project-status-continuation.js";

// Error-branch coverage for project-status-continuation.js (baseline 67.57% branch; the
// validate-fail branches at 67-71/76-77 and the recorder fail branches at 129-133/138-142 were
// uncovered). These are honestly reachable via the public API with plain input — they guard
// what counts as a valid PROJECT_STATUS continuation source and a valid durable workflow state.

// ---- prepareContinuationFromProjectStatus: validation-fail branches -----------------------

test("prepareContinuationFromProjectStatus: non-object project status is blocked", () => {
  const r = prepareContinuationFromProjectStatus(null);
  assert.equal(r.status, "blocked");
  assert.equal(r.should_continue, false);
  assert.equal(r.issues[0].code, "invalid_project_status");
  assert.equal(r.continuation_input, null);
});

test("prepareContinuationFromProjectStatus: wrong project target is blocked", () => {
  const r = prepareContinuationFromProjectStatus({ project: "stock_dashboard", next_step: "do x" });
  assert.equal(r.status, "blocked");
  assert.ok(r.issues.some((i) => i.code === "project_status_mismatch"));
});

test("prepareContinuationFromProjectStatus: no next_step and no global_goals is blocked", () => {
  const r = prepareContinuationFromProjectStatus({ project: "ai-control-platform" });
  assert.equal(r.status, "blocked");
  assert.ok(r.issues.some((i) => i.code === "missing_continuation_source"));
});

// ---- recordProjectStatusContinuationPrepared: recorder fail branches ----------------------

test("recordProjectStatusContinuationPrepared: non-object workflow state is rejected", () => {
  for (const bad of [null, "x", 42, []]) {
    const r = recordProjectStatusContinuationPrepared(bad, { status: "ready" });
    assert.equal(r.status, "fail");
    assert.equal(r.issues[0].code, "invalid_workflow_state");
  }
});

test("recordProjectStatusContinuationPrepared: missing run_id/cycle_id is rejected", () => {
  const r = recordProjectStatusContinuationPrepared({ manifest: { run_id: "run-1" } }, { status: "ready" });
  assert.equal(r.status, "fail");
  assert.equal(r.issues[0].code, "missing_workflow_identity");
});
