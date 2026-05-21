import assert from "node:assert/strict";
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

test("continuation emits a workbench snapshot publish plan when workflow state is available", () => {
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
  assert.equal(decision.snapshot_publish_plan.action, "publish_workbench_snapshot");
  assert.equal(decision.snapshot_publish_plan.endpoint, "/api/workbench/snapshots");
  assert.equal(decision.snapshot_publish_plan.id, "run-closeout");
  assert.equal(decision.snapshot_publish_plan.input, workflowState);
});
