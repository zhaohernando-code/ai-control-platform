import assert from "node:assert/strict";
import test from "node:test";

import { createArtifactLedger } from "../src/workflow/artifact-ledger.js";
import { createReviewerGateRequest } from "../src/workflow/llm-reviewer-gate.js";
import {
  createReviewerProviderHealthFact,
  createReviewerRetrySchedule,
  recordReviewerProviderHealthFact
} from "../src/workflow/reviewer-provider-health.js";
import { createRunManifest } from "../src/workflow/run-manifest.js";

function contextPack() {
  return {
    requirement_summary: "固化 reviewer provider health 调度事实",
    host: "platform_core",
    target_project_id: "ai-control-platform",
    owned_files: ["src/workflow/reviewer-provider-health.js", "test/reviewer-provider-health.test.js"],
    acceptance_gates: ["node --test test/reviewer-provider-health.test.js"],
    subtasks: [
      {
        id: "provider-health",
        title: "Reviewer provider health facts",
        owned_files: ["src/workflow/reviewer-provider-health.js"]
      }
    ]
  };
}

function reviewerRequest(overrides = {}) {
  return createReviewerGateRequest({
    run_id: "run-provider-health",
    cycle_id: "cycle-provider-health",
    scope: "Review provider health handling.",
    files: ["src/workflow/llm-reviewer-gate.js"],
    questions: ["timeout 后是否先 smoke？"],
    ...overrides
  });
}

function workflowState() {
  const manifest = createRunManifest({
    run_id: "run-provider-health",
    cycle_id: "cycle-provider-health",
    goal: "固化 reviewer provider health 调度事实",
    context_pack: contextPack(),
    work_packages: [{ id: "provider-health", status: "completed", owned_files: ["src/workflow/reviewer-provider-health.js"] }],
    artifacts: [],
    gate_results: [],
    review_findings: [],
    recovery_attempts: []
  });

  return {
    manifest,
    artifact_ledger: createArtifactLedger({
      run_id: manifest.run_id,
      cycle_id: manifest.cycle_id,
      artifacts: []
    })
  };
}

test("reviewer timeout without smoke schedules provider smoke fact", () => {
  const schedule = createReviewerRetrySchedule({
    request: reviewerRequest(),
    tools: ["Read"]
  });

  assert.equal(schedule.status, "needs_smoke_check");
  assert.equal(schedule.provider_health, "unknown");
  assert.equal(schedule.next_action, "provider_smoke_check");
  assert.equal(schedule.fact.status, "pass");
  assert.equal(schedule.fact.source.category, "reviewer_timeout");
});

test("smoke pass with tools schedules no-tool retry before split fallback", () => {
  const fact = createReviewerProviderHealthFact({
    request: reviewerRequest(),
    tools: ["Read"],
    smoke_status: "pass",
    created_at: "2026-05-21T12:00:00.000Z"
  });

  assert.equal(fact.provider_health, "healthy");
  assert.equal(fact.recovery_status, "retry");
  assert.deepEqual(fact.scheduled_actions, ["rerun_without_tools", "split_scope"]);
  assert.equal(fact.invocation_policy.timeout_recovery.smoke_timeout_seconds, 60);
});

test("smoke failure blocks DeepSeek reviewer scheduling and records fallback", () => {
  const schedule = createReviewerRetrySchedule({
    request: reviewerRequest(),
    smoke_status: "timeout"
  });

  assert.equal(schedule.status, "blocked");
  assert.equal(schedule.provider_health, "unhealthy");
  assert.equal(schedule.next_action, "fallback_model_or_defer_external_review");
  assert.equal(schedule.fact.status, "fail");
});

test("provider health facts persist into manifest events and artifact ledger", () => {
  const recorded = recordReviewerProviderHealthFact(workflowState(), {
    request: reviewerRequest(),
    tools: ["Read"],
    smoke_status: "pass",
    created_at: "2026-05-21T12:05:00.000Z"
  });

  assert.equal(recorded.status, "pass");
  assert.equal(recorded.workflow_state.manifest.events.at(-1).type, "reviewer_provider_health");
  assert.equal(recorded.workflow_state.manifest.events.at(-1).status, "retry");
  assert.equal(recorded.workflow_state.artifact_ledger.artifacts.at(-1).producer, "reviewer-provider-health");
  assert.equal(recorded.workflow_state.artifact_ledger.artifacts.at(-1).metadata.provider_health, "healthy");

  const second = recordReviewerProviderHealthFact(recorded.workflow_state, {
    request: reviewerRequest(),
    smoke_status: "timeout",
    created_at: "2026-05-21T12:06:00.000Z"
  });

  assert.equal(second.status, "pass");
  assert.notEqual(second.workflow_state.manifest.events.at(-1).artifact_id, recorded.workflow_state.manifest.events.at(-1).artifact_id);
  assert.match(second.workflow_state.manifest.events.at(-1).artifact_id, /-002$/);
  assert.equal(second.workflow_state.artifact_ledger.artifacts.at(-1).status, "fail");
});

test("provider health persistence fails closed on manifest and ledger mismatch", () => {
  const state = workflowState();
  const result = recordReviewerProviderHealthFact({
    ...state,
    artifact_ledger: {
      ...state.artifact_ledger,
      run_id: "wrong-run"
    }
  }, {
    request: reviewerRequest(),
    smoke_status: "pass"
  });

  assert.equal(result.status, "fail");
  assert.ok(result.issues.some((issue) => issue.code === "workflow_state_run_mismatch"));
  assert.equal(result.workflow_state, undefined);
});
