import assert from "node:assert/strict";
import test from "node:test";

import { runSchedulerLoopDriverWithFallback } from "../src/workflow/autonomous-scheduler-loop.js";

function projectedNextActionUnreachableClient(overrides = {}) {
  return {
    async loadHistory() {
      return { latest: "current" };
    },
    async loadProjection() {
      const error = new Error("ECONNREFUSED: workbench server unreachable");
      throw error;
    },
    async runNextAction() {
      throw new Error("ECONNREFUSED: workbench server unreachable");
    },
    async createSchedulerDispatchPlan(id, body) {
      overrides.calls?.push(["plan", id, body]);
      return overrides.plan || {
        status: "created",
        plan: { status: "pass", phase: "scheduler_dispatch_plan", steps: [{ id: "run-reviewer-shard-loop" }] }
      };
    },
    async runSchedulerDispatch(id, body) {
      overrides.calls?.push(["dispatch", id, body]);
      return overrides.dispatch || {
        status: "created",
        projection: { scheduler_continuation: { ready: true } }
      };
    },
    async enqueueSchedulerNextCycle(id, body) {
      overrides.calls?.push(["enqueue", id, body]);
      return overrides.enqueue || { status: "queued", next_item: { id: `${id}-next` } };
    }
  };
}

test("scheduler loop fallback retries with dispatch-chain when projected_next_action loses connectivity", async () => {
  const calls = [];
  const client = projectedNextActionUnreachableClient({ calls });
  const result = await runSchedulerLoopDriverWithFallback({
    max_iterations: 1,
    execution_strategy: "projected_next_action",
    allow_strategy_fallback: true,
    snapshot_prefix: "fallback-loop"
  }, { client });

  assert.equal(result.status, "pass");
  assert.equal(result.phase, "iteration_limit_reached");
  assert.equal(result.fallback.attempted, true);
  assert.equal(result.fallback.from_strategy, "projected_next_action");
  assert.equal(result.fallback.to_strategy, "scheduler_dispatch_chain");
  assert.equal(result.primary_result.status, "fail");
  assert.equal(result.primary_result.phase, "execution");
  assert.ok(calls.length >= 3);
  const callOrder = calls.map(([type]) => type);
  assert.deepEqual(callOrder, ["plan", "dispatch", "enqueue"]);
});

test("scheduler loop fallback refuses when allow_strategy_fallback is not set", async () => {
  const client = projectedNextActionUnreachableClient();
  const result = await runSchedulerLoopDriverWithFallback({
    max_iterations: 1,
    execution_strategy: "projected_next_action"
  }, { client });

  assert.equal(result.status, "fail");
  assert.equal(result.phase, "execution");
  assert.equal(result.fallback, undefined);
});

test("scheduler loop fallback refuses for approved_bounded_real_reviewer profile", async () => {
  const client = projectedNextActionUnreachableClient();
  const result = await runSchedulerLoopDriverWithFallback({
    max_iterations: 1,
    execution_strategy: "projected_next_action",
    execution_profile: "approved_bounded_real_reviewer",
    allow_strategy_fallback: true,
    reviewer_mock_status: "pass"
  }, { client });

  assert.equal(result.status, "fail");
  assert.equal(result.fallback.attempted, false);
  assert.ok(result.fallback.reason.includes("approved_bounded_real_reviewer"));
});

test("scheduler loop fallback refuses when dispatch-chain client methods are missing", async () => {
  const partialClient = {
    async loadHistory() { return { latest: "current" }; },
    async loadProjection() { throw new Error("ECONNREFUSED"); },
    async runNextAction() { throw new Error("ECONNREFUSED"); }
  };
  const result = await runSchedulerLoopDriverWithFallback({
    max_iterations: 1,
    execution_strategy: "projected_next_action",
    allow_strategy_fallback: true
  }, { client: partialClient });

  assert.equal(result.status, "fail");
  assert.equal(result.fallback.attempted, false);
  assert.ok(result.fallback.reason.includes("dispatch-chain"));
});
