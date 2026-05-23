import assert from "node:assert/strict";
import test from "node:test";

import { createArtifactLedger } from "../src/workflow/artifact-ledger.js";
import { createReviewerGateRequest, createReviewerTimeoutFinding } from "../src/workflow/llm-reviewer-gate.js";
import { buildModelCollaborationPlan } from "../src/workflow/model-router.js";
import { createRunManifest } from "../src/workflow/run-manifest.js";
import {
  createMobileWorkbenchProjection,
  createWorkbenchProjection,
  validateWorkbenchProjectionInput
} from "../src/workflow/workbench-projection.js";

function contextPack() {
  return {
    requirement_summary: "继续开发新中台：构建工作台 projection assembler",
    host: "platform_core",
    target_project_id: "ai-control-platform",
    non_goals: ["不修改 stock_dashboard", "不开发孤立 UI"],
    forbidden_actions: ["不得写入业务项目", "不得把 reviewer timeout 作为人工阻塞"],
    owned_files: ["src/workflow/workbench-projection.js", "test/workbench-projection.test.js"],
    acceptance_gates: ["node --test test/workbench-projection.test.js"],
    rollback_conditions: ["projection 丢失 run decision"],
    subtasks: [
      {
        id: "projection-runtime",
        title: "Workbench projection assembler runtime",
        owned_files: ["src/workflow/workbench-projection.js"]
      },
      {
        id: "projection-test",
        title: "Workbench projection tests",
        owned_files: ["test/workbench-projection.test.js"],
        depends_on: ["projection-runtime"]
      }
    ]
  };
}

function baseInput(overrides = {}) {
  const reviewerRequest = createReviewerGateRequest({
    run_id: "run-projection",
    cycle_id: "cycle-20260521",
    scope: "Review workbench projection assembler.",
    files: ["src/workflow/workbench-projection.js"],
    questions: ["projection 是否包含运行、模型、reviewer 和 DAG 状态？"]
  });
  const timeoutFinding = createReviewerTimeoutFinding(reviewerRequest, 120);
  const manifest = createRunManifest({
    run_id: "run-projection",
    cycle_id: "cycle-20260521",
    goal: "构建工作台 projection assembler",
    context_pack: contextPack(),
    work_packages: [
      { id: "projection-runtime", status: "completed", owned_files: ["src/workflow/workbench-projection.js"] },
      { id: "projection-test", status: "completed", owned_files: ["test/workbench-projection.test.js"] }
    ],
    artifacts: [{ id: "projection-patch", status: "pass" }],
    gate_results: [{ gate_id: "unit-tests", status: "pass" }],
    review_findings: [timeoutFinding],
    recovery_attempts: []
  });

  return {
    manifest,
    artifact_ledger: createArtifactLedger({
      run_id: "run-projection",
      cycle_id: "cycle-20260521",
      artifacts: [
        {
          id: "projection-patch",
          type: "patch",
          status: "pass",
          path: "src/workflow/workbench-projection.js",
          producer: "main-process",
          created_at: "2026-05-21T00:00:00.000Z"
        }
      ]
    }),
    model_plan: buildModelCollaborationPlan({
      goal: "构建工作台 projection assembler",
      stage: "implementation",
      risk: "high",
      budget_tier: "high",
      host: "platform_core",
      tags: ["boundary_sensitive"]
    }),
    reviewer_gate: {
      request: reviewerRequest,
      findings: [timeoutFinding]
    },
    task_dag: manifest.work_packages,
    generated_at: "2026-05-21T00:01:00.000Z",
    ...overrides
  };
}

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
  assert.equal(projection.projected_action_progress.status, "not_configured");
  assert.equal(projection.agent_lifecycle_pool.status, "not_configured");
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

test("workbench projection and mobile expose agent lifecycle pool cleanup readout", () => {
  const input = baseInput();
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: "worker-spawned-1",
        type: "WorkerSpawned",
        status: "pass",
        created_at: "2026-05-21T00:05:00.000Z",
        metadata: {
          pool_id: "pool-agent-lifecycle",
          worker_id: "child-1"
        }
      },
      {
        id: "worker-completed-1",
        type: "WorkerCompleted",
        status: "pass",
        created_at: "2026-05-21T00:06:00.000Z",
        metadata: {
          pool_id: "pool-agent-lifecycle",
          worker_id: "child-1"
        }
      }
    ]
  };

  const projection = createWorkbenchProjection(input);
  const mobile = createMobileWorkbenchProjection(input);

  assert.equal(projection.agent_lifecycle_pool.status, "unevaluated");
  assert.equal(projection.agent_lifecycle_pool.spawned, 1);
  assert.equal(projection.agent_lifecycle_pool.unevaluated, 1);
  assert.equal(projection.agent_lifecycle_pool.unclosed, 1);
  assert.equal(projection.operations_timeline.group_counts.agent_lifecycle_pool, 2);
  assert.equal(projection.operations_timeline.latest.type, "WorkerCompleted");
  assert.equal(projection.next_action_readout.status, "ready");
  assert.equal(projection.next_action_readout.action, "cleanup_agent_lifecycle_pool");
  assert.equal(projection.next_action_readout.source_type, "agent_lifecycle_pool");
  assert.equal(projection.one_screen.counters.agent_lifecycle_unevaluated, 1);
  assert.equal(mobile.agent_lifecycle_pool.status, "unevaluated");
  assert.equal(mobile.next_action_readout.action, "cleanup_agent_lifecycle_pool");
});

test("workbench projection and mobile expose agent lifecycle heartbeat and timeout readout", () => {
  const input = baseInput();
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: "worker-spawned-timeout-1",
        type: "WorkerSpawned",
        status: "pass",
        created_at: "2026-05-21T00:05:00.000Z",
        metadata: {
          pool_id: "pool-agent-lifecycle-timeout",
          worker_id: "child-timeout-1"
        }
      },
      {
        id: "worker-heartbeat-timeout-1",
        type: "WorkerHeartbeat",
        status: "pass",
        created_at: "2026-05-21T00:06:00.000Z",
        metadata: {
          pool_id: "pool-agent-lifecycle-timeout",
          worker_id: "child-timeout-1"
        }
      },
      {
        id: "worker-timeout-1",
        type: "WorkerTimeout",
        status: "fail",
        created_at: "2026-05-21T00:08:00.000Z",
        metadata: {
          pool_id: "pool-agent-lifecycle-timeout",
          worker_id: "child-timeout-1",
          issues: [{ code: "agent_lifecycle_worker_timeout", message: "child timed out" }]
        }
      }
    ]
  };

  const projection = createWorkbenchProjection(input);
  const mobile = createMobileWorkbenchProjection(input);

  assert.equal(projection.agent_lifecycle_pool.status, "blocked");
  assert.equal(projection.agent_lifecycle_pool.heartbeat_count, 1);
  assert.equal(projection.agent_lifecycle_pool.timed_out, 1);
  assert.equal(projection.agent_lifecycle_pool.latest_heartbeat_at, "2026-05-21T00:06:00.000Z");
  assert.equal(projection.agent_lifecycle_pool.latest_timeout_at, "2026-05-21T00:08:00.000Z");
  assert.equal(projection.agent_lifecycle_pool.timed_out_workers[0].worker_id, "child-timeout-1");
  assert.equal(projection.one_screen.counters.agent_lifecycle_timed_out, 1);
  assert.equal(projection.one_screen.counters.agent_lifecycle_heartbeats, 1);
  assert.equal(projection.next_action_readout.status, "blocked");
  assert.equal(projection.next_action_readout.action, "cleanup_agent_lifecycle_pool");
  assert.equal(mobile.agent_lifecycle_pool.timed_out, 1);
  assert.equal(mobile.agent_lifecycle_pool.heartbeat_count, 1);
  assert.equal(mobile.agent_lifecycle_pool.latest_heartbeat_at, "2026-05-21T00:06:00.000Z");
  assert.equal(mobile.agent_lifecycle_pool.latest_timeout_at, "2026-05-21T00:08:00.000Z");
  assert.equal(mobile.agent_lifecycle_pool.timed_out_workers[0].worker_id, "child-timeout-1");
});

test("workbench projection exposes headless child provider retry and split evidence", () => {
  const input = baseInput();
  const artifact = {
    id: "context-work-packages-run-headless-provider",
    type: "evaluation",
    status: "pass",
    uri: "context-work-packages://run/run-projection/cycle-20260521/context-work-packages-run-headless-provider",
    producer: "context-work-package-runner",
    created_at: "2026-05-21T00:07:00.000Z",
    metadata: {
      type: "context_work_packages_run",
      status: "pass",
      executed_count: 1,
      package_results: [
        {
          work_package_id: "projection-runtime",
          status: "pass",
          completion_evidence: {
            child_output: {
              command_evidence: {
                attempts: [
                  { attempt: 1, status: "fail", exit_code: 1, split_retry: false },
                  { attempt: 2, status: "pass", exit_code: 0, split_retry: true }
                ]
              }
            }
          }
        }
      ],
      executor_provenance: {
        executor_kind: "codex_proxy_cli_worker",
        command_runner_kind: "codex_proxy_child_process",
        provider: "codex_proxy",
        model: "codex-cli",
        retry_policy: {
          max_attempts: 2,
          split_retry: true
        },
        external_calls: 1
      }
    }
  };
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: `event-${artifact.id}`,
        type: "context_work_packages_run",
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

  assert.equal(projection.headless_child_provider.status, "pass");
  assert.equal(projection.headless_child_provider.provider, "codex_proxy");
  assert.equal(projection.headless_child_provider.command_runner_kind, "codex_proxy_child_process");
  assert.equal(projection.headless_child_provider.max_attempts, 2);
  assert.equal(projection.headless_child_provider.split_retry, true);
  assert.equal(projection.headless_child_provider.package_count, 1);
  assert.equal(projection.headless_child_provider.accepted_count, 1);
  assert.equal(projection.headless_child_provider.attempt_count, 2);
  assert.equal(projection.headless_child_provider.retry_attempt_count, 1);
  assert.equal(projection.headless_child_provider.split_retry_attempt_count, 1);
  assert.equal(projection.one_screen.counters.headless_child_attempts, 2);
  assert.equal(projection.one_screen.counters.headless_child_retry_attempts, 1);
  assert.equal(mobile.headless_child_provider.attempt_count, 2);
  assert.equal(mobile.headless_child_provider.split_retry_attempt_count, 1);
});

test("workbench projection exposes headless projected action progress evidence", () => {
  const input = baseInput();
  const artifact = {
    id: "headless-projected-action-run-projection-cycle-20260521-001",
    type: "evaluation",
    status: "pass",
    uri: "headless-cli://projected-action/run-projection/cycle-20260521/headless-projected-action-run-projection-cycle-20260521-001",
    producer: "headless-cli-orchestrator",
    created_at: "2026-05-21T00:08:00.000Z",
    metadata: {
      type: "headless_projected_action_progress",
      status: "executed",
      action: "run_reviewer_scope_shard",
      next_projection_id: "headless-loop-current-01",
      has_workflow_state: true,
      has_projection: true,
      issues: []
    }
  };
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: `event-${artifact.id}`,
        type: "headless_projected_action_progress",
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

  assert.equal(projection.projected_action_progress.status, "executed");
  assert.equal(projection.projected_action_progress.action, "run_reviewer_scope_shard");
  assert.equal(projection.projected_action_progress.next_projection_id, "headless-loop-current-01");
  assert.equal(projection.projected_action_progress.has_workflow_state, true);
  assert.equal(projection.projected_action_progress.has_projection, true);
  assert.equal(projection.operations_timeline.group_counts.headless_orchestrator, 1);
  assert.equal(projection.one_screen.counters.projected_action_progress_events, 1);
  assert.equal(mobile.projected_action_progress.action, "run_reviewer_scope_shard");
  assert.equal(mobile.projected_action_progress.has_projection, true);
});

test("workbench projection exposes global goal completion for autonomous continuation", () => {
  const projection = createWorkbenchProjection(baseInput({
    project_status: {
      project: "ai-control-platform",
      next_step: "",
      global_goals: [
        { id: "foundation", title: "Foundation", status: "completed" },
        {
          id: "completion-loop",
          title: "Completion loop",
          status: "in_progress",
          next_step: "Continue detecting unfinished platform goals."
        }
      ]
    }
  }));
  const mobile = createMobileWorkbenchProjection(baseInput({
    project_status: {
      project: "ai-control-platform",
      global_goals: [
        { id: "foundation", title: "Foundation", status: "completed" },
        { id: "completion-loop", title: "Completion loop", status: "in_progress" }
      ]
    }
  }));

  assert.equal(projection.global_goal_completion.status, "in_progress");
  assert.equal(projection.global_goal_completion.completed, 1);
  assert.equal(projection.global_goal_completion.pending, 1);
  assert.equal(projection.global_goal_completion.next_goal.id, "completion-loop");
  assert.equal(projection.next_action_readout.status, "ready");
  assert.equal(projection.next_action_readout.action, "prepare_project_status_continuation");
  assert.equal(projection.next_action_readout.source_type, "global_goal_completion");
  assert.equal(projection.one_screen.counters.global_goals_completed, 1);
  assert.equal(projection.one_screen.counters.global_goals_pending, 1);
  assert.equal(mobile.global_goal_completion.pending, 1);
});

test("workbench projection advances from prepared project status continuation to context pack seed", () => {
  const input = baseInput();
  const artifact = {
    id: "project-status-continuation-run-projection-cycle-20260521-001",
    type: "evaluation",
    status: "pass",
    uri: "project-status://continuation/run-projection/cycle-20260521/project-status-continuation-run-projection-cycle-20260521-001",
    producer: "project-status-continuation",
    created_at: "2026-05-21T00:03:00.000Z",
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
        id: `event-${artifact.id}`,
        type: "project_status_continuation",
        status: "ready",
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

  assert.equal(projection.operations_timeline.latest.type, "project_status_continuation");
  assert.equal(projection.next_action_readout.status, "ready");
  assert.equal(projection.next_action_readout.action, "create_context_pack_from_seed");
  assert.equal(projection.next_action_readout.source_type, "project_status_continuation");
});

test("workbench projection exposes materialized context pack cycle as ready execution", () => {
  const input = baseInput();
  const artifact = {
    id: "context-pack-cycle-run-projection-cycle-20260521-001",
    type: "context_pack",
    status: "pass",
    uri: "context-pack://cycle/run-projection/cycle-context/context-pack-cycle-run-projection-cycle-context-001",
    producer: "context-pack-cycle",
    created_at: "2026-05-21T00:04:00.000Z",
    metadata: {
      type: "context_pack_cycle",
      version: "context-pack-cycle.v1",
      status: "ready",
      cycle_id: "cycle-context",
      work_package_count: 2
    }
  };
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: `event-${artifact.id}`,
        type: "context_pack_cycle_created",
        status: "ready",
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
  input.task_dag = [
    {
      id: "context-runtime",
      title: "Run context runtime package",
      status: "pending",
      action: "implement",
      owned_files: ["src/workflow/context-work-package-runner.js"]
    },
    {
      id: "context-tests",
      title: "Run context runner tests",
      status: "pending",
      action: "test",
      depends_on: ["context-runtime"],
      owned_files: ["test/context-work-package-runner.test.js"]
    }
  ];

  const projection = createWorkbenchProjection(input);

  assert.equal(projection.operations_timeline.latest.type, "context_pack_cycle_created");
  assert.equal(projection.next_action_readout.status, "ready");
  assert.equal(projection.next_action_readout.action, "run_context_work_packages");
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
            executor_kind: "claude_deepseek",
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
  assert.equal(projection.reviewer_shard_review.latest_executor_kind, "claude_deepseek");
  assert.equal(projection.reviewer_shard_review.latest_execution_profile, "approved_bounded_real_reviewer");
  assert.equal(projection.reviewer_shard_review.latest_external_call_budget_used, 1);
  assert.equal(projection.one_screen.counters.reviewer_shards_completed, 2);
  assert.equal(mobile.shard_review.failed_finding_count, 1);
  assert.equal(mobile.shard_review.latest_executor_kind, "claude_deepseek");
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

test("workbench projection exposes scheduler dispatch run status", () => {
  const input = baseInput();
  const artifact = {
    id: "scheduler-dispatch-run-run-projection-cycle-20260521-001",
    type: "evaluation",
    status: "pass",
    uri: "scheduler-dispatch://run/run-projection/cycle-20260521/scheduler-dispatch-run-run-projection-cycle-20260521-001",
    producer: "scheduler-dispatch-runner",
    created_at: "2026-05-21T22:38:00.000Z",
    metadata: {
      type: "scheduler_dispatch_run",
      status: "pass",
      phase: "completed",
      result: {
        steps: [
          { id: "run-reviewer-shard-loop", status: "pass", dry_run: false },
          { id: "prepare-reviewer-shard-loop-continuation", status: "pass", dry_run: false },
          {
            id: "run-autonomous-closeout-loop",
            status: "pass",
            dry_run: false,
            outputs: {
              autonomous_closeout_loop_artifact: {
                status: "available",
                phase: "next_continuation",
                next_decision_status: "pass",
                next_decision_action: "rerun",
                should_continue: true,
                next_work_package_count: 2
              }
            }
          }
        ]
      }
    }
  };
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: `event-${artifact.id}`,
        type: "scheduler_dispatch_run",
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

  assert.equal(projection.scheduler_dispatch.status, "pass");
  assert.equal(projection.scheduler_dispatch.phase, "completed");
  assert.equal(projection.scheduler_dispatch.step_count, 3);
  assert.equal(projection.scheduler_dispatch.failed_step_count, 0);
  assert.equal(projection.scheduler_dispatch.dry_run, false);
  assert.equal(projection.scheduler_dispatch.next_continuation_status, "pass");
  assert.equal(projection.scheduler_dispatch.next_continuation_action, "rerun");
  assert.equal(projection.scheduler_dispatch.next_work_package_count, 2);
  assert.equal(projection.one_screen.counters.scheduler_dispatch_steps, 3);
  assert.equal(mobile.scheduler_dispatch.step_count, 3);
  assert.equal(mobile.scheduler_dispatch.next_work_package_count, 2);
});

test("workbench projection exposes scheduler dispatch continuation readiness", () => {
  const input = baseInput();
  const continuationArtifact = {
    id: "scheduler-dispatch-continuation-run-projection-cycle-20260521-001",
    type: "evaluation",
    status: "pass",
    uri: "scheduler-dispatch://continuation/run-projection/cycle-20260521/scheduler-dispatch-continuation-run-projection-cycle-20260521-001",
    producer: "scheduler-dispatch-continuation",
    created_at: "2026-05-22T00:05:00.000Z",
    metadata: {
      type: "scheduler_dispatch_continuation",
      version: "scheduler-dispatch-continuation.v1",
      status: "ready",
      phase: "scheduler_dispatch_continuation",
      continuation_input_path: "tmp/scheduler/run-projection/scheduler-dispatch-continuation-input.json",
      next_step: "Continue next cycle.",
      next_work_package_count: 2,
      should_continue: true
    }
  };
  const enqueueArtifact = {
    id: "scheduler-next-cycle-enqueue-run-projection-cycle-20260521-001",
    type: "evaluation",
    status: "pass",
    uri: "scheduler-dispatch://next-cycle/run-projection/cycle-20260521/scheduler-next-cycle-enqueue-run-projection-cycle-20260521-001",
    producer: "workbench-server",
    created_at: "2026-05-22T00:06:00.000Z",
    metadata: {
      type: "scheduler_next_cycle_enqueue",
      version: "scheduler-next-cycle-enqueue.v1",
      status: "queued",
      continuation_input_path: "tmp/scheduler/run-projection/scheduler-dispatch-continuation-input.json",
      snapshot_id: "scheduler-next",
      next_step: "Continue next cycle.",
      next_work_package_count: 2,
      should_continue: true
    }
  };
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: `event-${continuationArtifact.id}`,
        type: "scheduler_dispatch_continuation",
        status: "ready",
        artifact_id: continuationArtifact.id,
        created_at: continuationArtifact.created_at,
        metadata: continuationArtifact.metadata
      },
      {
        id: `event-${enqueueArtifact.id}`,
        type: "scheduler_next_cycle_enqueue",
        status: "queued",
        artifact_id: enqueueArtifact.id,
        created_at: enqueueArtifact.created_at,
        metadata: enqueueArtifact.metadata
      }
    ],
    artifacts: [...input.manifest.artifacts, continuationArtifact, enqueueArtifact]
  };
  input.artifact_ledger = {
    ...input.artifact_ledger,
    artifacts: [...input.artifact_ledger.artifacts, continuationArtifact, enqueueArtifact]
  };

  const projection = createWorkbenchProjection(input);
  const mobile = createMobileWorkbenchProjection(input);

  assert.equal(projection.scheduler_continuation.status, "queued");
  assert.equal(projection.scheduler_continuation.continuation_status, "ready");
  assert.equal(projection.scheduler_continuation.ready, true);
  assert.equal(projection.scheduler_continuation.enqueue_status, "queued");
  assert.equal(projection.scheduler_continuation.next_work_package_count, 2);
  assert.equal(projection.one_screen.counters.scheduler_continuation_ready, 1);
  assert.equal(mobile.scheduler_continuation.ready, true);
  assert.equal(mobile.scheduler_continuation.enqueue_status, "queued");
});

test("workbench projection exposes autonomous scheduler loop runs", () => {
  const input = baseInput();
  const artifact = {
    id: "autonomous-scheduler-loop-run-projection-cycle-20260521-001",
    type: "evaluation",
    status: "pass",
    uri: "scheduler-loop://run/run-projection/cycle-20260521/autonomous-scheduler-loop-run-projection-cycle-20260521-001",
    producer: "autonomous-scheduler-loop",
    created_at: "2026-05-22T00:45:00.000Z",
    metadata: {
      type: "autonomous_scheduler_loop_run",
      version: "autonomous-scheduler-loop-run.v1",
      status: "pass",
      phase: "iteration_limit_reached",
      created_at: "2026-05-22T00:45:00.000Z",
      input: {
        start_projection_id: "current",
        max_iterations: 1,
        execution_profile: "approved_mock_non_dry_run",
        snapshot_prefix: "workbench-loop"
      },
      result: {
        status: "pass",
        phase: "iteration_limit_reached",
        issues: [],
        iterations: [
          {
            index: 1,
            projection_id: "current",
            status: "queued",
            next_projection_id: "workbench-loop-current-01"
          }
        ]
      }
    }
  };
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: `event-${artifact.id}`,
        type: "autonomous_scheduler_loop_run",
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

  assert.equal(projection.scheduler_loop.status, "pass");
  assert.equal(projection.scheduler_loop.phase, "iteration_limit_reached");
  assert.equal(projection.scheduler_loop.run_count, 1);
  assert.equal(projection.scheduler_loop.invalid_count, 0);
  assert.equal(projection.scheduler_loop.iteration_count, 1);
  assert.equal(projection.scheduler_loop.latest_iteration_status, "queued");
  assert.equal(projection.scheduler_loop.latest_projection_id, "workbench-loop-current-01");
  assert.equal(projection.scheduler_loop.recovery_status, "ready");
  assert.equal(projection.scheduler_loop.recovery_action, "resume_from_latest_projection");
  assert.equal(projection.scheduler_loop.resumable, true);
  assert.equal(projection.scheduler_loop.resume_projection_id, "workbench-loop-current-01");
  assert.equal(projection.scheduler_loop.execution_strategy, "scheduler_dispatch_chain");
  assert.equal(projection.scheduler_loop.execution_profile, "approved_mock_non_dry_run");
  assert.equal(projection.one_screen.counters.scheduler_loop_iterations, 1);
  assert.equal(mobile.scheduler_loop.status, "pass");
  assert.equal(mobile.scheduler_loop.latest_projection_id, "workbench-loop-current-01");
  assert.equal(mobile.scheduler_loop.recovery_status, "ready");
  assert.equal(mobile.scheduler_loop.execution_strategy, "scheduler_dispatch_chain");
  assert.equal(mobile.scheduler_loop.execution_profile, "approved_mock_non_dry_run");
});

test("workbench projection blocks invalid autonomous scheduler loop history", () => {
  const input = baseInput();
  const artifact = {
    id: "autonomous-scheduler-loop-run-invalid-cycle-20260521-001",
    type: "evaluation",
    status: "pass",
    uri: "scheduler-loop://run/run-projection/cycle-20260521/autonomous-scheduler-loop-run-invalid-cycle-20260521-001",
    producer: "autonomous-scheduler-loop",
    created_at: "2026-05-22T01:10:00.000Z",
    metadata: {
      type: "autonomous_scheduler_loop_run",
      version: "autonomous-scheduler-loop-run.v1",
      status: "pass",
      phase: "iteration_limit_reached",
      created_at: "2026-05-22T01:10:00.000Z",
      input: {
        start_projection_id: "current",
        max_iterations: 1,
        execution_profile: "approved_mock_non_dry_run",
        snapshot_prefix: "workbench-loop"
      },
      result: {
        status: "fail",
        phase: "iteration_limit_reached",
        issues: [],
        iterations: [
          {
            index: 1,
            projection_id: "current",
            status: "queued",
            next_projection_id: ""
          }
        ]
      }
    }
  };
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: `event-${artifact.id}`,
        type: "autonomous_scheduler_loop_run",
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

  assert.equal(projection.scheduler_loop.status, "invalid");
  assert.equal(projection.scheduler_loop.phase, "replay_validation");
  assert.equal(projection.scheduler_loop.invalid_count, 1);
  assert.equal(projection.scheduler_loop.recovery_status, "blocked");
  assert.equal(projection.scheduler_loop.recovery_action, "quarantine_invalid_loop_artifact");
  assert.equal(projection.scheduler_loop.resumable, false);
  assert.ok(projection.scheduler_loop.latest_issue);
  assert.equal(mobile.scheduler_loop.recovery_status, "blocked");
});

test("workbench projection exposes scheduler loop resume attempts", () => {
  const input = baseInput();
  const artifact = {
    id: "scheduler-loop-resume-attempt-run-projection-cycle-20260521-001",
    type: "evaluation",
    status: "fail",
    uri: "scheduler-loop://resume-attempt/run-projection/cycle-20260521/scheduler-loop-resume-attempt-run-projection-cycle-20260521-001",
    producer: "autonomous-scheduler-loop",
    created_at: "2026-05-22T02:00:00.000Z",
    metadata: {
      type: "scheduler_loop_resume_attempt",
      version: "scheduler-loop-resume-attempt.v1",
      status: "blocked",
      run_id: "run-projection",
      cycle_id: "cycle-20260521",
      source_projection_id: "source",
      resume_projection_id: "target",
      recovery_status: "blocked",
      recovery_action: "quarantine_invalid_loop_artifact",
      issues: [{ code: "invalid_loop", message: "loop artifact invalid", path: "scheduler_loop" }]
    }
  };
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: `event-${artifact.id}`,
        type: "scheduler_loop_resume_attempt",
        status: "blocked",
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

  assert.equal(projection.scheduler_loop.latest_resume_status, "blocked");
  assert.equal(projection.scheduler_loop.latest_resume_target, "target");
  assert.equal(projection.scheduler_loop.latest_resume_issue, "loop artifact invalid");
  assert.equal(mobile.scheduler_loop.latest_resume_status, "blocked");
  assert.equal(mobile.scheduler_loop.latest_resume_target, "target");
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

test("workbench projection exposes scheduler dispatch policy blockers", () => {
  const input = baseInput();
  const artifact = {
    id: "scheduler-dispatch-policy-run-projection-cycle-20260521-001",
    type: "evaluation",
    status: "fail",
    uri: "scheduler-dispatch://policy/run-projection/cycle-20260521/scheduler-dispatch-policy-run-projection-cycle-20260521-001",
    producer: "scheduler-dispatch-policy",
    created_at: "2026-05-21T23:40:00.000Z",
    metadata: {
      type: "scheduler_dispatch_policy",
      version: "scheduler-dispatch-policy.v1",
      status: "fail",
      execution_mode: "blocked",
      issues: [
        {
          code: "missing_operator_authorization",
          message: "non-dry-run scheduler dispatch requires approved_non_dry_run authorization",
          path: "operator_authorization"
        }
      ],
      plan_step_count: 3
    }
  };
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: `event-${artifact.id}`,
        type: "scheduler_dispatch_policy",
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

  assert.equal(projection.scheduler_dispatch.status, "blocked");
  assert.equal(projection.scheduler_dispatch.phase, "policy");
  assert.equal(projection.scheduler_dispatch.policy_status, "fail");
  assert.equal(projection.scheduler_dispatch.policy_execution_mode, "blocked");
  assert.equal(projection.scheduler_dispatch.policy_issue_count, 1);
  assert.match(projection.scheduler_dispatch.policy_latest_issue, /approved_non_dry_run/);
  assert.equal(mobile.scheduler_dispatch.policy_status, "fail");
  assert.equal(mobile.scheduler_dispatch.policy_issue_count, 1);
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
