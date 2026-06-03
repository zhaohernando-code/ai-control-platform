import assert from "node:assert/strict";
import test from "node:test";

import { FRONTEND_ACCEPTANCE_RUN_VERSION } from "../src/workflow/frontend-acceptance.js";
import {
  createMobileWorkbenchProjection,
  createWorkbenchProjection,
  validateWorkbenchProjectionInput
} from "../src/workflow/workbench-projection.js";
import { baseInput } from "./helpers/workbench-projection.js";

test("workbench projection combines run, artifacts, model routing, reviewer and DAG state", () => {
  const projection = createWorkbenchProjection(baseInput());

  assert.equal(projection.projection_version, "workbench.v1");
  assert.equal(projection.run_id, "run-projection");
  assert.equal(projection.status, "rerun");
  assert.equal(projection.decision, "rerun");
  assert.equal(projection.manifest.status, "pass");
  assert.equal(projection.artifacts.total, 1);
  assert.equal(projection.closeout.status, "not_configured");
  assert.equal(projection.model_routing.selected_model, "gpt");
  assert.equal(projection.model_routing.has_independent_reviewer, true);
  assert.equal(projection.reviewer_gate.recommended_decision_signal, "rerun");
  assert.equal(projection.task_dag.status, "pass");
  assert.equal(projection.one_screen.counters.reviewer_findings, 1);
  assert.equal(projection.one_screen.counters.closeout_publishes, 0);
  assert.equal(projection.resume_health.status, "not_configured");
  assert.equal(projection.reviewer_provider_health.status, "not_configured");
  assert.equal(projection.scheduler_dispatch.status, "not_configured");
  assert.equal(projection.scheduler_continuation.status, "not_configured");
  assert.equal(projection.scheduler_loop.status, "not_configured");
  assert.equal(projection.headless_child_provider.status, "not_configured");
  assert.equal(projection.headless_child_provider.mock_child_worker, false);
  assert.equal(projection.projected_action_progress.status, "not_configured");
  assert.equal(projection.agent_lifecycle_pool.status, "not_configured");
  assert.equal(projection.self_governance.status, "available");
  assert.equal(projection.self_governance.finding_count, 0);
  assert.equal(projection.self_governance.cadence, "weekly");
  assert.equal(projection.self_governance.role_count, 4);
  assert.equal(projection.self_governance.auto_repair_count, 0);
  assert.equal(projection.project_management.status, "available");
  assert.equal(projection.project_management.projects_total, 2);
  assert.equal(projection.project_management.active_projects, 2);
  assert.equal(projection.project_management.projects[0].project_id, "ai-control-platform");
  assert.equal(projection.project_management.projects[0].display_name, "AI Control Platform");
  assert.equal(projection.project_management.projects[0].phase, "持续开发");
  assert.equal(projection.project_management.projects[0].owner_agent, "main_orchestrator");
  assert.equal(projection.project_management.projects[1].project_id, "stock_dashboard");
  assert.equal(projection.project_management.projects[1].display_name, "股票看板");
  assert.equal(projection.project_management.projects[1].type, "managed");
  assert.equal(projection.project_management.projects[1].owner_agent, "platform_orchestrator");
  assert.equal(projection.project_management.task_flow.map((step) => step.label).join(" -> "), "需求 -> 拆解 -> 子任务 -> Review -> 发布 -> Live 验证 -> 验收");
  assert.deepEqual(projection.project_management.task_items, []);
  assert.equal(projection.project_management.design_alignment.homepage_primary_surface, "project_management");
  assert.equal(projection.one_screen.counters.projects_total, 2);
  assert.equal(projection.one_screen.counters.active_projects, 2);
  assert.equal(projection.one_screen.counters.tasks_total, 2);
  assert.equal(projection.one_screen.counters.active_tasks, 0);
  assert.equal(projection.one_screen.counters.self_governance_findings, 0);
  assert.equal(projection.operations_timeline.status, "not_configured");
  assert.equal(projection.next_action_readout.status, "not_configured");
  assert.equal(projection.next_action_readout.action, "wait_for_driver_event");
  assert.equal(projection.one_screen.counters.resume_blockers, 0);
  assert.equal(projection.one_screen.counters.provider_health_events, 0);
  assert.equal(projection.one_screen.counters.headless_child_attempts, 0);
  assert.equal(projection.one_screen.counters.projected_action_progress_events, 0);
  assert.equal(projection.one_screen.counters.scheduler_dispatch_steps, 0);
  assert.equal(projection.one_screen.counters.scheduler_continuation_ready, 0);
  assert.equal(projection.one_screen.counters.scheduler_loop_iterations, 0);
  assert.equal(projection.one_screen.counters.agent_lifecycle_open, 0);
  assert.equal(projection.global_goal_completion.status, "not_configured");
  assert.equal(projection.one_screen.counters.global_goals_pending, 0);
  assert.equal(projection.one_screen.counters.operation_events, 0);
});

test("workbench projection exposes terminal next-action details for inspect states", () => {
  const input = baseInput();
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: "scheduler-loop-terminal",
        type: "autonomous_scheduler_loop_run",
        status: "pass",
        created_at: "2026-05-21T00:08:00.000Z",
        artifact_id: "scheduler-loop-terminal-artifact"
      }
    ]
  };
  input.artifact_ledger.artifacts.push({
    id: "scheduler-loop-terminal-artifact",
    type: "scheduler_loop",
    status: "pass",
    created_at: "2026-05-21T00:08:00.000Z",
    metadata: {
      version: "autonomous-scheduler-loop-run.v1",
      status: "pass",
      phase: "terminal_projected_action",
      created_at: "2026-05-21T00:08:00.000Z",
      input: {
        start_projection_id: "current",
        max_iterations: 1,
        execution_profile: "approved_mock_non_dry_run",
        execution_strategy: "projected_next_action",
        snapshot_prefix: "terminal-test"
      },
      result: {
        status: "pass",
        phase: "terminal_projected_action",
        issues: [],
        iterations: [
          {
            index: 1,
            status: "stopped",
            projection_id: "current",
            projected_action: "inspect_scheduler_loop",
            terminal_action: "inspect_scheduler_loop",
            terminal_reason: "projected next action is not executable"
          }
        ]
      }
    }
  });

  const projection = createWorkbenchProjection(input);
  const mobile = createMobileWorkbenchProjection(input);

  assert.equal(projection.next_action_readout.status, "pending");
  assert.equal(projection.next_action_readout.action, "inspect_scheduler_loop");
  assert.equal(projection.next_action_readout.reason, "projected next action is not executable");
  assert.equal(projection.next_action_terminal.terminal_action, "inspect_scheduler_loop");
  assert.equal(projection.next_action_terminal.terminal_reason, "projected next action is not executable");
  assert.equal(mobile.next_action_terminal.terminal_action, "inspect_scheduler_loop");
});
test("workbench projection exposes latest closeout publication evidence", () => {
  const input = baseInput();
  const artifact = {
    id: "closeout-snapshot-run-projection",
    type: "evaluation",
    status: "pass",
    path: "docs/examples/snapshots/run-projection.workbench-input.json",
    producer: "closeout-runner",
    created_at: "2026-05-21T10:30:00.000Z",
    metadata: {
      snapshot_id: "run-projection",
      closeout_status: "created",
      issues: []
    }
  };
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: "event-closeout-snapshot-run-projection",
        type: "closeout_snapshot_publish",
        status: "created",
        artifact_id: artifact.id,
        snapshot_id: "run-projection",
        created_at: "2026-05-21T10:30:00.000Z"
      }
    ],
    artifacts: [...input.manifest.artifacts, artifact]
  };
  input.artifact_ledger = {
    ...input.artifact_ledger,
    artifacts: [...input.artifact_ledger.artifacts, artifact]
  };

  const projection = createWorkbenchProjection(input);
  const mobile = createMobileWorkbenchProjection(input);

  assert.equal(projection.closeout.status, "pass");
  assert.equal(projection.closeout.publish_status, "created");
  assert.equal(projection.closeout.artifact_id, "closeout-snapshot-run-projection");
  assert.equal(projection.closeout.path, "docs/examples/snapshots/run-projection.workbench-input.json");
  assert.equal(projection.one_screen.counters.closeout_publishes, 1);
  assert.equal(mobile.closeout.status, "pass");
  assert.equal(mobile.closeout.snapshot_id, "run-projection");
});

test("workbench projection exposes browser event artifact evidence", () => {
  const input = baseInput();
  const artifact = {
    id: "workbench-browser-events-run-projection",
    type: "evaluation",
    status: "pass",
    uri: "codex://workbench-browser-events/run-projection",
    producer: "workbench-browser-events",
    created_at: "2026-05-22T06:10:00.000Z",
    metadata: {
      type: "workbench_browser_events_run",
      version: "workbench-browser-events-run.v1",
      status: "pass",
      scenario_count: 2,
      scenarios: [
        {
          scenario: "projected_real_partial_shard_readout",
          shard_review_next: "reviewer-scope-shard-002",
          next_action_readout: "run_reviewer_scope_shard",
          dimensions: { width: 1440, scrollWidth: 1440 }
        },
        {
          scenario: "mobile_projection",
          dimensions: { width: 390, scrollWidth: 390 }
        }
      ]
    }
  };
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: "event-workbench-browser-events-run-projection",
        type: "workbench_browser_events_run",
        status: "pass",
        artifact_id: artifact.id,
        created_at: artifact.created_at,
        metadata: artifact.metadata
      }
    ],
    artifacts: [...input.manifest.artifacts, artifact]
  };
  input.artifact_ledger = {
    ...input.artifact_ledger,
    artifacts: [...input.artifact_ledger.artifacts, artifact]
  };

  const projection = createWorkbenchProjection(input);
  const mobile = createMobileWorkbenchProjection(input);

  assert.equal(projection.workbench_browser_events.status, "pass");
  assert.equal(projection.workbench_browser_events.artifact_id, artifact.id);
  assert.equal(projection.workbench_browser_events.scenario_count, 2);
  assert.equal(projection.workbench_browser_events.partial_shard_ready, true);
  assert.equal(projection.workbench_browser_events.overflow_count, 0);
  assert.equal(projection.one_screen.counters.browser_event_scenarios, 2);
  assert.equal(mobile.workbench_browser_events.partial_shard_ready, true);
  assert.equal(mobile.workbench_browser_events.scenario_count, 2);
});

test("workbench projection exposes failed frontend acceptance repair as next action", () => {
  const input = baseInput();
  const artifact = {
    id: "frontend-acceptance-current-workbench",
    type: "evaluation",
    status: "fail",
    uri: "codex://frontend-acceptance/run-projection/cycle-20260521/frontend-acceptance-current-workbench",
    producer: "frontend-acceptance-child-worker",
    created_at: "2026-05-24T00:00:00.000Z",
    metadata: {
      version: FRONTEND_ACCEPTANCE_RUN_VERSION,
      status: "fail",
      created_at: "2026-05-24T00:00:00.000Z",
      viewport_results: [
        { viewport: "desktop" },
        { viewport: "desktop_narrow" },
        { viewport: "mobile" }
      ],
      navigation_results: [],
      layout_results: [],
      copy_results: [],
      control_results: [],
      mobile_results: [],
      findings: [
        {
          code: "frontend_dead_navigation",
          severity: "p1",
          status: "fail",
          message: "Navigation tabs do not change active state"
        }
      ],
      blocking_count: 1,
      blocking_findings: [
        {
          code: "frontend_dead_navigation",
          severity: "p1",
          status: "fail",
          message: "Navigation tabs do not change active state"
        }
      ]
    }
  };
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: "event-frontend-acceptance-current-workbench",
        type: "frontend_acceptance_run",
        status: "fail",
        artifact_id: artifact.id,
        created_at: artifact.created_at,
        metadata: artifact.metadata
      }
    ],
    artifacts: [...input.manifest.artifacts, artifact]
  };
  input.artifact_ledger = {
    ...input.artifact_ledger,
    artifacts: [...input.artifact_ledger.artifacts, artifact]
  };

  const projection = createWorkbenchProjection(input);
  const mobile = createMobileWorkbenchProjection(input);

  assert.equal(projection.frontend_acceptance.status, "fail");
  assert.equal(projection.frontend_acceptance.repair_required, true);
  assert.equal(projection.frontend_acceptance.repair_work_package.action, "repair_frontend_acceptance");
  assert.equal(projection.operations_timeline.latest_driver.type, "frontend_acceptance_run");
  assert.equal(projection.next_action_readout.status, "ready");
  assert.equal(projection.next_action_readout.action, "repair_frontend_acceptance");
  assert.equal(projection.next_action_readout.source_type, "frontend_acceptance_run");
  assert.equal(projection.one_screen.next_actions[0].id, "frontend-acceptance-repair-frontend-acceptance-current-workbench");
  assert.equal(projection.one_screen.counters.frontend_acceptance_blockers, 1);
  assert.equal(mobile.frontend_acceptance.repair_required, true);
  assert.equal(mobile.frontend_acceptance.repair_work_package_id, "frontend-acceptance-repair-frontend-acceptance-current-workbench");
  assert.equal(mobile.next_action_readout.action, "repair_frontend_acceptance");
});

test("workbench projection exposes replay validation blockers as resume health", () => {
  const input = baseInput();
  const artifact = {
    id: "autonomous-loop-replay-validation-run-projection-cycle-20260521-001",
    type: "evaluation",
    status: "fail",
    uri: "autonomous-loop://replay-validation/run-projection/cycle-20260521",
    producer: "autonomous-orchestrator",
    created_at: "2026-05-21T11:15:00.000Z",
    metadata: {
      run_id: "run-projection",
      cycle_id: "cycle-20260521",
      replay_status: "blocked",
      issues: [{ code: "result_drift", message: "replay result drifted from stored projection", path: "result" }]
    }
  };
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: `event-${artifact.id}`,
        type: "autonomous_loop_replay_validation",
        status: "blocked",
        artifact_id: artifact.id,
        message: "autonomous loop replay validation blocked scheduler continuation",
        created_at: "2026-05-21T11:15:00.000Z",
        metadata: artifact.metadata
      }
    ],
    artifacts: [...input.manifest.artifacts, artifact]
  };
  input.artifact_ledger = {
    ...input.artifact_ledger,
    artifacts: [...input.artifact_ledger.artifacts, artifact]
  };

  const projection = createWorkbenchProjection(input);
  const mobile = createMobileWorkbenchProjection(input);

  assert.equal(projection.resume_health.status, "blocked");
  assert.equal(projection.resume_health.replay_status, "blocked");
  assert.equal(projection.resume_health.artifact_id, artifact.id);
  assert.equal(projection.resume_health.issue_count, 1);
  assert.equal(projection.resume_health.latest_issue, "replay result drifted from stored projection");
  assert.equal(projection.one_screen.counters.resume_blockers, 1);
  assert.equal(mobile.resume_health.status, "blocked");
  assert.equal(mobile.resume_health.latest_issue, "replay result drifted from stored projection");
});

test("workbench projection exposes reviewer provider health scheduler facts", () => {
  const input = baseInput();
  const artifact = {
    id: "reviewer-provider-health-run-projection-cycle-20260521-001",
    type: "evaluation",
    status: "pass",
    uri: "codex://reviewer-provider-health/run-projection/cycle-20260521/reviewer-provider-health-run-projection-cycle-20260521-001",
    producer: "reviewer-provider-health",
    created_at: "2026-05-21T12:05:00.000Z",
    metadata: {
      type: "reviewer_provider_health",
      recovery_status: "retry",
      provider_health: "healthy",
      retry_strategy: "rerun_without_tools_or_split_scope",
      scheduled_actions: ["rerun_without_tools", "split_scope"],
      provider: "claude-code",
      model: "deepseek-v4-pro"
    }
  };
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: `event-${artifact.id}`,
        type: "reviewer_provider_health",
        status: "retry",
        artifact_id: artifact.id,
        message: "provider smoke passed after reviewer timeout",
        created_at: "2026-05-21T12:05:00.000Z",
        metadata: artifact.metadata
      }
    ],
    artifacts: [...input.manifest.artifacts, artifact]
  };
  input.artifact_ledger = {
    ...input.artifact_ledger,
    artifacts: [...input.artifact_ledger.artifacts, artifact]
  };

  const projection = createWorkbenchProjection(input);
  const mobile = createMobileWorkbenchProjection(input);

  assert.equal(projection.reviewer_provider_health.status, "retry");
  assert.equal(projection.reviewer_provider_health.provider_health, "healthy");
  assert.equal(projection.reviewer_provider_health.retry_strategy, "rerun_without_tools_or_split_scope");
  assert.equal(projection.reviewer_provider_health.next_action, "rerun_without_tools");
  assert.equal(projection.one_screen.counters.provider_health_events, 1);
  assert.equal(mobile.provider_health.provider_health, "healthy");
  assert.equal(mobile.provider_health.next_action, "rerun_without_tools");
});

test("workbench projection exposes reviewer scope split shard status", () => {
  const input = baseInput();
  const artifact = {
    id: "reviewer-scope-split-run-projection-cycle-20260521-001",
    type: "evaluation",
    status: "pass",
    uri: "codex://reviewer-scope-split/run-projection/cycle-20260521/reviewer-scope-split-run-projection-cycle-20260521-001",
    producer: "reviewer-scope-splitter",
    created_at: "2026-05-21T12:08:00.000Z",
    metadata: {
      type: "reviewer_scope_split",
      status: "pass",
      split_required: true,
      shard_count: 2,
      pending_shards: 2,
      provider: "claude-code",
      model: "deepseek-v4-pro",
      shards: [
        { id: "reviewer-scope-shard-001", status: "pending" },
        { id: "reviewer-scope-shard-002", status: "pending" }
      ]
    }
  };
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: `event-${artifact.id}`,
        type: "reviewer_scope_split",
        status: "planned",
        artifact_id: artifact.id,
        message: "Reviewer scope split into 2 bounded shard(s).",
        created_at: "2026-05-21T12:08:00.000Z",
        metadata: artifact.metadata
      }
    ],
    artifacts: [...input.manifest.artifacts, artifact]
  };
  input.artifact_ledger = {
    ...input.artifact_ledger,
    artifacts: [...input.artifact_ledger.artifacts, artifact]
  };

  const projection = createWorkbenchProjection(input);
  const mobile = createMobileWorkbenchProjection(input);

  assert.equal(projection.reviewer_scope_split.status, "planned");
  assert.equal(projection.reviewer_scope_split.shard_count, 2);
  assert.equal(projection.reviewer_scope_split.pending_shards, 2);
  assert.equal(projection.reviewer_scope_split.next_shard, "reviewer-scope-shard-001");
  assert.equal(projection.one_screen.counters.reviewer_scope_shards, 2);
  assert.equal(mobile.scope_split.next_shard, "reviewer-scope-shard-001");
});

test("workbench projection exposes reviewer shard aggregate status", () => {
  const input = baseInput();
  const splitArtifact = {
    id: "reviewer-scope-split-run-projection-cycle-20260521-001",
    type: "evaluation",
    status: "pass",
    uri: "codex://reviewer-scope-split/run-projection/cycle-20260521/reviewer-scope-split-run-projection-cycle-20260521-001",
    producer: "reviewer-scope-splitter",
    created_at: "2026-05-21T12:08:00.000Z",
    metadata: {
      type: "reviewer_scope_split",
      status: "pass",
      shard_count: 2,
      pending_shards: 2,
      shards: [
        { id: "reviewer-scope-shard-001", status: "pending" },
        { id: "reviewer-scope-shard-002", status: "pending" }
      ]
    }
  };
  const aggregateArtifact = {
    id: "reviewer-shard-aggregate-run-projection-cycle-20260521-001",
    type: "review",
    status: "fail",
    uri: "codex://reviewer-shard-aggregate/run-projection/cycle-20260521/reviewer-shard-aggregate-run-projection-cycle-20260521-001",
    producer: "reviewer-shard-aggregate",
    created_at: "2026-05-21T12:12:00.000Z",
    metadata: {
      type: "reviewer_shard_aggregate",
      status: "fail",
      total_shards: 2,
      completed_shards: 2,
      pending_shards: 0,
      finding_count: 1,
      failed_finding_count: 1
    }
  };
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: `event-${splitArtifact.id}`,
        type: "reviewer_scope_split",
        status: "planned",
        artifact_id: splitArtifact.id,
        created_at: splitArtifact.created_at,
        metadata: splitArtifact.metadata
      },
      {
        id: "event-reviewer-scope-shard-001",
        type: "reviewer_shard_result",
        status: "pass",
        created_at: "2026-05-21T12:10:00.000Z",
        metadata: { shard_id: "reviewer-scope-shard-001", status: "pass" }
      },
      {
        id: "event-reviewer-scope-shard-002",
        type: "reviewer_shard_result",
        status: "fail",
        created_at: "2026-05-21T12:11:00.000Z",
        metadata: {
          shard_id: "reviewer-scope-shard-002",
          status: "fail",
          executor_provenance: {
            executor_kind: "agent_invocation",
            execution_profile: "approved_bounded_real_reviewer",
            provider: "deepseek",
            model: "deepseek-v4-pro",
            external_call_budget_used: 1
          }
        }
      },
      {
        id: `event-${aggregateArtifact.id}`,
        type: "reviewer_shard_aggregate",
        status: "fail",
        artifact_id: aggregateArtifact.id,
        created_at: aggregateArtifact.created_at,
        metadata: aggregateArtifact.metadata
      }
    ],
    artifacts: [...input.manifest.artifacts, splitArtifact, aggregateArtifact]
  };
  input.artifact_ledger = {
    ...input.artifact_ledger,
    artifacts: [...input.artifact_ledger.artifacts, splitArtifact, aggregateArtifact]
  };

  const projection = createWorkbenchProjection(input);
  const mobile = createMobileWorkbenchProjection(input);

  assert.equal(projection.reviewer_shard_review.status, "fail");
  assert.equal(projection.reviewer_shard_review.completed_shards, 2);
  assert.equal(projection.reviewer_shard_review.pending_shards, 0);
  assert.equal(projection.reviewer_shard_review.failed_finding_count, 1);
  assert.equal(projection.reviewer_shard_review.latest_executor_kind, "agent_invocation");
  assert.equal(projection.reviewer_shard_review.latest_execution_profile, "approved_bounded_real_reviewer");
  assert.equal(projection.reviewer_shard_review.latest_external_call_budget_used, 1);
  assert.equal(projection.one_screen.counters.reviewer_shards_completed, 2);
  assert.equal(mobile.shard_review.failed_finding_count, 1);
  assert.equal(mobile.shard_review.latest_executor_kind, "agent_invocation");
  assert.equal(projection.next_action_readout.action, "continue_after_reviewer_aggregate");
});

test("workbench projection advances from reviewer aggregate continuation fact", () => {
  const input = baseInput();
  const aggregateArtifact = {
    id: "reviewer-shard-aggregate-run-projection-cycle-20260521-001",
    type: "review",
    status: "pass",
    uri: "codex://reviewer-shard-aggregate/run-projection/cycle-20260521/reviewer-shard-aggregate-run-projection-cycle-20260521-001",
    producer: "reviewer-shard-aggregate",
    created_at: "2026-05-21T12:12:00.000Z",
    metadata: {
      type: "reviewer_shard_aggregate",
      status: "pass",
      total_shards: 2,
      completed_shards: 2,
      pending_shards: 0,
      finding_count: 0,
      failed_finding_count: 0,
      merged_findings: []
    }
  };
  const continuationArtifact = {
    id: "project-status-continuation-after-reviewer-aggregate",
    type: "evaluation",
    status: "pass",
    uri: "project-status://continuation/run-projection/cycle-20260521/project-status-continuation-after-reviewer-aggregate",
    producer: "project-status-continuation",
    created_at: "2026-05-21T12:13:00.000Z",
    metadata: {
      type: "project_status_continuation",
      version: "project-status-continuation.v1",
      status: "ready",
      next_work_package_count: 1
    }
  };
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: `event-${aggregateArtifact.id}`,
        type: "reviewer_shard_aggregate",
        status: "pass",
        artifact_id: aggregateArtifact.id,
        created_at: aggregateArtifact.created_at,
        metadata: aggregateArtifact.metadata
      },
      {
        id: `event-${continuationArtifact.id}`,
        type: "project_status_continuation",
        status: "ready",
        artifact_id: continuationArtifact.id,
        created_at: continuationArtifact.created_at,
        metadata: continuationArtifact.metadata
      }
    ],
    artifacts: [...input.manifest.artifacts, aggregateArtifact, continuationArtifact]
  };
  input.artifact_ledger = {
    ...input.artifact_ledger,
    artifacts: [...input.artifact_ledger.artifacts, aggregateArtifact, continuationArtifact]
  };

  const projection = createWorkbenchProjection(input);

  assert.equal(projection.operations_timeline.latest_driver.type, "reviewer_shard_aggregate");
  assert.equal(projection.operations_timeline.latest.type, "project_status_continuation");
  assert.equal(projection.next_action_readout.status, "ready");
  assert.equal(projection.next_action_readout.action, "create_context_pack_from_seed");
  assert.equal(projection.next_action_readout.source_type, "project_status_continuation");
});

test("workbench projection advances next reviewer shard after partial result", () => {
  const input = baseInput();
  const splitArtifact = {
    id: "reviewer-scope-split-partial",
    type: "evaluation",
    status: "pass",
    uri: "codex://reviewer-scope-split/partial",
    producer: "reviewer-scope-split",
    created_at: "2026-05-21T12:05:00.000Z",
    metadata: {
      type: "reviewer_scope_split",
      status: "pass",
      shard_count: 2,
      pending_shards: 2,
      shards: [
        { id: "reviewer-scope-shard-001", status: "pending" },
        { id: "reviewer-scope-shard-002", status: "pending" }
      ]
    }
  };
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: "event-reviewer-scope-split-partial",
        type: "reviewer_scope_split",
        status: "pass",
        artifact_id: splitArtifact.id,
        created_at: splitArtifact.created_at,
        metadata: splitArtifact.metadata
      },
      {
        id: "event-reviewer-scope-shard-partial-001",
        type: "reviewer_shard_result",
        status: "pass",
        created_at: "2026-05-21T12:06:00.000Z",
        metadata: { shard_id: "reviewer-scope-shard-001", status: "pass" }
      }
    ],
    artifacts: [...input.manifest.artifacts, splitArtifact]
  };
  input.artifact_ledger = {
    ...input.artifact_ledger,
    artifacts: [...input.artifact_ledger.artifacts, splitArtifact]
  };

  const projection = createWorkbenchProjection(input);

  assert.equal(projection.reviewer_shard_review.completed_shards, 1);
  assert.equal(projection.reviewer_shard_review.pending_shards, 1);
  assert.equal(projection.reviewer_shard_review.next_shard, "reviewer-scope-shard-002");
});

test("workbench projection exposes compact operations timeline", () => {
  const input = baseInput();
  const dispatchArtifact = {
    id: "scheduler-dispatch-run-projection-cycle-20260521-001",
    type: "evaluation",
    status: "pass",
    uri: "scheduler-dispatch://run/run-projection/cycle-20260521/scheduler-dispatch-run-projection-cycle-20260521-001",
    producer: "scheduler-dispatch-runner",
    created_at: "2026-05-22T02:10:00.000Z",
    metadata: {
      type: "scheduler_dispatch_run",
      status: "pass",
      phase: "completed",
      result: { steps: [{ id: "run-reviewer-shard-loop" }] }
    }
  };
  const resumeArtifact = {
    id: "scheduler-loop-resume-attempt-run-projection-cycle-20260521-001",
    type: "evaluation",
    status: "pass",
    uri: "scheduler-loop://resume-attempt/run-projection/cycle-20260521/scheduler-loop-resume-attempt-run-projection-cycle-20260521-001",
    producer: "autonomous-scheduler-loop",
    created_at: "2026-05-22T02:11:00.000Z",
    metadata: {
      type: "scheduler_loop_resume_attempt",
      version: "scheduler-loop-resume-attempt.v1",
      status: "pass",
      resume_projection_id: "next-projection",
      issues: []
    }
  };
  const providerArtifact = {
    id: "reviewer-provider-health-run-projection-cycle-20260521-001",
    type: "evaluation",
    status: "pass",
    uri: "codex://reviewer-provider-health/run-projection/cycle-20260521/reviewer-provider-health-run-projection-cycle-20260521-001",
    producer: "reviewer-provider-health",
    created_at: "2026-05-22T02:12:00.000Z",
    metadata: {
      type: "reviewer_provider_health",
      status: "retry",
      provider_health: "healthy",
      scheduled_actions: ["split_scope"]
    }
  };
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: `event-${dispatchArtifact.id}`,
        type: "scheduler_dispatch_run",
        status: "pass",
        artifact_id: dispatchArtifact.id,
        created_at: dispatchArtifact.created_at,
        metadata: dispatchArtifact.metadata
      },
      {
        id: `event-${resumeArtifact.id}`,
        type: "scheduler_loop_resume_attempt",
        status: "pass",
        artifact_id: resumeArtifact.id,
        created_at: resumeArtifact.created_at,
        metadata: resumeArtifact.metadata
      },
      {
        id: `event-${providerArtifact.id}`,
        type: "reviewer_provider_health",
        status: "retry",
        artifact_id: providerArtifact.id,
        created_at: providerArtifact.created_at,
        metadata: providerArtifact.metadata
      }
    ],
    artifacts: [...input.manifest.artifacts, dispatchArtifact, resumeArtifact, providerArtifact]
  };
  input.artifact_ledger = {
    ...input.artifact_ledger,
    artifacts: [...input.artifact_ledger.artifacts, dispatchArtifact, resumeArtifact, providerArtifact]
  };

  const projection = createWorkbenchProjection(input);
  const mobile = createMobileWorkbenchProjection(input);

  assert.equal(projection.operations_timeline.status, "available");
  assert.equal(projection.operations_timeline.count, 3);
  assert.equal(projection.operations_timeline.group_counts.scheduler, 2);
  assert.equal(projection.operations_timeline.group_counts.reviewer_recovery, 1);
  assert.equal(projection.operations_timeline.driver_count, 2);
  assert.equal(projection.operations_timeline.operator_only_count, 1);
  assert.equal(projection.operations_timeline.items[0].type, "scheduler_dispatch_run");
  assert.equal(projection.operations_timeline.items[0].next_action_role, "operator_observable");
  assert.equal(projection.operations_timeline.items[1].type, "scheduler_loop_resume_attempt");
  assert.equal(projection.operations_timeline.items[1].group, "scheduler");
  assert.equal(projection.operations_timeline.items[1].next_action_role, "automation_driver");
  assert.equal(projection.operations_timeline.latest.type, "reviewer_provider_health");
  assert.equal(projection.operations_timeline.latest.group, "reviewer_recovery");
  assert.equal(projection.operations_timeline.latest_driver.type, "reviewer_provider_health");
  assert.equal(projection.next_action_readout.status, "ready");
  assert.equal(projection.next_action_readout.action, "split_scope");
  assert.equal(projection.next_action_readout.source_type, "reviewer_provider_health");
  assert.equal(projection.one_screen.counters.operation_events, 3);
  assert.equal(projection.one_screen.recommended_action, "split_scope");
  assert.equal(mobile.operations_timeline.status, "available");
  assert.equal(mobile.operations_timeline.latest.type, "reviewer_provider_health");
  assert.equal(mobile.next_action_readout.action, "split_scope");
});

test("workbench operations timeline follows manifest order across clock skew", () => {
  const input = baseInput();
  const reviewerArtifact = {
    id: "reviewer-scope-split-clock-skew",
    type: "evaluation",
    status: "pass",
    uri: "codex://reviewer-scope-split/clock-skew",
    producer: "reviewer-scope-splitter",
    created_at: "2026-05-22T20:20:30.000Z",
    metadata: {
      type: "reviewer_scope_split",
      status: "planned",
      shard_count: 2,
      shards: [{ id: "reviewer-scope-shard-001" }]
    }
  };
  const continuationArtifact = {
    id: "scheduler-dispatch-continuation-clock-skew",
    type: "evaluation",
    status: "pass",
    uri: "scheduler-dispatch://continuation/clock-skew",
    producer: "scheduler-dispatch-continuation",
    created_at: "2026-05-22T17:36:04.000Z",
    metadata: {
      type: "scheduler_dispatch_continuation",
      status: "ready",
      next_decision: { action: "rerun", next_work_packages: [{ id: "next" }] }
    }
  };
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: `event-${reviewerArtifact.id}`,
        type: "reviewer_scope_split",
        status: "planned",
        artifact_id: reviewerArtifact.id,
        created_at: reviewerArtifact.created_at,
        metadata: reviewerArtifact.metadata
      },
      {
        id: `event-${continuationArtifact.id}`,
        type: "scheduler_dispatch_continuation",
        status: "pass",
        artifact_id: continuationArtifact.id,
        created_at: continuationArtifact.created_at,
        metadata: continuationArtifact.metadata
      }
    ],
    artifacts: [...input.manifest.artifacts, reviewerArtifact, continuationArtifact]
  };
  input.artifact_ledger = {
    ...input.artifact_ledger,
    artifacts: [...input.artifact_ledger.artifacts, reviewerArtifact, continuationArtifact]
  };

  const projection = createWorkbenchProjection(input);

  assert.equal(projection.operations_timeline.items.at(-1).type, "scheduler_dispatch_continuation");
  assert.equal(projection.operations_timeline.latest_driver.type, "scheduler_dispatch_continuation");
  assert.equal(projection.next_action_readout.action, "enqueue_scheduler_next_cycle");
});

test("workbench projection ingests operator events before summarizing run state", () => {
  const input = baseInput({
    operator_event_ledger: {
      version: "operator-events.v1",
      events: [
        {
          id: "operator-event-projection-validate",
          action: "validate",
          run_id: "run-projection",
          cycle_id: "cycle-20260521",
          created_at: "2026-05-21T00:02:00.000Z",
          metadata: {
            projection_id: "current"
          }
        }
      ]
    }
  });

  const projection = createWorkbenchProjection(input);

  assert.equal(projection.status, "rerun");
  assert.equal(projection.operator_events.status, "pass");
  assert.equal(projection.operator_events.applied_run_events, 1);
  assert.equal(projection.operator_events.applied_artifacts, 1);
  assert.equal(projection.manifest.event_count, 1);
  assert.equal(projection.artifacts.total, 2);
  assert.equal(projection.artifacts.by_type.evaluation, 1);
  assert.equal(projection.autonomous_run.summaries.artifacts.total, 2);
});

test("workbench projection ignores stale run result when operator events are present", () => {
  const input = baseInput({
    run_result: {
      run_id: "run-projection",
      cycle_id: "cycle-20260521",
      work_packages: [],
      artifacts: [{ id: "stale", status: "pass" }],
      gate_results: [],
      review_findings: [],
      recovery_attempts: []
    },
    run_evaluation: {
      run_id: "run-projection",
      cycle_id: "cycle-20260521",
      status: "pass",
      decision: "pass",
      reasons: ["stale pass"],
      projection: {
        summaries: {
          artifacts: { total: 1, passed: 1, failed: 0, unknown: 0 }
        }
      }
    },
    operator_event_ledger: {
      version: "operator-events.v1",
      events: [
        {
          id: "operator-event-projection-validate",
          action: "validate",
          run_id: "run-projection",
          cycle_id: "cycle-20260521",
          created_at: "2026-05-21T00:02:00.000Z"
        }
      ]
    }
  });

  const projection = createWorkbenchProjection(input);

  assert.equal(projection.operator_events.applied_artifacts, 1);
  assert.equal(projection.artifacts.total, 2);
  assert.equal(projection.autonomous_run.summaries.artifacts.total, 2);
  assert.notDeepEqual(projection.reasons, ["stale pass"]);
});

test("workbench projection can use explicit run evaluation when no operator events are present", () => {
  const projection = createWorkbenchProjection(
    baseInput({
      run_evaluation: {
        run_id: "run-projection",
        cycle_id: "cycle-20260521",
        status: "pass",
        decision: "pass",
        reasons: ["explicit evaluation"],
        projection: {
          run_id: "run-projection",
          cycle_id: "cycle-20260521",
          status: "pass",
          decision: "pass",
          reasons: ["explicit evaluation"],
          blockers: [],
          summaries: {
            artifacts: { total: 1, passed: 1, failed: 0, unknown: 0 }
          }
        }
      }
    })
  );

  assert.equal(projection.status, "rerun");
  assert.deepEqual(projection.reasons, ["explicit evaluation"]);
});

test("workbench projection fails closed when operator event ingestion fails", () => {
  const projection = createWorkbenchProjection(
    baseInput({
      operator_event_ledger: {
        version: "operator-events.v1",
        events: [{ id: "orphan", action: "validate" }]
      }
    })
  );

  assert.equal(projection.status, "human_intervention");
  assert.equal(projection.operator_events.status, "fail");
  assert.ok(projection.operator_events.issues.some((issue) => issue.code === "missing_operator_event_field"));
  assert.equal(projection.manifest.event_count, 0);
  assert.equal(projection.artifacts.total, 1);
});

test("mobile projection keeps the one-screen subset", () => {
  const mobile = createMobileWorkbenchProjection(baseInput());

  assert.equal(mobile.projection_version, "workbench.mobile.v1");
  assert.equal(mobile.status, "rerun");
  assert.equal(mobile.model.selected_model, "gpt");
  assert.equal(mobile.reviewer.recommended_decision_signal, "rerun");
  assert.equal(mobile.resume_health.status, "not_configured");
  assert.equal(mobile.provider_health.status, "not_configured");
  assert.ok(mobile.next_actions.length <= 3);
});

test("projection input validation fails without durable sources", () => {
  const validation = validateWorkbenchProjectionInput({});
  const projection = createWorkbenchProjection({});

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some((issue) => issue.code === "missing_manifest"));
  assert.equal(projection.status, "human_intervention");
  assert.equal(projection.input_validation.status, "fail");
});

