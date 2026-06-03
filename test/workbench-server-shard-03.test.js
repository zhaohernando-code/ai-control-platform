import assert from "node:assert/strict";
import test from "node:test";

import {
  assertWorkbenchProjectionSchema,
  chmodSync,
  createSchedulerDispatchPlan,
  createSchedulerDispatchRunArtifact,
  createWorkbenchServer,
  currentProjectionHistory,
  currentSessionWithoutRequirementPlanReview,
  currentSessionWithoutSchedulerLoop,
  currentSessionWorkflowState,
  generatedRequirementPlan,
  isolatedExecutionCwd,
  join,
  mkdirSync,
  mkdtempSync,
  once,
  providerContextWorkPackageWorkflowState,
  readFileSync,
  relative,
  request,
  retryAgentWorkerWorkflowState,
  runNode,
  runSchedulerDispatchPlan,
  spawn,
  tmpdir,
  VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
  waitForCondition,
  waitForOutput,
  withServer,
  writeFileSync
} from "./helpers/workbench-server.js";

test("workbench server runs approved mocked non-dry-run scheduler dispatch from profile", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-scheduler-approved-mock-"));
  const inputPath = join(snapshotsRoot, "scheduler-approved-mock-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "scheduler-approved-mock",
    items: [
      {
        id: "scheduler-approved-mock",
        label: "Scheduler approved mock",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-dispatch?id=scheduler-approved-mock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        execution_profile: "approved_mock_non_dry_run",
        created_at: "2026-05-22T00:10:00.000Z"
      })
    });
    const created = response.json();
    const historyReady = (await request(`${baseUrl}/api/workbench/projections`)).json();
    const readyItem = historyReady.items.find((entry) => entry.id === "scheduler-approved-mock");
    const nextCycle = await request(`${baseUrl}/api/workbench/scheduler-next-cycle?id=scheduler-approved-mock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        snapshot_id: "scheduler-approved-mock-next",
        label: "Scheduler approved mock next",
        created_at: "2026-05-22T00:11:00.000Z"
      })
    });
    const queued = nextCycle.json();
    const historyQueued = (await request(`${baseUrl}/api/workbench/projections`)).json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.control.input.execution_profile, "approved_mock_non_dry_run");
    assert.equal(created.policy.execution_mode, "execute");
    assert.equal(created.policy.controls.max_external_reviewer_calls, 0);
    assert.equal(created.result.status, "pass");
    assert.equal(created.projection.scheduler_dispatch.dry_run, false);
    assert.equal(created.projection.scheduler_dispatch.policy_execution_mode, "execute");
    assert.equal(created.projection.scheduler_dispatch.next_continuation_action, "continue");
    assert.equal(created.projection.scheduler_dispatch.next_work_package_count, 1);
    assert.equal(created.projection.scheduler_continuation.ready, true);
    assert.equal(created.projection.scheduler_continuation.next_work_package_count, 1);
    assert.equal(readyItem.scheduler_dispatch.continuation_ready, true);
    assert.equal(readyItem.scheduler_dispatch.enqueue_available, true);
    assert.equal(readyItem.scheduler_dispatch.next_work_package_count, 1);
    assert.equal(nextCycle.status, 201);
    assert.equal(queued.status, "queued");
    assert.equal(queued.next_item.id, "scheduler-approved-mock-next");
    assert.equal(queued.projection.scheduler_continuation.status, "not_configured");
    assert.equal(queued.current_projection.scheduler_continuation.enqueue_status, "queued");
    assert.equal(historyQueued.latest, "scheduler-approved-mock-next");
    assert.equal(state.manifest.events.at(-4).type, "scheduler_dispatch_policy");
    assert.equal(state.manifest.events.at(-3).type, "scheduler_dispatch_run");
    assert.equal(state.manifest.events.at(-2).type, "scheduler_dispatch_continuation");
    assert.equal(state.manifest.events.at(-1).type, "scheduler_next_cycle_enqueue");
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server runs approved non-dry-run scheduler dispatch for lifecycle cleanup without continuation", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-scheduler-cleanup-"));
  const inputPath = join(snapshotsRoot, "scheduler-cleanup-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  workflowState.manifest.events = workflowState.manifest.events.filter((event) => ![
    "WorkerSpawned",
    "WorkerCompleted",
    "WorkerEvaluation",
    "WorkerClosed",
    "PoolIterationClosed",
    "reviewer_provider_health",
    "reviewer_scope_split",
    "reviewer_shard_result",
    "reviewer_shard_aggregate"
  ].includes(event.type));
  workflowState.manifest.artifacts = workflowState.manifest.artifacts.filter((artifact) => artifact.metadata?.type !== "agent_lifecycle_pool");
  workflowState.artifact_ledger.artifacts = workflowState.artifact_ledger.artifacts.filter((artifact) => artifact.metadata?.type !== "agent_lifecycle_pool");
  workflowState.manifest.events.push(
    {
      id: "worker-spawned-cleanup",
      type: "WorkerSpawned",
      status: "pass",
      created_at: "2026-05-22T08:20:00.000Z",
      metadata: { pool_id: "pool-scheduler-cleanup", worker_id: "worker-cleanup" }
    },
    {
      id: "worker-completed-cleanup",
      type: "WorkerCompleted",
      status: "pass",
      created_at: "2026-05-22T08:21:00.000Z",
      metadata: { pool_id: "pool-scheduler-cleanup", worker_id: "worker-cleanup" }
    }
  );
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "scheduler-cleanup",
    items: [
      {
        id: "scheduler-cleanup",
        label: "Scheduler cleanup",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-dispatch?id=scheduler-cleanup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        execution_profile: "approved_mock_non_dry_run",
        created_at: "2026-05-22T08:22:00.000Z"
      })
    });
    const created = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.plan.dispatch_kind, "agent_lifecycle_cleanup");
    assert.equal(created.plan.continuation_output.mode, "none");
    assert.equal(created.result.status, "pass");
    assert.equal(created.result.steps.length, 1);
    assert.equal(created.continuation, null);
    assert.equal(created.projection.agent_lifecycle_pool.status, "pass");
    assert.equal(created.projection.scheduler_dispatch.step_count, 1);
    assert.equal(created.projection.scheduler_continuation.ready, false);
    assert.ok(state.manifest.events.some((event) => event.type === "WorkerEvaluation"));
    assert.ok(state.manifest.events.some((event) => event.type === "WorkerClosed"));
    assert.ok(state.manifest.events.some((event) => event.type === "PoolIterationClosed"));
    assert.equal(state.manifest.events.at(-1).type, "scheduler_dispatch_run");
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server rejects scheduler next-cycle without workflow state input", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-next-cycle?id=bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    const rejected = response.json();

    assert.equal(response.status, 400);
    assert.match(rejected.error, /workflow state input not found/);
  });
});

test("workbench server rejects scheduler next-cycle without dispatch run artifact", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-next-cycle-missing-"));
  const inputPath = join(snapshotsRoot, "next-cycle-missing-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "next-cycle-missing",
    items: [
      {
        id: "next-cycle-missing",
        label: "Next cycle missing",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-next-cycle?id=next-cycle-missing`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ snapshot_id: "next-cycle-missing-output" })
    });
    const rejected = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 400);
    assert.equal(rejected.error, "scheduler dispatch run artifact not found");
    assert.equal(state.manifest.events.length, workflowState.manifest.events.length);
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});
