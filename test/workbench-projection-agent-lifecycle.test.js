import assert from "node:assert/strict";
import test from "node:test";

import { GOVERNANCE_AUDIT_SKILL_TRIAL_EVENT } from "../src/workflow/governance-audit-skill-trial.js";
import {
  createMobileWorkbenchProjection,
  createWorkbenchProjection
} from "../src/workflow/workbench-projection.js";
import { baseInput } from "./helpers/workbench-projection.js";

test("workbench projection and mobile expose agent lifecycle pool cleanup readout", () => {
  const input = baseInput();
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: "worker-spawned-1",
        type: "WorkerSpawned",
        status: "pass",
        created_at: "2026-05-21T00:05:00.000Z",
        metadata: {
          pool_id: "pool-agent-lifecycle",
          worker_id: "child-1"
        }
      },
      {
        id: "worker-completed-1",
        type: "WorkerCompleted",
        status: "pass",
        created_at: "2026-05-21T00:06:00.000Z",
        metadata: {
          pool_id: "pool-agent-lifecycle",
          worker_id: "child-1"
        }
      }
    ]
  };

  const projection = createWorkbenchProjection(input);
  const mobile = createMobileWorkbenchProjection(input);

  assert.equal(projection.agent_lifecycle_pool.status, "unevaluated");
  assert.equal(projection.agent_lifecycle_pool.spawned, 1);
  assert.equal(projection.agent_lifecycle_pool.unevaluated, 1);
  assert.equal(projection.agent_lifecycle_pool.unclosed, 1);
  assert.equal(projection.operations_timeline.group_counts.agent_lifecycle_pool, 2);
  assert.equal(projection.operations_timeline.latest.type, "WorkerCompleted");
  assert.equal(projection.next_action_readout.status, "ready");
  assert.equal(projection.next_action_readout.action, "cleanup_agent_lifecycle_pool");
  assert.equal(projection.next_action_readout.source_type, "agent_lifecycle_pool");
  assert.equal(projection.one_screen.counters.agent_lifecycle_unevaluated, 1);
  assert.equal(mobile.agent_lifecycle_pool.status, "unevaluated");
  assert.equal(mobile.next_action_readout.action, "cleanup_agent_lifecycle_pool");
});

test("workbench projection and mobile expose agent lifecycle heartbeat and timeout readout", () => {
  const input = baseInput();
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: "worker-spawned-timeout-1",
        type: "WorkerSpawned",
        status: "pass",
        created_at: "2026-05-21T00:05:00.000Z",
        metadata: {
          pool_id: "pool-agent-lifecycle-timeout",
          worker_id: "child-timeout-1"
        }
      },
      {
        id: "worker-heartbeat-timeout-1",
        type: "WorkerHeartbeat",
        status: "pass",
        created_at: "2026-05-21T00:06:00.000Z",
        metadata: {
          pool_id: "pool-agent-lifecycle-timeout",
          worker_id: "child-timeout-1"
        }
      },
      {
        id: "worker-timeout-1",
        type: "WorkerTimeout",
        status: "fail",
        created_at: "2026-05-21T00:08:00.000Z",
        metadata: {
          pool_id: "pool-agent-lifecycle-timeout",
          worker_id: "child-timeout-1",
          issues: [{ code: "agent_lifecycle_worker_timeout", message: "child timed out" }]
        }
      }
    ]
  };

  const projection = createWorkbenchProjection(input);
  const mobile = createMobileWorkbenchProjection(input);

  assert.equal(projection.agent_lifecycle_pool.status, "blocked");
  assert.equal(projection.agent_lifecycle_pool.heartbeat_count, 1);
  assert.equal(projection.agent_lifecycle_pool.timed_out, 1);
  assert.equal(projection.agent_lifecycle_pool.latest_heartbeat_at, "2026-05-21T00:06:00.000Z");
  assert.equal(projection.agent_lifecycle_pool.latest_timeout_at, "2026-05-21T00:08:00.000Z");
  assert.equal(projection.agent_lifecycle_pool.timed_out_workers[0].worker_id, "child-timeout-1");
  assert.equal(projection.one_screen.counters.agent_lifecycle_timed_out, 1);
  assert.equal(projection.one_screen.counters.agent_lifecycle_heartbeats, 1);
  assert.equal(projection.next_action_readout.status, "blocked");
  assert.equal(projection.next_action_readout.action, "cleanup_agent_lifecycle_pool");
  assert.equal(mobile.agent_lifecycle_pool.timed_out, 1);
  assert.equal(mobile.agent_lifecycle_pool.heartbeat_count, 1);
  assert.equal(mobile.agent_lifecycle_pool.latest_heartbeat_at, "2026-05-21T00:06:00.000Z");
  assert.equal(mobile.agent_lifecycle_pool.latest_timeout_at, "2026-05-21T00:08:00.000Z");
  assert.equal(mobile.agent_lifecycle_pool.timed_out_workers[0].worker_id, "child-timeout-1");
});
