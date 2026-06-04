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
