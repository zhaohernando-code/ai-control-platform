import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeSchedulerDispatchControlRequest,
  evaluateSchedulerDispatchControlPolicy
} from "../src/workflow/scheduler-dispatch-policy.js";

// Error/edge-branch coverage for scheduler-dispatch-policy.js. These guard which scheduler
// dispatch control requests are accepted; the reject branches are honestly reachable with
// plain input.

test("normalizeSchedulerDispatchControlRequest: non-object request is rejected", () => {
  for (const bad of [null, "x", 42, []]) {
    const r = normalizeSchedulerDispatchControlRequest(bad);
    assert.equal(r.status, "fail");
    assert.equal(r.issues[0].code, "invalid_scheduler_dispatch_request");
  }
});

test("normalizeSchedulerDispatchControlRequest: an unsupported execution profile is rejected", () => {
  const r = normalizeSchedulerDispatchControlRequest({ execution_profile: "totally_unapproved_profile" });
  assert.equal(r.status, "fail");
  assert.equal(r.issues[0].code, "unsupported_scheduler_dispatch_profile");
});

test("normalizeSchedulerDispatchControlRequest: no profile passes through unchanged (dry-run default)", () => {
  const r = normalizeSchedulerDispatchControlRequest({ id: "x" });
  assert.equal(r.status, "pass");
  assert.deepEqual(r.input, { id: "x" });
});

test("normalizeSchedulerDispatchControlRequest: the approved mock non-dry-run profile is normalized with bounded controls", () => {
  const r = normalizeSchedulerDispatchControlRequest({ execution_profile: "approved_mock_non_dry_run" });
  assert.equal(r.status, "pass");
  assert.equal(r.input.dry_run, false);
  assert.equal(r.input.operator_authorization, "approved_non_dry_run");
  assert.equal(r.input.max_external_reviewer_calls, 0);
  assert.equal(r.input.provider_cost_mode, "mocked");
});

test("evaluateSchedulerDispatchControlPolicy: defaults to dry-run mode when dry_run is not explicitly false", () => {
  const r = evaluateSchedulerDispatchControlPolicy({}, { steps: [{ id: "s1" }, { id: "s2" }] });
  assert.equal(r.status, "pass");
  assert.equal(r.execution_mode, "dry_run");
  assert.equal(r.controls.max_steps, 2);
});
