import assert from "node:assert/strict";
import test from "node:test";

import {
  applyGeneratedRequirementPlan,
  createRequirementPlanPrompt,
  markRequirementPlanGenerationFailed,
  parseRequirementPlanGenerationOutput,
  recordRequirementIntakeSubmitted,
  submitRequirementToProjectStatus,
  summarizeRequirementIntake,
  updateRequirementPlanReview
} from "../src/workflow/requirement-intake.js";
import { createRunManifest } from "../src/workflow/run-manifest.js";
import { createWorkbenchProjection } from "../src/workflow/workbench-projection.js";

function workflowState() {
  const manifest = createRunManifest({
    run_id: "run-requirement-intake",
    cycle_id: "cycle-requirement-intake",
    goal: "Validate requirement intake",
    context_pack: {
      requirement_summary: "Validate requirement intake",
      host: "platform_core",
      target_project_id: "ai-control-platform",
      non_goals: ["Do not modify managed projects"],
      forbidden_actions: ["Do not skip gates"],
      owned_files: ["src/workflow/requirement-intake.js"],
      acceptance_gates: ["node --test test/requirement-intake.test.js"],
      rollback_conditions: ["requirement intake does not produce continuation"],
      subtasks: [
        {
          id: "requirement-intake",
          title: "Requirement intake",
          owned_files: ["src/workflow/requirement-intake.js"]
        }
      ]
    },
    events: [],
    artifacts: [],
    gate_results: [],
    review_findings: [],
    recovery_attempts: [],
    created_at: "2026-05-25T00:00:00.000Z"
  });
  return {
    project_status: {
      project: "ai-control-platform",
      status: "in_progress",
      next_step: "",
      global_goals: []
    },
    manifest,
    artifact_ledger: {
      run_id: manifest.run_id,
      cycle_id: manifest.cycle_id,
      artifacts: []
    },
    task_dag: manifest.work_packages
  };
}

test("workbench requirement submission creates PROJECT_STATUS continuation input", () => {
  const submitted = submitRequirementToProjectStatus(workflowState().project_status, {
    title: "修复提需求模块",
    project_id: "ai-control-platform",
    surface_area: "workbench_frontend",
    problem_statement: "提需求页面和流程不只是前端展示，需要后端生成验收方案并等待用户审核。",
    constraints: "必须接入自动开发、验收门禁和真实 Workbench 页面验证。",
    plan_review_requested: true
  }, {
    created_at: "2026-05-25T08:00:00.000Z",
    requirement_id: "requirement-front-intake"
  });

  assert.equal(submitted.status, "pass");
  assert.equal(submitted.requirement.id, "requirement-front-intake");
  assert.equal(submitted.requirement.acceptance_criteria, "");
  assert.equal(submitted.project_status.plan_reviews["requirement-front-intake"].phase, "pending_plan_generation");
  assert.equal(submitted.project_status.plan_reviews["requirement-front-intake"].proposed_acceptance_plan, null);
  assert.equal(submitted.project_status.next_work_packages[0].global_goal_id, "requirement-front-intake");
  assert.ok(submitted.project_status.next_step.includes("提需求页面"));
  assert.ok(submitted.project_status.global_goals[0].owned_files.includes("apps/workbench"));
  assert.ok(submitted.project_status.global_goals[0].owned_files.includes("tools/workbench-server.mjs"));
  assert.equal(
    submitted.project_status.next_work_packages[0].source.acceptance_criteria,
    submitted.requirement.acceptance_criteria
  );
  assert.ok(submitted.project_status.requirement_intake.items[0].summary.includes("自动开发"));
});

test("requirement plan review is populated only from model plan output", () => {
  const submitted = submitRequirementToProjectStatus(workflowState().project_status, {
    title: "修复提需求模块",
    project_id: "ai-control-platform",
    problem_statement: "提需求页面需要生成方案并等待用户审核。",
    plan_review_requested: true
  }, {
    created_at: "2026-05-25T08:00:00.000Z",
    requirement_id: "requirement-plan-generation"
  });
  const prompt = createRequirementPlanPrompt(submitted.requirement);
  const parsed = parseRequirementPlanGenerationOutput(submitted.requirement, JSON.stringify({
    assessment_summary: "该任务需要先修正任务创建入口与审核状态，再进入实现。",
    proposed_acceptance_plan: "## 目标\n形成可审核方案。\n## 验收\n页面展示模型生成方案，审核通过前不得自动开发。",
    implementation_outline: ["生成方案", "审核后派发"],
    acceptance_gates: ["node --test test/requirement-intake.test.js"],
    risks: ["模型输出必须结构化"]
  }));
  const applied = applyGeneratedRequirementPlan(submitted.project_status, {
    requirement_id: "requirement-plan-generation",
    generated_plan: parsed,
    generator: { kind: "test_model_plan" }
  }, {
    created_at: "2026-05-25T08:01:00.000Z"
  });

  assert.match(prompt, /计划生成模式/);
  assert.match(prompt, /不要复制粘贴用户原话/);
  assert.equal(parsed.status, "pass");
  assert.equal(applied.status, "pass");
  assert.equal(applied.plan_review.phase, "ready_for_review");
  assert.match(applied.plan_review.proposed_acceptance_plan, /形成可审核方案/);
  assert.equal(applied.plan_review.generator.kind, "test_model_plan");
});

test("requirement plan generator output cannot be a verbatim problem copy", () => {
  const submitted = submitRequirementToProjectStatus(workflowState().project_status, {
    title: "修复提需求模块",
    problem_statement: "提需求页面需要先生成方案并等待用户审核。"
  }, {
    requirement_id: "requirement-plan-copy"
  });
  const parsed = parseRequirementPlanGenerationOutput(submitted.requirement, JSON.stringify({
    assessment_summary: "复制用户输入",
    proposed_acceptance_plan: "提需求页面需要先生成方案并等待用户审核。",
    implementation_outline: ["照抄"],
    acceptance_gates: ["无"]
  }));

  assert.equal(parsed.status, "fail");
  assert.ok(parsed.issues.some((item) => item.code === "generated_plan_copies_problem_statement"));
});

test("requirement plan generation failures are persisted as explicit failed state", () => {
  const submitted = submitRequirementToProjectStatus(workflowState().project_status, {
    title: "前端重构",
    project_id: "ai-control-platform",
    problem_statement: "迁移到 React 和 Ant Design，并保持单页工作台形态。",
    plan_review_requested: true
  }, {
    created_at: "2026-05-25T08:00:00.000Z",
    requirement_id: "requirement-plan-failed"
  });
  const failed = markRequirementPlanGenerationFailed(submitted.project_status, {
    requirement_id: "requirement-plan-failed",
    issues: [{ code: "requirement_plan_generation_failed", message: "simulated model timeout", path: "plan_generation" }],
    stderr: "simulated model timeout",
    generator: { kind: "test_model_plan" }
  }, {
    created_at: "2026-05-25T08:02:00.000Z"
  });
  const projection = createWorkbenchProjection({
    ...workflowState(),
    project_status: failed.project_status
  });

  assert.equal(failed.status, "pass");
  assert.equal(failed.plan_review.phase, "plan_generation_failed");
  assert.equal(failed.plan_review.action_status, "方案生成失败");
  assert.match(failed.plan_review.generation_error.message, /simulated model timeout/);
  assert.equal(projection.project_management.plan_review.phase, "plan_generation_failed");
  assert.equal(projection.next_action_readout.action, "retry_requirement_plan_generation");
  assert.match(projection.project_management.plan_review.assessment_summary, /生成失败/);
});

test("requirement intake fact drives workbench next action into existing autonomous flow", () => {
  const state = workflowState();
  const submitted = submitRequirementToProjectStatus(state.project_status, {
    title: "在前端提交中台需求",
    surface_area: "workbench_frontend",
    problem_statement: "操作员需要直接在看板提出新需求。",
    acceptance_criteria: "提交后看板展示需求，并推荐 prepare_project_status_continuation。",
    constraints: "必须接入自动开发和验收门禁。"
  }, {
    created_at: "2026-05-25T08:00:00.000Z",
    requirement_id: "requirement-front-intake"
  });
  const recorded = recordRequirementIntakeSubmitted(state, submitted, {
    created_at: "2026-05-25T08:00:00.000Z"
  });
  const projection = createWorkbenchProjection(recorded.workflow_state);

  assert.equal(recorded.status, "pass");
  assert.equal(recorded.workflow_state.manifest.events.at(-1).type, "requirement_intake_submitted");
  assert.equal(recorded.workflow_state.project_status.next_work_packages[0].action, "continue_requirement_intake");
  assert.equal(projection.project_management.requirement_intake.latest.title, "在前端提交中台需求");
  assert.equal(projection.next_action_readout.action, "generate_requirement_plan");
  assert.equal(projection.next_action_readout.source_type, "plan_review");
  assert.equal(projection.next_action_readout.requires_operator, false);
  assert.ok(projection.operations_timeline.items.some((item) => item.type === "requirement_intake_submitted"));
});

test("requirement plan review can be approved or returned for revision", () => {
  const submitted = submitRequirementToProjectStatus(workflowState().project_status, {
    title: "修复提需求模块",
    project_id: "ai-control-platform",
    problem_statement: "提需求页面需要先生成方案并等待用户审核。",
    plan_review_requested: true
  }, {
    created_at: "2026-05-25T08:00:00.000Z",
    requirement_id: "requirement-plan-review"
  });
  const generated = applyGeneratedRequirementPlan(submitted.project_status, {
    requirement_id: "requirement-plan-review",
    generated_plan: {
      assessment_summary: "先生成方案再审核。",
      proposed_acceptance_plan: "## 验收\n审核通过后才能开发。",
      implementation_outline: ["生成方案"],
      acceptance_gates: ["node --test test/requirement-intake.test.js"]
    }
  }, {
    created_at: "2026-05-25T08:04:00.000Z"
  });
  const approved = updateRequirementPlanReview(generated.project_status, {
    requirement_id: "requirement-plan-review",
    action: "approve",
    note: "方案可执行"
  }, {
    created_at: "2026-05-25T08:05:00.000Z"
  });
  const revised = updateRequirementPlanReview(generated.project_status, {
    requirement_id: "requirement-plan-review",
    action: "revise"
  }, {
    created_at: "2026-05-25T08:06:00.000Z"
  });

  assert.equal(approved.status, "pass");
  assert.equal(approved.plan_review.phase, "in_development");
  assert.equal(approved.plan_review.action_status, "开发中");
  assert.equal(revised.status, "pass");
  assert.equal(revised.plan_review.phase, "revising");
  assert.equal(revised.plan_review.action_status, "已退回修订");
});

test("legacy approved plan review projects as development state", () => {
  const submitted = submitRequirementToProjectStatus(workflowState().project_status, {
    title: "修复提需求模块",
    project_id: "ai-control-platform",
    problem_statement: "提需求页面需要先生成方案并等待用户审核。",
    plan_review_requested: true
  }, {
    created_at: "2026-05-25T08:00:00.000Z",
    requirement_id: "requirement-plan-review-legacy"
  });
  const generated = applyGeneratedRequirementPlan(submitted.project_status, {
    requirement_id: "requirement-plan-review-legacy",
    generated_plan: {
      assessment_summary: "先生成方案再审核。",
      proposed_acceptance_plan: "## 验收\n审核通过后才能开发。",
      implementation_outline: ["生成方案"],
      acceptance_gates: ["node --test test/requirement-intake.test.js"]
    }
  }, {
    created_at: "2026-05-25T08:04:00.000Z"
  });
  const legacyProjectStatus = {
    ...generated.project_status,
    plan_reviews: {
      ...generated.project_status.plan_reviews,
      "requirement-plan-review-legacy": {
        ...generated.plan_review,
        status: "approved",
        phase: "approved",
        next_action: "方案已通过，可进入开发",
        action_status: "已同意进入开发"
      }
    }
  };
  const projection = createWorkbenchProjection({
    ...workflowState(),
    project_status: legacyProjectStatus
  });

  assert.equal(projection.project_management.plan_review.phase, "in_development");
  assert.equal(projection.project_management.plan_review.status_label, "开发中");
  assert.equal(projection.project_management.plan_review.action_status, "开发中");
  assert.equal(projection.project_management.plan_review.next_action, "开发已开始");
});

test("requirement intake summary is stable without submissions", () => {
  const summary = summarizeRequirementIntake({});

  assert.equal(summary.status, "not_configured");
  assert.equal(summary.submitted_count, 0);
  assert.equal(summary.latest, null);
});
