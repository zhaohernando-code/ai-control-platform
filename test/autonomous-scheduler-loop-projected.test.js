import assert from "node:assert/strict";
import test from "node:test";

import { runSchedulerLoopDriver } from "../src/workflow/autonomous-scheduler-loop.js";

test("scheduler loop can follow projected next-action recommendations", async () => {
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
          action: id === "current-next" ? "inspect_resume_target" : "enqueue_scheduler_next_cycle"
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
  const result = await runSchedulerLoopDriver({
    max_iterations: 2,
    execution_strategy: "projected_next_action",
    reviewer_mock_status: "pass",
    snapshot_prefix: "projected-loop"
  }, { client });

  assert.equal(result.status, "pass");
  assert.equal(result.phase, "terminal_projected_action");
  assert.equal(result.iterations.length, 2);
  assert.equal(result.iterations[0].projected_action, "enqueue_scheduler_next_cycle");
  assert.equal(result.iterations[0].next_projection_id, "current-next");
  assert.equal(result.iterations[1].projected_action, "inspect_resume_target");
  assert.equal(result.iterations[1].terminal_action, "inspect_resume_target");
  assert.equal(result.iterations[1].terminal_reason, "projected next action is not executable");
  assert.deepEqual(calls.map((call) => call[0]), ["loadHistory", "projection", "nextAction", "projection"]);
  assert.equal(calls[2][2].expected_action, "enqueue_scheduler_next_cycle");
  assert.equal(calls[2][2].reviewer_mock_status, "pass");
  assert.equal(calls[2][2].snapshot_id, "projected-loop-current-01");
});

test("scheduler loop keeps projected next-action snapshot ids publishable", async () => {
  const calls = [];
  const longProjectionId = "headless-live-context-cycle-1779570720000";
  const client = {
    async loadHistory() {
      calls.push(["loadHistory"]);
      return { latest: longProjectionId };
    },
    async loadProjection(id) {
      calls.push(["projection", id]);
      return {
        next_action_readout: {
          status: "ready",
          action: "create_context_pack_from_seed"
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
  const result = await runSchedulerLoopDriver({
    max_iterations: 1,
    execution_strategy: "projected_next_action",
    snapshot_prefix: "requirement-intake-replay-20260525-module-update"
  }, { client });
  const snapshotId = calls[2][2].snapshot_id;

  assert.equal(result.status, "pass");
  assert.equal(result.phase, "iteration_limit_reached");
  assert.equal(result.iterations[0].projected_action, "create_context_pack_from_seed");
  assert.ok(snapshotId.length <= 80);
  assert.match(snapshotId, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/);
  assert.match(snapshotId, /-01$/);
});

test("scheduler loop keeps scheduler profiles out of context work package execution", async () => {
  const calls = [];
  const client = {
    async loadHistory() {
      calls.push(["loadHistory"]);
      return { latest: "context-cycle" };
    },
    async loadProjection(id) {
      calls.push(["projection", id]);
      return {
        next_action_readout: {
          status: "ready",
          action: "run_context_work_packages"
        }
      };
    },
    async runNextAction(id, body) {
      calls.push(["nextAction", id, body]);
      return {
        status: "executed",
        action: body.expected_action,
        projection: {
          next_action_readout: {
            status: "ready",
            action: "prepare_project_status_continuation",
            source_event_id: "event-context-work-packages-run"
          }
        }
      };
    }
  };
  const result = await runSchedulerLoopDriver({
    max_iterations: 1,
    execution_strategy: "projected_next_action",
    execution_profile: "approved_mock_non_dry_run",
    snapshot_prefix: "context-loop"
  }, { client });
  const body = calls[2][2];

  assert.equal(result.status, "pass");
  assert.equal(result.phase, "iteration_limit_reached");
  assert.equal(body.expected_action, "run_context_work_packages");
  assert.equal(body.execution_profile, undefined);
  assert.equal(body.context_work_package_execution_profile, undefined);
  assert.equal(body.snapshot_id, "context-loop-context-cycle-01");
});

test("scheduler loop surfaces blocked projected next action issues", async () => {
  const client = {
    async loadHistory() {
      return { latest: "context-cycle" };
    },
    async loadProjection() {
      return {
        next_action_readout: {
          status: "ready",
          action: "run_context_work_packages"
        }
      };
    },
    async runNextAction() {
      return {
        status: "blocked",
        issues: [{
          code: "local_bounded_requirement_intake_requires_child_authority",
          message: "requirement intake requires child authority",
          path: "manifest.work_packages.requirement-intake"
        }]
      };
    }
  };
  const result = await runSchedulerLoopDriver({
    max_iterations: 3,
    execution_strategy: "projected_next_action",
    snapshot_prefix: "context-loop"
  }, { client });

  assert.equal(result.status, "fail");
  assert.equal(result.phase, "projected_action_blocked");
  assert.equal(result.iterations.length, 1);
  assert.equal(result.iterations[0].status, "blocked");
  assert.ok(result.issues.some((entry) => entry.code === "local_bounded_requirement_intake_requires_child_authority"));
});
