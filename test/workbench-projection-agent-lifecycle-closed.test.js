import assert from "node:assert/strict";
import test from "node:test";

import { GOVERNANCE_AUDIT_SKILL_TRIAL_EVENT } from "../src/workflow/governance-audit-skill-trial.js";
import {
  createMobileWorkbenchProjection,
  createWorkbenchProjection
} from "../src/workflow/workbench-projection.js";
import { baseInput } from "./helpers/workbench-projection.js";

test("closed agent lifecycle drivers do not hide pending global continuation", () => {
  const input = baseInput({
    project_status: {
      project: "ai-control-platform",
      global_goals: [
        {
          id: "continue-platform",
          title: "Continue platform",
          status: "in_progress",
          next_step: "Continue repository global goal."
        }
      ]
    }
  });
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: "worker-spawned-closed",
        type: "WorkerSpawned",
        status: "pass",
        created_at: "2026-05-21T00:05:00.000Z",
        metadata: {
          pool_id: "pool-agent-lifecycle-closed",
          worker_id: "child-closed"
        }
      },
      {
        id: "worker-completed-closed",
        type: "WorkerCompleted",
        status: "pass",
        created_at: "2026-05-21T00:06:00.000Z",
        metadata: {
          pool_id: "pool-agent-lifecycle-closed",
          worker_id: "child-closed"
        }
      },
      {
        id: "worker-evaluation-closed",
        type: "WorkerEvaluation",
        status: "pass",
        created_at: "2026-05-21T00:07:00.000Z",
        metadata: {
          pool_id: "pool-agent-lifecycle-closed",
          worker_id: "child-closed"
        }
      },
      {
        id: "worker-closed-closed",
        type: "WorkerClosed",
        status: "pass",
        created_at: "2026-05-21T00:08:00.000Z",
        metadata: {
          pool_id: "pool-agent-lifecycle-closed",
          worker_id: "child-closed"
        }
      },
      {
        id: "pool-iteration-closed",
        type: "PoolIterationClosed",
        status: "pass",
        created_at: "2026-05-21T00:09:00.000Z",
        metadata: {
          pool_id: "pool-agent-lifecycle-closed"
        }
      }
    ]
  };

  const projection = createWorkbenchProjection(input);
  const mobile = createMobileWorkbenchProjection(input);

  assert.equal(projection.agent_lifecycle_pool.status, "pass");
  assert.equal(projection.agent_lifecycle_pool.next_action, null);
  assert.equal(projection.global_goal_completion.pending, 1);
  assert.equal(projection.operations_timeline.latest_driver.type, "PoolIterationClosed");
  assert.equal(projection.next_action_readout.status, "ready");
  assert.equal(projection.next_action_readout.action, "prepare_project_status_continuation");
  assert.equal(projection.next_action_readout.source_type, "PoolIterationClosed");
  assert.equal(mobile.next_action_readout.action, "prepare_project_status_continuation");
});

test("closed agent lifecycle drivers do not hide dispatchable context work packages", () => {
  const input = baseInput({
    project_status: {
      project: "ai-control-platform",
      global_goals: [
        {
          id: "context-packages",
          title: "Context packages",
          status: "in_progress",
          next_step: "Continue dispatching context packages."
        }
      ]
    },
    task_dag: [
      {
        id: "completed-package",
        title: "Completed package",
        status: "completed",
        action: "continue_global_goal",
        owned_files: ["src/workflow/workbench-projection.js"]
      },
      {
        id: "dispatchable-package",
        title: "Dispatchable package",
        status: "pending",
        action: "continue_global_goal",
        owned_files: ["test/workbench-projection.test.js"]
      }
    ]
  });
  input.manifest = {
    ...input.manifest,
    work_packages: input.task_dag,
    events: [
      ...input.manifest.events,
      {
        id: "worker-spawned-dispatchable",
        type: "WorkerSpawned",
        status: "pass",
        created_at: "2026-05-21T00:05:00.000Z",
        metadata: {
          pool_id: "pool-agent-lifecycle-dispatchable",
          worker_id: "child-dispatchable"
        }
      },
      {
        id: "worker-completed-dispatchable",
        type: "WorkerCompleted",
        status: "pass",
        created_at: "2026-05-21T00:06:00.000Z",
        metadata: {
          pool_id: "pool-agent-lifecycle-dispatchable",
          worker_id: "child-dispatchable"
        }
      },
      {
        id: "worker-evaluation-dispatchable",
        type: "WorkerEvaluation",
        status: "pass",
        created_at: "2026-05-21T00:07:00.000Z",
        metadata: {
          pool_id: "pool-agent-lifecycle-dispatchable",
          worker_id: "child-dispatchable"
        }
      },
      {
        id: "worker-closed-dispatchable",
        type: "WorkerClosed",
        status: "pass",
        created_at: "2026-05-21T00:08:00.000Z",
        metadata: {
          pool_id: "pool-agent-lifecycle-dispatchable",
          worker_id: "child-dispatchable"
        }
      },
      {
        id: "pool-iteration-closed-dispatchable",
        type: "PoolIterationClosed",
        status: "pass",
        created_at: "2026-05-21T00:09:00.000Z",
        metadata: {
          pool_id: "pool-agent-lifecycle-dispatchable"
        }
      }
    ]
  };

  const projection = createWorkbenchProjection(input);

  assert.equal(projection.agent_lifecycle_pool.status, "pass");
  assert.equal(projection.task_dag.dispatchable.length, 1);
  assert.equal(projection.global_goal_completion.pending, 1);
  assert.equal(projection.next_action_readout.status, "ready");
  assert.equal(projection.next_action_readout.action, "run_context_work_packages");
  assert.equal(projection.next_action_readout.source_type, "PoolIterationClosed");
});

test("closed agent lifecycle drivers continue when project status next step remains", () => {
  const input = baseInput({
    project_status: {
      project: "ai-control-platform",
      next_step: "Continue durable repository work after current context packages.",
      global_goals: [
        { id: "foundation", title: "Foundation", status: "completed" },
        { id: "workbench", title: "Workbench", status: "completed" }
      ]
    },
    task_dag: [
      {
        id: "completed-package",
        title: "Completed package",
        status: "completed",
        action: "continue_global_goal",
        owned_files: ["src/workflow/workbench-projection.js"]
      }
    ]
  });
  input.manifest = {
    ...input.manifest,
    work_packages: input.task_dag,
    events: [
      ...input.manifest.events,
      {
        id: "worker-spawned-next-step",
        type: "WorkerSpawned",
        status: "pass",
        created_at: "2026-05-21T00:05:00.000Z",
        metadata: {
          pool_id: "pool-agent-lifecycle-next-step",
          worker_id: "child-next-step"
        }
      },
      {
        id: "worker-completed-next-step",
        type: "WorkerCompleted",
        status: "pass",
        created_at: "2026-05-21T00:06:00.000Z",
        metadata: {
          pool_id: "pool-agent-lifecycle-next-step",
          worker_id: "child-next-step"
        }
      },
      {
        id: "worker-evaluation-next-step",
        type: "WorkerEvaluation",
        status: "pass",
        created_at: "2026-05-21T00:07:00.000Z",
        metadata: {
          pool_id: "pool-agent-lifecycle-next-step",
          worker_id: "child-next-step"
        }
      },
      {
        id: "worker-closed-next-step",
        type: "WorkerClosed",
        status: "pass",
        created_at: "2026-05-21T00:08:00.000Z",
        metadata: {
          pool_id: "pool-agent-lifecycle-next-step",
          worker_id: "child-next-step"
        }
      },
      {
        id: "pool-iteration-closed-next-step",
        type: "PoolIterationClosed",
        status: "pass",
        created_at: "2026-05-21T00:09:00.000Z",
        metadata: {
          pool_id: "pool-agent-lifecycle-next-step"
        }
      }
    ]
  };

  const projection = createWorkbenchProjection(input);

  assert.equal(projection.task_dag.dispatchable.length, 0);
  assert.equal(projection.global_goal_completion.status, "complete");
  assert.equal(projection.next_action_readout.status, "ready");
  assert.equal(projection.next_action_readout.action, "prepare_project_status_continuation");
  assert.equal(projection.next_action_readout.source_type, "PoolIterationClosed");
  assert.equal(projection.next_action_readout.reason, "Continue durable repository work after current context packages.");
});
