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

test("workbench server runs bounded autonomous scheduler loop from projection history input", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-autonomous-loop-"));
  const inputPath = join(snapshotsRoot, "autonomous-loop-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "autonomous-loop",
    items: [
      {
        id: "autonomous-loop",
        label: "Autonomous loop",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/autonomous-scheduler-loop?id=autonomous-loop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_iterations: 1,
        snapshot_prefix: "server-loop",
        created_at: "2026-05-22T00:50:00.000Z"
      })
    });
    const created = response.json();
    const history = (await request(`${baseUrl}/api/workbench/projections`)).json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.status, "created");
    assert.equal(created.result.phase, "iteration_limit_reached");
    assert.equal(created.projection.scheduler_loop.status, "pass");
    assert.equal(created.projection.scheduler_loop.iteration_count, 1);
    assert.equal(created.projection.scheduler_loop.recovery_status, "ready");
    assert.equal(history.latest, "server-loop-autonomous-loop-01");
    const sourceItem = history.items.find((entry) => entry.id === "autonomous-loop");
    assert.equal(sourceItem.scheduler_loop.status, "pass");
    assert.equal(sourceItem.scheduler_loop.recovery_status, "ready");
    assert.equal(sourceItem.scheduler_loop.resume_projection_id, "server-loop-autonomous-loop-01");
    assert.equal(state.manifest.events.at(-1).type, "autonomous_scheduler_loop_run");
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server can run autonomous scheduler loop through projected next actions", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-projected-loop-"));
  const inputPath = join(snapshotsRoot, "projected-loop-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWithoutSchedulerLoop();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "projected-loop",
    items: [
      {
        id: "projected-loop",
        label: "Projected loop",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/autonomous-scheduler-loop?id=projected-loop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_iterations: 2,
        execution_strategy: "projected_next_action",
        reviewer_mock_status: "pass",
        snapshot_prefix: "projected-loop",
        created_at: "2026-05-22T03:45:00.000Z"
      })
    });
    const created = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.status, "created");
    assert.equal(created.result.phase, "iteration_limit_reached");
    assert.equal(created.result.iterations[0].projected_action, "run_reviewer_scope_shard");
    assert.equal(created.result.iterations[1].projected_action, "run_reviewer_scope_shard");
    assert.equal(state.manifest.events.at(-2).type, "reviewer_shard_aggregate");
    assert.equal(state.manifest.events.at(-1).type, "autonomous_scheduler_loop_run");
    assert.equal(created.projection.reviewer_shard_review.pending_shards, 0);
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server can run projected real reviewer loop with injected executor", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-projected-real-loop-"));
  const inputPath = join(snapshotsRoot, "projected-real-loop-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWithoutSchedulerLoop();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "projected-real-loop",
    items: [
      {
        id: "projected-real-loop",
        label: "Projected real loop",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  const calls = [];
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/autonomous-scheduler-loop?id=projected-real-loop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_iterations: 1,
        execution_profile: "approved_bounded_real_reviewer",
        execution_strategy: "projected_next_action",
        max_external_reviewer_calls: 1,
        provider_cost_mode: "bounded",
        timeout_seconds: 90,
        snapshot_prefix: "projected-real-loop",
        created_at: "2026-05-22T05:11:00.000Z"
      })
    });
    const created = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.status, "created");
    assert.equal(created.result.iterations[0].projected_action, "run_reviewer_scope_shard");
    assert.equal(created.projection.reviewer_shard_review.latest_executor_kind, "test_real_reviewer");
    assert.equal(created.projection.reviewer_shard_review.latest_external_call_budget_used, 1);
    assert.equal(created.projection.scheduler_loop.execution_profile, "approved_bounded_real_reviewer");
    assert.equal(calls.length, 1);
    assert.equal(state.manifest.events.at(-1).type, "autonomous_scheduler_loop_run");
  }, {
    historyPath,
    snapshotsRoot,
    projectStatusPath: null,
    realReviewerExecutor: async ({ shard }) => {
      calls.push(shard.id);
      return {
        status: "pass",
        findings: [],
        provenance: {
          executor_kind: "test_real_reviewer",
          provider: "deepseek",
          model: "deepseek-v4-pro",
          timeout_seconds: 90,
          external_call_budget_used: 1
        }
      };
    }
  });
});
