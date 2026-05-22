import assert from "node:assert/strict";
import test from "node:test";

import { summarizeAgentLifecyclePool } from "../src/workflow/agent-lifecycle-pool.js";

test("summarizes latest agent lifecycle pool cleanup state from durable events", () => {
  const summary = summarizeAgentLifecyclePool({
    events: [
      {
        id: "spawn-old",
        type: "WorkerSpawned",
        status: "pass",
        metadata: { pool_id: "pool-old", worker_id: "worker-old" }
      },
      {
        id: "close-old",
        type: "PoolIterationClosed",
        status: "pass",
        metadata: { pool_id: "pool-old" }
      },
      {
        id: "spawn-1",
        type: "WorkerSpawned",
        status: "pass",
        metadata: { pool_id: "pool-latest", worker_id: "worker-1" }
      },
      {
        id: "complete-1",
        type: "WorkerCompleted",
        status: "pass",
        metadata: { pool_id: "pool-latest", worker_id: "worker-1" }
      },
      {
        id: "spawn-2",
        type: "WorkerSpawned",
        status: "pass",
        metadata: { pool_id: "pool-latest", worker_id: "worker-2" }
      }
    ]
  });

  assert.equal(summary.pool_id, "pool-latest");
  assert.equal(summary.spawned, 2);
  assert.equal(summary.completed, 1);
  assert.equal(summary.evaluated, 0);
  assert.equal(summary.closed, 0);
  assert.equal(summary.open, 1);
  assert.equal(summary.unevaluated, 1);
  assert.equal(summary.unclosed, 2);
  assert.equal(summary.status, "open");
  assert.equal(summary.next_action, "cleanup_agent_lifecycle_pool");
});

test("closed and evaluated workers pass only after pool iteration close", () => {
  const summary = summarizeAgentLifecyclePool({
    events: [
      { type: "WorkerSpawned", metadata: { pool_id: "pool-clean", worker_id: "worker-1" } },
      { type: "WorkerCompleted", metadata: { pool_id: "pool-clean", worker_id: "worker-1" } },
      { type: "WorkerEvaluation", metadata: { pool_id: "pool-clean", worker_id: "worker-1" } },
      { type: "WorkerClosed", metadata: { pool_id: "pool-clean", worker_id: "worker-1" } },
      { type: "PoolIterationClosed", status: "pass", metadata: { pool_id: "pool-clean" } }
    ]
  });

  assert.equal(summary.status, "pass");
  assert.equal(summary.next_action, null);
  assert.equal(summary.open, 0);
  assert.equal(summary.unevaluated, 0);
  assert.equal(summary.unclosed, 0);
});
