import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertShouldContinue,
  COMPLETE,
  CONTINUE,
  decideContinuation,
  RERUN,
  ROLLBACK,
  STOP_FOR_HUMAN
} from "../src/workflow/autonomous-continuation.js";
import { materializeContextPackCycleFromWorkflowState } from "../src/workflow/context-pack-cycle.js";

function projectStatus(overrides = {}) {
  return {
    project: "ai-control-platform",
    blockers: [],
    next_step: "Start the PC/mobile workbench frontend shell against validated projection JSON.",
    ...overrides
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("continues when a completed run has a durable next step and no blockers", () => {
  const decision = assertShouldContinue({
    project_status: projectStatus(),
    run_evaluation: { status: "pass", next_work_packages: [] }
  });

  assert.equal(decision.action, CONTINUE);
  assert.equal(decision.should_continue, true);
  assert.equal(decision.context_pack_seed.target_project_id, "ai-control-platform");
  assert.match(decision.context_pack_seed.requirement_summary, /PC\/mobile workbench/);
});

test("does not stop just because a cycle summary was produced", () => {
  const decision = decideContinuation({
    project_status: projectStatus({
      next_step: "Generate the next run manifest from the accepted projection fixture."
    }),
    run_evaluation: {
      status: "pass",
      reasons: ["all gates passed"]
    },
    summary_emitted: true
  });

  assert.equal(decision.should_continue, true);
  assert.equal(decision.action, CONTINUE);
  assert.ok(decision.reasons.includes("project_status.next_step is present"));
});

test("reruns when autonomous run returns recoverable next work packages", () => {
  const decision = decideContinuation({
    project_status: projectStatus({ next_step: "" }),
    run_evaluation: {
      status: "rerun",
      next_work_packages: [
        {
          id: "rerun-reviewer",
          title: "Rerun reviewer gate with smaller scope",
          owned_files: ["src/workflow/llm-reviewer-gate.js"]
        }
      ]
    }
  });

  assert.equal(decision.action, RERUN);
  assert.equal(decision.should_continue, true);
  assert.equal(decision.context_pack_seed.subtasks[0].id, "rerun-reviewer");
});

test("current reviewer aggregate fixture advances after provider health follow-up packages", () => {
  const workflowState = readJson("docs/examples/current-session-workbench-input.json");
  const decision = decideContinuation({
    project_status: projectStatus({ next_step: "" }),
    run_evaluation: { status: "pass" },
    workflow_state: workflowState
  });

  assert.equal(decision.action, CONTINUE);
  assert.ok(!decision.next_work_packages.some((workPackage) => workPackage.id === "reviewer-provider-rerun-without-tools"));
  assert.ok(!decision.next_work_packages.some((workPackage) => workPackage.id === "reviewer-scope-shard-001"));
  assert.equal(decision.global_goal_completion.status, "in_progress");
  assert.ok(decision.next_work_packages.some((workPackage) => workPackage.global_goal_id === "platform-boundary-and-state-foundation"));
});

test("agent lifecycle pool gaps schedule cleanup without human intervention", () => {
  const decision = decideContinuation({
    project_status: projectStatus({ next_step: "" }),
    run_evaluation: { status: "pass", next_work_packages: [] },
    workflow_state: {
      manifest: {
        events: [
          {
            id: "spawn-worker",
            type: "WorkerSpawned",
            status: "pass",
            metadata: {
              pool_id: "pool-main-child",
              worker_id: "child-implementation-1"
            }
          },
          {
            id: "complete-worker",
            type: "WorkerCompleted",
            status: "pass",
            metadata: {
              pool_id: "pool-main-child",
              worker_id: "child-implementation-1"
            }
          }
        ]
      },
      artifact_ledger: { artifacts: [] }
    }
  });

  const cleanupPackage = decision.next_work_packages.find((workPackage) => {
    return workPackage.action === "cleanup_agent_lifecycle_pool";
  });

  assert.equal(decision.action, CONTINUE);
  assert.equal(decision.should_continue, true);
  assert.ok(cleanupPackage);
  assert.ok(cleanupPackage.owned_files.includes("src/workflow/agent-lifecycle-pool.js"));
  assert.ok(cleanupPackage.owned_files.includes("src/workflow/workbench-projection.js"));
  assert.ok(decision.context_pack_seed.subtasks.some((subtask) => subtask.id === cleanupPackage.id));
});

test("timed-out agent lifecycle pool schedules smaller retry worker slice", () => {
  const decision = decideContinuation({
    project_status: projectStatus({ next_step: "" }),
    run_evaluation: { status: "pass", next_work_packages: [] },
    agent_lifecycle_pool: {
      status: "open",
      pool_id: "pool-main-child",
      timed_out: 1,
      open: 1,
      unevaluated: 0,
      unclosed: 1,
      latest_issue: "child implementation heartbeat timed out",
      timed_out_workers: [
        {
          worker_id: "child-implementation-2",
          owned_files: ["src/workflow/autonomous-continuation.js"],
          timeout_ms: 300000
        }
      ]
    }
  });

  const retryPackage = decision.next_work_packages.find((workPackage) => {
    return workPackage.action === "retry_agent_worker";
  });

  assert.equal(decision.action, CONTINUE);
  assert.equal(decision.should_continue, true);
  assert.ok(retryPackage);
  assert.equal(retryPackage.worker_id, "child-implementation-2");
  assert.equal(retryPackage.retry_worker.worker_id, "child-implementation-2");
  assert.deepEqual(retryPackage.owned_files, ["src/workflow/autonomous-continuation.js"]);
  assert.deepEqual(retryPackage.timed_out_workers.map((worker) => worker.worker_id), ["child-implementation-2"]);
  assert.ok(!decision.next_work_packages.some((workPackage) => workPackage.action === "cleanup_agent_lifecycle_pool"));
  assert.ok(decision.context_pack_seed.subtasks.some((subtask) => subtask.id === retryPackage.id));
  const retrySubtask = decision.context_pack_seed.subtasks.find((subtask) => subtask.id === retryPackage.id);
  assert.equal(retrySubtask.action, "retry_agent_worker");
  assert.equal(retrySubtask.source.pool_id, "pool-main-child");
  assert.equal(retrySubtask.source.worker_id, "child-implementation-2");
  assert.equal(retrySubtask.source.retry_worker.worker_id, "child-implementation-2");
  assert.deepEqual(retrySubtask.source.timed_out_workers.map((worker) => worker.worker_id), ["child-implementation-2"]);
});

test("timed-out agent lifecycle retry package has default owned files", () => {
  const decision = decideContinuation({
    project_status: projectStatus({ next_step: "" }),
    run_evaluation: { status: "pass", next_work_packages: [] },
    agent_lifecycle_pool: {
      status: "blocked",
      pool_id: "pool-main-child",
      timed_out: 1,
      latest_issue: "worker timed out",
      timed_out_workers: [{ worker_id: "child-implementation-3" }]
    }
  });

  const retryPackage = decision.next_work_packages.find((workPackage) => {
    return workPackage.action === "retry_agent_worker";
  });
  const retrySubtask = decision.context_pack_seed.subtasks.find((subtask) => subtask.id === retryPackage.id);

  assert.ok(retryPackage.owned_files.includes("src/workflow/agent-lifecycle-pool.js"));
  assert.ok(retryPackage.owned_files.includes("src/workflow/autonomous-continuation.js"));
  assert.deepEqual(retrySubtask.owned_files, retryPackage.owned_files);
});

test("reviewer scope split facts generate concrete shard work packages", () => {
  const decision = decideContinuation({
    project_status: projectStatus({ next_step: "" }),
    run_evaluation: { status: "pass" },
    reviewer_provider_health: {
      recovery_status: "retry",
      provider_health: "healthy",
      scheduled_actions: ["split_scope"],
      retry_strategy: "split_scope"
    },
    reviewer_scope_split: {
      status: "pass",
      split_reason: "reviewer request was split into bounded shards",
      shards: [
        {
          id: "reviewer-scope-shard-001",
          status: "pending",
          provider: "claude-code",
          model: "deepseek-v4-pro",
          profile: "process_guard",
          files: ["src/workflow/llm-reviewer-gate.js"],
          allowed_tools: []
        },
        {
          id: "reviewer-scope-shard-002",
          status: "pending",
          provider: "claude-code",
          model: "deepseek-v4-pro",
          profile: "process_guard",
          files: ["src/workflow/reviewer-provider-health.js"],
          allowed_tools: []
        }
      ]
    }
  });

  assert.equal(decision.action, CONTINUE);
  assert.ok(!decision.next_work_packages.some((workPackage) => workPackage.id === "reviewer-provider-split-scope"));
  assert.ok(decision.next_work_packages.some((workPackage) => workPackage.id === "reviewer-scope-shard-001"));
  assert.equal(decision.next_work_packages.find((workPackage) => workPackage.id === "reviewer-scope-shard-001").action, "run_reviewer_scope_shard");
  assert.ok(decision.context_pack_seed.subtasks.some((subtask) => subtask.id === "reviewer-scope-shard-002"));
});

test("reviewer scope split continuation skips shards with recorded results", () => {
  const decision = decideContinuation({
    project_status: projectStatus({ next_step: "" }),
    run_evaluation: { status: "pass" },
    workflow_state: {
      manifest: {
        events: [
          {
            type: "reviewer_scope_split",
            metadata: {
              status: "pass",
              shards: [
                { id: "reviewer-scope-shard-001", status: "pending", files: ["src/a.js"] },
                { id: "reviewer-scope-shard-002", status: "pending", files: ["src/b.js"] }
              ]
            }
          },
          {
            type: "reviewer_shard_result",
            metadata: {
              shard_id: "reviewer-scope-shard-001",
              status: "pass"
            }
          }
        ]
      }
    }
  });

  assert.ok(!decision.next_work_packages.some((workPackage) => workPackage.id === "reviewer-scope-shard-001"));
  assert.ok(decision.next_work_packages.some((workPackage) => workPackage.id === "reviewer-scope-shard-002"));
});

test("reviewer shard aggregate failure overrides stale pass evaluation", () => {
  const decision = decideContinuation({
    project_status: projectStatus({ next_step: "" }),
    run_evaluation: { status: "pass", next_work_packages: [] },
    workflow_state: {
      manifest: {
        run_id: "run-shard-aggregate",
        cycle_id: "cycle-shard-aggregate",
        work_packages: [{ id: "reviewer-shard-loop", status: "pass" }],
        artifacts: [],
        gate_results: [],
        recovery_attempts: [],
        review_findings: [],
        events: [
          {
            type: "reviewer_shard_aggregate",
            metadata: {
              status: "fail",
              pending_shards: 0,
              merged_findings: [
                {
                  finding_id: "aggregate-review-finding",
                  status: "fail",
                  severity: "medium",
                  category: "reviewer",
                  message: "aggregate finding requires rerun"
                }
              ]
            }
          }
        ]
      }
    }
  });

  assert.equal(decision.action, RERUN);
  assert.equal(decision.should_continue, true);
  assert.ok(decision.reasons.some((reason) => reason.includes("run_status=rerun")));
  assert.ok(decision.next_work_packages.some((workPackage) => workPackage.action === "rerun"));
  assert.ok(decision.context_pack_seed.subtasks.some((subtask) => subtask.id.includes("rerun")));
});

test("reviewer shard aggregate pass clears stale rerun evaluation", () => {
  const decision = decideContinuation({
    project_status: projectStatus({ next_step: "" }),
    run_evaluation: {
      status: "rerun",
      next_work_packages: [{ id: "stale-timeout-rerun", title: "Stale timeout rerun" }]
    },
    workflow_state: {
      manifest: {
        run_id: "run-shard-aggregate-pass",
        cycle_id: "cycle-shard-aggregate-pass",
        work_packages: [{ id: "reviewer-shard-loop", status: "pass" }],
        artifacts: [],
        gate_results: [],
        recovery_attempts: [],
        review_findings: [],
        events: [
          {
            type: "reviewer_shard_aggregate",
            metadata: {
              status: "pass",
              pending_shards: 0,
              merged_findings: []
            }
          }
        ]
      }
    }
  });

  assert.equal(decision.action, CONTINUE);
  assert.equal(decision.should_continue, true);
  assert.ok(!decision.next_work_packages.some((workPackage) => workPackage.id === "stale-timeout-rerun"));
});

test("reviewer shard aggregate pass clears stale reviewer recovery artifacts", () => {
  const decision = decideContinuation({
    project_status: projectStatus({ next_step: "Continue after reviewer aggregate." }),
    run_evaluation: {
      status: "rerun",
      next_work_packages: [{ id: "stale-timeout-rerun", title: "Stale timeout rerun" }]
    },
    workflow_state: {
      manifest: {
        run_id: "run-shard-aggregate-pass-artifacts",
        cycle_id: "cycle-shard-aggregate-pass-artifacts",
        work_packages: [{ id: "reviewer-shard-loop", status: "pass" }],
        artifacts: [
          { id: "tests", status: "pass" },
          { id: "reviewer-timeout", status: "fail" },
          {
            id: "reviewer-provider-health",
            type: "evaluation",
            status: "pass",
            producer: "reviewer-provider-health",
            metadata: {
              type: "reviewer_provider_health",
              scheduled_actions: ["rerun_without_tools", "split_scope"]
            }
          }
        ],
        gate_results: [],
        recovery_attempts: [],
        review_findings: [
          {
            finding_id: "stale-reviewer-timeout",
            status: "fail",
            category: "reviewer_timeout",
            severity: "medium"
          }
        ],
        events: [
          {
            type: "reviewer_provider_health",
            metadata: {
              status: "pass",
              scheduled_actions: ["rerun_without_tools", "split_scope"]
            }
          },
          {
            type: "reviewer_shard_aggregate",
            metadata: {
              status: "pass",
              pending_shards: 0,
              merged_findings: []
            }
          }
        ]
      }
    }
  });

  assert.equal(decision.action, CONTINUE);
  assert.deepEqual(decision.next_work_packages, []);
  assert.equal(decision.context_pack_seed.requirement_summary, "Continue after reviewer aggregate.");
  assert.deepEqual(decision.context_pack_seed.owned_files, [
    "PROJECT_STATUS.json",
    "src/workflow",
    "docs/contracts",
    "docs/examples/process-hardening-current.json"
  ]);
  assert.equal(decision.context_pack_seed.subtasks[0].id, "project-status-next-step");
  assert.equal(decision.context_pack_seed.subtasks[0].action, "continue_next_step");
  assert.ok(!decision.context_pack_seed.subtasks.some((subtask) => subtask.id === "reviewer-provider-rerun-without-tools"));
});

test("provider health fallback schedules model fallback work package", () => {
  const decision = decideContinuation({
    project_status: projectStatus({ next_step: "" }),
    run_evaluation: { status: "pass" },
    reviewer_provider_health: {
      recovery_status: "blocked",
      provider_health: "unhealthy",
      scheduled_actions: ["fallback_model_or_defer_external_review"],
      retry_strategy: "fallback_model_or_defer_external_review"
    }
  });

  assert.equal(decision.action, CONTINUE);
  assert.equal(decision.next_work_packages[0].id, "reviewer-provider-fallback-model-or-defer-external-review");
  assert.deepEqual(decision.next_work_packages[0].owned_files, ["src/workflow/model-router.js", "src/workflow/reviewer-provider-health.js"]);
});

test("rolls back without asking human when rollback is automatic", () => {
  const decision = decideContinuation({
    project_status: projectStatus({ next_step: "" }),
    run_evaluation: {
      status: "rollback",
      next_work_packages: [{ id: "rollback-host-drift", title: "Rollback host drift" }]
    }
  });

  assert.equal(decision.action, ROLLBACK);
  assert.equal(decision.should_continue, true);
});

test("stops only for human intervention blockers", () => {
  const decision = decideContinuation({
    project_status: projectStatus({ next_step: "Continue after credentials are supplied." }),
    run_evaluation: {
      status: "human_intervention",
      projection: {
        blockers: [{ id: "missing-token", category: "credentials" }]
      }
    }
  });

  assert.equal(decision.action, STOP_FOR_HUMAN);
  assert.equal(decision.should_continue, false);
  assert.equal(decision.context_pack_seed, null);
  assert.throws(() => assertShouldContinue({
    project_status: projectStatus(),
    run_evaluation: { status: "human_intervention", blockers: [{ category: "credentials" }] }
  }), { code: "AUTONOMOUS_CONTINUATION_STOPPED" });
});

test("stops when continuation points at the wrong host", () => {
  const decision = decideContinuation({
    project_status: projectStatus({ project: "stock_dashboard" }),
    run_evaluation: { status: "pass" }
  });

  assert.equal(decision.status, "fail");
  assert.equal(decision.action, STOP_FOR_HUMAN);
  assert.equal(decision.should_continue, false);
  assert.ok(decision.validation.issues.some((issue) => issue.code === "project_mismatch"));
});

test("continuation emits a workbench snapshot publish plan when workflow state is projection-ready", () => {
  const workflowState = readJson("docs/examples/current-session-workbench-input.json");
  const decision = decideContinuation({
    project_status: projectStatus({
      next_step: "Continue after publishing the latest workflow state."
    }),
    run_evaluation: { status: "pass" },
    workflow_state: workflowState
  });

  assert.equal(decision.should_continue, true);
  assert.equal(decision.snapshot_publish_plan.action, "publish_workbench_snapshot");
  assert.equal(decision.snapshot_publish_plan.endpoint, "/api/workbench/snapshots");
  assert.equal(decision.snapshot_publish_plan.id, "run-20260521-platform-self-trial");
  assert.equal(decision.snapshot_publish_plan.input, workflowState);
  assert.deepEqual(decision.snapshot_publish_issues, []);
});

test("continuation does not emit a snapshot publish plan when workflow state is not projection-ready", () => {
  const workflowState = {
    manifest: {
      run_id: "run-closeout",
      cycle_id: "cycle-closeout"
    },
    artifact_ledger: {
      artifacts: []
    }
  };
  const decision = decideContinuation({
    project_status: projectStatus({
      next_step: "Continue after publishing the latest workflow state."
    }),
    run_evaluation: { status: "pass" },
    workflow_state: workflowState
  });

  assert.equal(decision.should_continue, true);
  assert.equal(decision.snapshot_publish_plan, null);
  assert.ok(decision.snapshot_publish_issues.includes("projection input validation must pass before snapshot publish"));
});

test("continuation does not emit a snapshot publish plan without operator event facts", () => {
  const workflowState = readJson("docs/examples/current-session-workbench-input.json");
  delete workflowState.operator_event_ledger;
  const decision = decideContinuation({
    project_status: projectStatus({
      next_step: "Continue after publishing the latest workflow state."
    }),
    run_evaluation: { status: "pass" },
    workflow_state: workflowState
  });

  assert.equal(decision.should_continue, true);
  assert.equal(decision.snapshot_publish_plan, null);
  assert.ok(decision.snapshot_publish_issues.includes("operator events must apply before snapshot publish"));
});

test("continues from pending global goals after a single requirement passes", () => {
  const decision = decideContinuation({
    project_status: projectStatus({
      next_step: "Continue all repository global goals.",
      global_goals: [
        {
          id: "pc-mobile-workbench",
          title: "PC/mobile workbench shell",
          status: "completed"
        },
        {
          id: "global-completion-loop",
          title: "Global completion detector",
          status: "in_progress",
          next_step: "Implement global goal completion detection before stopping.",
          owned_files: ["src/workflow/global-goal-completion.js"]
        }
      ]
    }),
    run_evaluation: { status: "pass", next_work_packages: [] }
  });

  assert.equal(decision.action, CONTINUE);
  assert.equal(decision.should_continue, true);
  assert.equal(decision.global_goal_completion.status, "in_progress");
  assert.equal(decision.global_goal_completion.pending, 1);
  assert.ok(decision.reasons.includes("global_goals=1/2"));
  assert.equal(decision.next_work_packages[0].action, "continue_global_goal");
  assert.equal(decision.next_work_packages[0].global_goal_id, "global-completion-loop");
  assert.deepEqual(decision.context_pack_seed.owned_files, ["src/workflow/global-goal-completion.js"]);
  assert.equal(decision.context_pack_seed.subtasks[0].id, "global-goal-global-completion-loop");
  assert.equal(decision.context_pack_seed.subtasks[0].global_goal_id, "global-completion-loop");
  assert.equal(decision.context_pack_seed.subtasks[0].source.global_goal_id, "global-completion-loop");
});

test("completed global goal work packages are skipped on the next continuation", () => {
  const decision = decideContinuation({
    project_status: projectStatus({
      next_step: "",
      global_goals: [
        {
          id: "platform-foundation",
          title: "Platform foundation",
          status: "in_progress",
          next_step: "Harden durable platform state.",
          owned_files: ["src/workflow/global-goal-completion.js"]
        },
        {
          id: "workbench",
          title: "Workbench",
          status: "in_progress",
          next_step: "Continue workbench browser evidence.",
          owned_files: ["src/workflow/workbench-projection.js"]
        }
      ]
    }),
    run_evaluation: { status: "pass", next_work_packages: [] },
    workflow_state: {
      manifest: {
        work_packages: [
          {
            id: "global-goal-platform-foundation",
            action: "continue_global_goal",
            global_goal_id: "platform-foundation",
            status: "completed"
          }
        ],
        events: []
      },
      artifact_ledger: { artifacts: [] }
    }
  });

  assert.equal(decision.global_goal_completion.completed, 1);
  assert.equal(decision.global_goal_completion.pending, 1);
  assert.equal(decision.global_goal_completion.next_goal.id, "workbench");
  assert.ok(!decision.next_work_packages.some((workPackage) => workPackage.global_goal_id === "platform-foundation"));
  assert.equal(decision.next_work_packages[0].global_goal_id, "workbench");
});

test("global goal identity survives context pack materialization and drives the next continuation", () => {
  const status = projectStatus({
    next_step: "Continue all repository global goals.",
    global_goals: [
      {
        id: "platform-foundation",
        title: "Platform foundation",
        status: "in_progress",
        next_step: "Harden durable platform state.",
        owned_files: ["src/workflow/global-goal-completion.js"]
      },
      {
        id: "workbench",
        title: "Workbench",
        status: "in_progress",
        next_step: "Continue workbench browser evidence.",
        owned_files: ["src/workflow/workbench-projection.js"]
      }
    ]
  });
  const firstDecision = decideContinuation({
    project_status: status,
    run_evaluation: { status: "pass", next_work_packages: [] }
  });
  const sourceWorkflowState = {
    manifest: {
      run_id: "run-global-goals",
      cycle_id: "cycle-continuation",
      events: [
        {
          id: "event-project-status-continuation",
          type: "project_status_continuation",
          status: "ready",
          artifact_id: "artifact-project-status-continuation",
          created_at: "2026-05-24T00:00:00.000Z",
          metadata: {
            context_pack_seed: firstDecision.context_pack_seed
          }
        }
      ],
      artifacts: [
        {
          id: "artifact-project-status-continuation",
          status: "pass",
          metadata: {
            context_pack_seed: firstDecision.context_pack_seed
          }
        }
      ]
    },
    artifact_ledger: {
      artifacts: []
    }
  };

  const materialized = materializeContextPackCycleFromWorkflowState(sourceWorkflowState, {
    cycle_id: "cycle-global-goal-platform-foundation",
    created_at: "2026-05-24T00:01:00.000Z"
  });

  assert.equal(materialized.status, "ready");
  assert.equal(materialized.workflow_state.manifest.work_packages[0].global_goal_id, "platform-foundation");
  const completedWorkflowState = {
    ...materialized.workflow_state,
    manifest: {
      ...materialized.workflow_state.manifest,
      work_packages: materialized.workflow_state.manifest.work_packages.map((workPackage, index) => ({
        ...workPackage,
        status: index === 0 ? "completed" : workPackage.status
      }))
    }
  };
  const nextDecision = decideContinuation({
    project_status: status,
    run_evaluation: { status: "pass", next_work_packages: [] },
    workflow_state: completedWorkflowState
  });

  assert.equal(nextDecision.global_goal_completion.completed, 1);
  assert.equal(nextDecision.global_goal_completion.next_goal.id, "workbench");
  assert.deepEqual(
    nextDecision.next_work_packages.map((workPackage) => workPackage.global_goal_id),
    ["workbench"]
  );
});

test("global goals do not dilute explicit scheduler continuation packages", () => {
  const decision = decideContinuation({
    project_status: projectStatus({
      next_step: "",
      global_goals: [
        { id: "workbench", title: "Workbench", status: "in_progress" },
        { id: "scheduler", title: "Scheduler", status: "in_progress" }
      ]
    }),
    run_evaluation: {
      status: "pass",
      next_work_packages: [
        { id: "explicit-next", title: "Run explicit next scheduler step", action: "run_scheduler_step" }
      ]
    }
  });

  assert.equal(decision.should_continue, true);
  assert.equal(decision.next_work_packages.length, 1);
  assert.equal(decision.next_work_packages[0].id, "explicit-next");
  assert.equal(decision.global_goal_completion.pending, 2);
});

test("project status next work packages are durable continuation inputs", () => {
  const decision = decideContinuation({
    project_status: projectStatus({
      next_step: "Continue from scheduler continuation.",
      next_work_packages: [
        {
          id: "scheduler-continuation-next",
          title: "Continue from scheduler continuation.",
          action: "continue_scheduler",
          owned_files: ["src/workflow/scheduler-dispatch-continuation.js"]
        }
      ]
    }),
    run_evaluation: { status: "pass", next_work_packages: [] }
  });

  assert.equal(decision.should_continue, true);
  assert.equal(decision.next_work_packages.length, 1);
  assert.equal(decision.next_work_packages[0].id, "scheduler-continuation-next");
  assert.deepEqual(decision.context_pack_seed.owned_files, ["src/workflow/scheduler-dispatch-continuation.js"]);
});

test("self-governance defects and evidence gaps become continuation work packages", () => {
  const decision = decideContinuation({
    project_status: projectStatus({ next_step: "" }),
    run_evaluation: { status: "pass", next_work_packages: [] },
    workflow_state: {
      manifest: {
        events: [
          {
            id: "self-governance-defect",
            type: "self_governance_finding",
            metadata: {
              id: "governance-defect",
              category: "defect",
              dimension: "quality_gate",
              severity: "high",
              title: "Self-governance defect must be repaired",
              owned_files: ["src/workflow/self-governance.js"],
              acceptance_gates: ["node --test test/self-governance.test.js"]
            }
          },
          {
            id: "self-governance-evidence-gap",
            type: "self_governance_finding",
            metadata: {
              id: "governance-evidence-gap",
              category: "evidence_gap",
              dimension: "model_collaboration",
              severity: "medium",
              title: "Self-governance evidence must be collected",
              owned_files: ["src/workflow/model-router.js"],
              acceptance_gates: ["node --test test/model-router.test.js"]
            }
          },
          {
            id: "self-governance-iteration",
            type: "self_governance_finding",
            metadata: {
              id: "governance-iteration",
              category: "evolution_opportunity",
              dimension: "iteration_evolution",
              severity: "low",
              title: "Optional governance improvement"
            }
          }
        ]
      }
    }
  });

  const packageIds = decision.next_work_packages.map((workPackage) => workPackage.id);
  assert.equal(decision.action, CONTINUE);
  assert.ok(packageIds.includes("self-governance-fix-governance-defect"));
  assert.ok(packageIds.includes("self-governance-evidence-governance-evidence-gap"));
  assert.ok(!packageIds.includes("self-governance-decision-governance-iteration"));
  assert.ok(decision.context_pack_seed.subtasks.some((subtask) => subtask.id === "self-governance-fix-governance-defect"));
  assert.ok(decision.context_pack_seed.acceptance_gates.includes("node --test test/self-governance.test.js"));
});

test("invalid self-governance findings do not become continuation work packages", () => {
  const decision = decideContinuation({
    project_status: projectStatus({ next_step: "" }),
    run_evaluation: { status: "pass", next_work_packages: [] },
    workflow_state: {
      manifest: {
        events: [
          {
            id: "invalid-self-governance-finding",
            type: "self_governance_finding",
            metadata: {
              id: "invalid-governance",
              category: "made_up",
              dimension: "fake_dimension",
              title: "Invalid governance finding"
            }
          }
        ]
      }
    }
  });

  assert.ok(!decision.next_work_packages.some((workPackage) => workPackage.id.includes("invalid-governance")));
});

test("frontend repair continuation deduplicates package ids and preserves repair gates", () => {
  const repairPackageId = "frontend-acceptance-repair-frontend-acceptance-current-workbench";
  const repairOwnedFiles = ["apps/workbench", "test/workbench-shell.test.js"];
  const repairGates = [
    "npm run check:workbench:frontend-acceptance",
    "npm run check:workbench:browser-events",
    "npm run check:closeout"
  ];
  const decision = decideContinuation({
    project_status: projectStatus({
      next_step: "",
      next_work_packages: [
        {
          id: repairPackageId,
          title: "Repair PC/mobile workbench frontend acceptance blockers",
          action: "repair_frontend_acceptance",
          owned_files: repairOwnedFiles,
          acceptance_gates: repairGates
        }
      ],
      global_goals: [
        {
          id: "pc-mobile-autonomous-workbench",
          title: "PC/mobile autonomous workbench",
          status: "in_progress",
          next_step: "Repair frontend acceptance blockers.",
          owned_files: repairOwnedFiles
        }
      ]
    }),
    run_evaluation: { status: "pass", next_work_packages: [] },
    workflow_state: {
      manifest: {
        run_id: "run-frontend-continuation-dedupe",
        cycle_id: "cycle-frontend-continuation-dedupe",
        events: [
          {
            id: "event-frontend-acceptance-current-workbench",
            type: "frontend_acceptance_run",
            status: "fail",
            artifact_id: "frontend-acceptance-current-workbench",
            metadata: {
              status: "fail",
              blocking_count: 1,
              blocking_findings: [
                {
                  code: "desktop-dead-tabs",
                  status: "fail",
                  severity: "p1",
                  message: "Desktop navigation tabs do not change content."
                }
              ],
              findings: [
                {
                  code: "desktop-dead-tabs",
                  status: "fail",
                  severity: "p1",
                  message: "Desktop navigation tabs do not change content."
                }
              ],
              viewport_results: [
                { viewport: "desktop" },
                { viewport: "desktop_narrow" },
                { viewport: "mobile" }
              ]
            }
          }
        ],
        artifacts: []
      },
      artifact_ledger: {
        artifacts: [
          {
            id: "frontend-acceptance-current-workbench",
            status: "fail",
            metadata: {
              status: "fail",
              blocking_count: 1,
              blocking_findings: [
                {
                  code: "desktop-dead-tabs",
                  status: "fail",
                  severity: "p1",
                  message: "Desktop navigation tabs do not change content."
                }
              ],
              findings: [
                {
                  code: "desktop-dead-tabs",
                  status: "fail",
                  severity: "p1",
                  message: "Desktop navigation tabs do not change content."
                }
              ],
              viewport_results: [
                { viewport: "desktop" },
                { viewport: "desktop_narrow" },
                { viewport: "mobile" }
              ]
            }
          }
        ]
      }
    }
  });

  const repairPackages = decision.next_work_packages.filter((workPackage) => {
    return workPackage.id === repairPackageId;
  });
  const subtaskIds = decision.context_pack_seed.subtasks.map((subtask) => subtask.id);

  assert.equal(repairPackages.length, 1);
  assert.equal(subtaskIds.filter((id) => id === repairPackageId).length, 1);
  assert.equal(new Set(subtaskIds).size, subtaskIds.length);
  assert.ok(decision.context_pack_seed.acceptance_gates.includes("npm run check:workbench:frontend-acceptance"));
  assert.ok(decision.context_pack_seed.acceptance_gates.includes("npm run check:workbench:browser-events"));
  assert.ok(decision.context_pack_seed.acceptance_gates.includes("npm run check:closeout"));
  assert.deepEqual(decision.context_pack_seed.subtasks[0].source.acceptance_gates, repairGates);
});

test("marks continuation complete only when all configured global goals are done", () => {
  const decision = decideContinuation({
    project_status: projectStatus({
      next_step: "",
      global_goals: [
        { id: "workbench", title: "Workbench", status: "completed" },
        { id: "scheduler", title: "Scheduler", status: "done" }
      ]
    }),
    run_evaluation: { status: "pass", next_work_packages: [] }
  });

  assert.equal(decision.action, COMPLETE);
  assert.equal(decision.should_continue, false);
  assert.equal(decision.context_pack_seed, null);
  assert.equal(decision.global_goal_completion.status, "complete");
  assert.ok(decision.reasons.includes("all configured global goals are complete"));
  assert.throws(() => assertShouldContinue({
    project_status: projectStatus({
      next_step: "",
      global_goals: [{ id: "done", title: "Done", status: "completed" }]
    }),
    run_evaluation: { status: "pass" }
  }), { code: "AUTONOMOUS_CONTINUATION_COMPLETE" });
});

test("blocked global goals stop without pretending the cycle is complete", () => {
  const decision = decideContinuation({
    project_status: projectStatus({
      next_step: "",
      global_goals: [
        {
          id: "remote-secret",
          title: "Publish through production remote",
          status: "blocked",
          blockers: [{ id: "missing-secret", requires_human: true }]
        }
      ]
    }),
    run_evaluation: { status: "pass" }
  });

  assert.equal(decision.action, STOP_FOR_HUMAN);
  assert.equal(decision.should_continue, false);
  assert.equal(decision.global_goal_completion.status, "blocked");
  assert.ok(decision.blockers.some((blocker) => blocker.category === "global_goal_blocked"));
});
