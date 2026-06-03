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

test("workbench server executes allowlisted projected next actions", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-next-action-"));
  const inputPath = join(snapshotsRoot, "next-action-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWithoutRequirementPlanReview();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "next-action-source",
    items: [
      {
        id: "next-action-source",
        label: "Next action source",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const dispatch = await request(`${baseUrl}/api/workbench/scheduler-dispatch?id=next-action-source`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        execution_profile: "approved_mock_non_dry_run",
        created_at: "2026-05-22T02:50:00.000Z"
      })
    });
    assert.equal(dispatch.status, 201);

    const enqueue = await request(`${baseUrl}/api/workbench/next-action?id=next-action-source`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "enqueue_scheduler_next_cycle",
        snapshot_id: "next-action-queued",
        label: "Next action queued",
        created_at: "2026-05-22T02:51:00.000Z"
      })
    });
    const queued = enqueue.json();
    const sourceAfterEnqueue = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(enqueue.status, 201);
    assert.equal(queued.status, "executed");
    assert.equal(queued.action, "enqueue_scheduler_next_cycle");
    assert.equal(queued.next_action_readout.action, "enqueue_scheduler_next_cycle");
    assert.equal(queued.result.status, "queued");
    assert.equal(queued.result.next_item.id, "next-action-queued");
    assert.equal(sourceAfterEnqueue.manifest.events.at(-1).type, "scheduler_next_cycle_enqueue");

    const loop = await request(`${baseUrl}/api/workbench/next-action?id=next-action-source`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "run_autonomous_scheduler_loop",
        max_iterations: 1,
        snapshot_prefix: "next-action-loop",
        created_at: "2026-05-22T02:52:00.000Z"
      })
    });
    const looped = loop.json();
    const sourceAfterLoop = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(loop.status, 201);
    assert.equal(looped.status, "executed");
    assert.equal(looped.action, "run_autonomous_scheduler_loop");
    assert.equal(looped.next_action_readout.action, "run_autonomous_scheduler_loop");
    assert.equal(looped.result.status, "created");
    assert.equal(looped.result.result.phase, "iteration_limit_reached");
    assert.equal(sourceAfterLoop.manifest.events.at(-1).type, "autonomous_scheduler_loop_run");
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server advances from completed context work packages to project status continuation", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-context-work-packages-next-action-"));
  const inputPath = join(snapshotsRoot, "context-work-packages-next-action-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWithoutRequirementPlanReview();
  workflowState.project_status = {
    project: "ai-control-platform",
    next_step: "",
    global_goals: [
      { id: "foundation", title: "Foundation", status: "completed" },
      {
        id: "completion-loop",
        title: "Completion loop",
        status: "in_progress",
        next_step: "Continue detecting unfinished platform goals."
      }
    ]
  };
  workflowState.task_dag = [
    {
      id: "runtime",
      title: "Runtime",
      status: "completed",
      owned_files: ["src/workflow/context-work-package-runner.js"]
    }
  ];
  workflowState.manifest.events = [
    ...workflowState.manifest.events,
    {
      id: "event-context-work-packages-run",
      type: "context_work_packages_run",
      status: "pass",
      created_at: "2026-05-22T03:10:00.000Z",
      metadata: {
        type: "context_work_packages_run",
        status: "pass",
        executed_count: 1
      }
    }
  ];
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "context-work-packages-next-action",
    items: [
      {
        id: "context-work-packages-next-action",
        label: "Context work packages next action",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const projection = await request(`${baseUrl}/api/workbench/projection?id=context-work-packages-next-action`);
    assert.equal(projection.json().next_action_readout.action, "prepare_project_status_continuation");

    const response = await request(`${baseUrl}/api/workbench/next-action?id=context-work-packages-next-action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "prepare_project_status_continuation",
        created_at: "2026-05-22T03:11:00.000Z"
      })
    });
    const executed = response.json();

    assert.equal(response.status, 201);
    assert.equal(executed.status, "executed");
    assert.equal(executed.action, "prepare_project_status_continuation");
    assert.equal(executed.next_action_readout.action, "prepare_project_status_continuation");
    assert.equal(executed.result.status, "created");
    assert.equal(executed.result.projection.next_action_readout.action, "create_context_pack_from_seed");
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server runs reviewer shard through projected next action", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-next-action-reviewer-"));
  const inputPath = join(snapshotsRoot, "next-action-reviewer-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWithoutSchedulerLoop();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "next-action-reviewer",
    items: [
      {
        id: "next-action-reviewer",
        label: "Next action reviewer",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/next-action?id=next-action-reviewer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "run_reviewer_scope_shard",
        reviewer_mock_status: "pass",
        created_at: "2026-05-22T02:53:00.000Z"
      })
    });
    const created = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.status, "executed");
    assert.equal(created.action, "run_reviewer_scope_shard");
    assert.equal(created.result.status, "created");
    assert.equal(created.result.phase, "shard_recorded");
    assert.equal(created.projection.reviewer_shard_review.completed_shards, 1);
    assert.equal(state.manifest.events.at(-1).type, "reviewer_shard_result");
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});
