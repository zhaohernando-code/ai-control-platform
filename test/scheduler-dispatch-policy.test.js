import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createSchedulerDispatchPlan } from "../src/workflow/scheduler-dispatch-plan.js";
import {
  evaluateSchedulerDispatchControlPolicy,
  recordSchedulerDispatchPolicyDecision
} from "../src/workflow/scheduler-dispatch-policy.js";

function workflowState() {
  return JSON.parse(readFileSync("docs/examples/current-session-workbench-input.json", "utf8"));
}

function continuationInput() {
  return {
    project_status: {
      project: "ai-control-platform",
      blockers: [],
      next_step: ""
    },
    run_evaluation: { status: "pass" },
    workflow_state: workflowState()
  };
}

function plan(options = {}) {
  return createSchedulerDispatchPlan(continuationInput(), {
    workflow_state_input_path: "tmp/scheduler/input.json",
    workbench_writeback_mode: "service",
    workbench_base_url: "http://127.0.0.1:4180",
    projection_id: "current-session",
    ...options
  });
}

test("scheduler dispatch control policy allows dry-run without execution authorization", () => {
  const policy = evaluateSchedulerDispatchControlPolicy({ dry_run: true }, plan());

  assert.equal(policy.status, "pass");
  assert.equal(policy.execution_mode, "dry_run");
});

test("scheduler dispatch control policy rejects non-dry-run without operator authorization", () => {
  const policy = evaluateSchedulerDispatchControlPolicy({ dry_run: false }, plan());

  assert.equal(policy.status, "fail");
  assert.ok(policy.issues.some((entry) => entry.code === "missing_operator_authorization"));
  assert.ok(policy.issues.some((entry) => entry.code === "missing_max_steps"));
  assert.ok(policy.issues.some((entry) => entry.code === "missing_reviewer_budget"));
});

test("scheduler dispatch control policy allows mocked non-dry-run with explicit zero reviewer budget", () => {
  const policy = evaluateSchedulerDispatchControlPolicy({
    dry_run: false,
    operator_authorization: "approved_non_dry_run",
    max_steps: 3,
    max_external_reviewer_calls: 0,
    provider_cost_mode: "mocked"
  }, plan({ reviewer_mock_status: "pass" }));

  assert.equal(policy.status, "pass");
  assert.equal(policy.execution_mode, "execute");
  assert.equal(policy.controls.max_external_reviewer_calls, 0);
  assert.equal(policy.controls.reviewer_cost_mode, "mocked");
});

test("scheduler dispatch control policy bounds non-mocked reviewer cost", () => {
  const policy = evaluateSchedulerDispatchControlPolicy({
    dry_run: false,
    operator_authorization: "approved_non_dry_run",
    max_steps: 3,
    max_external_reviewer_calls: 99,
    provider_cost_mode: "bounded"
  }, plan());

  assert.equal(policy.status, "fail");
  assert.ok(policy.issues.some((entry) => entry.code === "invalid_reviewer_budget"));
});

test("scheduler dispatch policy decisions are durable workflow facts", () => {
  const state = workflowState();
  const policy = evaluateSchedulerDispatchControlPolicy({ dry_run: false }, plan());
  const recorded = recordSchedulerDispatchPolicyDecision(state, policy, {
    plan: plan(),
    created_at: "2026-05-21T23:40:00.000Z"
  });

  assert.equal(recorded.status, "pass");
  assert.equal(recorded.artifact.metadata.type, "scheduler_dispatch_policy");
  assert.equal(recorded.artifact.status, "fail");
  assert.equal(recorded.artifact.metadata.execution_mode, "blocked");
  assert.ok(recorded.artifact.metadata.issues.some((entry) => entry.code === "missing_operator_authorization"));
  assert.equal(recorded.workflow_state.manifest.events.at(-1).type, "scheduler_dispatch_policy");
  assert.equal(recorded.workflow_state.artifact_ledger.artifacts.at(-1).producer, "scheduler-dispatch-policy");
});
