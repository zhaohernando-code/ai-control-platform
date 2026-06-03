import assert from "node:assert/strict";
import test from "node:test";

import {
  currentSessionWithoutRequirementPlanReview,
  generatedRequirementPlan,
  join,
  mkdtempSync,
  readFileSync,
  relative,
  request,
  waitForCondition,
  withServer,
  writeFileSync
} from "./helpers/workbench-server.js";

test("workbench server accepts frontend requirements into autonomous continuation flow", async () => {
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-requirement-intake-"));
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const inputPath = join(snapshotsRoot, "requirement-intake-input.json");
  const projectStatusPath = join(snapshotsRoot, "PROJECT_STATUS.json");
  const workflowState = currentSessionWithoutRequirementPlanReview();
  workflowState.manifest.events = [];
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(projectStatusPath, JSON.stringify({
    project: "ai-control-platform",
    status: "in_progress",
    blockers: [],
    next_step: "",
    global_goals: []
  }, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "requirement-intake",
    items: [
      {
        id: "requirement-intake",
        label: "Requirement intake",
        status: "pass",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }, null, 2));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/requirements?id=requirement-intake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "提需求模块更新",
        project_id: "ai-control-platform",
        surface_area: "workbench_frontend",
        problem_statement: "看板提需求页面需要改成新建任务，并由后端生成方案等待用户审核，不只是前端展示。",
        constraints: "不能绕过自动开发、验收和门禁流程。",
        plan_review_requested: true,
        generate_plan: true,
        wait_for_plan_generation: true,
        created_at: "2026-05-25T09:00:00.000Z",
        requirement_id: "requirement-from-workbench"
      })
    });
    const payload = response.json();
    const savedProjectStatus = JSON.parse(readFileSync(projectStatusPath, "utf8"));
    const savedWorkflowState = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(payload.status, "created");
    assert.equal(payload.requirement.id, "requirement-from-workbench");
    assert.equal(payload.plan_review.phase, "ready_for_review");
    assert.equal(payload.submitted_projection.next_action_readout.action, "review_requirement_plan");
    assert.equal(payload.submitted_projection.next_action_readout.source_type, "plan_review");
    assert.equal(payload.submitted_projection.next_action_readout.requires_operator, true);
    assert.equal(payload.auto_advance.status, "waiting_for_plan_review");
    assert.equal(payload.auto_advance.result, null);
    assert.equal(payload.projection.next_action_readout.action, "review_requirement_plan");
    assert.equal(payload.projection.project_management.task_items[0].task_id, "requirement-from-workbench");
    assert.equal(payload.projection.project_management.task_items[0].status, "pending_review");
    assert.equal(payload.projection.project_management.task_items[0].reviewable, true);
    assert.equal(savedProjectStatus.requirement_intake.latest_requirement_id, "requirement-from-workbench");
    assert.equal(savedProjectStatus.plan_reviews["requirement-from-workbench"].phase, "ready_for_review");
    assert.equal(savedProjectStatus.next_work_packages[0].action, "continue_requirement_intake");
    assert.ok(savedProjectStatus.next_work_packages[0].owned_files.includes("apps/workbench"));
    assert.ok(savedProjectStatus.next_work_packages[0].owned_files.includes("tools/workbench-server.mjs"));
    assert.match(savedProjectStatus.plan_reviews["requirement-from-workbench"].proposed_acceptance_plan, /形成可审核方案/);
    assert.ok(savedWorkflowState.manifest.events.some((event) => event.type === "requirement_intake_submitted"));
    assert.equal(savedWorkflowState.project_status.next_work_packages[0].action, "continue_requirement_intake");
    assert.equal(savedWorkflowState.manifest.events.some((event) => event.type === "context_work_packages_run"), false);
    assert.equal(savedWorkflowState.manifest.events.at(-1).type, "requirement_intake_submitted");
  }, {
    historyPath,
    snapshotsRoot,
    projectStatusPath,
    requirementPlanGenerator: async () => ({
      status: "pass",
      generated_plan: generatedRequirementPlan(),
      generator: { kind: "test_plan_model" }
    })
  });
});

test("workbench server persists frontend requirement before model plan generation", async () => {
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-requirement-pending-"));
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const inputPath = join(snapshotsRoot, "requirement-pending-input.json");
  const projectStatusPath = join(snapshotsRoot, "PROJECT_STATUS.json");
  const workflowState = currentSessionWithoutRequirementPlanReview();
  workflowState.manifest.events = [];
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(projectStatusPath, JSON.stringify({
    project: "ai-control-platform",
    status: "in_progress",
    blockers: [],
    next_step: "",
    global_goals: []
  }, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "requirement-pending",
    items: [
      {
        id: "requirement-pending",
        label: "Requirement pending",
        status: "pass",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }, null, 2));

  let observedPendingWrite = false;
  let releaseGenerator;
  const generatorMayFinish = new Promise((resolve) => {
    releaseGenerator = resolve;
  });
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/requirements?id=requirement-pending`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "前端重构",
        project_id: "ai-control-platform",
        surface_area: "workbench_frontend",
        problem_statement: "基于 PC 和移动端视觉稿重构 Ops Workbench 首页。",
        plan_review_requested: true,
        generate_plan: true,
        created_at: "2026-05-25T10:00:00.000Z",
        requirement_id: "requirement-frontend-refactor"
      })
    });
    const payload = response.json();
    const savedProjectStatus = JSON.parse(readFileSync(projectStatusPath, "utf8"));
    const savedWorkflowState = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(payload.plan_generation.status, "scheduled");
    assert.equal(payload.plan_review.phase, "pending_plan_generation");
    assert.equal(payload.auto_advance.status, "waiting_for_plan_generation");
    assert.equal(payload.projection.next_action_readout.action, "generate_requirement_plan");
    assert.equal(payload.projection.project_management.plan_review.requirement_id, "requirement-frontend-refactor");
    assert.equal(savedProjectStatus.requirement_intake.latest_requirement_id, "requirement-frontend-refactor");
    assert.equal(savedProjectStatus.plan_reviews["requirement-frontend-refactor"].phase, "pending_plan_generation");
    assert.equal(savedWorkflowState.project_status.requirement_intake.latest_requirement_id, "requirement-frontend-refactor");
    assert.equal(savedWorkflowState.project_status.plan_reviews["requirement-frontend-refactor"].phase, "pending_plan_generation");
    assert.ok(savedWorkflowState.manifest.events.some((event) => event.type === "requirement_intake_submitted"));
    await waitForCondition(() => observedPendingWrite, "background generator sees pending write");
    releaseGenerator();
    await waitForCondition(() => {
      const currentProjectStatus = JSON.parse(readFileSync(projectStatusPath, "utf8"));
      return currentProjectStatus.plan_reviews["requirement-frontend-refactor"].phase === "plan_generation_failed";
    }, "background plan generation failure writeback");
    const failedProjectStatus = JSON.parse(readFileSync(projectStatusPath, "utf8"));
    const failedWorkflowState = JSON.parse(readFileSync(inputPath, "utf8"));
    assert.match(failedProjectStatus.plan_reviews["requirement-frontend-refactor"].generation_error.stderr, /simulated model timeout/);
    assert.equal(failedWorkflowState.project_status.plan_reviews["requirement-frontend-refactor"].phase, "plan_generation_failed");
  }, {
    historyPath,
    snapshotsRoot,
    projectStatusPath,
    requirementPlanGenerator: async () => {
      const pendingProjectStatus = JSON.parse(readFileSync(projectStatusPath, "utf8"));
      const pendingWorkflowState = JSON.parse(readFileSync(inputPath, "utf8"));
      observedPendingWrite =
        pendingProjectStatus.requirement_intake.latest_requirement_id === "requirement-frontend-refactor" &&
        pendingProjectStatus.plan_reviews["requirement-frontend-refactor"].phase === "pending_plan_generation" &&
        pendingWorkflowState.project_status.requirement_intake.latest_requirement_id === "requirement-frontend-refactor";
      await generatorMayFinish;
      return {
        status: "fail",
        stderr: "simulated model timeout"
      };
    }
  });
});

test("workbench server retries and closes failed requirement plan generation", async () => {
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-requirement-retry-close-"));
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const inputPath = join(snapshotsRoot, "requirement-retry-close-input.json");
  const projectStatusPath = join(snapshotsRoot, "PROJECT_STATUS.json");
  const workflowState = currentSessionWithoutRequirementPlanReview();
  workflowState.manifest.events = [];
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(projectStatusPath, JSON.stringify({
    project: "ai-control-platform",
    status: "in_progress",
    blockers: [],
    next_step: "",
    global_goals: []
  }, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "requirement-retry-close",
    items: [
      {
        id: "requirement-retry-close",
        label: "Requirement retry close",
        status: "pass",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }, null, 2));

  let generatorMode = "fail";
  await withServer(async (baseUrl) => {
    const submitted = await request(`${baseUrl}/api/workbench/requirements?id=requirement-retry-close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "完成项目 tab",
        project_id: "ai-control-platform",
        problem_statement: "项目 tab 需要接入项目治理。",
        plan_review_requested: true,
        generate_plan: true,
        created_at: "2026-05-25T10:00:00.000Z",
        requirement_id: "requirement-project-tab"
      })
    });
    assert.equal(submitted.status, 201);
    await waitForCondition(() => {
      const currentProjectStatus = JSON.parse(readFileSync(projectStatusPath, "utf8"));
      return currentProjectStatus.plan_reviews["requirement-project-tab"].phase === "plan_generation_failed";
    }, "initial failed plan generation");

    generatorMode = "pass";
    const retry = await request(`${baseUrl}/api/workbench/requirements/retry-plan?id=requirement-retry-close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requirement_id: "requirement-project-tab",
        created_at: "2026-05-25T10:05:00.000Z"
      })
    });
    const retryPayload = retry.json();
    assert.equal(retry.status, 202);
    assert.equal(retryPayload.plan_review.phase, "pending_plan_generation");
    assert.equal(retryPayload.plan_generation.status, "scheduled");
    await waitForCondition(() => {
      const currentProjectStatus = JSON.parse(readFileSync(projectStatusPath, "utf8"));
      return currentProjectStatus.plan_reviews["requirement-project-tab"].phase === "ready_for_review";
    }, "retried plan generation");

    const close = await request(`${baseUrl}/api/workbench/requirements/close?id=requirement-retry-close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requirement_id: "requirement-project-tab",
        note: "operator closed failed task",
        created_at: "2026-05-25T10:10:00.000Z"
      })
    });
    const closePayload = close.json();
    assert.equal(close.status, 201);
    assert.equal(closePayload.plan_review.phase, "closed_failed");
    assert.equal(closePayload.projection.project_management.task_items[0].status, "closed");
    assert.equal(closePayload.projection.project_management.active_tasks, 0);
    assert.equal(closePayload.projection.global_goal_completion.pending, 0);
  }, {
    historyPath,
    snapshotsRoot,
    projectStatusPath,
    requirementPlanGenerator: async () => (
      generatorMode === "pass"
        ? { status: "pass", generated_plan: generatedRequirementPlan(), generator: { kind: "test_model_plan" } }
        : { status: "fail", stderr: "simulated model timeout", generator: { kind: "test_model_plan", timed_out: true } }
    )
  });
});
