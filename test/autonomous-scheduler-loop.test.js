import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import {
  createSchedulerLoopRunArtifact,
  recordAutonomousSchedulerLoopRunArtifact,
  runSchedulerLoopDriver,
  schedulerLoopInput
} from "../src/workflow/autonomous-scheduler-loop.js";
import { createWorkbenchServer } from "../tools/workbench-server.mjs";

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
});

test("scheduler loop run artifact records into workflow state", async () => {
  const workflowState = JSON.parse(readFileSync("docs/examples/current-session-workbench-input.json", "utf8"));
  const result = await runSchedulerLoopDriver({ max_iterations: 1 }, { client: fakeClient() });
  const artifact = createSchedulerLoopRunArtifact({ max_iterations: 1 }, result);
  const recorded = recordAutonomousSchedulerLoopRunArtifact(workflowState, artifact, {
    created_at: "2026-05-22T00:45:00.000Z"
  });

  assert.equal(recorded.status, "pass");
  assert.equal(recorded.workflow_state.manifest.events.at(-1).type, "autonomous_scheduler_loop_run");
  assert.equal(recorded.workflow_state.artifact_ledger.artifacts.at(-1).metadata.version, "autonomous-scheduler-loop-run.v1");
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
  const workflowState = JSON.parse(readFileSync("docs/examples/current-session-workbench-input.json", "utf8"));
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
