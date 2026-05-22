import assert from "node:assert/strict";
import test from "node:test";

import {
  BOUNDED_MOCK_MULTI_AGENT_PROFILE,
  buildContextWorkPackageExecutionPlan,
  executeContextWorkPackagesWithAdapter,
  isProviderModelRoutedExecutionRequested,
  PROVIDER_MODEL_ROUTED_MODE,
  VERIFIED_PROVIDER_MULTI_AGENT_PROFILE
} from "../src/workflow/context-work-package-execution-adapter.js";

function workflowState() {
  return {
    manifest: {
      run_id: "run-adapter",
      cycle_id: "cycle-adapter",
      goal: "provider routed context work package execution",
      context_pack: {
        host: "platform_core",
        target_project_id: "ai-control-platform",
        requirement_summary: "wire provider routed adapters behind the fixed gate"
      }
    }
  };
}

const selectedPackages = [
  {
    id: "adapter-runtime",
    title: "Adapter runtime",
    owned_files: ["src/workflow/context-work-package-execution-adapter.js"],
    risk: "high",
    budget_tier: "high"
  }
];

test("provider/model routed execution is opt-in by mode or bounded mock profile", () => {
  assert.equal(isProviderModelRoutedExecutionRequested({}), false);
  assert.equal(isProviderModelRoutedExecutionRequested({ execution_profile: "local_bounded" }), false);
  assert.equal(
    isProviderModelRoutedExecutionRequested({
      execution_profile: BOUNDED_MOCK_MULTI_AGENT_PROFILE
    }),
    true
  );
  assert.equal(
    isProviderModelRoutedExecutionRequested({
      execution_mode: PROVIDER_MODEL_ROUTED_MODE,
      execution_profile: BOUNDED_MOCK_MULTI_AGENT_PROFILE
    }),
    true
  );
  assert.equal(
    isProviderModelRoutedExecutionRequested({
      execution_profile: "real_provider_not_registered"
    }),
    true
  );
  assert.equal(
    isProviderModelRoutedExecutionRequested({
      executor_kind: "deterministic_mock_multi_agent"
    }),
    true
  );
});

test("execution plan records model routing roles, reasons, budget, and risk", () => {
  const plan = buildContextWorkPackageExecutionPlan(workflowState(), selectedPackages, {
    execution_mode: PROVIDER_MODEL_ROUTED_MODE,
    execution_profile: BOUNDED_MOCK_MULTI_AGENT_PROFILE,
    codex_plan_pressure: true
  });

  assert.equal(plan.status, "pass");
  assert.equal(plan.execution_mode, PROVIDER_MODEL_ROUTED_MODE);
  assert.equal(plan.execution_profile, BOUNDED_MOCK_MULTI_AGENT_PROFILE);
  assert.equal(plan.model_routing.strategy, "per_work_package_buildModelCollaborationPlan");
  assert.equal(plan.model_routing.package_plans[0].risk, "high");
  assert.equal(plan.model_routing.package_plans[0].budget_tier, "high");
  assert.ok(plan.model_routing.package_plans[0].roles.some((role) => role.role === "process_guard"));
  assert.ok(plan.model_routing.package_plans[0].routing_reasons.some((reason) => reason.includes("budget=high")));
});

test("bounded mock multi-agent adapter validates without completion authority", () => {
  const result = executeContextWorkPackagesWithAdapter(workflowState(), selectedPackages, {
    execution_mode: PROVIDER_MODEL_ROUTED_MODE,
    execution_profile: BOUNDED_MOCK_MULTI_AGENT_PROFILE,
    created_at: "2026-05-22T05:00:00.000Z"
  });

  assert.equal(result.status, "validated");
  assert.equal(result.phase, "simulated_execution");
  assert.equal(result.allows_work_package_completion, false);
  assert.equal(result.completion_authority.allows_work_package_completion, false);
  assert.equal(result.package_results[0].status, "validated");
  assert.equal(result.package_results[0].result, "simulated_pass");
  assert.equal(result.package_results[0].allows_work_package_completion, false);
  assert.equal(result.package_results[0].completion_authority.allows_work_package_completion, false);
  assert.equal(result.package_results[0].work_package_id, "adapter-runtime");
  assert.equal(result.executor_provenance.execution_profile, BOUNDED_MOCK_MULTI_AGENT_PROFILE);
  assert.equal(result.executor_provenance.external_calls, 0);
  assert.equal(result.executor_provenance.deterministic, true);
  assert.ok(result.issues.some((item) => item.code === "simulation_has_no_completion_authority"));
});

test("provider/model routed execution blocks closed without a supported profile", () => {
  const missingProfile = buildContextWorkPackageExecutionPlan(workflowState(), selectedPackages, {
    execution_mode: PROVIDER_MODEL_ROUTED_MODE
  });
  assert.equal(missingProfile.status, "blocked");
  assert.ok(missingProfile.issues.some((item) => item.code === "missing_execution_profile"));

  const unknownProfile = executeContextWorkPackagesWithAdapter(workflowState(), selectedPackages, {
    execution_mode: PROVIDER_MODEL_ROUTED_MODE,
    execution_profile: "real_provider_not_registered"
  });
  assert.equal(unknownProfile.status, "blocked");
  assert.equal(unknownProfile.allows_work_package_completion, false);
  assert.equal(unknownProfile.completion_authority.allows_work_package_completion, false);
  assert.ok(unknownProfile.issues.some((item) => item.code === "unsupported_execution_profile"));
  assert.deepEqual(unknownProfile.package_results, []);
});

test("verified provider profile blocks closed without injected executor", () => {
  const result = executeContextWorkPackagesWithAdapter(workflowState(), selectedPackages, {
    execution_mode: PROVIDER_MODEL_ROUTED_MODE,
    execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    created_at: "2026-05-22T05:10:00.000Z"
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.phase, "provider_executor_required");
  assert.equal(result.allows_work_package_completion, false);
  assert.equal(result.completion_authority.allows_work_package_completion, false);
  assert.equal(result.executor_provenance, null);
  assert.deepEqual(result.package_results, []);
  assert.ok(result.issues.some((item) => item.code === "missing_provider_executor"));
});

test("verified provider profile blocks pass result without completion evidence and external-call provenance", () => {
  const result = executeContextWorkPackagesWithAdapter(workflowState(), selectedPackages, {
    execution_mode: PROVIDER_MODEL_ROUTED_MODE,
    execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    created_at: "2026-05-22T05:11:00.000Z",
    provider_executor: ({ selected_work_packages }) => ({
      status: "pass",
      package_results: selected_work_packages.map((workPackage) => ({
        work_package_id: workPackage.id,
        status: "pass"
      })),
      executor_provenance: {
        executor_kind: "claude_deepseek_provider_executor",
        execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
        external_calls: 0
      }
    })
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.phase, "provider_executor_result_validation");
  assert.equal(result.allows_work_package_completion, false);
  assert.equal(result.completion_authority.allows_work_package_completion, false);
  assert.equal(result.package_results[0].allows_work_package_completion, false);
  assert.equal(result.package_results[0].completion_authority.allows_work_package_completion, false);
  assert.ok(result.issues.some((item) => item.code === "missing_completion_evidence"));
  assert.ok(result.issues.some((item) => item.code === "missing_package_completion_evidence"));
  assert.ok(result.issues.some((item) => item.code === "missing_external_call_provenance"));
});

test("verified provider profile rejects fake command runner provenance", () => {
  const result = executeContextWorkPackagesWithAdapter(workflowState(), selectedPackages, {
    execution_mode: PROVIDER_MODEL_ROUTED_MODE,
    execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    created_at: "2026-05-22T05:11:30.000Z",
    provider_executor: ({ selected_work_packages }) => ({
      status: "pass",
      completion_evidence: {
        kind: "provider_execution",
        summary: "fake command runner must not become completion evidence"
      },
      package_results: selected_work_packages.map((workPackage) => ({
        work_package_id: workPackage.id,
        status: "pass",
        result: "pass",
        completion_evidence: {
          kind: "package_completion",
          artifact_id: `fake-runner-${workPackage.id}`
        }
      })),
      executor_provenance: {
        executor_kind: "claude_deepseek_provider_executor",
        provider: "deepseek",
        execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
        command_runner_kind: "fake_test_command_runner",
        external_calls: 1,
        deterministic: false
      }
    })
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.allows_work_package_completion, false);
  assert.equal(result.completion_authority.allows_work_package_completion, false);
  assert.equal(result.package_results[0].status, "pass");
  assert.equal(result.package_results[0].allows_work_package_completion, false);
  assert.equal(result.executor_provenance.command_runner_kind, "fake_test_command_runner");
  assert.ok(result.issues.some((item) => item.code === "non_external_command_runner_provenance_not_allowed"));
});

test("verified provider profile grants completion authority only for compliant executor evidence", () => {
  const result = executeContextWorkPackagesWithAdapter(workflowState(), selectedPackages, {
    execution_mode: PROVIDER_MODEL_ROUTED_MODE,
    execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    created_at: "2026-05-22T05:12:00.000Z",
    provider_executor: ({ selected_work_packages }) => ({
      status: "pass",
      completion_evidence: {
        kind: "provider_execution",
        summary: "real provider executor completed selected context work package"
      },
      package_results: selected_work_packages.map((workPackage) => ({
        work_package_id: workPackage.id,
        status: "pass",
        result: "pass",
        completion_evidence: {
          kind: "package_completion",
          artifact_id: `provider-completion-${workPackage.id}`
        }
      })),
      executor_provenance: {
        executor_kind: "claude_deepseek_gpt_provider_executor",
        provider: "multi_provider",
        execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
        external_calls: 2,
        deterministic: false
      }
    })
  });

  assert.equal(result.status, "pass");
  assert.equal(result.phase, "provider_executor_completed");
  assert.equal(result.allows_work_package_completion, true);
  assert.equal(result.completion_authority.allows_work_package_completion, true);
  assert.equal(result.completion_authority.evidence_kind, "real_provider_execution");
  assert.equal(result.executor_provenance.execution_profile, VERIFIED_PROVIDER_MULTI_AGENT_PROFILE);
  assert.equal(result.executor_provenance.external_calls, 2);
  assert.equal(result.package_results[0].status, "pass");
  assert.equal(result.package_results[0].allows_work_package_completion, true);
  assert.equal(result.package_results[0].completion_authority.allows_work_package_completion, true);
  assert.equal(result.execution_plan.model_routing.strategy, "per_work_package_buildModelCollaborationPlan");
});
