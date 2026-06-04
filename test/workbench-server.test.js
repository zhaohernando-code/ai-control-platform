import assert from "node:assert/strict";
import test from "node:test";

import {
  currentSessionWithoutRequirementPlanReview,
  join,
  mkdtempSync,
  relative,
  request,
  withServer,
  writeFileSync
} from "./helpers/workbench-server.js";

test("workbench server returns latest projection", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/projection?id=current-session`);
    const projection = response.json();

    assert.equal(response.status, 200);
    assert.equal(projection.projection_version, "workbench.v1");
    assert.equal(projection.run_id, "run-20260521-platform-self-trial");
    assert.equal(projection.operator_events.status, "pass");
    assert.equal(projection.operator_events.applied_artifacts, 1);
    assert.ok(projection.manifest.event_count >= 8);
    assert.ok(projection.artifacts.total >= 8);
    assert.equal(projection.reviewer_provider_health.provider_health, "healthy");
    assert.equal(projection.reviewer_scope_split.shard_count, 2);
  });
});

test("workbench server builds latest projection from workflow state input", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/projection?id=current-session`);
    const projection = response.json();

    assert.equal(response.status, 200);
    assert.equal(projection.operator_events.event_count, 1);
    assert.ok(projection.artifacts.by_type.evaluation >= 3);
    assert.ok(projection.autonomous_run.summaries.artifacts.total >= 8);
    assert.equal(projection.reviewer_provider_health.next_action, "rerun_without_tools");
    assert.equal(projection.reviewer_scope_split.next_shard, "reviewer-scope-shard-001");
  });
});

test("workbench server overlays repository PROJECT_STATUS into workflow projections", async () => {
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-project-status-"));
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const inputPath = join(snapshotsRoot, "project-status-input.json");
  const projectStatusPath = join(snapshotsRoot, "PROJECT_STATUS.json");
  const workflowState = currentSessionWithoutRequirementPlanReview();
  workflowState.project_status = {
    project: "ai-control-platform",
    next_step: "",
    global_goals: [{ id: "stale", title: "Stale input goal", status: "completed" }]
  };
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(projectStatusPath, JSON.stringify({
    project: "ai-control-platform",
    status: "in_progress",
    blockers: [],
    next_step: "Continue from repository PROJECT_STATUS.",
    global_goals: [
      {
        id: "repo-goal",
        title: "Repository status goal",
        status: "in_progress",
        next_step: "Use repo-level goal state."
      }
    ]
  }, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "project-status",
    items: [
      {
        id: "project-status",
        label: "Project status",
        status: "pass",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }, null, 2));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/projection`);
    const projection = response.json();

    assert.equal(response.status, 200);
    assert.equal(projection.global_goal_completion.status, "in_progress");
    assert.equal(projection.global_goal_completion.next_goal.id, "repo-goal");
    assert.equal(projection.global_goal_completion.next_goal.title, "Repository status goal");
    assert.equal(projection.one_screen.counters.global_goals_pending, 1);
  }, { historyPath, snapshotsRoot, projectStatusPath });
});

test("workbench server truncates generated context pack snapshot ids for long projection ids", async () => {
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-long-context-id-"));
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const inputPath = join(snapshotsRoot, "long-context-id-input.json");
  const projectStatusPath = join(snapshotsRoot, "PROJECT_STATUS.json");
  const longProjectionId = "headless-continuation-third-cycle-20260521-autonomous-platform-headless-01-headl";
  const workflowState = currentSessionWithoutRequirementPlanReview();
  workflowState.manifest.events = [];
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(projectStatusPath, JSON.stringify({
    project: "ai-control-platform",
    status: "in_progress",
    blockers: [],
    next_step: "",
    global_goals: [
      {
        id: "repo-goal",
        title: "Repository status goal",
        status: "in_progress",
        next_step: "Prepare the next global-goal cycle.",
        owned_files: ["src/workflow/context-pack-cycle.js", "test/context-pack-cycle.test.js"]
      }
    ]
  }, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: longProjectionId,
    items: [
      {
        id: longProjectionId,
        label: "Long projection id",
        status: "pass",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }, null, 2));

  await withServer(async (baseUrl) => {
    await request(`${baseUrl}/api/workbench/next-action?id=${longProjectionId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "prepare_project_status_continuation",
        created_at: "2026-05-22T03:20:00.000Z"
      })
    });

    const cycle = await request(`${baseUrl}/api/workbench/next-action?id=${longProjectionId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "create_context_pack_from_seed",
        cycle_id: "cycle-long-context-id",
        created_at: "2026-05-22T03:21:00.000Z"
      })
    });
    const created = cycle.json();

    assert.equal(cycle.status, 201);
    assert.equal(created.action, "create_context_pack_from_seed");
    assert.ok(created.result.next_item.id.startsWith("context-pack-cycle-"));
    assert.ok(created.result.next_item.id.length <= 80);
    assert.equal(created.result.projection.next_action_readout.action, "run_context_work_packages");
  }, { historyPath, snapshotsRoot, projectStatusPath });
});
