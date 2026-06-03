import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertShouldContinue,
  CONTINUE,
  decideContinuation,
  RERUN,
  REVIEWER_SMOKE_STALL_THRESHOLD,
  reviewerProviderSmokeStall,
  ROLLBACK,
  STOP_FOR_HUMAN
} from "../src/workflow/autonomous-continuation.js";

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

test("approved requirement plans split broad intake into bounded implementation steps", () => {
  const decision = decideContinuation({
    project_status: projectStatus({
      next_step: "",
      requirement_intake: {
        items: [
          {
            id: "requirement-frontend-refactor",
            title: "前端重构",
            status: "submitted",
            owned_files: ["."],
            acceptance_gates: ["npm run check:closeout"]
          }
        ]
      },
      plan_reviews: {
        "requirement-frontend-refactor": {
          phase: "in_development",
          id: "plan-review-requirement-frontend-refactor",
          plan_id: "plan-requirement-frontend-refactor",
          implementation_outline: ["盘点现状", "建立 Next.js + antd 骨架"],
          acceptance_gates: ["Next.js build passes"]
        }
      },
      next_work_packages: [
        {
          id: "requirement-frontend-refactor-intake",
          action: "continue_requirement_intake",
          global_goal_id: "requirement-frontend-refactor",
          owned_files: ["."]
        }
      ]
    }),
    run_evaluation: { status: "pass", next_work_packages: [] }
  });

  assert.equal(decision.action, CONTINUE);
  assert.equal(decision.next_work_packages.length, 2);
  assert.equal(decision.next_work_packages[0].id, "requirement-frontend-refactor-plan-step-01");
  assert.equal(decision.next_work_packages[0].action, "execute_requirement_plan_step");
  assert.ok(!decision.next_work_packages[0].acceptance_gates.some((gate) => gate.includes("建立 Next.js")));
  assert.equal(decision.next_work_packages[1].depends_on[0], "requirement-frontend-refactor-plan-step-01");
  assert.equal(decision.context_pack_seed.subtasks[0].action, "execute_requirement_plan_step");
});

test("approved requirement plan continuation removes dependencies already completed in prior cycles", () => {
  const decision = decideContinuation({
    project_status: projectStatus({
      next_step: "",
      requirement_intake: {
        items: [
          {
            id: "requirement-frontend-refactor",
            title: "前端重构",
            status: "submitted",
            owned_files: ["."],
            acceptance_gates: ["npm run check:closeout"]
          }
        ]
      },
      plan_reviews: {
        "requirement-frontend-refactor": {
          phase: "in_development",
          id: "plan-review-requirement-frontend-refactor",
          plan_id: "plan-requirement-frontend-refactor",
          implementation_outline: ["盘点现状", "建立 Next.js + antd 骨架"],
          acceptance_gates: ["现状清单入库", "Next.js build passes"]
        }
      },
      next_work_packages: [
        {
          id: "requirement-frontend-refactor-intake",
          action: "continue_requirement_intake",
          global_goal_id: "requirement-frontend-refactor",
          owned_files: ["."]
        }
      ]
    }),
    run_evaluation: { status: "pass", next_work_packages: [] },
    workflow_state: {
      manifest: {
        work_packages: [
          {
            id: "requirement-frontend-refactor-plan-step-01",
            status: "pass",
            global_goal_id: "requirement-frontend-refactor"
          }
        ]
      }
    }
  });

  assert.equal(decision.action, CONTINUE);
  assert.deepEqual(decision.next_work_packages.map((workPackage) => workPackage.id), [
    "requirement-frontend-refactor-plan-step-02"
  ]);
  assert.deepEqual(decision.next_work_packages[0].depends_on, []);
  assert.deepEqual(decision.context_pack_seed.subtasks[0].depends_on, []);
  assert.equal(decision.context_pack_seed.subtasks[0].source.implementation_step, "建立 Next.js + antd 骨架");
});

test("existing broad frontend view migration packages are split before dispatch", () => {
  const decision = decideContinuation({
    project_status: projectStatus({ next_step: "" }),
    run_evaluation: {
      status: "rerun",
      next_work_packages: [
        {
          id: "requirement-frontend-refactor-plan-step-04",
          title: "前端重构：实施步骤 04 / 7",
          action: "execute_requirement_plan_step",
          owned_files: ["."],
          acceptance_gates: ["npm run check:workbench:browser-events"],
          depends_on: ["requirement-frontend-refactor-plan-step-03"],
          reason: "按视图切片迁移：优先迁移高频核心视图（如工作台主页、需求录入、计划审核），每个切片以独立 PR 落地，并保持旧入口可回退。",
          source: {
            requirement_id: "requirement-frontend-refactor",
            plan_step_index: 4,
            plan_step_total: 7,
            constraints: "当前中台的所有前端代码，都用antd作为ui框架、react+next.js(app模式) 作为项目框架进行重构。",
            implementation_step: "按视图切片迁移：优先迁移高频核心视图（如工作台主页、需求录入、计划审核），每个切片以独立 PR 落地，并保持旧入口可回退。"
          }
        }
      ]
    }
  });

  assert.equal(decision.action, RERUN);
  assert.deepEqual(decision.next_work_packages.map((workPackage) => workPackage.id), [
    "requirement-frontend-refactor-plan-step-04-workbench-home",
    "requirement-frontend-refactor-plan-step-04-requirement-intake",
    "requirement-frontend-refactor-plan-step-04-plan-review"
  ]);
  assert.deepEqual(decision.next_work_packages[0].depends_on, ["requirement-frontend-refactor-plan-step-03"]);
  assert.deepEqual(decision.next_work_packages[1].depends_on, ["requirement-frontend-refactor-plan-step-04-workbench-home"]);
  assert.equal(decision.context_pack_seed.subtasks[0].source.plan_step_slice, "workbench-home");
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
  assert.ok(decision.global_goal_completion.next_goal?.id);
  assert.ok(decision.next_work_packages.some((workPackage) => {
    return workPackage.global_goal_id === decision.global_goal_completion.next_goal.id;
  }));
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

test("code review coverage gap schedules supplement shard work and seeds context source", () => {
  const decision = decideContinuation({
    project_status: projectStatus({ next_step: "" }),
    run_evaluation: { status: "pass", next_work_packages: [] },
    code_review_coverage: {
      version: "code-review-coverage.v1",
      id: "coverage-gap",
      shards: [
        {
          id: "workflow-coverage",
          status: "needs_rerun",
          files: [
            "src/workflow/autonomous-continuation.js",
            "node_modules/pkg/index.js",
            "tmp/review.json"
          ]
        }
      ]
    }
  });

  const workPackage = decision.next_work_packages.find((candidate) => {
    return candidate.action === "run_code_quality_review_shard";
  });

  assert.equal(decision.action, CONTINUE);
  assert.equal(decision.should_continue, true);
  assert.ok(workPackage);
  assert.equal(workPackage.governance_action, "supplement_code_review_coverage");
  assert.deepEqual(workPackage.owned_files, ["src/workflow/autonomous-continuation.js"]);

  const subtask = decision.context_pack_seed.subtasks.find((candidate) => candidate.id === workPackage.id);
  assert.ok(subtask);
  assert.equal(subtask.source.code_review_coverage.shard_id, "workflow-coverage");
  assert.equal(subtask.source.code_review_coverage.shard_status, "needs_rerun");
  assert.equal(subtask.source.code_review_coverage.excluded_files.length, 2);
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

function smokeNeedsEvent(index) {
  return {
    type: "reviewer_provider_health",
    metadata: {
      recovery_status: "needs_smoke_check",
      scheduled_actions: ["provider_smoke_check"],
      provider_health: "unknown",
      retry_strategy: "run_provider_smoke_check",
      sequence: index
    }
  };
}

test("provider health needs_smoke_check below threshold still schedules smoke", () => {
  const input = {
    project_status: projectStatus({ next_step: "" }),
    run_evaluation: { status: "pass" },
    workflow_state: {
      manifest: {
        events: [smokeNeedsEvent(1)]
      }
    },
    reviewer_provider_health: {
      recovery_status: "needs_smoke_check",
      provider_health: "unknown",
      scheduled_actions: ["provider_smoke_check"],
      retry_strategy: "run_provider_smoke_check"
    }
  };
  const stall = reviewerProviderSmokeStall(input);
  assert.equal(stall.stalled, false);
  assert.equal(stall.smoke_check_count, 1);

  const decision = decideContinuation(input);
  assert.equal(decision.next_work_packages[0].id, "reviewer-provider-provider-smoke-check");
  assert.equal(decision.action, CONTINUE);
});

test("provider health stops for human after consecutive smoke requests reach threshold", () => {
  const events = [];
  for (let i = 0; i < REVIEWER_SMOKE_STALL_THRESHOLD; i += 1) {
    events.push(smokeNeedsEvent(i + 1));
  }

  const input = {
    project_status: projectStatus({ next_step: "" }),
    run_evaluation: { status: "pass" },
    workflow_state: { manifest: { events } },
    reviewer_provider_health: {
      recovery_status: "needs_smoke_check",
      provider_health: "unknown",
      scheduled_actions: ["provider_smoke_check"],
      retry_strategy: "run_provider_smoke_check"
    }
  };

  const stall = reviewerProviderSmokeStall(input);
  assert.equal(stall.stalled, true);
  assert.equal(stall.smoke_check_count, REVIEWER_SMOKE_STALL_THRESHOLD);
  assert.ok(stall.reason);

  const decision = decideContinuation(input);
  assert.equal(decision.action, STOP_FOR_HUMAN);
  assert.equal(decision.should_continue, false);
  const stallBlocker = decision.blockers.find((blocker) => blocker.id === "reviewer_provider_smoke_stalled");
  assert.ok(stallBlocker);
  assert.equal(stallBlocker.category, "recovery_exhausted");
  assert.equal(stallBlocker.requires_human, true);
  assert.equal(stallBlocker.smoke_check_count, REVIEWER_SMOKE_STALL_THRESHOLD);
  assert.equal(decision.next_work_packages.find((pkg) => pkg.id === "reviewer-provider-provider-smoke-check"), undefined);
});

test("smoke stall counter resets when a non-smoke health event interrupts the streak", () => {
  const input = {
    workflow_state: {
      manifest: {
        events: [
          smokeNeedsEvent(1),
          {
            type: "reviewer_provider_health",
            metadata: {
              recovery_status: "blocked",
              scheduled_actions: ["fallback_model_or_defer_external_review"],
              provider_health: "unhealthy"
            }
          },
          smokeNeedsEvent(2)
        ]
      }
    }
  };
  const stall = reviewerProviderSmokeStall(input);
  assert.equal(stall.stalled, false);
  assert.equal(stall.smoke_check_count, 1);
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
