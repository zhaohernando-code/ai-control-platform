import assert from "node:assert/strict";
import test from "node:test";

import {
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
