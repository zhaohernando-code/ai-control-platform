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

test("workbench server blocks bounded real reviewer profile without healthy provider preflight", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-real-reviewer-preflight-"));
  const inputPath = join(snapshotsRoot, "real-reviewer-preflight-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  workflowState.manifest.events = workflowState.manifest.events.filter((event) => event.type !== "reviewer_provider_health");
  workflowState.manifest.artifacts = workflowState.manifest.artifacts.filter((artifact) => artifact.metadata?.type !== "reviewer_provider_health");
  workflowState.artifact_ledger.artifacts = workflowState.artifact_ledger.artifacts.filter((artifact) => artifact.metadata?.type !== "reviewer_provider_health");
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "real-reviewer-preflight",
    items: [
      {
        id: "real-reviewer-preflight",
        label: "Real reviewer preflight",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/reviewer-shard-run?id=real-reviewer-preflight`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        execution_profile: "approved_bounded_real_reviewer",
        max_external_reviewer_calls: 1,
        provider_cost_mode: "bounded",
        timeout_seconds: 90,
        created_at: "2026-05-22T04:42:00.000Z"
      })
    });
    const rejected = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 400);
    assert.equal(rejected.error, "reviewer execution policy rejected");
    assert.ok(rejected.issues.some((entry) => entry.code === "reviewer_provider_health_preflight_required"));
    assert.equal(state.manifest.events.length, workflowState.manifest.events.length);
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server records direct reviewer shard runs", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-reviewer-shard-run-"));
  const inputPath = join(snapshotsRoot, "reviewer-shard-run-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "reviewer-shard-run",
    items: [
      {
        id: "reviewer-shard-run",
        label: "Reviewer shard run",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/reviewer-shard-run?id=reviewer-shard-run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reviewer_mock_status: "pass",
        created_at: "2026-05-22T02:53:30.000Z"
      })
    });
    const created = response.json();

    assert.equal(response.status, 201);
    assert.equal(created.status, "created");
    assert.equal(created.phase, "shard_recorded");
    assert.equal(created.shard_id, "reviewer-scope-shard-001");
    assert.equal(created.pending_shards, 1);
    assert.equal(created.projection.reviewer_shard_review.completed_shards, 1);
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server resumes scheduler loop through projected next action", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-next-action-resume-"));
  const inputPath = join(snapshotsRoot, "next-action-resume-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWithoutRequirementPlanReview();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "next-action-resume",
    items: [
      {
        id: "next-action-resume",
        label: "Next action resume",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const loop = await request(`${baseUrl}/api/workbench/autonomous-scheduler-loop?id=next-action-resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_iterations: 1,
        snapshot_prefix: "resume-loop",
        created_at: "2026-05-22T02:53:40.000Z"
      })
    });
    assert.equal(loop.status, 201);

    const response = await request(`${baseUrl}/api/workbench/next-action?id=next-action-resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "resume_autonomous_scheduler_loop",
        snapshot_prefix: "next-action-resume",
        created_at: "2026-05-22T02:53:50.000Z"
      })
    });
    const created = response.json();
    const sourceState = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.status, "executed");
    assert.equal(created.action, "resume_autonomous_scheduler_loop");
    assert.equal(created.result.status, "created");
    assert.equal(created.result.recovery.status, "ready");
    assert.equal(sourceState.manifest.events.at(-1).type, "scheduler_loop_resume_attempt");
    assert.equal(sourceState.manifest.events.at(-1).status, "pass");
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server fails closed for unsupported projected next action", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-next-action-unsupported-"));
  const inputPath = join(snapshotsRoot, "next-action-unsupported-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWithoutRequirementPlanReview();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "next-action-unsupported",
    items: [
      {
        id: "next-action-unsupported",
        label: "Next action unsupported",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const first = await request(`${baseUrl}/api/workbench/autonomous-scheduler-loop?id=next-action-unsupported`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_iterations: 1,
        snapshot_prefix: "unsupported-loop",
        created_at: "2026-05-22T02:53:40.000Z"
      })
    });
    assert.equal(first.status, 201);
    const resumed = await request(`${baseUrl}/api/workbench/next-action?id=next-action-unsupported`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "resume_autonomous_scheduler_loop",
        snapshot_prefix: "unsupported-resume",
        created_at: "2026-05-22T02:53:50.000Z"
      })
    });
    assert.equal(resumed.status, 201);

    const response = await request(`${baseUrl}/api/workbench/next-action?id=next-action-unsupported`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "wait_for_new_work",
        created_at: "2026-05-22T02:54:00.000Z"
      })
    });
    const rejected = response.json();

    assert.equal(response.status, 409);
    assert.equal(rejected.next_action_readout.action, "wait_for_new_work");
    assert.equal(rejected.projection.next_action_terminal.status, "idle");
    assert.equal(rejected.projection.next_action_terminal.terminal_action, "wait_for_new_work");
    assert.equal(rejected.projection.next_action_terminal.terminal_reason, "scheduler loop resume completed; wait for new dispatchable work");
    assert.equal(assertWorkbenchProjectionSchema(rejected.projection).status, "pass");
    assert.equal(rejected.issues[0].code, "unsupported_projected_next_action");
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server fails closed when projected next action drifts", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/next-action?id=current-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "enqueue_scheduler_next_cycle",
        created_at: "2026-05-22T02:54:00.000Z"
      })
    });
    const rejected = response.json();

    assert.equal(response.status, 409);
    assert.ok(rejected.next_action_readout.action);
    assert.equal(rejected.issues[0].code, "next_action_drift");
    assert.match(rejected.issues[0].message, /expected enqueue_scheduler_next_cycle/);
  });
});
