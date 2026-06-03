import assert from "node:assert/strict";
import test from "node:test";

import { createWorkbenchProjection } from "../src/workflow/workbench-projection.js";
import { baseInput } from "./helpers/workbench-projection.js";

test("workbench projection exposes task flow items for submitted requirements", () => {
  const projection = createWorkbenchProjection(baseInput({
    project_status: {
      project: "ai-control-platform",
      status: "in_progress",
      updated_at: "2026-05-28T02:30:00.000Z",
      requirement_intake: {
        items: [
          {
            id: "requirement-task-flow",
            title: "接入任务流",
            project_id: "ai-control-platform",
            status: "submitted",
            submitted_at: "2026-05-28T02:00:00.000Z",
            problem_statement: "新建任务后应进入任务流审视。",
            constraints: "使用 Next 动态路由。"
          }
        ]
      },
      plan_reviews: {
        "requirement-task-flow": {
          id: "plan-review-requirement-task-flow",
          phase: "ready_for_review",
          generated_at: "2026-05-28T02:05:00.000Z",
          assessment_summary: "需要先审视计划。",
          proposed_acceptance_plan: "任务流显示并可审视。",
          implementation_outline: ["接列表", "接详情"],
          acceptance_gates: ["npm run check:closeout"]
        }
      },
      next_work_packages: [
        {
          id: "requirement-task-flow-plan-step-01",
          title: "接入任务流：实施步骤 01 / 2",
          action: "execute_requirement_plan_step",
          global_goal_id: "requirement-task-flow",
          source: { requirement_id: "requirement-task-flow" }
        }
      ]
    }
  }));
  const task = projection.project_management.task_items[0];

  assert.equal(task.task_id, "requirement-task-flow");
  assert.equal(task.title, "接入任务流");
  assert.equal(task.status, "pending_review");
  assert.equal(task.status_label, "待审视");
  assert.equal(task.phase_label, "计划审视");
  assert.equal(task.location_label, "人工决策");
  assert.equal(task.reviewable, true);
  assert.equal(task.plan_review.assessment_summary, "需要先审视计划。");
  assert.equal(task.work_packages[0].id, "requirement-task-flow-plan-step-01");
  assert.equal(projection.project_management.human_decisions, 1);
  assert.equal(projection.one_screen.counters.human_decisions, 1);
  assert.equal(projection.one_screen.counters.tasks_total, 1);
  assert.equal(projection.one_screen.counters.active_tasks, 1);
});

test("pending requirement plan generation is not projected as running and stays recoverable", () => {
  const projection = createWorkbenchProjection(baseInput({
    project_status: {
      project: "ai-control-platform",
      status: "in_progress",
      requirement_intake: {
        items: [
          {
            id: "requirement-project-tab",
            title: "完成项目 tab",
            project_id: "ai-control-platform",
            status: "submitted",
            submitted_at: "2026-05-28T02:00:00.000Z",
            problem_statement: "项目 tab 需要接入项目治理。"
          }
        ]
      },
      plan_reviews: {
        "requirement-project-tab": {
          id: "plan-review-requirement-project-tab",
          phase: "pending_plan_generation",
          status: "pending_plan_generation",
          requested_at: "2026-05-28T02:01:00.000Z"
        }
      }
    }
  }));
  const task = projection.project_management.task_items[0];

  assert.equal(task.status, "pending_plan_generation");
  assert.equal(task.status_label, "待生成");
  assert.equal(task.phase_label, "等待方案生成");
  assert.equal(task.location_label, "计划生成");
  assert.equal(task.recoverable, true);
  assert.equal(projection.project_management.active_tasks, 1);
});

test("approved requirements with only pending work packages are projected as pending execution", () => {
  const projection = createWorkbenchProjection(baseInput({
    project_status: {
      project: "ai-control-platform",
      status: "in_progress",
      requirement_intake: {
        items: [
          {
            id: "requirement-project-tab-execution",
            title: "完成项目 tab",
            project_id: "ai-control-platform",
            status: "submitted",
            submitted_at: "2026-05-28T02:00:00.000Z",
            problem_statement: "项目 tab 需要接入项目治理。"
          }
        ]
      },
      plan_reviews: {
        "requirement-project-tab-execution": {
          id: "plan-review-requirement-project-tab-execution",
          phase: "in_development",
          status: "in_development",
          reviewed_at: "2026-05-28T02:10:00.000Z"
        }
      },
      next_work_packages: [
        {
          id: "requirement-project-tab-execution-plan-step-01",
          title: "完成项目 tab：实施步骤 01 / 2",
          action: "execute_requirement_plan_step",
          status: "pending",
          global_goal_id: "requirement-project-tab-execution",
          source: { requirement_id: "requirement-project-tab-execution" }
        }
      ]
    }
  }));
  const task = projection.project_management.task_items[0];

  assert.equal(task.status, "pending_execution");
  assert.equal(task.status_label, "待执行");
  assert.equal(task.phase_label, "等待派发");
  assert.equal(task.location_label, "执行队列");
  assert.equal(task.recoverable, true);
  assert.equal(task.work_packages[0].status, "pending");
});

test("approved requirements with running work packages are projected as running", () => {
  const projection = createWorkbenchProjection(baseInput({
    project_status: {
      project: "ai-control-platform",
      status: "in_progress",
      requirement_intake: {
        items: [
          {
            id: "requirement-project-tab-running",
            title: "完成项目 tab",
            project_id: "ai-control-platform",
            status: "submitted",
            submitted_at: "2026-05-28T02:00:00.000Z",
            problem_statement: "项目 tab 需要接入项目治理。"
          }
        ]
      },
      plan_reviews: {
        "requirement-project-tab-running": {
          id: "plan-review-requirement-project-tab-running",
          phase: "in_development",
          status: "in_development",
          reviewed_at: "2026-05-28T02:10:00.000Z"
        }
      },
      next_work_packages: [
        {
          id: "requirement-project-tab-running-plan-step-01",
          title: "完成项目 tab：实施步骤 01 / 2",
          action: "execute_requirement_plan_step",
          status: "running",
          global_goal_id: "requirement-project-tab-running",
          source: { requirement_id: "requirement-project-tab-running" }
        }
      ]
    }
  }));
  const task = projection.project_management.task_items[0];

  assert.equal(task.status, "running");
  assert.equal(task.status_label, "运行中");
  assert.equal(task.phase_label, "开发执行");
  assert.equal(task.recoverable, false);
});

test("approved requirements with failed work packages are projected as failed and recoverable", () => {
  const projection = createWorkbenchProjection(baseInput({
    project_status: {
      project: "ai-control-platform",
      status: "in_progress",
      requirement_intake: {
        items: [
          {
            id: "requirement-project-tab-failed",
            title: "完成项目 tab",
            project_id: "ai-control-platform",
            status: "submitted",
            submitted_at: "2026-05-28T02:00:00.000Z",
            problem_statement: "项目 tab 需要接入项目治理。"
          }
        ]
      },
      plan_reviews: {
        "requirement-project-tab-failed": {
          id: "plan-review-requirement-project-tab-failed",
          phase: "in_development",
          status: "in_development",
          reviewed_at: "2026-05-28T02:10:00.000Z"
        }
      },
      next_work_packages: [
        {
          id: "requirement-project-tab-failed-plan-step-01",
          title: "完成项目 tab：实施步骤 01 / 2",
          action: "execute_requirement_plan_step",
          status: "failed",
          result: "dispatch_failed",
          dispatch_run_id: "dispatch-failed-project-tab-001",
          dispatch_started_at: "2026-05-29T02:34:55.942Z",
          dispatch_failed_at: "2026-05-29T02:38:58.623Z",
          dispatch_artifact: {
            path: "tmp/context-work-package-background-jobs/dispatch-failed-project-tab-001.json",
            phase: "provider_model_routed_execution"
          },
          dispatch_executor_provenance: {
            provider_attempts: [
              { model: "deepseek-v4-pro[1m]", status: "fail", issue: "provider_executor_timeout", timed_out: true, exit_code: 1 },
              { model: "deepseek-v4-flash", status: "fail", issue: "provider_executor_timeout", timed_out: true, exit_code: 1 }
            ]
          },
          global_goal_id: "requirement-project-tab-failed",
          source: { requirement_id: "requirement-project-tab-failed" },
          failure_issues: [
            { code: "provider_executor_result_not_pass", message: "provider executor top-level status must be pass" },
            { code: "package_result_not_pass", message: "provider executor package result must be pass" }
          ]
        }
      ]
    }
  }));
  const task = projection.project_management.task_items[0];

  assert.equal(task.status, "failed");
  assert.equal(task.status_label, "失败");
  assert.equal(task.phase_label, "执行失败");
  assert.equal(task.recoverable, true);
  assert.equal(task.updated_at, "2026-05-29T02:38:58.623Z");
  assert.equal(task.latest_dispatch.dispatch_run_id, "dispatch-failed-project-tab-001");
  assert.equal(task.latest_dispatch.dispatch_failed_at, "2026-05-29T02:38:58.623Z");
  assert.equal(task.latest_dispatch.artifact_path, "tmp/context-work-package-background-jobs/dispatch-failed-project-tab-001.json");
  assert.equal(task.latest_dispatch.attempt_count, 2);
  assert.equal(task.latest_dispatch.latest_attempt.model, "deepseek-v4-flash");
  assert.equal(task.latest_dispatch.latest_attempt.issue, "provider_executor_timeout");
  assert.deepEqual(task.latest_dispatch.issue_codes, ["provider_executor_result_not_pass", "package_result_not_pass"]);
  assert.equal(task.failure_reason, "外部模型执行超时，任务未完成。");
  assert.ok(!task.failure_reason.includes("provider executor"));
});
