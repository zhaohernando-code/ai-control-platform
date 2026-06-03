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

test("workbench server records agent lifecycle cleanup into workflow state input", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-agent-lifecycle-"));
  const inputPath = join(snapshotsRoot, "agent-lifecycle-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  workflowState.manifest.events = workflowState.manifest.events.filter((event) => ![
    "WorkerSpawned",
    "WorkerCompleted",
    "WorkerEvaluation",
    "WorkerClosed",
    "PoolIterationClosed"
  ].includes(event.type));
  workflowState.manifest.artifacts = workflowState.manifest.artifacts.filter((artifact) => artifact.metadata?.type !== "agent_lifecycle_pool");
  workflowState.artifact_ledger.artifacts = workflowState.artifact_ledger.artifacts.filter((artifact) => artifact.metadata?.type !== "agent_lifecycle_pool");
  workflowState.manifest.events.push(
    {
      id: "worker-spawned-api",
      type: "WorkerSpawned",
      status: "pass",
      created_at: "2026-05-22T08:15:00.000Z",
      metadata: { pool_id: "pool-api", worker_id: "worker-api" }
    },
    {
      id: "worker-completed-api",
      type: "WorkerCompleted",
      status: "pass",
      created_at: "2026-05-22T08:16:00.000Z",
      metadata: { pool_id: "pool-api", worker_id: "worker-api" }
    }
  );
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "agent-lifecycle",
    items: [
      {
        id: "agent-lifecycle",
        label: "Agent lifecycle",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/agent-lifecycle-pool`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cleanup_latest_pool: true,
        created_at: "2026-05-22T08:17:00.000Z"
      })
    });
    const created = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.status, "created");
    assert.equal(created.after.status, "pass");
    assert.equal(created.projection.agent_lifecycle_pool.status, "pass");
    assert.notEqual(created.projection.next_action_readout.action, "cleanup_agent_lifecycle_pool");
    assert.deepEqual(created.facts.map((fact) => fact.event_type), [
      "WorkerEvaluation",
      "WorkerClosed",
      "PoolIterationClosed"
    ]);
    assert.equal(state.manifest.events.at(-1).type, "PoolIterationClosed");
    assert.equal(state.artifact_ledger.artifacts.at(-1).metadata.lifecycle_event, "PoolIterationClosed");
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server rejects agent lifecycle recording without workflow state input", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/agent-lifecycle-pool?id=bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cleanup_latest_pool: true })
    });
    const rejected = response.json();

    assert.equal(response.status, 400);
    assert.match(rejected.error, /workflow state input not found/);
  });
});

test("workbench server records workbench browser event run artifacts", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-browser-events-"));
  const inputPath = join(snapshotsRoot, "browser-events-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "browser-events",
    items: [
      {
        id: "browser-events",
        label: "Browser events",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/workbench-browser-events-run?id=browser-events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: "workbench-browser-events-run.v1",
        status: "pass",
        created_at: "2026-05-22T06:45:00.000Z",
        scenario_count: 1,
        scenarios: [
          {
            scenario: "projected_real_partial_shard_readout",
            shard_review_next: "reviewer-scope-shard-002",
            next_action_readout: "run_reviewer_scope_shard",
            dimensions: { width: 1440, scrollWidth: 1440 }
          }
        ]
      })
    });
    const created = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.status, "created");
    assert.equal(created.projection.workbench_browser_events.status, "pass");
    assert.equal(created.projection.workbench_browser_events.partial_shard_ready, true);
    assert.equal(state.manifest.events.at(-1).type, "workbench_browser_events_run");
    assert.equal(state.artifact_ledger.artifacts.at(-1).metadata.version, "workbench-browser-events-run.v1");
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server creates scheduler dispatch plans from projection history input", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-scheduler-plan-"));
  const inputPath = join(snapshotsRoot, "scheduler-plan-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWithoutRequirementPlanReview();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "scheduler-plan",
    items: [
      {
        id: "scheduler-plan",
        label: "Scheduler plan",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-dispatch-plan?id=scheduler-plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        next_step: "Continue from generated scheduler plan.",
        reviewer_mock_status: "pass"
      })
    });
    const created = response.json();

    assert.equal(response.status, 201);
    assert.equal(created.status, "created");
    assert.equal(created.plan.status, "pass");
    assert.equal(created.plan.writeback.mode, "service");
    assert.equal(created.plan.writeback.base_url, baseUrl);
    assert.equal(created.plan.writeback.projection_id, "scheduler-plan");
    assert.ok(created.plan.steps[0].args.includes(relative(process.cwd(), inputPath)));
    assert.ok(created.plan.steps[0].args.includes("--mock-status"));
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server runs guarded scheduler dispatch dry-run from projection history input", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-scheduler-control-"));
  const inputPath = join(snapshotsRoot, "scheduler-control-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "scheduler-control",
    items: [
      {
        id: "scheduler-control",
        label: "Scheduler control",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-dispatch?id=scheduler-control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dry_run: true })
    });
    const created = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.status, "created");
    assert.equal(created.policy.execution_mode, "dry_run");
    assert.equal(created.result.status, "pass");
    assert.equal(created.projection.scheduler_dispatch.status, "pass");
    assert.equal(created.projection.scheduler_dispatch.policy_status, "pass");
    assert.equal(created.projection.scheduler_dispatch.policy_execution_mode, "dry_run");
    assert.equal(created.projection.scheduler_dispatch.step_count, 3);
    assert.equal(state.manifest.events.at(-2).type, "scheduler_dispatch_policy");
    assert.equal(state.manifest.events.at(-1).type, "scheduler_dispatch_run");
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});
