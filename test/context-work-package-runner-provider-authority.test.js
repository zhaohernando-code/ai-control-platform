import assert from "node:assert/strict";
import test from "node:test";

import { VERIFIED_PROVIDER_MULTI_AGENT_PROFILE } from "../src/workflow/context-work-package-execution-adapter.js";
import { runContextWorkPackages } from "../src/workflow/context-work-package-runner.js";
import { workflowStateWithContextCycle } from "./helpers/context-work-package-runner.js";

test("context work package runner only completes provider results with completion authority", () => {
  const workflowState = workflowStateWithContextCycle();

  const validatedWithAuthority = runContextWorkPackages(workflowState, {
    max_package_count: 1,
    execution_mode: "provider_model_routed",
    execution_profile: "bounded_mock_multi_agent",
    created_at: "2026-05-22T04:05:15.000Z",
    adapter_executor: (_state, selected) => ({
      status: "validated",
      phase: "simulated_execution",
      allows_work_package_completion: true,
      completion_authority: {
        allows_work_package_completion: true,
        authority: "verified_provider_executor",
        evidence_kind: "real_execution",
        reason: "test adapter has executor authority"
      },
      execution_plan: {
        model_routing: { strategy: "test", package_plans: [] }
      },
      package_results: [{
        work_package_id: selected[0].id,
        status: "pass",
        allows_work_package_completion: true
      }],
      executor_provenance: {
        executor_kind: "verified_provider_executor",
        execution_mode: "provider_model_routed",
        execution_profile: "verified_provider",
        external_calls: 1
      },
      issues: []
    })
  });

  assert.equal(validatedWithAuthority.status, "validated");
  assert.ok(validatedWithAuthority.issues.some((item) => item.code === "adapter_result_not_completed"));
  assert.notEqual(workflowState.manifest.work_packages.find((item) => item.id === "runtime").status, "completed");

  const withoutPackageAuthority = runContextWorkPackages(workflowState, {
    max_package_count: 1,
    execution_mode: "provider_model_routed",
    execution_profile: "bounded_mock_multi_agent",
    created_at: "2026-05-22T04:05:30.000Z",
    adapter_executor: (_state, selected) => ({
      status: "pass",
      phase: "adapter_execution",
      allows_work_package_completion: true,
      completion_authority: {
        allows_work_package_completion: true,
        authority: "verified_provider_executor",
        evidence_kind: "real_execution",
        reason: "test adapter has executor authority"
      },
      execution_plan: {
        model_routing: { strategy: "test", package_plans: [] }
      },
      package_results: [{
        work_package_id: selected[0].id,
        status: "pass",
        allows_work_package_completion: false
      }],
      executor_provenance: {
        executor_kind: "verified_provider_executor",
        execution_mode: "provider_model_routed",
        execution_profile: "verified_provider",
        external_calls: 1
      },
      issues: []
    })
  });

  assert.equal(withoutPackageAuthority.status, "blocked");
  assert.ok(withoutPackageAuthority.issues.some((item) => item.code === "no_completion_authorized_package_results"));
  assert.notEqual(workflowState.manifest.work_packages.find((item) => item.id === "runtime").status, "completed");

  const withAuthority = runContextWorkPackages(workflowState, {
    max_package_count: 1,
    execution_mode: "provider_model_routed",
    execution_profile: "bounded_mock_multi_agent",
    created_at: "2026-05-22T04:05:45.000Z",
    adapter_executor: (_state, selected) => ({
      status: "pass",
      phase: "adapter_execution",
      allows_work_package_completion: true,
      completion_authority: {
        allows_work_package_completion: true,
        authority: "verified_provider_executor",
        evidence_kind: "real_execution",
        reason: "test adapter has executor authority"
      },
      execution_plan: {
        model_routing: { strategy: "test", package_plans: [] }
      },
      package_results: [{
        work_package_id: selected[0].id,
        status: "pass",
        allows_work_package_completion: true,
        completion_authority: {
          allows_work_package_completion: true,
          authority: "verified_provider_executor",
          evidence_kind: "real_execution",
          reason: "package result has verified completion evidence"
        }
      }],
      executor_provenance: {
        executor_kind: "verified_provider_executor",
        execution_mode: "provider_model_routed",
        execution_profile: "verified_provider",
        external_calls: 1
      },
      issues: []
    })
  });

  assert.equal(withAuthority.status, "pass");
  assert.equal(withAuthority.executed_count, 1);
  assert.equal(withAuthority.workflow_state.manifest.work_packages.find((item) => item.id === "runtime").status, "completed");
  assert.equal(withAuthority.artifact.metadata.execution_profile, "verified_provider");
  assert.equal(withAuthority.artifact.metadata.completion_authority.allows_work_package_completion, true);
});

test("context work package runner completes verified provider profile with durable provenance and authority", () => {
  const workflowState = workflowStateWithContextCycle();

  const result = runContextWorkPackages(workflowState, {
    max_package_count: 1,
    execution_mode: "provider_model_routed",
    execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    created_at: "2026-05-22T04:06:30.000Z",
    provider_executor: ({ selected_work_packages }) => ({
      status: "pass",
      completion_evidence: {
        kind: "provider_execution",
        summary: "verified provider executor completed selected package"
      },
      package_results: selected_work_packages.map((workPackage) => ({
        work_package_id: workPackage.id,
        status: "pass",
        result: "pass",
        completion_evidence: {
          kind: "package_completion",
          artifact_id: `provider-package-${workPackage.id}`
        }
      })),
      executor_provenance: {
        executor_kind: "gpt_deepseek_claude_provider_executor",
        provider: "multi_provider",
        execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
        external_calls: 3,
        deterministic: false
      }
    })
  });

  assert.equal(result.status, "pass");
  assert.equal(result.executed_count, 1);
  assert.equal(result.workflow_state.manifest.work_packages.find((item) => item.id === "runtime").status, "completed");
  assert.equal(result.artifact.metadata.execution_mode, "provider_model_routed");
  assert.equal(result.artifact.metadata.execution_profile, VERIFIED_PROVIDER_MULTI_AGENT_PROFILE);
  assert.equal(result.artifact.metadata.executor_provenance.executor_kind, "gpt_deepseek_claude_provider_executor");
  assert.equal(result.artifact.metadata.executor_provenance.external_calls, 3);
  assert.equal(result.artifact.metadata.completion_authority.allows_work_package_completion, true);
  assert.equal(result.artifact.metadata.package_results[0].allows_work_package_completion, true);
  assert.equal(result.artifact.metadata.model_routing.strategy, "per_work_package_buildModelCollaborationPlan");
});
