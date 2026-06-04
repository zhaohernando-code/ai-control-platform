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
  withServer,
  writeFileSync
} from "./helpers/workbench-server.js";

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
