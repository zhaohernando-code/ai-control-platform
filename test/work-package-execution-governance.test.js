import assert from "node:assert/strict";
import test from "node:test";

import { evaluateWorkPackageExecutionGovernance } from "../src/workflow/work-package-execution-governance.js";

test("execution governance blocks undecomposed requirement plan steps before dispatch", () => {
  const result = evaluateWorkPackageExecutionGovernance({
    selected_work_packages: [
      {
        id: "requirement-frontend-refactor-plan-step-04",
        action: "execute_requirement_plan_step",
        title: "前端重构：实施步骤 04 / 7",
        owned_files: ["."],
        acceptance_gates: ["node --test test/frontend-acceptance.test.js"],
        reason: "实现已审核方案步骤。",
        source: {
          requirement_id: "requirement-frontend-refactor",
          plan_step_index: 4,
          implementation_step: "实现已审核方案步骤。",
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
  });

  assert.equal(result.status, "fail");
  assert.equal(result.gate_id, "work-package-execution-governance");
  assert.ok(result.issues.some((issue) => {
    return issue.code === "requirement_plan_step_requires_manager_decomposition" &&
      issue.repair_action === "split_into_executable_work_packages_before_dispatch";
  }));
});

test("execution governance accepts manager-produced slices with focused verification", () => {
  const result = evaluateWorkPackageExecutionGovernance({
    selected_work_packages: [
      {
        id: "requirement-frontend-refactor-plan-step-04-workbench-home",
        action: "execute_requirement_plan_step",
        title: "前端重构：实施步骤 04 / 7：工作台主页切片",
        owned_files: ["apps/workbench", "test/workbench-shell.test.js"],
        acceptance_gates: [
          "node --test test/workbench-shell.test.js",
          "工作台主页由 Next.js + React 渲染，页面基础布局与核心信息区使用 antd 组件。"
        ],
        reason: "迁移工作台主页视图到 React + Next.js App Router，并使用 antd Layout、Card、Statistic、List 等基础与布局组件承载现有投影数据。",
        source: {
          requirement_id: "requirement-frontend-refactor",
          plan_step_index: 4,
          plan_step_slice: "workbench-home",
          parent_implementation_step: "按视图切片迁移：优先迁移高频核心视图。",
          execution_governance: {
            version: "work-package-execution-governance.v1",
            granularity: "bounded_slice",
            decomposition: {
              required: true,
              status: "completed",
              evidence_id: "requirement-frontend-refactor-plan-step-04-manager-decomposition",
              parent_work_package_id: "requirement-frontend-refactor-plan-step-04",
              slice_id: "workbench-home"
            },
            verification: {
              required: true,
              status: "defined",
              gate_count: 2
            }
          }
        }
      }
    ]
  });

  assert.equal(result.status, "pass");
  assert.deepEqual(result.issues, []);
});

test("execution governance blocks requirement plan steps without focused verification", () => {
  const result = evaluateWorkPackageExecutionGovernance({
    selected_work_packages: [
      {
        id: "requirement-frontend-refactor-plan-step-05",
        action: "execute_requirement_plan_step",
        title: "前端重构：实施步骤 05 / 7",
        owned_files: ["apps/workbench"],
        reason: "迁移任务流交互到新前端。",
        source: {
          requirement_id: "requirement-frontend-refactor",
          plan_step_index: 5,
          implementation_step: "迁移任务流交互到新前端。",
          execution_governance: {
            version: "work-package-execution-governance.v1",
            granularity: "single_step",
            decomposition: {
              required: false,
              status: "not_required"
            },
            verification: {
              required: true,
              status: "missing",
              gate_count: 0
            }
          }
        }
      }
    ]
  });

  assert.equal(result.status, "fail");
  assert.ok(result.issues.some((issue) => {
    return issue.code === "requirement_plan_step_missing_focused_verification";
  }));
});

test("execution governance blocks requirement plan steps without structured governance", () => {
  const result = evaluateWorkPackageExecutionGovernance({
    selected_work_packages: [
      {
        id: "requirement-frontend-refactor-plan-step-legacy",
        action: "execute_requirement_plan_step",
        title: "旧格式实施步骤",
        owned_files: ["apps/workbench"],
        acceptance_gates: ["node --test test/frontend-acceptance.test.js"],
        reason: "旧格式包只有自然语言，没有结构化执行治理。",
        source: {
          requirement_id: "requirement-frontend-refactor",
          plan_step_index: 5,
          implementation_step: "旧格式包只有自然语言，没有结构化执行治理。"
        }
      }
    ]
  });

  assert.equal(result.status, "fail");
  assert.ok(result.issues.some((issue) => {
    return issue.code === "requirement_plan_step_missing_execution_governance";
  }));
});
