import assert from "node:assert/strict";
import test from "node:test";

import {
  assertShouldContinue,
  COMPLETE,
  CONTINUE,
  decideContinuation,
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
