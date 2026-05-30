import assert from "node:assert/strict";
import test from "node:test";
import { evaluateReviewerExecutionPolicy } from "../src/workflow/reviewer-execution-policy.js";

// Error/edge-branch coverage for reviewer-execution-policy.js (baseline 80.23% branch). This
// gate decides whether a reviewer run is mock/bounded-real/blocked; the reject branches guard
// cost and authorization and are honestly reachable with plain input.

test("evaluateReviewerExecutionPolicy: approved mock profile without mock output is blocked", () => {
  const r = evaluateReviewerExecutionPolicy({ execution_profile: "approved_mock_non_dry_run" });
  assert.equal(r.status, "fail");
  assert.equal(r.execution_mode, "blocked");
  assert.equal(r.issues[0].code, "missing_mock_reviewer_output");
});

test("evaluateReviewerExecutionPolicy: approved mock profile WITH mock output passes (mocked, zero external calls)", () => {
  const r = evaluateReviewerExecutionPolicy({ execution_profile: "approved_mock_non_dry_run", reviewer_mock_status: "pass" });
  assert.equal(r.status, "pass");
  assert.equal(r.execution_mode, "mocked");
  assert.equal(r.controls.max_external_reviewer_calls, 0);
});

test("evaluateReviewerExecutionPolicy: an unsupported profile is blocked", () => {
  const r = evaluateReviewerExecutionPolicy({ execution_profile: "some_unapproved_profile" });
  assert.equal(r.status, "fail");
  assert.equal(r.execution_mode, "blocked");
  assert.equal(r.issues[0].code, "unsupported_reviewer_execution_profile");
});

test("evaluateReviewerExecutionPolicy: bounded real reviewer must not carry mock output", () => {
  const r = evaluateReviewerExecutionPolicy({
    execution_profile: "approved_bounded_real_reviewer",
    reviewer_mock_status: "pass",
    max_external_reviewer_calls: 1
  });
  // mock output on a real profile is a recorded issue (fail), guarding cost-mode confusion
  assert.ok(r.issues.some((i) => i.code === "mock_output_for_real_reviewer"));
});
