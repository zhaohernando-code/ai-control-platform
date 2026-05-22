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

test("codex plan pressure adds DeepSeek Pro process guard before expensive GPT work", () => {
  const plan = buildModelCollaborationPlan({
    goal: "继续无人值守中台开发并检查流程是否跑偏",
    stage: "implementation",
    risk: "high",
    budget_tier: "high",
    host: "platform_core",
    codex_plan_pressure: true,
    tags: ["boundary_sensitive", "process_guard"]
  });
  const summary = summarizeModelRouting(plan);
  const guardIndex = plan.roles.findIndex((role) => role.role === "process_guard");
  const primaryIndex = plan.roles.findIndex((role) => role.role === "primary");

  assert.equal(plan.selected_model, "gpt");
  assert.ok(guardIndex >= 0);
  assert.ok(primaryIndex >= 0);
  assert.ok(guardIndex < primaryIndex);
  assert.ok(plan.roles.some((role) => role.role === "process_guard" && role.model_id === "deepseek-v4-pro"));
  assert.ok(plan.roles.some((role) => role.role === "independent_reviewer" && role.model_id === "deepseek-v4-pro"));
  assert.equal(plan.guardrails.codex_plan_pressure_uses_deepseek_pro, true);
  assert.equal(summary.has_process_guard, true);
  assert.equal(summary.by_model["deepseek-v4-pro"], 2);
});

test("plan budget pressure tag adds process guard before planning primary", () => {
  const plan = buildModelCollaborationPlan({
    goal: "设计下一轮中台流程并先审查是否跑偏",
    stage: "planning",
    risk: "high",
    budget_tier: "high",
    host: "platform_core",
    tags: ["plan_budget_pressure"]
  });
  const guardIndex = plan.roles.findIndex((role) => role.role === "process_guard");
  const primaryIndex = plan.roles.findIndex((role) => role.role === "primary");

  assert.equal(plan.selected_model, "gpt");
  assert.ok(guardIndex >= 0);
  assert.ok(guardIndex < primaryIndex);
});

test("process guard tag alone adds guard before primary", () => {
  const plan = buildModelCollaborationPlan({
    goal: "只用流程守门标签触发前置审查",
    stage: "implementation",
    risk: "high",
    budget_tier: "high",
    host: "platform_core",
    tags: ["process_guard"]
  });
  const guardIndex = plan.roles.findIndex((role) => role.role === "process_guard");
  const primaryIndex = plan.roles.findIndex((role) => role.role === "primary");

  assert.equal(plan.selected_model, "gpt");
  assert.ok(guardIndex >= 0);
  assert.ok(guardIndex < primaryIndex);
});

test("cost pressure adds process guard but low-risk classification stays cheap", () => {
  const guarded = buildModelCollaborationPlan({
    goal: "在预算压力下继续平台实现前先做流程守门",
    stage: "implementation",
    risk: "high",
    budget_tier: "high",
    host: "platform_core",
    cost_pressure: true
  });
  const classification = buildModelCollaborationPlan({
    goal: "把用户新需求分类到平台模块",
    stage: "classification",
    risk: "low",
    budget_tier: "low",
    codex_plan_pressure: true,
    tags: ["classification", "routing"]
  });

  assert.ok(guarded.roles.some((role) => role.role === "process_guard"));
  assert.equal(summarizeModelRouting(classification).has_process_guard, false);
  assert.equal(classification.selected_model, "deepseek-v4-flash");
});

test("DS expanded strategy makes medium-risk implementation DS primary under plan pressure", () => {
  const plan = buildModelCollaborationPlan({
    goal: "继续实现中台工作台投影但当前 Codex plan 紧张",
    stage: "implementation",
    risk: "medium",
    budget_tier: "medium",
    host: "platform_core",
    codex_plan_pressure: true,
    model_routing_strategy: "ds_expanded"
  });
  const summary = summarizeModelRouting(plan);

  assert.equal(plan.status, "pass");
  assert.equal(plan.selected_model, "deepseek-v4-pro");
  assert.equal(plan.model_routing_strategy, "ds_expanded");
  assert.equal(plan.ds_ratio_boost, 2);
  assert.equal(plan.guardrails.ds_expansion_is_configurable, true);
  assert.equal(summary.ds_primary, true);
  assert.ok(summary.ds_role_count > summary.gpt_role_count);
  assert.ok(plan.roles.some((role) => role.role === "scout" && role.model_id === "deepseek-v4-flash"));
});

test("DS expanded strategy keeps high-risk platform implementation GPT-led", () => {
  const plan = buildModelCollaborationPlan({
    goal: "修改中台核心调度和安全边界",
    stage: "implementation",
    risk: "high",
    budget_tier: "high",
    host: "platform_core",
    model_routing_strategy: "ds_expanded",
    tags: ["boundary_sensitive"]
  });
  const guardIndex = plan.roles.findIndex((role) => role.role === "process_guard");
  const primaryIndex = plan.roles.findIndex((role) => role.role === "primary");

  assert.equal(plan.selected_model, "gpt");
  assert.equal(plan.guardrails.gpt_primary_required_for_high_risk_platform_core, true);
  assert.ok(guardIndex >= 0);
  assert.ok(guardIndex < primaryIndex);
  assert.ok(plan.roles.some((role) => role.role === "independent_reviewer" && role.model_id === "deepseek-v4-pro"));
});

test("DS expanded strategy does not take primary ownership of recovery stage", () => {
  const plan = buildModelCollaborationPlan({
    goal: "恢复失败的中台调度循环",
    stage: "recovery",
    risk: "medium",
    budget_tier: "high",
    host: "platform_core",
    model_routing_strategy: "ds_expanded"
  });

  assert.equal(plan.selected_model, "gpt");
  assert.ok(plan.roles.some((role) => role.role === "process_guard" && role.model_id === "deepseek-v4-pro"));
});

test("DeepSeek Pro primary review does not duplicate process guard", () => {
  const plan = buildModelCollaborationPlan({
    goal: "审查平台宿主边界是否仍可能漂移",
    stage: "review",
    risk: "high",
    budget_tier: "high",
    cost_pressure: true,
    tags: ["independent_review", "code_audit"]
  });
  const processGuards = plan.roles.filter((role) => role.role === "process_guard");

  assert.equal(plan.selected_model, "deepseek-v4-pro");
  assert.equal(processGuards.length, 0);
  assert.ok(plan.roles.some((role) => role.role === "arbiter" && role.model_id === "gpt"));
});

test("codex plan pressure does not duplicate guard when DeepSeek Pro is primary", () => {
  const plan = buildModelCollaborationPlan({
    goal: "在 plan 压力下让 DS Pro 审查代码而不重复插入 guard",
    stage: "review",
    risk: "high",
    budget_tier: "high",
    codex_plan_pressure: true,
    tags: ["independent_review", "code_audit"]
  });

  assert.equal(plan.selected_model, "deepseek-v4-pro");
  assert.equal(plan.roles.filter((role) => role.role === "process_guard").length, 0);
  assert.ok(plan.roles.some((role) => role.role === "arbiter" && role.model_id === "gpt"));
});

test("invalid request fails validation", () => {
  const validation = validateModelRoutingRequest({
    stage: "implementation",
    risk: "extreme",
    budget_tier: "free",
    model_routing_strategy: "always_gpt",
    ds_ratio_boost: 8
  });

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some((issue) => issue.code === "missing_goal"));
  assert.ok(validation.issues.some((issue) => issue.code === "invalid_risk"));
  assert.ok(validation.issues.some((issue) => issue.code === "invalid_budget_tier"));
  assert.ok(validation.issues.some((issue) => issue.code === "invalid_model_routing_strategy"));
  assert.ok(validation.issues.some((issue) => issue.code === "invalid_ds_ratio_boost"));
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
  assert.equal(summary.ds_role_count, 2);
  assert.equal(summary.gpt_role_count, 0);
  assert.equal(summary.has_independent_reviewer, false);
});
