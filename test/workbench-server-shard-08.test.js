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

test("workbench server continues projected real reviewer loop from durable partial shard state", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-projected-real-resume-"));
  const inputPath = join(snapshotsRoot, "projected-real-resume-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWithoutSchedulerLoop();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "projected-real-resume",
    items: [
      {
        id: "projected-real-resume",
        label: "Projected real resume",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  const calls = [];
  const realReviewerExecutor = async ({ shard }) => {
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
  };

  await withServer(async (baseUrl) => {
    const first = await request(`${baseUrl}/api/workbench/autonomous-scheduler-loop?id=projected-real-resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_iterations: 1,
        execution_profile: "approved_bounded_real_reviewer",
        execution_strategy: "projected_next_action",
        max_external_reviewer_calls: 1,
        provider_cost_mode: "bounded",
        timeout_seconds: 90,
        snapshot_prefix: "projected-real-resume",
        created_at: "2026-05-22T05:40:00.000Z"
      })
    });
    const firstCreated = first.json();

    assert.equal(first.status, 201);
    assert.deepEqual(calls, ["reviewer-scope-shard-001"]);
    assert.equal(firstCreated.projection.reviewer_shard_review.completed_shards, 1);
    assert.equal(firstCreated.projection.reviewer_shard_review.next_shard, "reviewer-scope-shard-002");
    assert.equal(firstCreated.projection.next_action_readout.action, "run_reviewer_scope_shard");

    const second = await request(`${baseUrl}/api/workbench/autonomous-scheduler-loop?id=projected-real-resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_iterations: 1,
        execution_profile: "approved_bounded_real_reviewer",
        execution_strategy: "projected_next_action",
        max_external_reviewer_calls: 1,
        provider_cost_mode: "bounded",
        timeout_seconds: 90,
        snapshot_prefix: "projected-real-resume",
        created_at: "2026-05-22T05:41:00.000Z"
      })
    });
    const secondCreated = second.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));
    const shardIds = state.manifest.events
      .filter((event) => event.type === "reviewer_shard_result")
      .map((event) => event.metadata.shard_id);

    assert.equal(second.status, 201);
    assert.deepEqual(calls, ["reviewer-scope-shard-001", "reviewer-scope-shard-002"]);
    assert.deepEqual(shardIds, ["reviewer-scope-shard-001", "reviewer-scope-shard-002"]);
    assert.equal(secondCreated.result.iterations[0].projected_action, "run_reviewer_scope_shard");
    assert.equal(secondCreated.projection.reviewer_shard_review.pending_shards, 0);
    assert.equal(secondCreated.projection.reviewer_shard_review.status, "pass");
    assert.equal(state.manifest.events.at(-2).type, "reviewer_shard_aggregate");
    assert.equal(state.manifest.events.at(-1).type, "autonomous_scheduler_loop_run");
  }, {
    historyPath,
    snapshotsRoot,
    projectStatusPath: null,
    realReviewerExecutor
  });
});

test("workbench server resumes autonomous scheduler loop from registry recovery policy", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-autonomous-loop-resume-"));
  const inputPath = join(snapshotsRoot, "autonomous-loop-resume-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "resume-source",
    items: [
      {
        id: "resume-source",
        label: "Resume source",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const first = await request(`${baseUrl}/api/workbench/autonomous-scheduler-loop?id=resume-source`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_iterations: 1,
        snapshot_prefix: "server-loop",
        created_at: "2026-05-22T01:20:00.000Z"
      })
    });
    assert.equal(first.status, 201);

    const resumed = await request(`${baseUrl}/api/workbench/autonomous-scheduler-loop-resume?id=resume-source`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_iterations: 1,
        snapshot_prefix: "server-resume",
        created_at: "2026-05-22T01:21:00.000Z"
      })
    });
    const created = resumed.json();
    const history = (await request(`${baseUrl}/api/workbench/projections`)).json();
    const targetInputPath = join(snapshotsRoot, "server-loop-resume-source-01.workbench-input.json");
    const targetState = JSON.parse(readFileSync(targetInputPath, "utf8"));
    const sourceState = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(resumed.status, 201);
    assert.equal(created.status, "created");
    assert.equal(created.recovery.status, "ready");
    assert.equal(created.resume_attempt.metadata.status, "pass");
    assert.equal(created.item.id, "server-loop-resume-source-01");
    assert.equal(created.result.phase, "no_dispatchable_scheduler_actions");
    assert.equal(history.latest, "server-loop-resume-source-01");
    assert.equal(sourceState.manifest.events.at(-1).type, "scheduler_loop_resume_attempt");
    assert.equal(sourceState.manifest.events.at(-1).status, "pass");
    assert.equal(targetState.manifest.events.at(-1).type, "autonomous_scheduler_loop_run");
  }, { historyPath, snapshotsRoot });
});

test("workbench server rejects autonomous scheduler loop resume without ready recovery", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-autonomous-loop-resume-blocked-"));
  const inputPath = join(snapshotsRoot, "autonomous-loop-resume-blocked-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWithoutSchedulerLoop();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "resume-blocked",
    items: [
      {
        id: "resume-blocked",
        label: "Resume blocked",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/autonomous-scheduler-loop-resume?id=resume-blocked`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ max_iterations: 1 })
    });
    const rejected = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 409);
    assert.notEqual(rejected.recovery.status, "ready");
    assert.equal(rejected.recovery.resumable, false);
    assert.equal(rejected.resume_attempt.metadata.status, "blocked");
    assert.equal(rejected.projection.scheduler_loop.latest_resume_status, "blocked");
    assert.equal(state.manifest.events.at(-1).type, "scheduler_loop_resume_attempt");
    assert.equal(state.manifest.events.at(-1).status, "blocked");
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server rejects autonomous scheduler loop without workflow state input", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/autonomous-scheduler-loop?id=bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ max_iterations: 1 })
    });
    const rejected = response.json();

    assert.equal(response.status, 400);
    assert.match(rejected.error, /workflow state input not found/);
  });
});
