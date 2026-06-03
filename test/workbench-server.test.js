import assert from "node:assert/strict";
import test from "node:test";

import {
  currentSessionWithoutRequirementPlanReview,
  generatedRequirementPlan,
  isolatedExecutionCwd,
  join,
  mkdtempSync,
  providerContextWorkPackageWorkflowState,
  readFileSync,
  relative,
  request,
  VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
  WORKBENCH_SERVER_TEST_FILES,
  waitForCondition,
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

test("workbench server falls back to a governed requirement plan model after timeout", async () => {
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-requirement-fallback-"));
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const inputPath = join(snapshotsRoot, "requirement-fallback-input.json");
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
    latest: "requirement-fallback",
    items: [
      {
        id: "requirement-fallback",
        label: "Requirement fallback",
        status: "pass",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }, null, 2));
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/requirements?id=requirement-fallback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "完成项目 tab",
        project_id: "ai-control-platform",
        problem_statement: "项目 tab 需要接入项目治理。",
        plan_review_requested: true,
        generate_plan: true,
        wait_for_plan_generation: true,
        requirement_plan_timeout_ms: 50,
        created_at: "2026-05-25T10:00:00.000Z",
        requirement_id: "requirement-project-tab"
      })
    });
    const payload = response.json();
    const generator = payload.plan_review.generator;
    assert.equal(response.status, 201);
    assert.equal(payload.plan_review.phase, "ready_for_review");
    assert.equal(generator.model, "claude-haiku-4-5-20251001");
    assert.equal(generator.fallback_from_model, "claude-sonnet-4-6");
    assert.equal(generator.attempts[0].timed_out, true);
    assert.equal(generator.attempts[1].attempt, "candidate_fallback");
  }, {
    historyPath,
    snapshotsRoot,
    projectStatusPath,
    requirementPlanGenerator: async () => ({
      status: "pass",
      generated_plan: generatedRequirementPlan(),
      generator: {
        kind: "agent_invocation_requirement_plan",
        model: "claude-haiku-4-5-20251001",
        timed_out: false,
        attempt: "candidate_fallback",
        fallback_from_model: "claude-sonnet-4-6",
        attempts: [
          { model: "claude-sonnet-4-6", timed_out: true, attempt: "primary" },
          { model: "claude-haiku-4-5-20251001", timed_out: false, attempt: "candidate_fallback" }
        ]
      }
    })
  });
});

test("workbench server can apply a supplied plan when retrying failed plan generation", async () => {
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-requirement-supplied-plan-"));
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const inputPath = join(snapshotsRoot, "requirement-supplied-plan-input.json");
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
    latest: "requirement-supplied-plan",
    items: [
      {
        id: "requirement-supplied-plan",
        label: "Requirement supplied plan",
        status: "pass",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }, null, 2));

  await withServer(async (baseUrl) => {
    const submitted = await request(`${baseUrl}/api/workbench/requirements?id=requirement-supplied-plan`, {
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

    const retry = await request(`${baseUrl}/api/workbench/requirements/retry-plan?id=requirement-supplied-plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requirement_id: "requirement-project-tab",
        generated_plan: generatedRequirementPlan(),
        created_at: "2026-05-25T10:05:00.000Z"
      })
    });
    const payload = retry.json();
    assert.equal(retry.status, 201);
    assert.equal(payload.status, "generated");
    assert.equal(payload.plan_review.phase, "ready_for_review");
    assert.equal(payload.plan_review.generator.kind, "operator_supplied_requirement_plan");
    assert.equal(payload.auto_advance.status, "waiting_for_plan_review");
  }, {
    historyPath,
    snapshotsRoot,
    projectStatusPath,
    requirementPlanGenerator: async () => ({ status: "fail", stderr: "simulated model timeout" })
  });
});

test("workbench server records plan review decisions", async () => {
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-plan-review-"));
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const inputPath = join(snapshotsRoot, "plan-review-input.json");
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
    latest: "plan-review",
    items: [
      {
        id: "plan-review",
        label: "Plan review",
        status: "pass",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }, null, 2));

  await withServer(async (baseUrl) => {
    const submitted = await request(`${baseUrl}/api/workbench/requirements?id=plan-review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "提需求模块更新",
        project_id: "ai-control-platform",
        problem_statement: "提需求页面需要先生成方案并等待用户审核。",
        plan_review_requested: true,
        generated_plan: generatedRequirementPlan(),
        auto_advance: false,
        created_at: "2026-05-25T09:00:00.000Z",
        requirement_id: "requirement-plan-review-server"
      })
    });
    const response = await request(`${baseUrl}/api/workbench/plan-reviews?id=plan-review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requirement_id: "requirement-plan-review-server",
        action: "approve",
        auto_advance: false,
        created_at: "2026-05-25T09:05:00.000Z"
      })
    });
    const payload = response.json();
    const savedProjectStatus = JSON.parse(readFileSync(projectStatusPath, "utf8"));
    const savedWorkflowState = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(submitted.status, 201);
    assert.equal(response.status, 201);
    assert.equal(payload.status, "updated");
    assert.equal(payload.plan_review.phase, "in_development");
    assert.equal(payload.projection.project_management.plan_review.phase, "in_development");
    assert.equal(payload.projection.project_management.plan_review.action_status, "开发中");
    assert.equal(payload.projection.project_management.task_items[0].status, "pending_execution");
    assert.equal(payload.projection.project_management.task_items[0].phase_label, "等待派发");
    assert.equal(savedProjectStatus.plan_reviews["requirement-plan-review-server"].phase, "in_development");
    assert.equal(savedWorkflowState.project_status.plan_reviews["requirement-plan-review-server"].phase, "in_development");
  }, { historyPath, snapshotsRoot, projectStatusPath });
});

test("workbench server starts development automatically after plan review approval", async () => {
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-plan-review-auto-dev-"));
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const inputPath = join(snapshotsRoot, "plan-review-auto-dev-input.json");
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
    latest: "plan-review-auto-dev",
    items: [
      {
        id: "plan-review-auto-dev",
        label: "Plan review auto dev",
        status: "pass",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }, null, 2));

  await withServer(async (baseUrl) => {
    const executionCwd = isolatedExecutionCwd("workbench-plan-review-auto-dev-");
    const submitted = await request(`${baseUrl}/api/workbench/requirements?id=plan-review-auto-dev`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "审批后直接进入开发",
        project_id: "ai-control-platform",
        problem_statement: "用户同意方案后不应该再点一次开始开发。",
        plan_review_requested: true,
        generated_plan: generatedRequirementPlan(),
        auto_advance: false,
        created_at: "2026-05-25T09:10:00.000Z",
        requirement_id: "requirement-plan-review-auto-dev"
      })
    });
    const response = await request(`${baseUrl}/api/workbench/plan-reviews?id=plan-review-auto-dev`, {
      method: "POST",
      headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requirement_id: "requirement-plan-review-auto-dev",
          action: "approve",
          execution_cwd: executionCwd,
          primary_worktree_path: process.cwd(),
          created_at: "2026-05-25T09:15:00.000Z"
        })
      });
    const payload = response.json();
    const savedHistory = JSON.parse(readFileSync(historyPath, "utf8"));
    const latestHistoryItem = savedHistory.items.find((entry) => entry.id === savedHistory.latest);
    const latestWorkflowState = JSON.parse(readFileSync(join(process.cwd(), latestHistoryItem.input_path), "utf8"));
    const eventTypes = latestWorkflowState.manifest.events.map((event) => event.type);
    const contextRunArtifact = latestWorkflowState.artifact_ledger.artifacts
      .find((artifact) => artifact.metadata?.type === "context_work_packages_run");

    assert.equal(submitted.status, 201);
    assert.equal(response.status, 201);
    assert.equal(payload.plan_review.phase, "in_development");
    assert.equal(payload.projection.project_management.plan_review.action_status, "开发中");
    assert.equal(payload.auto_advance.status, "created");
    assert.equal(payload.auto_advance.requirement_completion.status, "not_completed");
    assert.equal(payload.auto_advance.result.status, "pass");
    assert.ok(payload.auto_advance.result.iterations.some((iteration) => iteration.projected_action === "run_context_work_packages"));
    assert.equal(payload.projection.next_action_readout.action, "run_context_work_packages");
    assert.ok(eventTypes.includes("context_work_packages_run"));
    assert.equal(latestWorkflowState.manifest.work_packages[0].status, "completed");
    assert.equal(contextRunArtifact.metadata.execution_profile, VERIFIED_PROVIDER_MULTI_AGENT_PROFILE);
    assert.equal(contextRunArtifact.metadata.execution_cwd, executionCwd);
    assert.equal(contextRunArtifact.metadata.primary_worktree_path, process.cwd());
  }, {
    historyPath,
    snapshotsRoot,
    projectStatusPath,
    contextWorkPackageProviderExecutor: ({ selected_work_packages }) => ({
      status: "pass",
      completion_evidence: {
        kind: "provider_execution",
        summary: "verified provider started and completed the approved development package"
      },
      package_results: selected_work_packages.map((workPackage) => ({
        work_package_id: workPackage.id,
        status: "pass",
        result: "pass",
        allows_work_package_completion: true,
        completion_authority: {
          allows_work_package_completion: true,
          authority: "verified_provider_executor",
          evidence_kind: "provider_execution",
          reason: "configured workbench provider executor completed approved development package"
        },
        completion_evidence: {
          kind: "package_completion",
          artifact_id: `plan-review-auto-dev-${workPackage.id}`
        }
      })),
      executor_provenance: {
        executor_kind: "configured_workbench_provider_executor",
        provider: "multi_provider",
        execution_mode: "provider_model_routed",
        execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
        external_calls: 2,
        deterministic: false
      }
    })
  });
});

test("workbench server stages resume execution in background without blocking projection API", async () => {
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-background-resume-"));
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const inputPath = join(snapshotsRoot, "background-resume-input.json");
  const projectStatusPath = join(snapshotsRoot, "PROJECT_STATUS.json");
  const stateDbPath = join(snapshotsRoot, "workbench-state.sqlite");
  const requirementId = "requirement-background-resume";
  const workPackage = {
    id: "requirement-background-resume-plan-step-01",
    title: "后台恢复执行步骤 01",
    action: "execute_requirement_plan_step",
    status: "pending",
    owned_files: ["apps/workbench/app/projects/page.tsx"],
    acceptance_gates: [`node --test ${WORKBENCH_SERVER_TEST_FILES.join(" ")}`],
    global_goal_id: requirementId,
    source: {
      requirement_id: requirementId,
      plan_step_index: 1,
      implementation_step: "恢复执行应后台派发，API 继续可用。",
      execution_governance: {
        version: "work-package-execution-governance.v1",
        granularity: "single_step",
        decomposition: {
          required: false,
          status: "not_required"
        },
        verification: {
          required: true,
          status: "defined",
          gate_count: 1
        }
      }
    }
  };
  const workflowState = currentSessionWithoutRequirementPlanReview();
  workflowState.manifest.events = [];
  workflowState.manifest.work_packages = [workPackage];
  workflowState.manifest.context_pack = {
    requirement_summary: "后台恢复执行",
    host: "platform_core",
    target_project_id: "ai-control-platform",
    owned_files: ["apps/workbench/app/projects/page.tsx", "tools/workbench-server.mjs"],
    acceptance_gates: [`node --test ${WORKBENCH_SERVER_TEST_FILES.join(" ")}`],
    non_goals: ["不阻塞 API"],
    forbidden_actions: ["不得同步长耗时 provider"],
    rollback_conditions: ["API 恢复执行后不可用"],
    subtasks: [workPackage]
  };
  workflowState.task_dag = [workPackage];
  workflowState.project_status = {
    project: "ai-control-platform",
    status: "in_progress",
    blockers: [],
    requirement_intake: {
      items: [{
        id: requirementId,
        title: "后台恢复执行",
        project_id: "ai-control-platform",
        status: "submitted",
        submitted_at: "2026-05-28T13:30:00.000Z",
        problem_statement: "恢复执行不能让 API 失效。"
      }]
    },
    plan_reviews: {
      [requirementId]: {
        id: `plan-review-${requirementId}`,
        phase: "in_development",
        status: "in_development",
        reviewed_at: "2026-05-28T13:31:00.000Z"
      }
    },
    next_work_packages: [workPackage]
  };
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(projectStatusPath, JSON.stringify(workflowState.project_status, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "background-resume",
    items: [
      {
        id: "background-resume",
        label: "Background resume",
        status: "pass",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }, null, 2));

  let launched = null;
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/context-work-packages-run?id=background-resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_package_count: 1,
        background: true,
        dispatch_mode: "background",
        created_at: "2026-05-28T13:32:00.000Z"
      })
    });
    const payload = response.json();
    const projectionResponse = await request(`${baseUrl}/api/workbench/projection?id=background-resume`);
    const projection = projectionResponse.json();
    const task = projection.project_management.task_items[0];

    assert.equal(response.status, 202);
    assert.equal(payload.status, "accepted");
    assert.equal(payload.phase, "context_work_packages_dispatch_started");
    assert.deepEqual(payload.selected_work_package_ids, [workPackage.id]);
    assert.equal(payload.projection.project_management.task_items[0].status, "running");
    assert.equal(projectionResponse.status, 200);
    assert.equal(task.status, "running");
    assert.equal(task.status_label, "运行中");
    assert.equal(task.work_packages[0].status, "running");
    assert.equal(launched.selected_work_package_ids[0], workPackage.id);
    assert.equal(launched.snapshot_id, "background-resume");
  }, {
    historyPath,
    snapshotsRoot,
    projectStatusPath,
    stateDbPath,
    contextWorkPackageBackgroundLauncher: (input) => {
      launched = input;
      return {
        status: "started",
        pid: 12345,
        output_path: input.output_path
      };
    }
  });
});

test("workbench server completes requirement intake only with verified provider completion authority", async () => {
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-requirement-provider-"));
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const inputPath = join(snapshotsRoot, "requirement-provider-input.json");
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
    latest: "requirement-provider",
    items: [
      {
        id: "requirement-provider",
        label: "Requirement provider",
        status: "pass",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }, null, 2));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/requirements?id=requirement-provider`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "需求链路使用 verified provider",
        surface_area: "workbench_frontend",
        problem_statement: "需求提交后的实现包必须由具备完成权限的执行器完成。",
        acceptance_criteria: "配置 verified provider executor 时，auto advance 可以完成 context work package。",
        constraints: "不能让 local bounded runner 写 completed。",
        generated_plan: generatedRequirementPlan(),
        auto_advance_after_plan_review: true,
        execution_cwd: isolatedExecutionCwd("workbench-requirement-provider-"),
        primary_worktree_path: process.cwd(),
        created_at: "2026-05-25T09:30:00.000Z",
        requirement_id: "requirement-provider-authorized"
      })
    });
    const payload = response.json();
    const savedHistory = JSON.parse(readFileSync(historyPath, "utf8"));
    const latestHistoryItem = savedHistory.items.find((entry) => entry.id === savedHistory.latest);
    const latestWorkflowState = JSON.parse(readFileSync(join(process.cwd(), latestHistoryItem.input_path), "utf8"));
    const contextRunArtifact = latestWorkflowState.artifact_ledger.artifacts
      .find((artifact) => artifact.metadata?.type === "context_work_packages_run");

    assert.equal(response.status, 201);
    assert.equal(payload.auto_advance.status, "created");
    assert.equal(payload.auto_advance.requirement_completion.status, "not_completed");
    assert.equal(payload.auto_advance.result.status, "pass");
    assert.equal(payload.auto_advance.result.phase, "iteration_limit_reached");
    assert.equal(payload.projection.next_action_readout.action, "run_context_work_packages");
    assert.equal(latestWorkflowState.manifest.work_packages[0].action, "execute_requirement_plan_step");
    assert.equal(latestWorkflowState.manifest.work_packages[0].status, "completed");
    assert.equal(contextRunArtifact.metadata.execution_profile, VERIFIED_PROVIDER_MULTI_AGENT_PROFILE);
    assert.equal(contextRunArtifact.metadata.completion_authority.allows_work_package_completion, true);
  }, {
    historyPath,
    snapshotsRoot,
    projectStatusPath,
    contextWorkPackageProviderExecutor: ({ selected_work_packages }) => ({
      status: "pass",
      completion_evidence: {
        kind: "provider_execution",
        summary: "verified provider completed requirement intake package"
      },
      package_results: selected_work_packages.map((workPackage) => ({
        work_package_id: workPackage.id,
        status: "pass",
        result: "pass",
        allows_work_package_completion: true,
        completion_authority: {
          allows_work_package_completion: true,
          authority: "verified_provider_executor",
          evidence_kind: "provider_execution",
          reason: "configured workbench provider executor completed requirement intake package"
        },
        completion_evidence: {
          kind: "package_completion",
          artifact_id: `requirement-provider-${workPackage.id}`
        }
      })),
      executor_provenance: {
        executor_kind: "configured_workbench_provider_executor",
        provider: "multi_provider",
        execution_mode: "provider_model_routed",
        execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
        external_calls: 2,
        deterministic: false
      }
    })
  });
});

test("workbench server closes requirement when all approved implementation packages finish", async () => {
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-requirement-closeout-"));
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const inputPath = join(snapshotsRoot, "requirement-closeout-input.json");
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
    latest: "requirement-closeout",
    items: [
      {
        id: "requirement-closeout",
        label: "Requirement closeout",
        status: "pass",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }, null, 2));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/requirements?id=requirement-closeout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "单步需求自动收口",
        surface_area: "workbench_frontend",
        problem_statement: "所有实施包完成后，任务流应自动显示完成。",
        generated_plan: generatedRequirementPlan({
          implementation_outline: ["完成实现并通过验证"]
        }),
        auto_advance_after_plan_review: true,
        execution_cwd: isolatedExecutionCwd("workbench-requirement-closeout-"),
        primary_worktree_path: process.cwd(),
        created_at: "2026-05-25T10:00:00.000Z",
        requirement_id: "requirement-auto-closeout"
      })
    });
    const payload = response.json();
    const savedHistory = JSON.parse(readFileSync(historyPath, "utf8"));
    const latestHistoryItem = savedHistory.items.find((entry) => entry.id === savedHistory.latest);
    const latestWorkflowState = JSON.parse(readFileSync(join(process.cwd(), latestHistoryItem.input_path), "utf8"));

    assert.equal(response.status, 201);
    assert.equal(payload.auto_advance.status, "created");
    assert.equal(payload.auto_advance.requirement_completion.status, "completed");
    assert.equal(payload.plan_review.phase, "completed");
    assert.equal(payload.projection.project_management.task_items[0].status, "completed");
    assert.equal(payload.projection.project_management.active_tasks, 0);
    assert.equal(latestWorkflowState.project_status.requirement_intake.items[0].status, "completed");
    assert.equal(latestWorkflowState.project_status.plan_reviews["requirement-auto-closeout"].phase, "completed");
    assert.equal(latestWorkflowState.project_status.requirement_intake.open_count, 0);
  }, {
    historyPath,
    snapshotsRoot,
    projectStatusPath,
    contextWorkPackageProviderExecutor: ({ selected_work_packages }) => ({
      status: "pass",
      completion_evidence: {
        kind: "provider_execution",
        summary: "verified provider completed the only approved package"
      },
      package_results: selected_work_packages.map((workPackage) => ({
        work_package_id: workPackage.id,
        status: "pass",
        result: "pass",
        allows_work_package_completion: true,
        completion_authority: {
          allows_work_package_completion: true,
          authority: "verified_provider_executor",
          evidence_kind: "provider_execution",
          reason: "configured workbench provider executor completed approved development package"
        },
        completion_evidence: {
          kind: "package_completion",
          artifact_id: `requirement-closeout-${workPackage.id}`
        }
      })),
      executor_provenance: {
        executor_kind: "configured_workbench_provider_executor",
        provider: "multi_provider",
        execution_mode: "provider_model_routed",
        execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
        external_calls: 1,
        deterministic: false
      }
    })
  });
});

test("workbench server can complete requirement intake through configured governed agent executor", async () => {
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-requirement-agent-executor-"));
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const inputPath = join(snapshotsRoot, "requirement-agent-executor-input.json");
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
    latest: "requirement-agent-executor",
    items: [
      {
        id: "requirement-agent-executor",
        label: "Requirement agent executor",
        status: "pass",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }, null, 2));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/requirements?id=requirement-agent-executor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "需求链路使用统一 agent 执行器",
        surface_area: "workbench_frontend",
        problem_statement: "需求提交后的实现包必须由项目内统一 agent 调用层完成。",
        acceptance_criteria: "配置 governed agent executor 时，auto advance 可以完成 context work package。",
        constraints: "不能让 local bounded runner 写 completed。",
        generated_plan: generatedRequirementPlan(),
        auto_advance_after_plan_review: true,
        execution_cwd: isolatedExecutionCwd("workbench-requirement-agent-executor-"),
        primary_worktree_path: process.cwd(),
        created_at: "2026-05-25T09:45:00.000Z",
        requirement_id: "requirement-agent-executor-authorized"
      })
    });
    const payload = response.json();
    const savedHistory = JSON.parse(readFileSync(historyPath, "utf8"));
    const latestHistoryItem = savedHistory.items.find((entry) => entry.id === savedHistory.latest);
    const latestWorkflowState = JSON.parse(readFileSync(join(process.cwd(), latestHistoryItem.input_path), "utf8"));
    const contextRunArtifact = latestWorkflowState.artifact_ledger.artifacts
      .find((artifact) => artifact.metadata?.type === "context_work_packages_run");

    assert.equal(response.status, 201);
    assert.equal(payload.auto_advance.status, "created");
    assert.equal(payload.auto_advance.requirement_completion.status, "not_completed");
    assert.equal(payload.auto_advance.result.status, "pass");
    assert.equal(latestWorkflowState.manifest.work_packages[0].status, "completed");
    assert.equal(contextRunArtifact.metadata.execution_profile, VERIFIED_PROVIDER_MULTI_AGENT_PROFILE);
    assert.equal(contextRunArtifact.metadata.executor_provenance.executor_kind, "agent_invocation_provider_executor");
    assert.equal(contextRunArtifact.metadata.executor_provenance.command_runner_kind, "spawn_sync");
    assert.equal(contextRunArtifact.metadata.package_results[0].completion_evidence.kind, "package_completion");
  }, {
    historyPath,
    snapshotsRoot,
    projectStatusPath,
    contextWorkPackageProviderExecutor: ({ selected_work_packages }) => ({
      status: "pass",
      completion_evidence: {
        kind: "provider_execution",
        summary: "governed agent invocation completed requirement implementation package"
      },
      package_results: selected_work_packages.map((workPackage) => ({
        work_package_id: workPackage.id,
        status: "pass",
        result: "pass",
        completion_evidence: {
          kind: "package_completion",
          artifact_id: `agent-executor-${workPackage.id}`
        }
      })),
      executor_provenance: {
        executor_kind: "agent_invocation_provider_executor",
        provider: "agent_invocation",
        execution_mode: "provider_model_routed",
        execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
        external_calls: 1,
        deterministic: false,
        command_runner_kind: "spawn_sync"
      }
    })
  });
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

test("workbench server only completes verified provider profile with configured executor", async () => {
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-provider-context-"));
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const inputPath = join(snapshotsRoot, "provider-context-input.json");
  writeFileSync(inputPath, JSON.stringify(providerContextWorkPackageWorkflowState(), null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "provider-context",
    items: [
      {
        id: "provider-context",
        label: "Provider context",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }, null, 2));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/context-work-packages-run?id=provider-context`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_package_count: 1,
        execution_mode: "provider_model_routed",
        execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
        provider_executor: "http-body-must-not-be-used",
        created_at: "2026-05-22T05:20:00.000Z"
      })
    });
    const rejected = response.json();
    const stateAfterRejected = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 409);
    assert.equal(rejected.error, "context work package run failed");
    assert.ok(rejected.issues.some((issue) => issue.code === "missing_provider_executor"));
    assert.notEqual(stateAfterRejected.manifest.work_packages[0].status, "completed");
    assert.equal(stateAfterRejected.artifact_ledger.artifacts.length, 0);
  }, {
    historyPath,
    snapshotsRoot,
    projectStatusPath: null,
    disableDefaultAgentProviderExecutor: true
  });

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/next-action?id=provider-context`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "run_context_work_packages",
        max_package_count: 1,
        execution_mode: "provider_model_routed",
        execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
        created_at: "2026-05-22T05:21:00.000Z"
      })
    });
    const created = response.json();
    const stateAfterCreated = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.status, "executed");
    assert.equal(created.result.status, "created");
    assert.equal(stateAfterCreated.manifest.work_packages[0].status, "completed");
    const contextRunArtifact = stateAfterCreated.artifact_ledger.artifacts
      .find((artifact) => artifact.metadata?.type === "context_work_packages_run");
    assert.equal(contextRunArtifact.metadata.execution_profile, VERIFIED_PROVIDER_MULTI_AGENT_PROFILE);
    assert.equal(contextRunArtifact.metadata.executor_provenance.external_calls, 2);
    assert.equal(contextRunArtifact.metadata.completion_authority.allows_work_package_completion, true);
  }, {
    historyPath,
    snapshotsRoot,
    projectStatusPath: null,
    contextWorkPackageProviderExecutor: ({ selected_work_packages }) => ({
      status: "pass",
      completion_evidence: {
        kind: "provider_execution",
        summary: "configured workbench executor completed provider context package"
      },
      package_results: selected_work_packages.map((workPackage) => ({
        work_package_id: workPackage.id,
        status: "pass",
        result: "pass",
        completion_evidence: {
          kind: "package_completion",
          artifact_id: `workbench-provider-${workPackage.id}`
        }
      })),
      executor_provenance: {
        executor_kind: "configured_workbench_provider_executor",
        provider: "multi_provider",
        execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
        external_calls: 2,
        deterministic: false
      }
    })
  });
});

test("workbench next action defaults requirement implementation packages to verified provider execution", async () => {
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-provider-default-"));
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const inputPath = join(snapshotsRoot, "provider-default-input.json");
  const workflowState = providerContextWorkPackageWorkflowState();
  workflowState.manifest.context_pack.subtasks[0].action = "continue_requirement_intake";
  workflowState.manifest.work_packages[0].action = "continue_requirement_intake";
  workflowState.task_dag[0].action = "continue_requirement_intake";
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "provider-default",
    items: [
      {
        id: "provider-default",
        label: "Provider default",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }, null, 2));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/next-action?id=provider-default`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "run_context_work_packages",
        max_package_count: 1,
        created_at: "2026-05-22T05:22:00.000Z"
      })
    });
    const created = response.json();
    const stateAfterCreated = JSON.parse(readFileSync(inputPath, "utf8"));
    const contextRunArtifact = stateAfterCreated.artifact_ledger.artifacts
      .find((artifact) => artifact.metadata?.type === "context_work_packages_run");

    assert.equal(response.status, 201);
    assert.equal(created.status, "executed");
    assert.equal(created.result.status, "created");
    assert.equal(contextRunArtifact.metadata.execution_mode, "provider_model_routed");
    assert.equal(contextRunArtifact.metadata.execution_profile, VERIFIED_PROVIDER_MULTI_AGENT_PROFILE);
    assert.equal(stateAfterCreated.manifest.work_packages[0].status, "completed");
  }, {
    historyPath,
    snapshotsRoot,
    projectStatusPath: null,
    contextWorkPackageProviderExecutor: ({ selected_work_packages }) => ({
      status: "pass",
      completion_evidence: {
        kind: "provider_execution",
        summary: "provider default completed broad requirement implementation package"
      },
      package_results: selected_work_packages.map((workPackage) => ({
        work_package_id: workPackage.id,
        status: "pass",
        result: "pass",
        completion_evidence: {
          kind: "package_completion",
          artifact_id: `provider-default-${workPackage.id}`
        }
      })),
      executor_provenance: {
        executor_kind: "configured_workbench_provider_executor",
        provider: "multi_provider",
        execution_mode: "provider_model_routed",
        execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
        external_calls: 2,
        deterministic: false
      }
    })
  });
});
