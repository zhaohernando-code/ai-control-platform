import assert from "node:assert/strict";
import test from "node:test";

import { runContextWorkPackages } from "../src/workflow/context-work-package-runner.js";
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
