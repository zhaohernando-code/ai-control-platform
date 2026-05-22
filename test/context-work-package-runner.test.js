import assert from "node:assert/strict";
import test from "node:test";

import { materializeContextPackCycleFromWorkflowState } from "../src/workflow/context-pack-cycle.js";
import { VERIFIED_PROVIDER_MULTI_AGENT_PROFILE } from "../src/workflow/context-work-package-execution-adapter.js";
import { runContextWorkPackages } from "../src/workflow/context-work-package-runner.js";
import {
  prepareContinuationFromProjectStatus,
  recordProjectStatusContinuationPrepared
} from "../src/workflow/project-status-continuation.js";
import { createWorkbenchProjection } from "../src/workflow/workbench-projection.js";

function workflowStateWithContextCycle() {
  const workflowState = {
    manifest: {
      run_id: "run-context-work",
      cycle_id: "cycle-source",
      goal: "source",
      context_pack: {
        requirement_summary: "中台工作台 source",
        host: "platform_core",
        target_project_id: "ai-control-platform",
        non_goals: ["不修改业务项目"],
        forbidden_actions: ["不得越过 owned_files"],
        owned_files: ["src/workflow/context-work-package-runner.js", "test/context-work-package-runner.test.js"],
        acceptance_gates: ["node --test test/context-work-package-runner.test.js"],
        rollback_conditions: ["runner 状态不一致"],
        subtasks: [{ id: "source", owned_files: ["src/workflow/context-work-package-runner.js"] }]
      },
      work_packages: [{ id: "source", title: "Source", status: "completed", owned_files: ["src/workflow/context-work-package-runner.js"] }],
      events: [],
      artifacts: [],
      gate_results: [],
      review_findings: [],
      recovery_attempts: []
    },
    artifact_ledger: {
      run_id: "run-context-work",
      cycle_id: "cycle-source",
      artifacts: []
    },
    model_plan: {
      selected_model: "deepseek-v4-flash",
      routes: []
    },
    reviewer_gate: { findings: [] }
  };
  const prepared = prepareContinuationFromProjectStatus({
    project: "ai-control-platform",
    status: "in_progress",
    blockers: [],
    next_step: "",
    global_goals: [
      {
        id: "context-work",
        title: "Context work",
        status: "in_progress",
        next_step: "中台工作台 run context work packages.",
        next_work_packages: [
          {
            id: "runtime",
            title: "Runtime",
            owned_files: ["src/workflow/context-work-package-runner.js"]
          },
          {
            id: "tests",
            title: "Tests",
            owned_files: ["test/context-work-package-runner.test.js"],
            depends_on: ["runtime"]
          }
        ]
      }
    ]
  }, { workflow_state: workflowState });
  const recorded = recordProjectStatusContinuationPrepared(workflowState, prepared, {
    created_at: "2026-05-22T04:00:00.000Z"
  });
  return materializeContextPackCycleFromWorkflowState(recorded.workflow_state, {
    cycle_id: "cycle-context-work",
    created_at: "2026-05-22T04:01:00.000Z"
  }).workflow_state;
}

test("context work package runner executes dispatchable packages and updates workflow state", () => {
  const workflowState = workflowStateWithContextCycle();
  const first = runContextWorkPackages(workflowState, {
    max_package_count: 1,
    created_at: "2026-05-22T04:02:00.000Z"
  });

  assert.equal(first.status, "pass");
  assert.equal(first.executed_count, 1);
  assert.equal(first.executed_work_packages[0].id, "runtime");
  assert.equal(first.workflow_state.manifest.work_packages.find((item) => item.id === "runtime").status, "completed");
  assert.equal(first.workflow_state.manifest.events.at(-1).type, "context_work_packages_run");
  assert.equal(first.artifact.metadata.fixed_development_mode_gate.status, "pass");
  assert.equal(first.artifact.metadata.fixed_development_mode_gate.gate_id, "fixed-development-mode-dispatch");
  assert.equal(first.artifact.metadata.execution_profile, "local_bounded");
  assert.deepEqual(first.artifact.metadata.package_results, []);
  assert.equal(first.artifact.metadata.executor_provenance.executor_kind, "local_bounded");
  assert.equal(first.workflow_state.manifest.gate_results.at(-1).gate_id, "fixed-development-mode-dispatch");
  assert.equal(first.workflow_state.artifact_ledger.artifacts.at(-1).metadata.executed_work_package_ids[0], "runtime");

  const projection = createWorkbenchProjection(first.workflow_state);
  assert.equal(projection.next_action_readout.action, "run_context_work_packages");
  assert.equal(projection.next_action_readout.status, "ready");
});

test("context work package runner blocks when no packages can dispatch", () => {
  const workflowState = workflowStateWithContextCycle();
  workflowState.manifest.work_packages = workflowState.manifest.work_packages.map((workPackage) => ({
    ...workPackage,
    status: "completed"
  }));
  workflowState.task_dag = workflowState.manifest.work_packages;

  const result = runContextWorkPackages(workflowState);

  assert.equal(result.status, "blocked");
  assert.ok(result.issues.some((issue) => issue.code === "no_dispatchable_work_packages"));
});

test("context work package runner blocks managed project paths before completion", () => {
  const workflowState = workflowStateWithContextCycle();
  const forbiddenOwnedFiles = ["../stock_dashboard/src/runner.js"];
  workflowState.manifest.context_pack.owned_files = forbiddenOwnedFiles;
  workflowState.manifest.context_pack.subtasks = [{ id: "runtime", owned_files: forbiddenOwnedFiles }];
  workflowState.manifest.work_packages = [
    {
      id: "runtime",
      title: "Runtime",
      status: "pending",
      owned_files: forbiddenOwnedFiles
    }
  ];
  workflowState.task_dag = workflowState.manifest.work_packages;
  const eventCountBefore = workflowState.manifest.events.length;
  const artifactCountBefore = workflowState.artifact_ledger.artifacts.length;

  const result = runContextWorkPackages(workflowState, {
    max_package_count: 1,
    created_at: "2026-05-22T04:03:00.000Z"
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.phase, "fixed_development_mode_gate");
  assert.equal(result.gate_result.gate_id, "fixed-development-mode-dispatch");
  assert.ok(result.issues.some((item) => item.code === "fixed_mode_managed_project_owned_file"));
  assert.equal(workflowState.manifest.work_packages[0].status, "pending");
  assert.equal(workflowState.manifest.events.length, eventCountBefore);
  assert.equal(workflowState.artifact_ledger.artifacts.length, artifactCountBefore);
  assert.equal(result.workflow_state, undefined);
});

test("context work package runner blocks fixed gate before provider routed adapter", () => {
  const workflowState = workflowStateWithContextCycle();
  const forbiddenOwnedFiles = ["../lobechat/app/page.tsx"];
  workflowState.manifest.context_pack.owned_files = forbiddenOwnedFiles;
  workflowState.manifest.context_pack.subtasks = [{ id: "runtime", owned_files: forbiddenOwnedFiles }];
  workflowState.manifest.work_packages = [
    {
      id: "runtime",
      title: "Runtime",
      status: "pending",
      owned_files: forbiddenOwnedFiles
    }
  ];
  workflowState.task_dag = workflowState.manifest.work_packages;

  const result = runContextWorkPackages(workflowState, {
    max_package_count: 1,
    execution_mode: "provider_model_routed",
    execution_profile: "bounded_mock_multi_agent",
    created_at: "2026-05-22T04:04:00.000Z"
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.phase, "fixed_development_mode_gate");
  assert.equal(result.execution_plan, undefined);
  assert.equal(workflowState.manifest.work_packages[0].status, "pending");
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
