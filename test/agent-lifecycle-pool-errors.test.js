import assert from "node:assert/strict";
import test from "node:test";
import { recordAgentLifecycleFact, createAgentLifecycleFact } from "../src/workflow/agent-lifecycle-pool.js";

// Error/edge-branch coverage for agent-lifecycle-pool.js (baseline 78.26% branch). The fact
// recorder guards durable lifecycle facts; its validation branches are reachable with plain input.

const validState = {
  manifest: { run_id: "run-1", cycle_id: "cycle-1" },
  artifact_ledger: { run_id: "run-1", cycle_id: "cycle-1" }
};

test("recordAgentLifecycleFact: non-object workflow state is rejected", () => {
  for (const bad of [null, "x", 42, []]) {
    const r = recordAgentLifecycleFact(bad, { event_type: "WorkerSpawned", worker_id: "w1" });
    assert.equal(r.status, "fail");
    assert.equal(r.issues[0].code, "invalid_workflow_state");
  }
});

test("createAgentLifecycleFact: an unsupported event type is a validation issue", () => {
  const fact = createAgentLifecycleFact({ event_type: "NotARealEvent", worker_id: "w1" });
  assert.ok(fact.validation_issues.some((i) => i.code === "unsupported_agent_lifecycle_fact_type"));
});

test("createAgentLifecycleFact: a worker lifecycle event without worker_id is a validation issue", () => {
  const fact = createAgentLifecycleFact({ event_type: "WorkerSpawned" });
  assert.ok(fact.validation_issues.some((i) => i.code === "missing_agent_lifecycle_worker_id"));
});

test("recordAgentLifecycleFact: invalid fact input surfaces validation issues as a fail", () => {
  const r = recordAgentLifecycleFact(validState, {});
  assert.equal(r.status, "fail");
  assert.equal(r.issues[0].code, "unsupported_agent_lifecycle_fact_type");
});

test("recordAgentLifecycleFact: a valid worker-spawned fact records a durable fact", () => {
  const r = recordAgentLifecycleFact(validState, { event_type: "WorkerSpawned", worker_id: "w1", pool_id: "pool-1" });
  assert.equal(r.status, "pass");
  assert.equal(r.fact.worker_id, "w1");
  assert.equal(r.fact.event_type, "WorkerSpawned");
  assert.ok(r.workflow_state, "a durable workflow_state is returned");
});
