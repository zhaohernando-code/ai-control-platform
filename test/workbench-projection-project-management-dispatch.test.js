import assert from "node:assert/strict";
import test from "node:test";

import { createWorkbenchProjection } from "../src/workflow/workbench-projection.js";
import { baseInput } from "./helpers/workbench-projection.js";

test("failed provider budget cap is projected as a user-facing failure reason", () => {
  const projection = createWorkbenchProjection(baseInput({
    project_status: {
      project: "ai-control-platform",
      status: "in_progress",
      requirement_intake: {
        items: [
          {
            id: "requirement-project-tab-budget-failed",
            title: "完成项目 tab",
            project_id: "ai-control-platform",
            status: "submitted",
            submitted_at: "2026-05-28T02:00:00.000Z",
            problem_statement: "项目 tab 需要接入项目治理。"
          }
        ]
      },
      plan_reviews: {
        "requirement-project-tab-budget-failed": {
          id: "plan-review-requirement-project-tab-budget-failed",
          phase: "in_development",
          status: "in_development",
          reviewed_at: "2026-05-28T02:10:00.000Z"
        }
      },
      next_work_packages: [
        {
          id: "requirement-project-tab-budget-failed-plan-step-02",
          title: "完成项目 tab：实施步骤 02 / 2",
          action: "execute_requirement_plan_step",
          status: "failed",
          result: "dispatch_failed",
          dispatch_run_id: "dispatch-budget-failed-project-tab-001",
          dispatch_started_at: "2026-05-29T02:34:55.942Z",
          dispatch_failed_at: "2026-05-29T02:38:58.623Z",
          dispatch_artifact: {
            path: "tmp/context-work-package-background-jobs/dispatch-budget-failed-project-tab-001.json",
            phase: "provider_model_routed_execution"
          },
          dispatch_executor_provenance: {
            provider_attempts: [
              { model: "gpt-5.3-codex-spark", status: "fail", issue: "provider_executor_command_failed", timed_out: false, exit_code: 1 }
            ]
          },
          dispatch_package_results: [
            {
              work_package_id: "requirement-project-tab-budget-failed-plan-step-02",
              status: "fail",
              result: "fail",
              completion_evidence: {
                kind: "provider_execution_failure",
                reason: "agent provider executor failed with exit code 1",
                evidence: {
                  issue_code: "provider_executor_command_failed",
                  stderr: "Error: reached max budget of $1.00 before completion",
                  exit_code: 1,
                  command: {
                    args: ["codex", "exec", "--max-budget-usd", "1"]
                  }
                }
              }
            }
          ],
          global_goal_id: "requirement-project-tab-budget-failed",
          source: { requirement_id: "requirement-project-tab-budget-failed" },
          failure_issues: [
            { code: "provider_executor_result_not_pass", message: "provider executor top-level status must be pass" },
            { code: "package_result_not_pass", message: "provider executor package result must be pass for requirement-project-tab-budget-failed-plan-step-02" }
          ]
        }
      ]
    }
  }));
  const task = projection.project_management.task_items[0];

  assert.equal(task.status, "failed");
  assert.equal(task.failure_reason, "外部模型调用到达 $1 预算上限，任务未完成。");
  assert.ok(!task.failure_reason.includes("provider executor"));
  assert.deepEqual(task.latest_dispatch.issue_codes, ["provider_executor_result_not_pass", "package_result_not_pass"]);
});

test("approved requirements with completed work packages are projected as completed", () => {
  const projection = createWorkbenchProjection(baseInput({
    project_status: {
      project: "ai-control-platform",
      status: "in_progress",
      requirement_intake: {
        items: [
          {
            id: "requirement-project-tab-completed",
            title: "完成项目 tab",
            project_id: "ai-control-platform",
            status: "submitted",
            submitted_at: "2026-05-28T02:00:00.000Z",
            problem_statement: "项目 tab 需要接入项目治理。"
          }
        ]
      },
      plan_reviews: {
        "requirement-project-tab-completed": {
          id: "plan-review-requirement-project-tab-completed",
          phase: "in_development",
          status: "in_development",
          reviewed_at: "2026-05-28T02:10:00.000Z"
        }
      },
      next_work_packages: [
        {
          id: "requirement-project-tab-completed-plan-step-01",
          title: "完成项目 tab：实施步骤 01 / 2",
          action: "execute_requirement_plan_step",
          status: "completed",
          global_goal_id: "requirement-project-tab-completed",
          source: { requirement_id: "requirement-project-tab-completed" }
        }
      ]
    }
  }));
  const task = projection.project_management.task_items[0];

  assert.equal(task.status, "completed");
  assert.equal(task.status_label, "完成");
  assert.equal(task.phase_label, "任务包完成");
  assert.equal(task.recoverable, false);
});

test("workbench projection counts task flow items as the task source of truth", () => {
  const projection = createWorkbenchProjection(baseInput({
    manifest: {
      run_id: "run-task-counts",
      cycle_id: "cycle-task-counts",
      work_packages: [
        { id: "stale-open-package", title: "Old package", status: "pending" }
      ],
      events: []
    },
    project_status: {
      project: "ai-control-platform",
      status: "in_progress",
      requirement_intake: {
        items: [
          {
            id: "requirement-done-a",
            title: "完成任务 A",
            status: "completed",
            submitted_at: "2026-05-28T02:00:00.000Z"
          },
          {
            id: "requirement-done-b",
            title: "完成任务 B",
            status: "completed",
            submitted_at: "2026-05-28T02:01:00.000Z"
          }
        ]
      },
      plan_reviews: {
        "requirement-done-a": { phase: "completed" },
        "requirement-done-b": { phase: "completed" }
      }
    }
  }));

  assert.equal(projection.project_management.tasks_total, 2);
  assert.equal(projection.project_management.active_tasks, 0);
  assert.equal(projection.one_screen.counters.tasks_total, 2);
  assert.equal(projection.one_screen.counters.active_tasks, 0);
  assert.deepEqual(
    projection.project_management.task_items.map((item) => item.status),
    ["completed", "completed"]
  );
});

test("workbench projection treats completed requirement goals as completed task flow items", () => {
  const projection = createWorkbenchProjection(baseInput({
    project_status: {
      project: "ai-control-platform",
      status: "in_progress",
      requirement_intake: {
        items: [
          {
            id: "requirement-goal-complete",
            title: "目标已完成的需求",
            status: "submitted",
            submitted_at: "2026-05-28T02:00:00.000Z"
          }
        ]
      },
      plan_reviews: {
        "requirement-goal-complete": {
          phase: "in_development",
          status: "in_development"
        }
      },
      global_goals: [
        {
          id: "requirement-goal-complete",
          title: "目标已完成的需求",
          status: "completed"
        }
      ]
    }
  }));
  const task = projection.project_management.task_items[0];

  assert.equal(task.status, "completed");
  assert.equal(task.status_label, "完成");
  assert.equal(task.phase_label, "验收完成");
  assert.equal(projection.project_management.active_tasks, 0);
  assert.equal(projection.one_screen.counters.active_tasks, 0);
});

test("workbench projection treats closed failed requirements as inactive archived tasks", () => {
  const projection = createWorkbenchProjection(baseInput({
    project_status: {
      project: "ai-control-platform",
      status: "in_progress",
      requirement_intake: {
        open_count: 0,
        items: [
          {
            id: "requirement-closed-failed",
            title: "关闭失败任务",
            status: "closed_failed",
            submitted_at: "2026-05-28T02:00:00.000Z"
          }
        ]
      },
      plan_reviews: {
        "requirement-closed-failed": {
          phase: "closed_failed",
          status: "closed_failed",
          close_reason: "operator closed failed task"
        }
      },
      global_goals: [
        {
          id: "requirement-closed-failed",
          title: "关闭失败任务",
          status: "closed"
        }
      ]
    }
  }));
  const task = projection.project_management.task_items[0];

  assert.equal(task.status, "closed");
  assert.equal(task.status_label, "已关闭");
  assert.equal(task.phase_label, "失败已关闭");
  assert.equal(projection.project_management.active_tasks, 0);
  assert.equal(projection.global_goal_completion.pending, 0);
});
