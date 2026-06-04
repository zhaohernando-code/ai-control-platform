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
