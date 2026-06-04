import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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
import { createSqliteWorkbenchStateStore } from "../src/workflow/workbench-state-store.js";
import { currentSessionWorkflowState } from "./helpers/current-session-workflow-state.js";
import {
  currentSessionWithoutSchedulerLoop,
  fakeClient,
  runNode,
  withServer
} from "./helpers/autonomous-scheduler-loop.js";

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
  const workflowState = currentSessionWithoutSchedulerLoop();
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

test("scheduler loop recovery can resume from the latest executed projection", () => {
  const workflowState = currentSessionWithoutSchedulerLoop();
  const artifact = createSchedulerLoopRunArtifact({
    max_iterations: 3,
    execution_strategy: "projected_next_action",
    snapshot_prefix: "requirement-intake-auto"
  }, {
    status: "pass",
    phase: "iteration_limit_reached",
    issues: [],
    iterations: [
      {
        index: 3,
        projection_id: "requirement-intake-auto-current-session-02",
        status: "executed",
        projected_action: "run_context_work_packages",
        next_action_status: "ready",
        next_projection_id: null,
        issues: []
      }
    ]
  }, {
    created_at: "2026-05-22T01:07:00.000Z"
  });
  const recorded = recordAutonomousSchedulerLoopRunArtifact(workflowState, artifact, {
    created_at: "2026-05-22T01:07:00.000Z"
  });
  const registry = buildSchedulerLoopRunRegistry(recorded.workflow_state);
  const recovery = evaluateSchedulerLoopRecovery(registry);

  assert.equal(registry.latest.resume_projection_id, null);
  assert.equal(registry.latest.latest_projection_id, "requirement-intake-auto-current-session-02");
  assert.equal(recovery.status, "ready");
  assert.equal(recovery.action, "resume_from_latest_projection");
  assert.equal(recovery.resume_projection_id, "requirement-intake-auto-current-session-02");
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

  await withServer({ historyPath, snapshotsRoot }, async (baseUrl, serverOptions) => {
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
    const store = createSqliteWorkbenchStateStore({ dbPath: serverOptions.stateDbPath });
    const history = store.readHistory();
    const state = store.readWorkflowSnapshot(history.latest);
    const eventTypes = history.items.flatMap((item) => store.readWorkflowSnapshot(item.id).manifest.events.map((event) => event.type));

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(summary.status, "pass");
    assert.equal(summary.phase, "iteration_limit_reached");
    assert.equal(artifact.version, "autonomous-scheduler-loop-run.v1");
    assert.equal(artifact.result.iterations.length, 1);
    assert.equal(artifact.result.iterations[0].status, "queued");
    assert.equal(history.latest, "loop-service-loop-service-01");
    assert.equal(state.manifest.run_id, workflowState.manifest.run_id);
    assert.ok(eventTypes.includes("scheduler_next_cycle_enqueue"));
  });
});
