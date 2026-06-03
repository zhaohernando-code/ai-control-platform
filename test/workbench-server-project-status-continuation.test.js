import assert from "node:assert/strict";
import test from "node:test";

import {
  currentSessionWithoutRequirementPlanReview,
  join,
  mkdtempSync,
  readFileSync,
  relative,
  request,
  withServer,
  writeFileSync
} from "./helpers/workbench-server.js";

test("workbench server executes project status continuation next action", async () => {
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-project-status-next-action-"));
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const inputPath = join(snapshotsRoot, "project-status-next-action-input.json");
  const projectStatusPath = join(snapshotsRoot, "PROJECT_STATUS.json");
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
    latest: "project-status-next-action",
    items: [
      {
        id: "project-status-next-action",
        label: "Project status next action",
        status: "pass",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }, null, 2));

  await withServer(async (baseUrl) => {
    const before = await request(`${baseUrl}/api/workbench/projection`);
    assert.equal(before.json().next_action_readout.action, "prepare_project_status_continuation");

    const response = await request(`${baseUrl}/api/workbench/next-action?id=project-status-next-action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "prepare_project_status_continuation",
        created_at: "2026-05-22T03:10:00.000Z"
      })
    });
    const payload = response.json();
    const saved = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(payload.status, "executed");
    assert.equal(payload.action, "prepare_project_status_continuation");
    assert.equal(payload.result.status, "created");
    assert.equal(payload.result.artifact.metadata.next_goal.id, "repo-goal");
    assert.equal(saved.manifest.events.at(-1).type, "project_status_continuation");
    assert.equal(payload.result.projection.next_action_readout.action, "create_context_pack_from_seed");

    const cycle = await request(`${baseUrl}/api/workbench/next-action?id=project-status-next-action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "create_context_pack_from_seed",
        snapshot_id: "project-status-context-cycle",
        cycle_id: "cycle-project-status-context",
        label: "Project status context cycle",
        created_at: "2026-05-22T03:11:00.000Z"
      })
    });
    const created = cycle.json();
    const sourceAfterCycle = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(cycle.status, 201);
    assert.equal(created.action, "create_context_pack_from_seed");
    assert.equal(created.result.next_item.id, "project-status-context-cycle");
    assert.equal(created.result.projection.cycle_id, "cycle-project-status-context");
    assert.equal(created.result.projection.manifest.work_package_count, 1);
    assert.equal(created.result.projection.next_action_readout.action, "run_context_work_packages");
    assert.equal(sourceAfterCycle.manifest.events.at(-1).type, "context_pack_cycle_materialized");

    const cycleHistory = JSON.parse(readFileSync(historyPath, "utf8"));
    const cycleItem = cycleHistory.items.find((entry) => entry.id === "project-status-context-cycle");
    const cycleInputPath = join(process.cwd(), cycleItem.input_path);
    const cycleState = JSON.parse(readFileSync(cycleInputPath, "utf8"));
    const scopedPackage = {
      ...cycleState.manifest.work_packages[0],
      id: "project-status-scoped-next-step",
      action: "continue_next_step",
      global_goal_id: ""
    };
    cycleState.manifest.work_packages = [scopedPackage];
    cycleState.manifest.context_pack.subtasks = [scopedPackage];
    cycleState.task_dag = [scopedPackage];
    writeFileSync(cycleInputPath, `${JSON.stringify(cycleState, null, 2)}\n`);

    const rejectedRun = await request(`${baseUrl}/api/workbench/next-action?id=project-status-context-cycle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "run_context_work_packages",
        max_package_count: 1,
        execution_mode: "provider_model_routed",
        execution_profile: "real_provider_not_registered",
        created_at: "2026-05-22T03:11:30.000Z"
      })
    });
    const rejected = rejectedRun.json();
    const stateAfterRejectedRun = JSON.parse(readFileSync(cycleInputPath, "utf8"));

    assert.equal(rejectedRun.status, 409);
    assert.equal(rejected.error, "context work package run failed");
    assert.ok(rejected.issues.some((issue) => issue.code === "unsupported_execution_profile"));
    assert.notEqual(stateAfterRejectedRun.manifest.work_packages[0].status, "completed");

    const profileOnlyRun = await request(`${baseUrl}/api/workbench/context-work-packages-run?id=project-status-context-cycle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_package_count: 1,
        execution_profile: "real_provider_not_registered",
        created_at: "2026-05-22T03:11:40.000Z"
      })
    });
    const profileOnly = profileOnlyRun.json();
    const stateAfterProfileOnlyRun = JSON.parse(readFileSync(cycleInputPath, "utf8"));

    assert.equal(profileOnlyRun.status, 409);
    assert.equal(profileOnly.error, "context work package run failed");
    assert.ok(profileOnly.issues.some((issue) => issue.code === "unsupported_execution_profile"));
    assert.notEqual(stateAfterProfileOnlyRun.manifest.work_packages[0].status, "completed");

    const deterministicKindRun = await request(`${baseUrl}/api/workbench/context-work-packages-run?id=project-status-context-cycle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_package_count: 1,
        executor_kind: "deterministic_mock_multi_agent",
        created_at: "2026-05-22T03:11:45.000Z"
      })
    });
    const deterministicKind = deterministicKindRun.json();
    const stateAfterDeterministicKindRun = JSON.parse(readFileSync(cycleInputPath, "utf8"));

    assert.equal(deterministicKindRun.status, 409);
    assert.equal(deterministicKind.error, "context work package run failed");
    assert.ok(deterministicKind.issues.some((issue) => issue.code === "unsupported_execution_profile"));
    assert.notEqual(stateAfterDeterministicKindRun.manifest.work_packages[0].status, "completed");

    const adapterProfileRun = await request(`${baseUrl}/api/workbench/context-work-packages-run?id=project-status-context-cycle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_package_count: 1,
        adapter_profile: "bounded_mock_multi_agent",
        risk: "high",
        budget_tier: "high",
        codex_plan_pressure: true,
        created_at: "2026-05-22T03:11:50.000Z"
      })
    });
    const adapterProfile = adapterProfileRun.json();
    const stateAfterAdapterProfileRun = JSON.parse(readFileSync(cycleInputPath, "utf8"));

    assert.equal(adapterProfileRun.status, 409);
    assert.equal(adapterProfile.status, "validated");
    assert.equal(adapterProfile.error, "context work package run validated without completion authority");
    assert.equal(adapterProfile.executor_provenance.executor_kind, "deterministic_mock_multi_agent");
    assert.notEqual(stateAfterAdapterProfileRun.manifest.work_packages[0].status, "completed");
    assert.equal(stateAfterAdapterProfileRun.artifact_ledger.artifacts.some((artifact) => artifact.metadata?.execution_profile === "bounded_mock_multi_agent"), false);

    const directMockRun = await request(`${baseUrl}/api/workbench/context-work-packages-run?id=project-status-context-cycle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_package_count: 1,
        execution_mode: "provider_model_routed",
        execution_profile: "bounded_mock_multi_agent",
        risk: "high",
        budget_tier: "high",
        codex_plan_pressure: true,
        tags: ["boundary_sensitive"],
        stage: "implementation",
        created_at: "2026-05-22T03:12:00.000Z"
      })
    });
    const directMock = directMockRun.json();
    const stateAfterDirectMockRun = JSON.parse(readFileSync(cycleInputPath, "utf8"));

    assert.equal(directMockRun.status, 409);
    assert.equal(directMock.status, "validated");
    assert.equal(directMock.error, "context work package run validated without completion authority");
    assert.equal(directMock.allows_work_package_completion, false);
    assert.equal(directMock.completion_authority.allows_work_package_completion, false);
    assert.equal(directMock.executor_provenance.executor_kind, "deterministic_mock_multi_agent");
    assert.equal(directMock.package_results[0].status, "validated");
    assert.equal(directMock.package_results[0].allows_work_package_completion, false);
    assert.equal(directMock.execution_plan.model_routing.strategy, "per_work_package_buildModelCollaborationPlan");
    assert.ok(directMock.execution_plan.model_routing.package_plans[0].roles.some((role) => role.role === "process_guard"));
    assert.notEqual(stateAfterDirectMockRun.manifest.work_packages[0].status, "completed");
    assert.equal(stateAfterDirectMockRun.artifact_ledger.artifacts.some((artifact) => artifact.metadata?.execution_profile === "bounded_mock_multi_agent"), false);

    const nextActionMockRun = await request(`${baseUrl}/api/workbench/next-action?id=project-status-context-cycle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "run_context_work_packages",
        max_package_count: 1,
        execution_mode: "provider_model_routed",
        execution_profile: "bounded_mock_multi_agent",
        risk: "high",
        budget_tier: "high",
        codex_plan_pressure: true,
        tags: ["boundary_sensitive"],
        stage: "implementation",
        created_at: "2026-05-22T03:12:30.000Z"
      })
    });
    const nextActionMock = nextActionMockRun.json();
    const stateAfterNextActionMockRun = JSON.parse(readFileSync(cycleInputPath, "utf8"));

    assert.equal(nextActionMockRun.status, 409);
    assert.equal(nextActionMock.error, "context work package run validated without completion authority");
    assert.equal(nextActionMock.result.status, "validated");
    assert.equal(nextActionMock.result.allows_work_package_completion, false);
    assert.equal(nextActionMock.result.executor_provenance.executor_kind, "deterministic_mock_multi_agent");
    assert.equal(nextActionMock.result.package_results[0].status, "validated");
    assert.notEqual(stateAfterNextActionMockRun.manifest.work_packages[0].status, "completed");
    assert.equal(stateAfterNextActionMockRun.artifact_ledger.artifacts.some((artifact) => artifact.metadata?.execution_profile === "bounded_mock_multi_agent"), false);

    const localRun = await request(`${baseUrl}/api/workbench/context-work-packages-run?id=project-status-context-cycle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_package_count: 1,
        created_at: "2026-05-22T03:13:00.000Z"
      })
    });
    const local = localRun.json();
    const stateAfterLocalRun = JSON.parse(readFileSync(cycleInputPath, "utf8"));

    assert.equal(localRun.status, 201);
    assert.equal(local.status, "created");
    assert.equal(local.executed_count, 1);
    assert.equal(stateAfterLocalRun.manifest.work_packages[0].status, "completed");
    const localContextRunArtifact = stateAfterLocalRun.artifact_ledger.artifacts
      .find((artifact) => artifact.metadata?.type === "context_work_packages_run");
    assert.equal(localContextRunArtifact.metadata.execution_profile, "local_bounded");
  }, { historyPath, snapshotsRoot, projectStatusPath });
});
