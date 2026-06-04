import assert from "node:assert/strict";
import test from "node:test";

import {
  currentSessionWithoutRequirementPlanReview,
  generatedRequirementPlan,
  isolatedExecutionCwd,
  join,
  mkdtempSync,
  readFileSync,
  relative,
  request,
  VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
  withServer,
  writeFileSync
} from "./helpers/workbench-server.js";

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
