import assert from "node:assert/strict";
import test from "node:test";

import { createRunManifest } from "../src/workflow/run-manifest.js";
import {
  createMobileWorkbenchProjection,
  createWorkbenchProjection
} from "../src/workflow/workbench-projection.js";
import { baseInput } from "./helpers/workbench-projection.js";

test("workbench projection advances from completed context work packages to global goal continuation", () => {
  const input = baseInput({
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
    },
    task_dag: [
      {
        id: "runtime",
        title: "Runtime",
        status: "completed",
        action: "implement",
        owned_files: ["src/workflow/context-work-package-runner.js"]
      }
    ]
  });
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: "context-work-packages-run-001",
        type: "context_work_packages_run",
        status: "pass",
        created_at: "2026-05-21T00:05:00.000Z",
        metadata: {
          type: "context_work_packages_run",
          status: "pass",
          executed_count: 1
        }
      }
    ]
  };

  const projection = createWorkbenchProjection(input);

  assert.equal(projection.task_dag.dispatchable.length, 0);
  assert.equal(projection.global_goal_completion.pending, 1);
  assert.equal(projection.operations_timeline.latest.type, "context_work_packages_run");
  assert.equal(projection.next_action_readout.status, "ready");
  assert.equal(projection.next_action_readout.action, "prepare_project_status_continuation");
  assert.equal(projection.next_action_readout.source_type, "context_work_packages_run");
});

test("workbench projection reports complete when goals and context work are exhausted", () => {
  const input = baseInput({
    project_status: {
      project: "ai-control-platform",
      next_step: "",
      global_goals: [
        { id: "foundation", title: "Foundation", status: "completed", completed: true },
        { id: "completion-loop", title: "Completion loop", status: "completed", completed: true }
      ]
    },
    task_dag: [
      {
        id: "runtime",
        title: "Runtime",
        status: "completed",
        action: "implement",
        owned_files: ["src/workflow/context-work-package-runner.js"]
      }
    ]
  });
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: "context-work-packages-run-complete",
        type: "context_work_packages_run",
        status: "pass",
        created_at: "2026-05-21T00:06:00.000Z",
        metadata: {
          type: "context_work_packages_run",
          status: "pass",
          executed_count: 1
        }
      }
    ]
  };

  const projection = createWorkbenchProjection(input);
  const mobile = createMobileWorkbenchProjection(input);

  assert.equal(projection.global_goal_completion.status, "complete");
  assert.equal(projection.task_dag.dispatchable.length, 0);
  assert.equal(projection.next_action_readout.status, "complete");
  assert.equal(projection.next_action_readout.action, "no_next_action");
  assert.equal(projection.next_action_terminal.terminal_action, "no_next_action");
  assert.equal(mobile.next_action_readout.status, "complete");
  assert.equal(mobile.next_action_readout.action, "no_next_action");
});

test("workbench projection ignores stale reviewer gate from a previous cycle", () => {
  const input = baseInput({
    project_status: {
      project: "ai-control-platform",
      next_step: "",
      global_goals: [
        { id: "current-cycle-goal", title: "Current cycle goal", status: "completed", completed: true }
      ]
    },
    reviewer_gate: {
      request: {
        run_id: "run-projection",
        cycle_id: "cycle-previous",
        scope: "Old cycle review."
      },
      findings: [
        {
          id: "old-cycle-finding",
          status: "fail",
          severity: "medium",
          message: "Old cycle finding must not force the current cycle to rerun."
        }
      ]
    }
  });
  input.manifest = createRunManifest({
    ...input.manifest,
    cycle_id: "cycle-current",
    work_packages: [
      { id: "projection-runtime", status: "completed", owned_files: ["src/workflow/workbench-projection.js"] },
      { id: "projection-test", status: "completed", owned_files: ["test/workbench-projection.test.js"] }
    ],
    review_findings: []
  });
  input.task_dag = input.manifest.work_packages;

  const projection = createWorkbenchProjection(input);

  assert.equal(projection.manifest.status, "pass");
  assert.equal(projection.reviewer_gate.recommended_decision_signal, "pass");
  assert.notEqual(projection.status, "rerun");
});

test("workbench projection treats stale next_step as complete after all context work is done", () => {
  const input = baseInput({
    project_status: {
      project: "ai-control-platform",
      next_step: "Stale next step from a goal that is already complete.",
      global_goals: [
        { id: "done-goal", title: "Done goal", status: "completed", completed: true }
      ]
    },
    task_dag: [
      {
        id: "projection-runtime",
        title: "Projection runtime",
        status: "completed",
        owned_files: ["src/workflow/workbench-projection.js"]
      }
    ]
  });
  input.manifest = {
    ...input.manifest,
    work_packages: input.task_dag,
    review_findings: [],
    events: [
      ...input.manifest.events,
      {
        id: "context-work-packages-run-complete",
        type: "context_work_packages_run",
        status: "pass",
        created_at: "2026-05-21T00:06:00.000Z",
        metadata: {
          type: "context_work_packages_run",
          status: "pass",
          executed_count: 1
        }
      },
      {
        id: "context-pack-cycle-materialized-after-run",
        type: "context_pack_cycle_materialized",
        status: "ready",
        created_at: "2026-05-21T00:07:00.000Z",
        metadata: {
          type: "context_pack_cycle_materialized",
          status: "ready"
        }
      }
    ]
  };

  const projection = createWorkbenchProjection(input);

  assert.equal(projection.global_goal_completion.status, "complete");
  assert.equal(projection.task_dag.dispatchable.length, 0);
  assert.equal(projection.operations_timeline.latest.type, "context_pack_cycle_materialized");
  assert.equal(projection.next_action_readout.status, "complete");
  assert.equal(projection.next_action_readout.action, "no_next_action");
});
