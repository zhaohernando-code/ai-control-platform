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
  assert.equal(projection.one_screen.counters.resume_blockers, 0);
  assert.equal(projection.one_screen.counters.provider_health_events, 0);
  assert.equal(projection.one_screen.counters.scheduler_dispatch_steps, 0);
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
        metadata: { shard_id: "reviewer-scope-shard-002", status: "fail" }
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
  assert.equal(projection.one_screen.counters.reviewer_shards_completed, 2);
  assert.equal(mobile.shard_review.failed_finding_count, 1);
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
