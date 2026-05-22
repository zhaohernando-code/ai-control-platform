import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  cleanupAgentLifecyclePool,
  createAgentLifecycleFact,
  recordAgentLifecycleFact,
  summarizeAgentLifecyclePool
} from "../src/workflow/agent-lifecycle-pool.js";

function workflowState(events = []) {
  return {
    manifest: {
      run_id: "run-agent-lifecycle",
      cycle_id: "cycle-agent-lifecycle",
      events,
      artifacts: [],
      gate_results: [],
      review_findings: [],
      recovery_attempts: []
    },
    artifact_ledger: {
      run_id: "run-agent-lifecycle",
      cycle_id: "cycle-agent-lifecycle",
      artifacts: []
    }
  };
}

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

test("creates agent lifecycle facts from camel and snake case event types", () => {
  const spawned = createAgentLifecycleFact({
    event_type: "WorkerSpawned",
    pool_id: "pool-fact",
    worker_id: "worker-1",
    created_at: "2026-05-22T08:00:00.000Z"
  });
  const closed = createAgentLifecycleFact({
    event_type: "worker_closed",
    pool_id: "pool-fact",
    worker_id: "worker-1",
    created_at: "2026-05-22T08:01:00.000Z"
  });

  assert.equal(spawned.event_type, "WorkerSpawned");
  assert.equal(closed.event_type, "WorkerClosed");
  assert.equal(spawned.validation_issues.length, 0);
});

test("creates heartbeat and timeout lifecycle facts", () => {
  const heartbeat = createAgentLifecycleFact({
    event_type: "worker_heartbeat",
    pool_id: "pool-fact",
    worker_id: "worker-1",
    created_at: "2026-05-22T08:01:30.000Z"
  });
  const timeout = createAgentLifecycleFact({
    event_type: "WorkerTimeout",
    pool_id: "pool-fact",
    worker_id: "worker-1",
    status: "timeout",
    issue: "worker stopped sending heartbeat",
    created_at: "2026-05-22T08:02:30.000Z"
  });

  assert.equal(heartbeat.event_type, "WorkerHeartbeat");
  assert.equal(timeout.event_type, "WorkerTimeout");
  assert.equal(timeout.status, "fail");
  assert.equal(heartbeat.validation_issues.length, 0);
  assert.equal(timeout.validation_issues.length, 0);
});

test("records lifecycle fact into manifest and artifact ledger", () => {
  const result = recordAgentLifecycleFact(workflowState(), {
    event_type: "WorkerSpawned",
    pool_id: "pool-record",
    worker_id: "worker-1",
    created_at: "2026-05-22T08:02:00.000Z"
  });

  assert.equal(result.status, "pass");
  assert.equal(result.workflow_state.manifest.events.at(-1).type, "WorkerSpawned");
  assert.equal(result.workflow_state.manifest.artifacts.at(-1).metadata.lifecycle_event, "WorkerSpawned");
  assert.equal(result.workflow_state.artifact_ledger.artifacts.at(-1).metadata.pool_id, "pool-record");
});

test("records heartbeat and timeout facts into summary readout", () => {
  let state = workflowState();
  for (const input of [
    {
      event_type: "WorkerSpawned",
      pool_id: "pool-heartbeat",
      worker_id: "worker-1",
      created_at: "2026-05-22T08:00:00.000Z"
    },
    {
      event_type: "WorkerHeartbeat",
      pool_id: "pool-heartbeat",
      worker_id: "worker-1",
      created_at: "2026-05-22T08:01:00.000Z"
    },
    {
      event_type: "WorkerHeartbeat",
      pool_id: "pool-heartbeat",
      worker_id: "worker-1",
      created_at: "2026-05-22T08:02:00.000Z"
    },
    {
      event_type: "WorkerTimeout",
      pool_id: "pool-heartbeat",
      worker_id: "worker-1",
      status: "timeout",
      issue: "silent worker exceeded threshold",
      created_at: "2026-05-22T08:05:00.000Z"
    }
  ]) {
    const result = recordAgentLifecycleFact(state, input);
    assert.equal(result.status, "pass");
    state = result.workflow_state;
  }

  assert.equal(state.manifest.events.at(-1).type, "WorkerTimeout");
  assert.equal(state.manifest.artifacts.at(-1).metadata.lifecycle_event, "WorkerTimeout");
  assert.equal(state.artifact_ledger.artifacts.at(-1).metadata.worker_id, "worker-1");

  const summary = summarizeAgentLifecyclePool(state.manifest, state.artifact_ledger);
  assert.equal(summary.timed_out, 1);
  assert.equal(summary.heartbeat_count, 2);
  assert.equal(summary.latest_heartbeat_at, "2026-05-22T08:02:00.000Z");
  assert.equal(summary.latest_timeout_at, "2026-05-22T08:05:00.000Z");
  assert.match(summary.latest_issue, /silent worker/);
  assert.equal(summary.timed_out_workers[0].worker_id, "worker-1");
});

test("cleanup latest pool records missing evaluation close and iteration close", () => {
  let state = workflowState();
  for (const input of [
    { event_type: "WorkerSpawned", pool_id: "pool-cleanup", worker_id: "worker-1" },
    { event_type: "WorkerCompleted", pool_id: "pool-cleanup", worker_id: "worker-1" }
  ]) {
    const result = recordAgentLifecycleFact(state, { ...input, created_at: "2026-05-22T08:03:00.000Z" });
    state = result.workflow_state;
  }

  const cleanup = cleanupAgentLifecyclePool(state, {
    created_at: "2026-05-22T08:04:00.000Z"
  });

  assert.equal(cleanup.status, "pass");
  assert.deepEqual(cleanup.facts.map((fact) => fact.event_type), [
    "WorkerEvaluation",
    "WorkerClosed",
    "PoolIterationClosed"
  ]);
  assert.equal(cleanup.after.status, "pass");
  assert.equal(cleanup.after.next_action, null);
});

test("cleanup records timeout for silent worker once when threshold is exceeded", () => {
  let state = workflowState();
  const spawned = recordAgentLifecycleFact(state, {
    event_type: "WorkerSpawned",
    pool_id: "pool-timeout",
    worker_id: "worker-silent",
    created_at: "2026-05-22T08:00:00.000Z"
  });
  state = spawned.workflow_state;

  const cleanup = cleanupAgentLifecyclePool(state, {
    now: "2026-05-22T08:05:00.000Z",
    timeout_threshold_ms: 60_000
  });

  assert.equal(cleanup.status, "cleanup_required");
  assert.equal(cleanup.facts.filter((fact) => fact.event_type === "WorkerTimeout").length, 1);
  assert.equal(cleanup.after.timed_out, 1);
  assert.equal(cleanup.after.latest_timeout_at, "2026-05-22T08:05:00.000Z");
  assert.match(cleanup.after.latest_issue, /timed out/);

  const secondCleanup = cleanupAgentLifecyclePool(cleanup.workflow_state, {
    now: "2026-05-22T08:06:00.000Z",
    timeout_threshold_ms: 60_000
  });

  assert.equal(secondCleanup.facts.filter((fact) => fact.event_type === "WorkerTimeout").length, 0);
  assert.equal(secondCleanup.after.timed_out, 1);
});

test("cleanup latest pool closes open spawned workers without looping", () => {
  let state = workflowState();
  const spawned = recordAgentLifecycleFact(state, {
    event_type: "WorkerSpawned",
    pool_id: "pool-open",
    worker_id: "worker-open",
    created_at: "2026-05-22T08:04:30.000Z"
  });
  state = spawned.workflow_state;

  const cleanup = cleanupAgentLifecyclePool(state, {
    created_at: "2026-05-22T08:04:40.000Z"
  });

  assert.equal(cleanup.status, "pass");
  assert.deepEqual(cleanup.facts.map((fact) => fact.event_type), [
    "WorkerCompleted",
    "WorkerEvaluation",
    "WorkerClosed",
    "PoolIterationClosed"
  ]);
  assert.equal(cleanup.after.status, "pass");
  assert.equal(cleanup.after.open, 0);
  assert.equal(cleanup.after.unevaluated, 0);
  assert.equal(cleanup.after.unclosed, 0);
  assert.equal(cleanup.after.next_action, null);
});

test("blocked cleanup writes durable blocker and keeps projection blocked", () => {
  let state = workflowState();
  for (const input of [
    { event_type: "WorkerSpawned", pool_id: "pool-blocked", worker_id: "worker-1" },
    { event_type: "WorkerCompleted", pool_id: "pool-blocked", worker_id: "worker-1" }
  ]) {
    const result = recordAgentLifecycleFact(state, { ...input, created_at: "2026-05-22T08:05:00.000Z" });
    state = result.workflow_state;
  }

  const cleanup = cleanupAgentLifecyclePool(state, {
    failure: "child process exited without usable result",
    created_at: "2026-05-22T08:06:00.000Z"
  });

  assert.equal(cleanup.status, "blocked");
  assert.equal(cleanup.facts[0].status, "fail");
  assert.equal(cleanup.after.status, "blocked");
  assert.equal(cleanup.after.next_action, "cleanup_agent_lifecycle_pool");
  assert.match(cleanup.after.latest_issue, /child process exited/);
});

test("agent lifecycle CLI fails closed on unreadable input", () => {
  const result = spawnSync(process.execPath, [
    "tools/record-agent-lifecycle-pool.mjs",
    "--input",
    "tmp/does-not-exist-agent-lifecycle.json",
    "--output",
    "tmp/unused-agent-lifecycle.json",
    "--cleanup-latest-pool"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /agent_lifecycle_input_read_failed/);
});
