import assert from "node:assert/strict";
import test from "node:test";

import { VERIFIED_PROVIDER_MULTI_AGENT_PROFILE } from "../src/workflow/context-work-package-execution-adapter.js";
import {
  markContextWorkPackageDispatchFailed,
  runContextWorkPackages,
  stageContextWorkPackageDispatch
} from "../src/workflow/context-work-package-runner.js";
import { createRunManifest } from "../src/workflow/run-manifest.js";
import {
  workflowStateWithContextCycle,
  workflowStateWithRetryAgentWorker
} from "./helpers/context-work-package-runner.js";
import { createWorkbenchProjection } from "../src/workflow/workbench-projection.js";

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
  assert.ok(first.workflow_state.manifest.events.some((event) => event.type === "context_work_packages_run"));
  assert.equal(first.artifact.metadata.fixed_development_mode_gate.status, "pass");
  assert.equal(first.artifact.metadata.fixed_development_mode_gate.gate_id, "fixed-development-mode-dispatch");
  assert.equal(first.artifact.metadata.execution_profile, "local_bounded");
  assert.deepEqual(first.artifact.metadata.package_results, []);
  assert.equal(first.artifact.metadata.executor_provenance.executor_kind, "local_bounded");
  assert.equal(first.agent_lifecycle_facts.length, 6);
  assert.equal(first.retry_agent_worker_facts.length, 0);
  assert.equal(first.workflow_state.manifest.gate_results.at(-1).gate_id, "fixed-development-mode-dispatch");
  assert.equal(
    first.workflow_state.artifact_ledger.artifacts
      .find((artifact) => artifact.metadata?.type === "context_work_packages_run")
      .metadata.executed_work_package_ids[0],
    "runtime"
  );
  const eventTypes = first.workflow_state.manifest.events.map((event) => event.type);
  assert.ok(eventTypes.includes("WorkerSpawned"));
  assert.ok(eventTypes.includes("WorkerHeartbeat"));
  assert.ok(eventTypes.includes("WorkerCompleted"));
  assert.ok(eventTypes.includes("WorkerEvaluation"));
  assert.ok(eventTypes.includes("WorkerClosed"));
  assert.ok(eventTypes.includes("PoolIterationClosed"));

  const projection = createWorkbenchProjection(first.workflow_state);
  assert.equal(projection.agent_lifecycle_pool.pool_id, "context-work-package-run-context-work-cycle-context-work");
  assert.equal(projection.agent_lifecycle_pool.status, "pass");
  assert.equal(projection.agent_lifecycle_pool.spawned, 1);
  assert.equal(projection.agent_lifecycle_pool.heartbeat_count, 1);
  assert.equal(projection.agent_lifecycle_pool.completed, 1);
  assert.equal(projection.agent_lifecycle_pool.evaluated, 1);
  assert.equal(projection.agent_lifecycle_pool.closed, 1);
  assert.equal(projection.agent_lifecycle_pool.iteration_closed, true);
  assert.equal(projection.agent_lifecycle_pool.open, 0);
  assert.equal(projection.agent_lifecycle_pool.unevaluated, 0);
  assert.equal(projection.agent_lifecycle_pool.unclosed, 0);
  assert.notEqual(projection.next_action_readout.action, "cleanup_agent_lifecycle_pool");
});

test("context work package runner splits materialized broad frontend view migration before execution", () => {
  const contextPack = {
    requirement_summary: "前端重构",
    host: "platform_core",
    target_project_id: "ai-control-platform",
    non_goals: ["Do not modify managed projects"],
    forbidden_actions: ["Do not skip gates"],
    owned_files: ["."],
    acceptance_gates: ["npm run check:workbench:browser-events"],
    rollback_conditions: ["frontend migration drifts"],
    subtasks: [
      {
        id: "requirement-frontend-refactor-plan-step-03",
        title: "前端重构：实施步骤 03 / 7",
        action: "execute_requirement_plan_step",
        owned_files: ["PROJECT_RULES.md"],
        acceptance_gates: ["node --test test/workbench-shell.test.js"],
        reason: "固化 antd + Next.js 约束",
        source: {
          requirement_id: "requirement-frontend-refactor",
          plan_step_index: 3,
          plan_step_total: 7
        }
      },
      {
        id: "requirement-frontend-refactor-plan-step-04",
        title: "前端重构：实施步骤 04 / 7",
        action: "execute_requirement_plan_step",
        owned_files: ["."],
        acceptance_gates: ["npm run check:workbench:browser-events"],
        depends_on: ["requirement-frontend-refactor-plan-step-03"],
        reason: "按视图切片迁移：优先迁移高频核心视图（如工作台主页、需求录入、计划审核），每个切片以独立 PR 落地，并保持旧入口可回退。",
        source: {
          requirement_id: "requirement-frontend-refactor",
          plan_step_index: 4,
          plan_step_total: 7,
          constraints: "当前中台的所有前端代码，都用antd作为ui框架、react+next.js(app模式) 作为项目框架进行重构。",
          implementation_step: "按视图切片迁移：优先迁移高频核心视图（如工作台主页、需求录入、计划审核），每个切片以独立 PR 落地，并保持旧入口可回退。"
        }
      },
      {
        id: "requirement-frontend-refactor-plan-step-05",
        title: "前端重构：实施步骤 05 / 7",
        action: "execute_requirement_plan_step",
        owned_files: ["apps/workbench"],
        acceptance_gates: ["node --test test/frontend-acceptance.test.js"],
        depends_on: ["requirement-frontend-refactor-plan-step-04"],
        reason: "补齐新前端交互",
        source: {
          requirement_id: "requirement-frontend-refactor",
          plan_step_index: 5,
          plan_step_total: 7
        }
      }
    ]
  };
  const manifest = createRunManifest({
    run_id: "run-frontend-slice",
    cycle_id: "cycle-frontend-slice",
    goal: contextPack.requirement_summary,
    context_pack: contextPack,
    events: [],
    artifacts: [],
    gate_results: [],
    review_findings: [],
    recovery_attempts: [],
    created_at: "2026-05-26T14:00:00.000Z"
  });
  const workflowState = {
    manifest: {
      ...manifest,
      work_packages: manifest.work_packages.map((workPackage) => workPackage.id === "requirement-frontend-refactor-plan-step-03"
        ? { ...workPackage, status: "completed", result: "pass" }
        : workPackage)
    },
    artifact_ledger: {
      run_id: manifest.run_id,
      cycle_id: manifest.cycle_id,
      artifacts: []
    },
    task_dag: manifest.work_packages.map((workPackage) => workPackage.id === "requirement-frontend-refactor-plan-step-03"
      ? { ...workPackage, status: "completed", result: "pass" }
      : workPackage)
  };

  const result = runContextWorkPackages(workflowState, {
    max_package_count: 1,
    created_at: "2026-05-26T14:01:00.000Z"
  });

  assert.equal(result.status, "pass");
  assert.equal(result.artifact.metadata.work_package_execution_governance.status, "pass");
  assert.equal(result.executed_work_packages[0].id, "requirement-frontend-refactor-plan-step-04-workbench-home");
  assert.equal(
    result.workflow_state.manifest.work_packages
      .find((workPackage) => workPackage.id === "requirement-frontend-refactor-plan-step-04-workbench-home")
      .status,
    "completed"
  );
  assert.ok(result.workflow_state.manifest.work_packages.some((workPackage) => {
    return workPackage.id === "requirement-frontend-refactor-plan-step-04-requirement-intake" &&
      workPackage.depends_on[0] === "requirement-frontend-refactor-plan-step-04-workbench-home";
  }));
  assert.ok(result.workflow_state.manifest.work_packages.some((workPackage) => {
    return workPackage.id === "requirement-frontend-refactor-plan-step-05" &&
      workPackage.depends_on[0] === "requirement-frontend-refactor-plan-step-04-plan-review";
  }));
  assert.ok(!result.workflow_state.manifest.work_packages.some((workPackage) => {
    return workPackage.id === "requirement-frontend-refactor-plan-step-04";
  }));
});

test("context work package runner blocks broad unsliced requirement plan steps before child execution", () => {
  const contextPack = {
    requirement_summary: "前端重构",
    host: "platform_core",
    target_project_id: "ai-control-platform",
    non_goals: ["Do not modify managed projects"],
    forbidden_actions: ["Do not skip gates"],
    owned_files: ["."],
    acceptance_gates: ["node --test test/context-work-package-runner.test.js"],
    rollback_conditions: ["frontend migration drifts"],
    subtasks: [
      {
        id: "requirement-frontend-refactor-plan-step-broad",
        title: "前端重构：整体迁移所有前端入口",
        action: "execute_requirement_plan_step",
        owned_files: ["."],
        acceptance_gates: ["node --test test/frontend-acceptance.test.js"],
        reason: "整体迁移所有前端代码到 React + Next.js + antd。",
        source: {
          requirement_id: "requirement-frontend-refactor",
          plan_step_index: 4,
          implementation_step: "整体迁移所有前端代码到 React + Next.js + antd。",
          execution_governance: {
            version: "work-package-execution-governance.v1",
            granularity: "bounded_slice",
            decomposition: {
              required: true,
              status: "pending"
            },
            verification: {
              required: true,
              status: "defined",
              gate_count: 1
            }
          }
        }
      }
    ]
  };
  const manifest = createRunManifest({
    run_id: "run-broad-governance",
    cycle_id: "cycle-broad-governance",
    goal: contextPack.requirement_summary,
    context_pack: contextPack,
    events: [],
    artifacts: [],
    gate_results: [],
    review_findings: [],
    recovery_attempts: [],
    created_at: "2026-05-26T15:00:00.000Z"
  });
  const workflowState = {
    manifest,
    artifact_ledger: {
      run_id: manifest.run_id,
      cycle_id: manifest.cycle_id,
      artifacts: []
    },
    task_dag: manifest.work_packages
  };

  const result = runContextWorkPackages(workflowState, {
    max_package_count: 1,
    created_at: "2026-05-26T15:01:00.000Z"
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.phase, "work_package_execution_governance");
  assert.equal(result.work_package_execution_governance.status, "fail");
  assert.ok(result.issues.some((issue) => {
    return issue.code === "requirement_plan_step_requires_manager_decomposition";
  }));
  assert.equal(result.allows_work_package_completion, false);
});

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

test("context work package runner executes retry_agent_worker by recording a closed lifecycle chain", () => {
  const workflowState = workflowStateWithRetryAgentWorker();
  const result = runContextWorkPackages(workflowState, {
    max_package_count: 1,
    created_at: "2026-05-22T09:01:00.000Z"
  });
  const eventTypes = result.workflow_state.manifest.events.map((event) => event.type);
  const projection = createWorkbenchProjection(result.workflow_state);

  assert.equal(result.status, "pass");
  assert.equal(result.executed_count, 1);
  assert.equal(result.workflow_state.manifest.work_packages[0].status, "completed");
  assert.equal(result.agent_lifecycle_facts.length, 6);
  assert.equal(result.retry_agent_worker_facts.length, 6);
  assert.ok(eventTypes.includes("WorkerSpawned"));
  assert.ok(eventTypes.includes("WorkerHeartbeat"));
  assert.ok(eventTypes.includes("WorkerCompleted"));
  assert.ok(eventTypes.includes("WorkerEvaluation"));
  assert.ok(eventTypes.includes("WorkerClosed"));
  assert.ok(eventTypes.includes("PoolIterationClosed"));
  assert.equal(projection.agent_lifecycle_pool.pool_id, "pool-main-child");
  assert.equal(projection.agent_lifecycle_pool.spawned, 1);
  assert.equal(projection.agent_lifecycle_pool.heartbeat_count, 1);
  assert.equal(projection.agent_lifecycle_pool.completed, 1);
  assert.equal(projection.agent_lifecycle_pool.evaluated, 1);
  assert.equal(projection.agent_lifecycle_pool.closed, 1);
  assert.equal(projection.agent_lifecycle_pool.iteration_closed, true);
  assert.equal(projection.agent_lifecycle_pool.open, 0);
  assert.equal(projection.agent_lifecycle_pool.unevaluated, 0);
  assert.equal(projection.agent_lifecycle_pool.unclosed, 0);
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

test("context work package dispatch can be staged as running before background provider execution", () => {
  const workflowState = workflowStateWithContextCycle();

  const staged = stageContextWorkPackageDispatch(workflowState, {
    max_package_count: 1,
    execution_mode: "provider_model_routed",
    execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    dispatch_run_id: "dispatch-running-001",
    created_at: "2026-05-28T13:30:00.000Z"
  });

  assert.equal(staged.status, "pass");
  assert.equal(staged.phase, "context_work_packages_dispatch_started");
  assert.deepEqual(staged.selected_work_package_ids, ["runtime"]);
  const runtime = staged.workflow_state.manifest.work_packages.find((item) => item.id === "runtime");
  assert.equal(runtime.status, "running");
  assert.equal(runtime.result, "dispatch_started");
  assert.equal(runtime.dispatch_run_id, "dispatch-running-001");
  assert.ok(staged.workflow_state.manifest.events.some((event) => event.type === "context_work_packages_dispatch_started"));
});

test("context work package dispatch scopes implicit selection by requirement id", () => {
  const workflowState = workflowStateWithContextCycle();
  const workPackages = [
    {
      id: "task-a-package",
      title: "Task A package",
      status: "pending",
      owned_files: ["src/workflow/context-work-package-runner.js"],
      acceptance_gates: ["node --test test/context-work-package-runner.test.js"],
      source: { requirement_id: "task-a" }
    },
    {
      id: "task-b-package",
      title: "Task B package",
      status: "pending",
      owned_files: ["test/context-work-package-runner.test.js"],
      acceptance_gates: ["node --test test/context-work-package-runner.test.js"],
      source: { requirement_id: "task-b" }
    }
  ];
  workflowState.manifest.work_packages = workPackages;
  workflowState.manifest.context_pack.subtasks = workPackages;
  workflowState.task_dag = workPackages;

  const staged = stageContextWorkPackageDispatch(workflowState, {
    requirement_id: "task-b",
    max_package_count: 1,
    execution_mode: "provider_model_routed",
    execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    dispatch_run_id: "dispatch-task-b-001",
    created_at: "2026-05-28T13:30:30.000Z"
  });

  assert.equal(staged.status, "pass");
  assert.deepEqual(staged.selected_work_package_ids, ["task-b-package"]);
  assert.equal(
    staged.workflow_state.manifest.work_packages.find((item) => item.id === "task-a-package").status,
    "pending"
  );
  assert.equal(
    staged.workflow_state.manifest.work_packages.find((item) => item.id === "task-b-package").status,
    "running"
  );
});

test("context work package dispatch does not fall back to another requirement", () => {
  const workflowState = workflowStateWithContextCycle();
  const workPackages = [{
    id: "task-a-package",
    title: "Task A package",
    status: "pending",
    owned_files: ["src/workflow/context-work-package-runner.js"],
    acceptance_gates: ["node --test test/context-work-package-runner.test.js"],
    source: { requirement_id: "task-a" }
  }];
  workflowState.manifest.work_packages = workPackages;
  workflowState.manifest.context_pack.subtasks = workPackages;
  workflowState.task_dag = workPackages;

  const staged = stageContextWorkPackageDispatch(workflowState, {
    requirement_id: "task-b",
    max_package_count: 1,
    execution_mode: "provider_model_routed",
    execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    dispatch_run_id: "dispatch-task-b-empty-001",
    created_at: "2026-05-28T13:30:40.000Z"
  });

  assert.equal(staged.status, "blocked");
  assert.equal(staged.phase, "no_dispatchable_work_packages");
  assert.ok(staged.issues.some((item) => item.code === "no_dispatchable_work_packages"));
});

test("context work package runner can complete a staged running package by explicit id", () => {
  const workflowState = workflowStateWithContextCycle();
  const staged = stageContextWorkPackageDispatch(workflowState, {
    max_package_count: 1,
    execution_mode: "provider_model_routed",
    execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    dispatch_run_id: "dispatch-complete-001",
    created_at: "2026-05-28T13:31:00.000Z"
  });

  const result = runContextWorkPackages(staged.workflow_state, {
    selected_work_package_ids: staged.selected_work_package_ids,
    execution_mode: "provider_model_routed",
    execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    created_at: "2026-05-28T13:32:00.000Z",
    provider_executor: ({ selected_work_packages }) => ({
      status: "pass",
      completion_evidence: {
        kind: "provider_execution",
        summary: "background provider completed staged package"
      },
      package_results: selected_work_packages.map((workPackage) => ({
        work_package_id: workPackage.id,
        status: "pass",
        result: "pass",
        completion_evidence: {
          kind: "package_completion",
          artifact_id: `background-${workPackage.id}`
        }
      })),
      executor_provenance: {
        executor_kind: "background_provider_executor",
        provider: "multi_provider",
        execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
        external_calls: 1,
        deterministic: false
      }
    })
  });

  assert.equal(result.status, "pass");
  assert.equal(result.executed_count, 1);
  assert.equal(result.workflow_state.manifest.work_packages.find((item) => item.id === "runtime").status, "completed");
});

test("context work package dispatch failure is persisted as failed", () => {
  const workflowState = workflowStateWithContextCycle();
  const staged = stageContextWorkPackageDispatch(workflowState, {
    max_package_count: 1,
    execution_mode: "provider_model_routed",
    execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    dispatch_run_id: "dispatch-failed-001",
    created_at: "2026-05-28T13:33:00.000Z"
  });

  const failed = markContextWorkPackageDispatchFailed(staged.workflow_state, {
    selected_work_package_ids: staged.selected_work_package_ids,
    dispatch_run_id: "dispatch-failed-001",
    created_at: "2026-05-28T13:34:00.000Z",
    issues: [{ code: "provider_executor_timeout", message: "provider timed out", path: "provider_executor" }]
  });

  assert.equal(failed.status, "pass");
  const runtime = failed.workflow_state.manifest.work_packages.find((item) => item.id === "runtime");
  assert.equal(runtime.status, "failed");
  assert.equal(runtime.result, "dispatch_failed");
  assert.equal(runtime.failure_issues[0].code, "provider_executor_timeout");
  assert.ok(failed.workflow_state.manifest.events.some((event) => event.type === "context_work_packages_dispatch_failed"));
});

test("context work package dispatch retries a failed package whose dependencies are complete", () => {
  const workflowState = workflowStateWithContextCycle();
  const workPackages = workflowState.manifest.work_packages.map((workPackage) => {
    if (workPackage.id === "runtime") return { ...workPackage, status: "completed" };
    if (workPackage.id === "tests") return { ...workPackage, status: "failed", result: "dispatch_failed" };
    return workPackage;
  });
  const stateWithFailedPackage = {
    ...workflowState,
    manifest: {
      ...workflowState.manifest,
      work_packages: workPackages
    },
    task_dag: workPackages
  };

  const staged = stageContextWorkPackageDispatch(stateWithFailedPackage, {
    max_package_count: 1,
    execution_mode: "provider_model_routed",
    execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    dispatch_run_id: "dispatch-retry-failed-001",
    created_at: "2026-05-28T14:20:00.000Z"
  });

  assert.equal(staged.status, "pass");
  assert.deepEqual(staged.selected_work_package_ids, ["tests"]);
  const testsPackage = staged.workflow_state.manifest.work_packages.find((item) => item.id === "tests");
  assert.equal(testsPackage.status, "running");
  assert.equal(testsPackage.result, "dispatch_started");
});
