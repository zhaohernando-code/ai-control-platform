import assert from "node:assert/strict";
import test from "node:test";

import {
  buildModelCollaborationPlan,
  selectModelForTask,
  summarizeModelRouting,
  validateModelRoutingRequest
} from "../src/workflow/model-router.js";

test("low-risk classification uses DeepSeek V4 Flash", () => {
  const selection = selectModelForTask({
    goal: "判断新需求应路由到哪个项目",
    stage: "classification",
    risk: "low",
    budget_tier: "low",
    tags: ["classification", "routing"]
  });

  assert.equal(selection.status, "pass");
  assert.equal(selection.selected_model, "deepseek-v4-flash");
  assert.equal(selection.model_profile.cost_tier, "low");
});

test("high-risk platform implementation uses GPT and adds DeepSeek Pro reviewer", () => {
  const plan = buildModelCollaborationPlan({
    goal: "实现新中台 Recovery Engine 的自动回退策略",
    stage: "implementation",
    risk: "high",
    budget_tier: "high",
    host: "platform_core",
    tags: ["boundary_sensitive"]
  });

  assert.equal(plan.status, "pass");
  assert.equal(plan.selected_model, "gpt");
  assert.ok(plan.roles.some((role) => role.role === "primary" && role.model_id === "gpt"));
  assert.ok(plan.roles.some((role) => role.role === "independent_reviewer" && role.model_id === "deepseek-v4-pro"));
});

test("independent review defaults to DeepSeek V4 Pro and GPT arbitration for high risk", () => {
  const plan = buildModelCollaborationPlan({
    goal: "审查平台宿主边界是否仍可能漂移",
    stage: "review",
    risk: "high",
    budget_tier: "high",
    tags: ["independent_review", "code_audit"]
  });

  assert.equal(plan.selected_model, "deepseek-v4-pro");
  assert.ok(plan.roles.some((role) => role.role === "arbiter" && role.model_id === "gpt"));
});

test("medium budget records downgrade instead of silently using high-cost GPT", () => {
  const selection = selectModelForTask({
    goal: "设计平台核心架构但当前预算受限",
    stage: "planning",
    risk: "high",
    budget_tier: "medium",
    host: "platform_core",
    tags: ["architecture"]
  });

  assert.equal(selection.preferred_model, "gpt");
  assert.equal(selection.selected_model, "deepseek-v4-pro");
  assert.equal(selection.downgraded_for_budget, true);
});

test("invalid request fails validation", () => {
  const validation = validateModelRoutingRequest({
    stage: "implementation",
    risk: "extreme",
    budget_tier: "free"
  });

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some((issue) => issue.code === "missing_goal"));
  assert.ok(validation.issues.some((issue) => issue.code === "invalid_risk"));
  assert.ok(validation.issues.some((issue) => issue.code === "invalid_budget_tier"));
});

test("routing summary is workbench-friendly", () => {
  const plan = buildModelCollaborationPlan({
    goal: "批量总结项目体检信号",
    stage: "summarization",
    risk: "low",
    budget_tier: "low",
    tags: ["summarization"]
  });
  const summary = summarizeModelRouting(plan);

  assert.equal(summary.selected_model, "deepseek-v4-flash");
  assert.equal(summary.role_count, 2);
  assert.equal(summary.by_model["deepseek-v4-flash"], 2);
  assert.equal(summary.has_independent_reviewer, false);
});
