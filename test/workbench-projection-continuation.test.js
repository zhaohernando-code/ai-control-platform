import assert from "node:assert/strict";
import test from "node:test";

import {
  createMobileWorkbenchProjection,
  createWorkbenchProjection
} from "../src/workflow/workbench-projection.js";
import { baseInput } from "./helpers/workbench-projection.js";

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

test("workbench projection stops after completed project status continuation", () => {
  const input = baseInput();
  const artifact = {
    id: "project-status-continuation-run-projection-cycle-complete",
    type: "evaluation",
    status: "pass",
    uri: "project-status://continuation/run-projection/cycle-20260521/project-status-continuation-run-projection-cycle-complete",
    producer: "project-status-continuation",
    created_at: "2026-05-21T00:03:00.000Z",
    metadata: {
      type: "project_status_continuation",
      version: "project-status-continuation.v1",
      status: "completed",
      next_work_package_count: 0
    }
  };
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: `event-${artifact.id}`,
        type: "project_status_continuation",
        status: "completed",
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
  assert.equal(projection.next_action_readout.status, "complete");
  assert.equal(projection.next_action_readout.action, "no_next_action");
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
