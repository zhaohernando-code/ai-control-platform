import assert from "node:assert/strict";
import test from "node:test";

import { VERIFIED_PROVIDER_MULTI_AGENT_PROFILE } from "../src/workflow/context-work-package-execution-adapter.js";
import { runContextWorkPackages } from "../src/workflow/context-work-package-runner.js";
import { workflowStateWithContextCycle } from "./helpers/context-work-package-runner.js";

test("context work package runner can complete already-satisfied packages before provider dispatch", () => {
  const workflowState = workflowStateWithContextCycle();
  const result = runContextWorkPackages(workflowState, {
    max_package_count: 1,
    created_at: "2026-05-22T04:02:00.000Z",
    execution_mode: "provider_model_routed",
    execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    already_satisfied_evaluator: ({ selected_work_packages: selectedWorkPackages }) => ({
      status: "pass",
      phase: "mainline_already_satisfied_preflight",
      allows_work_package_completion: true,
      completion_authority: {
        allows_work_package_completion: true,
        authority: "mainline_already_satisfied_preflight",
        evidence_kind: "focused_tests_and_mainline_commit",
        reason: "current mainline already satisfies the package"
      },
      executor_provenance: {
        executor_kind: "mainline_already_satisfied_preflight",
        execution_mode: "provider_model_routed",
        execution_profile: "mainline_already_satisfied_preflight"
      },
      package_results: selectedWorkPackages.map((workPackage) => ({
        work_package_id: workPackage.id,
        status: "pass",
        result: "already_satisfied_by_mainline",
        allows_work_package_completion: true,
        completion_authority: {
          allows_work_package_completion: true,
          authority: "mainline_already_satisfied_preflight",
          evidence_kind: "focused_tests_and_mainline_commit",
          reason: "current mainline already satisfies the package"
        },
        completion_evidence: { kind: "mainline_already_satisfied_preflight" }
      }))
    }),
    provider_executor: () => {
      throw new Error("provider should not run after already-satisfied preflight");
    }
  });

  assert.equal(result.status, "pass");
  assert.equal(result.phase, "context_work_packages_run");
  assert.equal(result.executed_count, 1);
  assert.equal(result.artifact.metadata.package_results[0].result, "already_satisfied_by_mainline");
  assert.equal(result.artifact.metadata.executor_provenance.executor_kind, "mainline_already_satisfied_preflight");
  assert.equal(result.workflow_state.manifest.work_packages.find((item) => item.id === "runtime").status, "completed");
});

test("context work package runner returns bounded mock simulation without completing packages", () => {
  const workflowState = workflowStateWithContextCycle();

  const result = runContextWorkPackages(workflowState, {
    max_package_count: 1,
    execution_mode: "provider_model_routed",
    execution_profile: "bounded_mock_multi_agent",
    codex_plan_pressure: true,
    risk: "high",
    budget_tier: "high",
    created_at: "2026-05-22T04:05:00.000Z"
  });

  assert.equal(result.status, "validated");
  assert.equal(result.phase, "simulated_execution");
  assert.equal(result.workflow_state, undefined);
  assert.equal(result.artifact, undefined);
  assert.equal(result.allows_work_package_completion, false);
  assert.equal(result.completion_authority.allows_work_package_completion, false);
  assert.equal(result.executor_provenance.executor_kind, "deterministic_mock_multi_agent");
  assert.equal(result.executor_provenance.external_calls, 0);
  assert.equal(result.package_results[0].status, "validated");
  assert.equal(result.package_results[0].result, "simulated_pass");
  assert.equal(result.package_results[0].allows_work_package_completion, false);
  assert.equal(result.package_results[0].work_package_id, "runtime");
  assert.equal(result.execution_plan.model_routing.strategy, "per_work_package_buildModelCollaborationPlan");
  assert.equal(result.execution_plan.model_routing.package_plans[0].work_package_id, "runtime");
  assert.ok(result.execution_plan.model_routing.package_plans[0].roles.some((role) => role.role === "process_guard"));
  assert.notEqual(workflowState.manifest.work_packages.find((item) => item.id === "runtime").status, "completed");
  assert.equal(workflowState.artifact_ledger.artifacts.some((artifact) => artifact.metadata?.execution_profile === "bounded_mock_multi_agent"), false);
  assert.ok(result.issues.some((item) => item.code === "simulation_has_no_completion_authority"));
});

test("context work package runner blocks explicit non-local identities without local fallback", () => {
  const cases = [
    {
      name: "unknown execution profile",
      options: { execution_profile: "real_provider_not_registered" },
      expectedStatus: "blocked",
      expectedIssue: "unsupported_execution_profile"
    },
    {
      name: "deterministic mock executor kind",
      options: { executor_kind: "deterministic_mock_multi_agent" },
      expectedStatus: "blocked",
      expectedIssue: "unsupported_execution_profile"
    },
    {
      name: "bounded mock adapter profile",
      options: { adapter_profile: "bounded_mock_multi_agent" },
      expectedStatus: "validated",
      expectedIssue: "simulation_has_no_completion_authority"
    }
  ];

  for (const item of cases) {
    const workflowState = workflowStateWithContextCycle();
    const result = runContextWorkPackages(workflowState, {
      max_package_count: 1,
      created_at: "2026-05-22T04:05:10.000Z",
      ...item.options
    });

    assert.equal(result.status, item.expectedStatus, item.name);
    assert.equal(result.workflow_state, undefined, item.name);
    assert.equal(result.artifact, undefined, item.name);
    assert.notEqual(
      workflowState.manifest.work_packages.find((workPackage) => workPackage.id === "runtime").status,
      "completed",
      item.name
    );
    assert.ok(result.issues.some((issue) => issue.code === item.expectedIssue), item.name);
  }
});

test("context work package runner blocks provider routed mode without supported adapter profile", () => {
  const workflowState = workflowStateWithContextCycle();

  const result = runContextWorkPackages(workflowState, {
    max_package_count: 1,
    execution_mode: "provider_model_routed",
    execution_profile: "real_provider_not_registered",
    created_at: "2026-05-22T04:06:00.000Z"
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.phase, "provider_model_routed_execution");
  assert.ok(result.issues.some((item) => item.code === "unsupported_execution_profile"));
  assert.notEqual(workflowState.manifest.work_packages.find((item) => item.id === "runtime")?.status, "completed");
  assert.equal(result.workflow_state, undefined);
});
