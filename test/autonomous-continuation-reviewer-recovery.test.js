import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CONTINUE,
  decideContinuation,
  RERUN
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
