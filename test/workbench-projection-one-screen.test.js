import assert from "node:assert/strict";
import test from "node:test";

import { createWorkbenchOneScreenProjection } from "../src/workflow/workbench-projection.js";

test("workbench one-screen helper preserves next action and counter contract", () => {
  const oneScreen = createWorkbenchOneScreenProjection({
    manifest: { goal: "治理 projection 聚合层" },
    status: "rerun",
    runEvaluation: {
      decision: "rerun",
      next_work_packages: [
        { id: "repair-model", reason: "需要修复模型路由" }
      ]
    },
    manifestSummary: { work_package_count: 3 },
    artifactSummary: { total: 2 },
    reviewerSummary: { counts: { total: 1 } },
    dagSummary: {
      dispatchable: [
        { id: "dispatch-ui", action: "dispatch", title: "派发 UI 验收" }
      ]
    },
    closeoutSummary: { status: "pass" },
    browserEventsSummary: { scenario_count: 4 },
    frontendAcceptance: {
      blocking_count: 1,
      repair_work_package: {
        id: "frontend-repair",
        action: "repair_frontend_acceptance",
        title: "修复前端验收"
      }
    },
    governanceAudit: { blocking_count: 0 },
    resumeHealth: { status: "blocked", issue_count: 2 },
    reviewerProviderHealth: { status: "pass" },
    reviewerScopeSplit: { shard_count: 2 },
    reviewerShardReview: { completed_shards: 1 },
    headlessChildProvider: { attempt_count: 3, retry_attempt_count: 1 },
    projectedActionProgress: { status: "pass" },
    schedulerDispatch: { step_count: 5 },
    schedulerContinuation: { ready: true },
    schedulerLoop: { iteration_count: 6 },
    agentLifecyclePool: {
      open: 1,
      completed: 2,
      evaluated: 3,
      closed: 4
    },
    agentKeyHealth: { key_count: 5, available_key_count: 2 },
    selfGovernance: {
      finding_count: 7,
      auto_repair_count: 1,
      evidence_building_count: 2,
      user_decision_count: 3
    },
    projectManagement: {
      projects_total: 2,
      active_projects: 1,
      tasks_total: 8,
      active_tasks: 3,
      released_services: 1,
      human_decisions: 2
    },
    globalGoalCompletion: {
      total: 4,
      pending: 1,
      completed: 2,
      blocked: 1
    },
    operationsTimeline: { count: 9 },
    nextActionReadout: { action: "repair_frontend_acceptance" }
  });

  assert.equal(oneScreen.headline, "治理 projection 聚合层");
  assert.equal(oneScreen.primary_status, "rerun");
  assert.deepEqual(oneScreen.next_actions.map((action) => action.id), [
    "frontend-repair",
    "repair-model",
    "dispatch-ui"
  ]);
  assert.equal(oneScreen.next_actions[1].action, "rerun");
  assert.equal(oneScreen.counters.work_packages, 3);
  assert.equal(oneScreen.counters.artifacts, 2);
  assert.equal(oneScreen.counters.reviewer_findings, 1);
  assert.equal(oneScreen.counters.dispatchable_tasks, 1);
  assert.equal(oneScreen.counters.closeout_publishes, 1);
  assert.equal(oneScreen.counters.browser_event_scenarios, 4);
  assert.equal(oneScreen.counters.frontend_acceptance_blockers, 1);
  assert.equal(oneScreen.counters.resume_blockers, 2);
  assert.equal(oneScreen.counters.provider_health_events, 1);
  assert.equal(oneScreen.counters.reviewer_scope_shards, 2);
  assert.equal(oneScreen.counters.reviewer_shards_completed, 1);
  assert.equal(oneScreen.counters.headless_child_attempts, 3);
  assert.equal(oneScreen.counters.headless_child_retry_attempts, 1);
  assert.equal(oneScreen.counters.projected_action_progress_events, 1);
  assert.equal(oneScreen.counters.scheduler_dispatch_steps, 5);
  assert.equal(oneScreen.counters.scheduler_continuation_ready, 1);
  assert.equal(oneScreen.counters.scheduler_loop_iterations, 6);
  assert.equal(oneScreen.counters.agent_lifecycle_open, 1);
  assert.equal(oneScreen.counters.agent_lifecycle_completed, 2);
  assert.equal(oneScreen.counters.agent_lifecycle_evaluated, 3);
  assert.equal(oneScreen.counters.agent_lifecycle_closed, 4);
  assert.equal(oneScreen.counters.agent_key_total, 5);
  assert.equal(oneScreen.counters.agent_key_available, 2);
  assert.equal(oneScreen.counters.self_governance_findings, 7);
  assert.equal(oneScreen.counters.self_governance_auto_repairs, 1);
  assert.equal(oneScreen.counters.self_governance_evidence_tasks, 2);
  assert.equal(oneScreen.counters.self_governance_user_decisions, 3);
  assert.equal(oneScreen.counters.projects_total, 2);
  assert.equal(oneScreen.counters.active_projects, 1);
  assert.equal(oneScreen.counters.tasks_total, 8);
  assert.equal(oneScreen.counters.active_tasks, 3);
  assert.equal(oneScreen.counters.released_services, 1);
  assert.equal(oneScreen.counters.human_decisions, 2);
  assert.equal(oneScreen.counters.global_goals_total, 4);
  assert.equal(oneScreen.counters.global_goals_pending, 1);
  assert.equal(oneScreen.counters.global_goals_completed, 2);
  assert.equal(oneScreen.counters.global_goals_blocked, 1);
  assert.equal(oneScreen.counters.operation_events, 9);
  assert.equal(oneScreen.recommended_action, "repair_frontend_acceptance");
});
