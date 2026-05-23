import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import {
  buildSchedulerLoopRunRegistry,
  createSchedulerLoopRunArtifact,
  evaluateSchedulerLoopRecovery,
  recordAutonomousSchedulerLoopRunArtifact,
  recordSchedulerLoopResumeAttempt,
  runSchedulerLoopDriver,
  schedulerLoopInput,
  validateSchedulerLoopRunArtifact
} from "../src/workflow/autonomous-scheduler-loop.js";
import { createWorkbenchServer } from "../tools/workbench-server.mjs";
import { currentSessionWorkflowState } from "./helpers/current-session-workflow-state.js";

async function withServer(options, fn) {
  const server = createWorkbenchServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

function runNode(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

function fakeClient(overrides = {}) {
  const calls = [];
  return {
    calls,
    async loadHistory() {
      calls.push(["loadHistory"]);
      return overrides.history || { latest: "current" };
    },
    async createSchedulerDispatchPlan(id, body) {
      calls.push(["plan", id, body]);
      return overrides.plan || {
        status: "created",
        plan: {
          status: "pass",
          phase: "scheduler_dispatch_plan",
          steps: [{ id: "run-reviewer-shard-loop" }]
        }
      };
    },
    async runSchedulerDispatch(id, body) {
      calls.push(["dispatch", id, body]);
      return overrides.dispatch || {
        status: "created",
        projection: {
          scheduler_continuation: { ready: true }
        }
      };
    },
    async enqueueSchedulerNextCycle(id, body) {
      calls.push(["enqueue", id, body]);
      return overrides.enqueue || {
        status: "queued",
        next_item: { id: `${id}-next` }
      };
    }
  };
}

test("scheduler loop stops without dispatch when plan has no steps", async () => {
  const client = fakeClient({
    plan: {
      status: "created",
      plan: {
        status: "pass",
        phase: "no_dispatchable_scheduler_actions",
        steps: []
      }
    }
  });
  const result = await runSchedulerLoopDriver({ max_iterations: 3 }, { client });

  assert.equal(result.status, "pass");
  assert.equal(result.phase, "no_dispatchable_scheduler_actions");
  assert.equal(result.iterations.length, 1);
  assert.equal(result.iterations[0].step_count, 0);
  assert.deepEqual(client.calls.map((call) => call[0]), ["loadHistory", "plan"]);
});

test("scheduler loop dispatches and enqueues until iteration bound", async () => {
  const client = fakeClient();
  const result = await runSchedulerLoopDriver({
    max_iterations: 2,
    snapshot_prefix: "loop"
  }, { client });

  assert.equal(result.status, "pass");
  assert.equal(result.phase, "iteration_limit_reached");
  assert.equal(result.iterations.length, 2);
  assert.deepEqual(client.calls.map((call) => call[0]), [
    "loadHistory",
    "plan",
    "dispatch",
    "enqueue",
    "plan",
    "dispatch",
    "enqueue"
  ]);
  assert.equal(client.calls[2][2].execution_profile, "approved_mock_non_dry_run");
  assert.equal(client.calls[3][2].snapshot_id, "loop-current-01");
  assert.equal(result.iterations[1].projection_id, "current-next");
});

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

test("scheduler loop fails when dispatch does not produce ready continuation", async () => {
  const client = fakeClient({
    dispatch: {
      status: "created",
      projection: {
        scheduler_continuation: { ready: false }
      }
    }
  });
  const result = await runSchedulerLoopDriver({ max_iterations: 1 }, { client });

  assert.equal(result.status, "fail");
  assert.equal(result.phase, "continuation_not_ready");
  assert.equal(result.iterations[0].status, "blocked");
  assert.ok(result.issues.some((entry) => entry.code === "scheduler_continuation_not_ready"));
});

test("scheduler loop validates bounded profile and iterations", () => {
  const input = schedulerLoopInput({
    max_iterations: 9,
    execution_profile: "unbounded_real_model"
  });

  assert.equal(input.status, "fail");
  assert.ok(input.issues.some((entry) => entry.code === "invalid_scheduler_loop_iterations"));
  assert.ok(input.issues.some((entry) => entry.code === "unsupported_scheduler_loop_profile"));
});

test("scheduler loop run artifact captures iterations", async () => {
  const result = await runSchedulerLoopDriver({ max_iterations: 1 }, { client: fakeClient() });
  const artifact = createSchedulerLoopRunArtifact({ max_iterations: 1 }, result, {
    created_at: "2026-05-22T00:30:00.000Z"
  });

  assert.equal(artifact.version, "autonomous-scheduler-loop-run.v1");
  assert.equal(artifact.status, "pass");
  assert.equal(artifact.result.iterations.length, 1);
  assert.equal(validateSchedulerLoopRunArtifact(artifact).status, "pass");
});

test("scheduler loop run artifact validation rejects damaged run history", async () => {
  const result = await runSchedulerLoopDriver({ max_iterations: 1 }, { client: fakeClient() });
  const artifact = createSchedulerLoopRunArtifact({ max_iterations: 1 }, result);
  const damaged = {
    ...artifact,
    result: {
      ...artifact.result,
      status: "fail",
      iterations: [{
        ...artifact.result.iterations[0],
        status: "queued",
        next_projection_id: ""
      }]
    }
  };
  const validation = validateSchedulerLoopRunArtifact(damaged);

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some((entry) => entry.code === "scheduler_loop_status_mismatch"));
  assert.ok(validation.issues.some((entry) => entry.code === "missing_scheduler_loop_next_projection"));
});

test("scheduler loop run artifact records into workflow state", async () => {
  const workflowState = currentSessionWorkflowState();
  const result = await runSchedulerLoopDriver({ max_iterations: 1 }, { client: fakeClient() });
  const artifact = createSchedulerLoopRunArtifact({ max_iterations: 1 }, result);
  const recorded = recordAutonomousSchedulerLoopRunArtifact(workflowState, artifact, {
    created_at: "2026-05-22T00:45:00.000Z"
  });

  assert.equal(recorded.status, "pass");
  assert.equal(recorded.workflow_state.manifest.events.at(-1).type, "autonomous_scheduler_loop_run");
  assert.equal(recorded.workflow_state.artifact_ledger.artifacts.at(-1).metadata.version, "autonomous-scheduler-loop-run.v1");
});

test("scheduler loop registry and recovery policy resume from latest queued projection", async () => {
  const workflowState = currentSessionWorkflowState();
  const result = await runSchedulerLoopDriver({ max_iterations: 1 }, { client: fakeClient() });
  const artifact = createSchedulerLoopRunArtifact({ max_iterations: 1 }, result, {
    created_at: "2026-05-22T01:05:00.000Z"
  });
  const recorded = recordAutonomousSchedulerLoopRunArtifact(workflowState, artifact, {
    created_at: "2026-05-22T01:05:00.000Z"
  });
  const registry = buildSchedulerLoopRunRegistry(recorded.workflow_state);
  const recovery = evaluateSchedulerLoopRecovery(registry);

  assert.equal(registry.status, "pass");
  assert.equal(registry.total_runs, 1);
  assert.equal(registry.latest.iteration_count, 1);
  assert.equal(registry.latest.resume_projection_id, "current-next");
  assert.equal(recovery.status, "ready");
  assert.equal(recovery.action, "resume_from_latest_projection");
  assert.equal(recovery.resume_projection_id, "current-next");
});

test("scheduler loop registry blocks invalid durable artifacts", async () => {
  const workflowState = currentSessionWorkflowState();
  const result = await runSchedulerLoopDriver({ max_iterations: 1 }, { client: fakeClient() });
  const artifact = createSchedulerLoopRunArtifact({ max_iterations: 1 }, result);
  const recorded = recordAutonomousSchedulerLoopRunArtifact(workflowState, artifact, {
    created_at: "2026-05-22T01:10:00.000Z"
  });
  const artifactId = recorded.artifact.id;
  const damagedState = {
    ...recorded.workflow_state,
    artifact_ledger: {
      ...recorded.workflow_state.artifact_ledger,
      artifacts: recorded.workflow_state.artifact_ledger.artifacts.map((entry) => entry.id === artifactId
        ? {
          ...entry,
          metadata: {
            ...entry.metadata,
            result: {
              ...entry.metadata.result,
              status: "fail"
            }
          }
        }
        : entry)
    }
  };
  const registry = buildSchedulerLoopRunRegistry(damagedState);
  const recovery = evaluateSchedulerLoopRecovery(registry);

  assert.equal(registry.status, "blocked");
  assert.equal(registry.invalid_count, 1);
  assert.equal(recovery.status, "blocked");
  assert.equal(recovery.action, "quarantine_invalid_loop_artifact");
  assert.ok(recovery.issues.some((entry) => entry.code === "scheduler_loop_status_mismatch"));
});

test("scheduler loop resume attempts are durable workflow facts", () => {
  const workflowState = currentSessionWorkflowState();
  const recorded = recordSchedulerLoopResumeAttempt(workflowState, {
    status: "blocked",
    source_projection_id: "source",
    resume_projection_id: "target",
    recovery_status: "blocked",
    recovery_action: "quarantine_invalid_loop_artifact",
    issues: [{ code: "invalid_loop", message: "loop artifact invalid", path: "scheduler_loop" }]
  }, {
    created_at: "2026-05-22T02:00:00.000Z"
  });

  assert.equal(recorded.status, "pass");
  assert.equal(recorded.workflow_state.manifest.events.at(-1).type, "scheduler_loop_resume_attempt");
  assert.equal(recorded.workflow_state.manifest.events.at(-1).status, "blocked");
  assert.equal(recorded.workflow_state.artifact_ledger.artifacts.at(-1).metadata.version, "scheduler-loop-resume-attempt.v1");
  assert.equal(recorded.workflow_state.artifact_ledger.artifacts.at(-1).metadata.resume_projection_id, "target");
});

test("run-autonomous-scheduler-loop CLI fails closed for nonlocal workbench url", () => {
  const dir = mkdtempSync(join(tmpdir(), "autonomous-scheduler-loop-cli-"));
  const outputPath = join(dir, "autonomous-scheduler-loop-run.json");
  const result = spawnSync(process.execPath, [
    "tools/run-with-node18.mjs",
    "tools/run-autonomous-scheduler-loop.mjs",
    "--workbench-base-url",
    "https://example.com",
    "--output",
    outputPath
  ], { encoding: "utf8" });
  const summary = JSON.parse(result.stdout);
  const artifact = JSON.parse(readFileSync(outputPath, "utf8"));

  assert.equal(result.status, 1);
  assert.equal(summary.status, "fail");
  assert.equal(artifact.version, "autonomous-scheduler-loop-run.v1");
  assert.equal(artifact.result.issues[0].code, "INVALID_WORKBENCH_BASE_URL");
});

test("run-autonomous-scheduler-loop CLI prints usage without required args", () => {
  assert.throws(() => execFileSync(process.execPath, [
    "tools/run-with-node18.mjs",
    "tools/run-autonomous-scheduler-loop.mjs"
  ], { encoding: "utf8", stdio: "pipe" }));
});

test("run-autonomous-scheduler-loop CLI can drive one workbench service cycle", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/autonomous-scheduler-loop-service-"));
  const inputPath = join(snapshotsRoot, "loop-service-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const outputPath = join(snapshotsRoot, "autonomous-scheduler-loop-run.json");
  const workflowState = currentSessionWorkflowState();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "loop-service",
    items: [
      {
        id: "loop-service",
        label: "Loop service",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }, null, 2));

  await withServer({ historyPath, snapshotsRoot }, async (baseUrl) => {
    const result = await runNode([
      "tools/run-with-node18.mjs",
      "tools/run-autonomous-scheduler-loop.mjs",
      "--workbench-base-url",
      baseUrl,
      "--start-projection-id",
      "loop-service",
      "--max-iterations",
      "1",
      "--snapshot-prefix",
      "loop-service",
      "--output",
      outputPath
    ]);
    const summary = JSON.parse(result.stdout);
    const artifact = JSON.parse(readFileSync(outputPath, "utf8"));
    const history = JSON.parse(readFileSync(historyPath, "utf8"));
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(summary.status, "pass");
    assert.equal(summary.phase, "iteration_limit_reached");
    assert.equal(artifact.version, "autonomous-scheduler-loop-run.v1");
    assert.equal(artifact.result.iterations.length, 1);
    assert.equal(artifact.result.iterations[0].status, "queued");
    assert.equal(history.latest, "loop-service-loop-service-01");
    assert.equal(state.manifest.events.at(-1).type, "scheduler_next_cycle_enqueue");
  });
});
