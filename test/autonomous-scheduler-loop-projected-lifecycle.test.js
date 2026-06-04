import assert from "node:assert/strict";
import test from "node:test";

import {
  runSchedulerLoopDriver,
  schedulerLoopInput
} from "../src/workflow/autonomous-scheduler-loop.js";

test("scheduler loop executes projected lifecycle cleanup through next action in place", async () => {
  const calls = [];
  let cleaned = false;
  const client = {
    async loadHistory() {
      calls.push(["loadHistory"]);
      return { latest: "current" };
    },
    async loadProjection(id) {
      calls.push(["projection", id]);
      return {
        next_action_readout: {
          status: "ready",
          action: cleaned ? "inspect_resume_target" : "cleanup_agent_lifecycle_pool"
        }
      };
    },
    async runNextAction(id, body) {
      calls.push(["nextAction", id, body]);
      cleaned = true;
      return {
        status: "executed",
        action: body.expected_action,
        result: {
          projection: {
            agent_lifecycle_pool: { status: "pass" },
            next_action_readout: {
              status: "ready",
              action: "inspect_resume_target"
            }
          }
        }
      };
    }
  };
  const result = await runSchedulerLoopDriver({
    max_iterations: 2,
    execution_strategy: "projected_next_action",
    snapshot_prefix: "cleanup-loop"
  }, { client });

  assert.equal(result.status, "pass");
  assert.equal(result.phase, "terminal_projected_action");
  assert.equal(result.iterations.length, 2);
  assert.equal(result.iterations[0].projected_action, "cleanup_agent_lifecycle_pool");
  assert.equal(result.iterations[0].next_projection_id, null);
  assert.equal(result.iterations[1].projected_action, "inspect_resume_target");
  assert.deepEqual(calls.map((call) => call[0]), ["loadHistory", "projection", "nextAction", "projection"]);
  assert.equal(calls[2][1], "current");
  assert.equal(calls[2][2].expected_action, "cleanup_agent_lifecycle_pool");
  assert.equal(calls[2][2].snapshot_id, "cleanup-loop-current-01");
});

test("scheduler loop blocks projected lifecycle cleanup without progress evidence", async () => {
  const calls = [];
  const client = {
    async loadHistory() {
      calls.push(["loadHistory"]);
      return { latest: "current" };
    },
    async loadProjection(id) {
      calls.push(["projection", id]);
      return {
        next_action_readout: {
          status: "ready",
          action: "cleanup_agent_lifecycle_pool"
        }
      };
    },
    async runNextAction(id, body) {
      calls.push(["nextAction", id, body]);
      return {
        status: "executed",
        action: body.expected_action,
        result: {}
      };
    }
  };
  const result = await runSchedulerLoopDriver({
    max_iterations: 3,
    execution_strategy: "projected_next_action",
    snapshot_prefix: "cleanup-loop"
  }, { client });

  assert.equal(result.status, "fail");
  assert.equal(result.phase, "projected_action_missing_progress_evidence");
  assert.equal(result.iterations.length, 1);
  assert.equal(result.iterations[0].status, "blocked");
  assert.equal(result.iterations[0].projected_action, "cleanup_agent_lifecycle_pool");
  assert.ok(result.issues.some((entry) => entry.code === "projected_action_missing_progress_evidence"));
  assert.deepEqual(calls.map((call) => call[0]), ["loadHistory", "projection", "nextAction"]);
});

test("scheduler loop blocks projected next action when returned projection preserves the same readout", async () => {
  const staleReadout = {
    status: "ready",
    action: "cleanup_agent_lifecycle_pool",
    source_event_id: "event-stale",
    source_type: "WorkerCompleted",
    reason: "cleanup still appears pending"
  };
  const calls = [];
  const client = {
    async loadHistory() {
      calls.push(["loadHistory"]);
      return { latest: "current" };
    },
    async loadProjection(id) {
      calls.push(["projection", id]);
      return { next_action_readout: staleReadout };
    },
    async runNextAction(id, body) {
      calls.push(["nextAction", id, body]);
      return {
        status: "executed",
        action: body.expected_action,
        result: {
          projection: {
            id,
            next_action_readout: staleReadout
          }
        }
      };
    }
  };
  const result = await runSchedulerLoopDriver({
    max_iterations: 2,
    execution_strategy: "projected_next_action",
    snapshot_prefix: "stale-loop"
  }, { client });

  assert.equal(result.status, "fail");
  assert.equal(result.phase, "projected_action_missing_progress_evidence");
  assert.equal(result.iterations.length, 1);
  assert.equal(result.iterations[0].status, "blocked");
  assert.equal(result.iterations[0].projected_action, "cleanup_agent_lifecycle_pool");
  assert.ok(result.issues.some((entry) => entry.code === "projected_action_missing_progress_evidence"));
  assert.deepEqual(calls.map((call) => call[0]), ["loadHistory", "projection", "nextAction"]);
});

test("scheduler loop real reviewer profile requires projected strategy and passes reviewer controls", async () => {
  const calls = [];
  const client = {
    async loadHistory() {
      calls.push(["loadHistory"]);
      return { latest: "current" };
    },
    async loadProjection(id) {
      calls.push(["projection", id]);
      return {
        next_action_readout: {
          status: "ready",
          action: id === "current-next" ? "inspect_resume_target" : "run_reviewer_scope_shard"
        }
      };
    },
    async runNextAction(id, body) {
      calls.push(["nextAction", id, body]);
      return {
        status: "executed",
        action: body.expected_action,
        result: { next_item: { id: `${id}-next` } }
      };
    }
  };
  const invalid = schedulerLoopInput({
    execution_profile: "approved_bounded_real_reviewer",
    execution_strategy: "scheduler_dispatch_chain"
  });
  const result = await runSchedulerLoopDriver({
    max_iterations: 2,
    execution_profile: "approved_bounded_real_reviewer",
    execution_strategy: "projected_next_action",
    max_external_reviewer_calls: 1,
    provider_cost_mode: "bounded",
    timeout_seconds: 90,
    budget_tier: "medium"
  }, { client });

  assert.equal(invalid.status, "fail");
  assert.ok(invalid.issues.some((entry) => entry.code === "real_reviewer_requires_projected_strategy"));
  assert.equal(result.status, "pass");
  assert.equal(calls[2][2].execution_profile, "approved_bounded_real_reviewer");
  assert.equal(calls[2][2].max_external_reviewer_calls, 1);
  assert.equal(calls[2][2].provider_cost_mode, "bounded");
  assert.equal(calls[2][2].timeout_seconds, 90);
});
