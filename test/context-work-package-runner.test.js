import assert from "node:assert/strict";
import test from "node:test";

import { materializeContextPackCycleFromWorkflowState } from "../src/workflow/context-pack-cycle.js";
import { runContextWorkPackages } from "../src/workflow/context-work-package-runner.js";
import {
  prepareContinuationFromProjectStatus,
  recordProjectStatusContinuationPrepared
} from "../src/workflow/project-status-continuation.js";
import { createWorkbenchProjection } from "../src/workflow/workbench-projection.js";

function workflowStateWithContextCycle() {
  const workflowState = {
    manifest: {
      run_id: "run-context-work",
      cycle_id: "cycle-source",
      goal: "source",
      context_pack: {
        requirement_summary: "中台工作台 source",
        host: "platform_core",
        target_project_id: "ai-control-platform",
        non_goals: ["不修改业务项目"],
        forbidden_actions: ["不得越过 owned_files"],
        owned_files: ["src/workflow/context-work-package-runner.js", "test/context-work-package-runner.test.js"],
        acceptance_gates: ["node --test test/context-work-package-runner.test.js"],
        rollback_conditions: ["runner 状态不一致"],
        subtasks: [{ id: "source", owned_files: ["src/workflow/context-work-package-runner.js"] }]
      },
      work_packages: [{ id: "source", title: "Source", status: "completed", owned_files: ["src/workflow/context-work-package-runner.js"] }],
      events: [],
      artifacts: [],
      gate_results: [],
      review_findings: [],
      recovery_attempts: []
    },
    artifact_ledger: {
      run_id: "run-context-work",
      cycle_id: "cycle-source",
      artifacts: []
    },
    model_plan: {
      selected_model: "deepseek-v4-flash",
      routes: []
    },
    reviewer_gate: { findings: [] }
  };
  const prepared = prepareContinuationFromProjectStatus({
    project: "ai-control-platform",
    status: "in_progress",
    blockers: [],
    next_step: "",
    global_goals: [
      {
        id: "context-work",
        title: "Context work",
        status: "in_progress",
        next_step: "中台工作台 run context work packages.",
        next_work_packages: [
          {
            id: "runtime",
            title: "Runtime",
            owned_files: ["src/workflow/context-work-package-runner.js"]
          },
          {
            id: "tests",
            title: "Tests",
            owned_files: ["test/context-work-package-runner.test.js"],
            depends_on: ["runtime"]
          }
        ]
      }
    ]
  }, { workflow_state: workflowState });
  const recorded = recordProjectStatusContinuationPrepared(workflowState, prepared, {
    created_at: "2026-05-22T04:00:00.000Z"
  });
  return materializeContextPackCycleFromWorkflowState(recorded.workflow_state, {
    cycle_id: "cycle-context-work",
    created_at: "2026-05-22T04:01:00.000Z"
  }).workflow_state;
}

test("context work package runner executes dispatchable packages and updates workflow state", () => {
  const workflowState = workflowStateWithContextCycle();
  const first = runContextWorkPackages(workflowState, {
    max_package_count: 1,
    created_at: "2026-05-22T04:02:00.000Z"
  });

  assert.equal(first.status, "pass");
  assert.equal(first.executed_count, 1);
  assert.equal(first.executed_work_packages[0].id, "runtime");
  assert.equal(first.workflow_state.manifest.work_packages.find((item) => item.id === "runtime").status, "completed");
  assert.equal(first.workflow_state.manifest.events.at(-1).type, "context_work_packages_run");
  assert.equal(first.workflow_state.artifact_ledger.artifacts.at(-1).metadata.executed_work_package_ids[0], "runtime");

  const projection = createWorkbenchProjection(first.workflow_state);
  assert.equal(projection.next_action_readout.action, "run_context_work_packages");
  assert.equal(projection.next_action_readout.status, "ready");
});

test("context work package runner blocks when no packages can dispatch", () => {
  const workflowState = workflowStateWithContextCycle();
  workflowState.manifest.work_packages = workflowState.manifest.work_packages.map((workPackage) => ({
    ...workPackage,
    status: "completed"
  }));
  workflowState.task_dag = workflowState.manifest.work_packages;

  const result = runContextWorkPackages(workflowState);

  assert.equal(result.status, "blocked");
  assert.ok(result.issues.some((issue) => issue.code === "no_dispatchable_work_packages"));
});
