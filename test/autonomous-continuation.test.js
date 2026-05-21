import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertShouldContinue,
  CONTINUE,
  decideContinuation,
  RERUN,
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

test("reviewer provider health facts generate scheduler follow-up work packages", () => {
  const workflowState = readJson("docs/examples/current-session-workbench-input.json");
  const decision = decideContinuation({
    project_status: projectStatus({ next_step: "" }),
    run_evaluation: { status: "pass" },
    workflow_state: workflowState
  });

  assert.equal(decision.action, CONTINUE);
  assert.ok(decision.next_work_packages.some((workPackage) => workPackage.id === "reviewer-provider-rerun-without-tools"));
  assert.ok(!decision.next_work_packages.some((workPackage) => workPackage.id === "reviewer-provider-split-scope"));
  assert.ok(decision.next_work_packages.some((workPackage) => workPackage.id === "reviewer-scope-shard-001"));
  assert.ok(decision.context_pack_seed.subtasks.some((subtask) => subtask.id === "reviewer-provider-rerun-without-tools"));
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
