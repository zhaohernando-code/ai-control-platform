import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateReviewerExecutionPolicy,
  evaluateReviewerProviderHealthPreflight
} from "../src/workflow/reviewer-execution-policy.js";

test("reviewer execution policy requires mock output for mock profile", () => {
  const policy = evaluateReviewerExecutionPolicy({
    execution_profile: "approved_mock_non_dry_run"
  });

  assert.equal(policy.status, "fail");
  assert.equal(policy.execution_mode, "blocked");
  assert.ok(policy.issues.some((entry) => entry.code === "missing_mock_reviewer_output"));
});

test("reviewer execution policy allows mock profile with zero external calls", () => {
  const policy = evaluateReviewerExecutionPolicy({
    execution_profile: "approved_mock_non_dry_run",
    reviewer_mock_status: "pass"
  });

  assert.equal(policy.status, "pass");
  assert.equal(policy.execution_mode, "mocked");
  assert.equal(policy.controls.executor_mode, "mock");
  assert.equal(policy.controls.max_external_reviewer_calls, 0);
  assert.equal(policy.controls.provider_cost_mode, "mocked");
});

test("reviewer execution policy allows bounded real reviewer profile", () => {
  const policy = evaluateReviewerExecutionPolicy({
    execution_profile: "approved_bounded_real_reviewer",
    max_external_reviewer_calls: 1,
    provider_cost_mode: "bounded",
    timeout_seconds: 90,
    budget_tier: "medium"
  });

  assert.equal(policy.status, "pass");
  assert.equal(policy.execution_mode, "bounded_real_reviewer");
  assert.equal(policy.controls.executor_mode, "agent_invocation");
  assert.equal(policy.controls.max_external_reviewer_calls, 1);
  assert.equal(policy.controls.max_allowed_external_reviewer_calls, 1);
  assert.equal(policy.controls.ds_participation_mode, "balanced");
  assert.equal(policy.controls.provider_cost_mode, "bounded");
  assert.equal(policy.controls.model_routing.selected_model, "deepseek-v4-pro");
});

test("reviewer execution policy can temporarily expand DS bounded participation", () => {
  const policy = evaluateReviewerExecutionPolicy({
    execution_profile: "approved_bounded_real_reviewer",
    max_external_reviewer_calls: 2,
    provider_cost_mode: "bounded",
    timeout_seconds: 120,
    ds_participation_mode: "expanded",
    budget_tier: "medium"
  });

  assert.equal(policy.status, "pass");
  assert.equal(policy.execution_mode, "bounded_real_reviewer");
  assert.equal(policy.controls.executor_mode, "agent_invocation");
  assert.equal(policy.controls.max_external_reviewer_calls, 2);
  assert.equal(policy.controls.max_allowed_external_reviewer_calls, 2);
  assert.equal(policy.controls.ds_participation_mode, "expanded");
  assert.equal(policy.controls.model_routing.model_routing_strategy, "ds_expanded");
  assert.equal(policy.controls.model_routing.selected_model, "deepseek-v4-pro");
});

test("reviewer execution policy caps expanded DS cumulative timeout", () => {
  const policy = evaluateReviewerExecutionPolicy({
    execution_profile: "approved_bounded_real_reviewer",
    max_external_reviewer_calls: 2,
    provider_cost_mode: "bounded",
    timeout_seconds: 150,
    ds_participation_mode: "expanded"
  });

  assert.equal(policy.status, "fail");
  assert.ok(policy.issues.some((entry) => entry.code === "invalid_reviewer_cumulative_timeout"));
});

test("reviewer execution policy rejects mock output and unsafe bounds for real profile", () => {
  const policy = evaluateReviewerExecutionPolicy({
    execution_profile: "approved_bounded_real_reviewer",
    reviewer_mock_status: "pass",
    max_external_reviewer_calls: 2,
    provider_cost_mode: "mocked",
    timeout_seconds: 180
  });

  assert.equal(policy.status, "fail");
  assert.ok(policy.issues.some((entry) => entry.code === "mock_output_for_real_reviewer"));
  assert.ok(policy.issues.some((entry) => entry.code === "invalid_real_reviewer_budget"));
  assert.ok(policy.issues.some((entry) => entry.code === "invalid_real_reviewer_cost_mode"));
  assert.ok(policy.issues.some((entry) => entry.code === "invalid_reviewer_timeout"));
});

test("reviewer provider health preflight gates bounded real reviewer execution", () => {
  const policy = evaluateReviewerExecutionPolicy({
    execution_profile: "approved_bounded_real_reviewer",
    max_external_reviewer_calls: 1,
    provider_cost_mode: "bounded",
    timeout_seconds: 90
  });
  const missing = evaluateReviewerProviderHealthPreflight({ manifest: { events: [] } }, policy);
  const unhealthy = evaluateReviewerProviderHealthPreflight({
    manifest: {
      events: [{
        type: "reviewer_provider_health",
        metadata: { provider_health: "unhealthy", recovery_status: "blocked" }
      }]
    }
  }, policy);
  const healthy = evaluateReviewerProviderHealthPreflight({
    manifest: {
      events: [{
        type: "reviewer_provider_health",
        metadata: { provider_health: "healthy", recovery_status: "retry" }
      }]
    }
  }, policy);

  assert.equal(missing.status, "fail");
  assert.ok(missing.issues.some((entry) => entry.code === "reviewer_provider_health_preflight_required"));
  assert.equal(unhealthy.status, "fail");
  assert.ok(unhealthy.issues.some((entry) => entry.code === "reviewer_provider_unhealthy"));
  assert.equal(healthy.status, "pass");
});
