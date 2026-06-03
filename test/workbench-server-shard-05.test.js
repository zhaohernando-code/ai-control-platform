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

test("workbench server continues after reviewer aggregate through projected next action", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-next-action-reviewer-aggregate-"));
  const inputPath = join(snapshotsRoot, "next-action-reviewer-aggregate-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWithoutSchedulerLoop();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "next-action-reviewer-aggregate",
    items: [
      {
        id: "next-action-reviewer-aggregate",
        label: "Next action reviewer aggregate",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    for (const createdAt of ["2026-05-22T02:53:00.000Z", "2026-05-22T02:53:20.000Z"]) {
      const shard = await request(`${baseUrl}/api/workbench/next-action?id=next-action-reviewer-aggregate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expected_action: "run_reviewer_scope_shard",
          reviewer_mock_status: "pass",
          created_at: createdAt
        })
      });
      assert.equal(shard.status, 201);
    }

    const before = await request(`${baseUrl}/api/workbench/projection?id=next-action-reviewer-aggregate`);
    assert.equal(before.json().next_action_readout.action, "continue_after_reviewer_aggregate");

    const response = await request(`${baseUrl}/api/workbench/next-action?id=next-action-reviewer-aggregate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "continue_after_reviewer_aggregate",
        created_at: "2026-05-22T02:53:40.000Z"
      })
    });
    const created = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.status, "executed");
    assert.equal(created.action, "continue_after_reviewer_aggregate");
    assert.equal(created.result.status, "created");
    assert.equal(created.result.projection.next_action_readout.action, "create_context_pack_from_seed");
    assert.equal(created.projection.next_action_readout.action, "create_context_pack_from_seed");
    assert.equal(state.manifest.events.at(-2).type, "reviewer_shard_aggregate");
    assert.equal(state.manifest.events.at(-1).type, "project_status_continuation");
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server executes retry_agent_worker through context work package next action", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-next-action-retry-agent-"));
  const inputPath = join(snapshotsRoot, "next-action-retry-agent-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = retryAgentWorkerWorkflowState();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "next-action-retry-agent",
    items: [
      {
        id: "next-action-retry-agent",
        label: "Next action retry agent",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const before = await request(`${baseUrl}/api/workbench/projection?id=next-action-retry-agent`);
    assert.equal(before.json().next_action_readout.action, "run_context_work_packages");

    const response = await request(`${baseUrl}/api/workbench/next-action?id=next-action-retry-agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "run_context_work_packages",
        created_at: "2026-05-22T09:21:00.000Z"
      })
    });
    const created = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));
    const eventTypes = state.manifest.events.map((event) => event.type);

    assert.equal(response.status, 201);
    assert.equal(created.status, "executed");
    assert.equal(created.action, "run_context_work_packages");
    assert.equal(created.result.status, "created");
    assert.ok(eventTypes.includes("WorkerSpawned"));
    assert.ok(eventTypes.includes("WorkerHeartbeat"));
    assert.equal(created.projection.agent_lifecycle_pool.pool_id, "pool-server");
    assert.equal(created.projection.agent_lifecycle_pool.heartbeat_count, 1);
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server blocks reviewer shard execution when mock profile has no mock output", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-reviewer-policy-block-"));
  const inputPath = join(snapshotsRoot, "reviewer-policy-block-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWithoutRequirementPlanReview();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "reviewer-policy-block",
    items: [
      {
        id: "reviewer-policy-block",
        label: "Reviewer policy block",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/reviewer-shard-run?id=reviewer-policy-block`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        execution_profile: "approved_mock_non_dry_run",
        created_at: "2026-05-22T04:40:00.000Z"
      })
    });
    const rejected = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 400);
    assert.equal(rejected.error, "reviewer execution policy rejected");
    assert.ok(rejected.issues.some((entry) => entry.code === "missing_mock_reviewer_output"));
    assert.equal(state.manifest.events.length, workflowState.manifest.events.length);
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server runs bounded real reviewer profile only with explicit budget", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-real-reviewer-policy-"));
  const inputPath = join(snapshotsRoot, "real-reviewer-policy-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  workflowState.manifest.events.push({
    id: "event-real-reviewer-health",
    type: "reviewer_provider_health",
    status: "retry",
    created_at: "2026-05-22T04:40:00.000Z",
    metadata: {
      type: "reviewer_provider_health",
      provider_health: "healthy",
      recovery_status: "retry",
      retry_strategy: "rerun_without_tools_or_split_scope",
      provider: "deepseek",
      model: "deepseek-v4-pro"
    }
  });
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "real-reviewer-policy",
    items: [
      {
        id: "real-reviewer-policy",
        label: "Real reviewer policy",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  const calls = [];
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/reviewer-shard-run?id=real-reviewer-policy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        execution_profile: "approved_bounded_real_reviewer",
        max_external_reviewer_calls: 1,
        provider_cost_mode: "bounded",
        timeout_seconds: 90,
        created_at: "2026-05-22T04:41:00.000Z"
      })
    });
    const created = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.status, "created");
    assert.equal(created.reviewer_execution_policy.execution_mode, "bounded_real_reviewer");
    assert.equal(created.result.executor_provenance.executor_kind, "test_real_reviewer");
    assert.equal(calls.length, 1);
    assert.equal(state.manifest.events.at(-1).type, "reviewer_shard_result");
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
