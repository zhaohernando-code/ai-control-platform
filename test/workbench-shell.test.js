import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { isRenderedSchedulerDispatchPassStatus } from "../tools/check-scheduler-dispatch-writeback.mjs";

const FILES = [
  "apps/workbench/desktop.html",
  "apps/workbench/mobile.html",
  "apps/workbench/favicon.svg",
  "apps/workbench/styles.css",
  "apps/workbench/workbench.js"
];

function read(path) {
  return readFileSync(path, "utf8");
}

test("workbench shell has separate desktop and mobile entries", () => {
  const desktop = read("apps/workbench/desktop.html");
  const mobile = read("apps/workbench/mobile.html");

  assert.match(desktop, /data-view="desktop"/);
  assert.match(mobile, /data-view="mobile"/);
  assert.match(desktop, /<link rel="icon" type="image\/svg\+xml" href="\.\/favicon\.svg" \/>/);
  assert.match(mobile, /<link rel="icon" type="image\/svg\+xml" href="\.\/favicon\.svg" \/>/);
  assert.match(read("apps/workbench/favicon.svg"), /<svg[\s\S]*AI Control Platform/);
  assert.match(desktop, /data-history-select/);
  assert.match(mobile, /data-history-select/);
  assert.match(desktop, /data-bind="closeout_status"/);
  assert.match(mobile, /data-bind="closeout_status"/);
  assert.match(desktop, /data-bind="operator_goal_summary"/);
  assert.match(desktop, /data-bind="operator_blocker_summary"/);
  assert.match(desktop, /data-bind="operator_risk_summary"/);
  assert.match(desktop, /data-bind="operator_evidence_summary"/);
  assert.match(desktop, /data-bind="operator_recovery_summary"/);
  assert.match(desktop, /data-bind="operator_review_summary"/);
  assert.match(mobile, /data-bind="operator_blocker_summary"/);
  assert.match(mobile, /data-bind="operator_dispatch_summary"/);
  assert.match(mobile, /data-bind="operator_recovery_summary"/);
  assert.match(mobile, /data-bind="operator_review_summary"/);
  assert.match(desktop, /data-bind="ui_verification_status"/);
  assert.match(mobile, /data-bind="ui_verification_status"/);
  assert.match(desktop, /data-bind="ui_verification_scenarios"/);
  assert.match(desktop, /data-bind="ui_verification_artifact"/);
  assert.match(mobile, /data-bind="ui_verification_partial"/);
  assert.match(desktop, /data-bind="resume_health_status"/);
  assert.match(mobile, /data-bind="resume_health_status"/);
  assert.match(desktop, /data-bind="provider_health_value"/);
  assert.match(mobile, /data-bind="provider_health_value"/);
  assert.match(desktop, /data-bind="scheduler_dispatch_status"/);
  assert.match(mobile, /data-bind="scheduler_dispatch_status"/);
  assert.match(desktop, /data-bind="scheduler_policy_status"/);
  assert.match(mobile, /data-bind="scheduler_policy_reason"/);
  assert.match(desktop, /data-bind="scheduler_next_status"/);
  assert.match(mobile, /data-bind="scheduler_next_packages"/);
  assert.match(desktop, /data-bind="scheduler_continuation_ready"/);
  assert.match(mobile, /data-bind="scheduler_continuation_enqueue"/);
  assert.match(desktop, /data-bind="scheduler_loop_status"/);
  assert.match(mobile, /data-bind="scheduler_loop_iterations"/);
  assert.match(desktop, /data-bind="scheduler_loop_recovery"/);
  assert.match(mobile, /data-bind="scheduler_loop_recovery"/);
  assert.match(desktop, /data-bind="scheduler_loop_resume_status"/);
  assert.match(mobile, /data-bind="scheduler_loop_resume_status"/);
  assert.match(desktop, /data-bind="agent_lifecycle_pool_status"/);
  assert.match(mobile, /data-bind="agent_lifecycle_pool_status"/);
  assert.match(desktop, /data-bind="agent_lifecycle_pool_open"/);
  assert.match(mobile, /data-bind="agent_lifecycle_pool_open"/);
  assert.match(desktop, /data-bind="agent_lifecycle_pool_unevaluated"/);
  assert.match(mobile, /data-bind="agent_lifecycle_pool_unevaluated"/);
  assert.match(desktop, /data-bind="agent_lifecycle_pool_unclosed"/);
  assert.match(mobile, /data-bind="agent_lifecycle_pool_unclosed"/);
  assert.match(desktop, /data-bind="agent_lifecycle_pool_timed_out"/);
  assert.match(mobile, /data-bind="agent_lifecycle_pool_timed_out"/);
  assert.match(desktop, /data-bind="agent_lifecycle_pool_heartbeats"/);
  assert.match(mobile, /data-bind="agent_lifecycle_pool_heartbeats"/);
  assert.match(desktop, /data-bind="agent_lifecycle_pool_latest_heartbeat"/);
  assert.match(mobile, /data-bind="agent_lifecycle_pool_latest_heartbeat"/);
  assert.match(desktop, /data-bind="agent_lifecycle_pool_latest_timeout"/);
  assert.match(mobile, /data-bind="agent_lifecycle_pool_latest_timeout"/);
  assert.match(desktop, /data-bind="agent_lifecycle_pool_next_action"/);
  assert.match(mobile, /data-bind="agent_lifecycle_pool_next_action"/);
  assert.match(desktop, /data-bind="counter_projects_total"/);
  assert.match(mobile, /data-bind="counter_projects_total"/);
  assert.match(desktop, /data-bind="counter_active_projects"/);
  assert.match(mobile, /data-bind="counter_active_projects"/);
  assert.match(desktop, /data-bind="counter_active_tasks"/);
  assert.match(mobile, /data-bind="counter_active_tasks"/);
  assert.match(desktop, /data-list="project_rows"/);
  assert.match(mobile, /data-list="project_rows"/);
  assert.match(desktop, /data-list="project_task_flow"/);
  assert.match(mobile, /data-list="project_task_flow"/);
  assert.match(desktop, /data-workbench-tab="requirements"/);
  assert.match(desktop, /data-requirement-form/);
  assert.match(mobile, /data-requirement-form/);
  assert.match(desktop, /data-list="requirement_intake"/);
  assert.match(mobile, /data-list="requirement_intake"/);
  assert.match(desktop, /新建任务/);
  assert.match(mobile, /新建任务/);
  assert.match(desktop, /<button[^>]*data-requirement-submit[^>]*>提交</);
  assert.match(mobile, /<button[^>]*data-requirement-submit[^>]*>提交</);
  assert.doesNotMatch(desktop, /提交到流程/);
  assert.doesNotMatch(mobile, /提交到流程/);
  assert.doesNotMatch(desktop, /<span>验收标准<\/span>/);
  assert.doesNotMatch(mobile, /<span>验收标准<\/span>/);
  assert.match(desktop, /<span>项目<\/span>/);
  assert.match(mobile, /<span>项目<\/span>/);
  assert.match(desktop, /data-bind="plan_review_status"/);
  assert.match(mobile, /data-bind="plan_review_status"/);
  assert.match(desktop, /data-bind="plan_review_phase"/);
  assert.match(mobile, /data-bind="plan_review_phase"/);
  assert.match(desktop, /class="plan-review-copy[^"]*" data-bind="plan_review_acceptance_plan"/);
  assert.match(mobile, /class="plan-review-copy[^"]*" data-bind="plan_review_acceptance_plan"/);
  assert.doesNotMatch(desktop, /<strong data-bind="plan_review_acceptance_plan"/);
  assert.doesNotMatch(mobile, /<strong data-bind="plan_review_acceptance_plan"/);
  assert.match(desktop, /方案评估与审核/);
  assert.match(mobile, /方案评估与审核/);
  assert.match(desktop, /需求 -> 拆解 -> 子任务 -> Review -> 发布 -> Live 验证 -> 验收/);
  assert.match(mobile, /项目、阶段、当前任务、Agent、进度和更新时间/);
  assert.match(desktop, /data-list="operations_timeline"/);
  assert.match(mobile, /data-list="operations_timeline"/);
  assert.match(desktop, /data-bind="counter_operation_events"/);
  assert.match(mobile, /data-bind="counter_operation_events"/);
  assert.match(desktop, /data-bind="next_action_readout_action"/);
  assert.match(mobile, /data-bind="next_action_readout_action"/);
  assert.match(desktop, /data-bind="next_action_terminal_status"/);
  assert.match(mobile, /data-bind="next_action_terminal_status"/);
  assert.match(desktop, /data-bind="next_action_terminal_action"/);
  assert.match(mobile, /data-bind="next_action_terminal_action"/);
  assert.match(desktop, /data-bind="next_action_terminal_reason"/);
  assert.match(mobile, /data-bind="next_action_terminal_reason"/);
  assert.match(desktop, /data-bind="scheduler_loop_strategy"/);
  assert.match(mobile, /data-bind="scheduler_loop_strategy"/);
  assert.match(desktop, /data-bind="shard_review_executor"/);
  assert.match(mobile, /data-bind="shard_review_executor"/);
  assert.match(desktop, /data-bind="shard_review_next"/);
  assert.match(mobile, /data-bind="shard_review_next"/);
  assert.match(desktop, /data-bind="shard_review_budget"/);
  assert.match(mobile, /data-bind="shard_review_budget"/);
  assert.match(desktop, /data-workbench-next-action="guarded"/);
  assert.match(mobile, /data-workbench-next-action="guarded"/);
  assert.match(desktop, /data-scheduler-dispatch="dry-run"/);
  assert.match(mobile, /data-scheduler-dispatch="dry-run"/);
  assert.match(desktop, /data-scheduler-dispatch="approved-mock"/);
  assert.match(mobile, /data-scheduler-dispatch="approved-mock"/);
  assert.match(desktop, /data-autonomous-scheduler-loop="bounded"/);
  assert.match(mobile, /data-autonomous-scheduler-loop="bounded"/);
  assert.match(desktop, /data-autonomous-scheduler-loop="projected-mock"/);
  assert.match(mobile, /data-autonomous-scheduler-loop="projected-mock"/);
  assert.match(desktop, /data-autonomous-scheduler-loop="projected-real"/);
  assert.match(mobile, /data-autonomous-scheduler-loop="projected-real"/);
  assert.match(desktop, /data-autonomous-scheduler-loop-resume="bounded"/);
  assert.match(mobile, /data-autonomous-scheduler-loop-resume="bounded"/);
  assert.match(desktop, /data-provider-health="pass"/);
  assert.match(mobile, /data-provider-health="timeout"/);
  assert.doesNotMatch(desktop, /Work Packages|Context Pack\s*(?:-&gt;|->)\s*Run\s*(?:-&gt;|->)\s*Review\s*(?:-&gt;|->)\s*Continuation|Provider Health|Smoke OK|Smoke Timeout|role\(s\)|Projection|Closeout|Resume Health|Snapshot|Evidence|Scheduler Dispatch|Projected Mock Loop|Projected Real Loop|Projected Loop 已记录|Loop 已记录|Resume 已记录|Smoke 已记录/);
  assert.doesNotMatch(mobile, /Provider smoke|Smoke OK|Smoke Timeout|Projection|Closeout|Snapshot|Projected Mock Loop|Projected Real Loop|Replay|Issues|Dry run|Projected Loop 已记录|Loop 已记录|Resume 已记录|Smoke 已记录/);
  assert.match(desktop, /通道诊断详情/);
  assert.match(mobile, /诊断与高级调度/);
  assert.equal((mobile.match(/<details class="control-drawer">/g) || []).length >= 4, true);
  assert.match(mobile, /<summary>验收详情<\/summary>[\s\S]*data-bind="closeout_status"/);
  assert.match(mobile, /<summary>诊断与高级调度<\/summary>[\s\S]*data-bind="agent_lifecycle_pool_latest_timeout"/);
  assert.notEqual(desktop, mobile);
  assert.match(desktop, /desktop-app/);
  assert.match(mobile, /phone-app/);
});

test("workbench shell consumes projection json instead of logs", () => {
  const script = read("apps/workbench/workbench.js");
  const source = read("apps/workbench/projection-source.js");

  assert.match(script, /createProjectionSource/);
  assert.match(script, /closeout_status/);
  assert.match(script, /ui_verification_status/);
  assert.match(script, /ui_verification_partial/);
  assert.match(script, /resume_health_status/);
  assert.match(script, /provider_health_value/);
  assert.match(script, /scheduler_dispatch_status/);
  assert.match(script, /scheduler_policy_reason/);
  assert.match(script, /scheduler_next_action/);
  assert.match(script, /scheduler_continuation_ready/);
  assert.match(script, /scheduler_loop_status/);
  assert.match(script, /scheduler_loop_recovery/);
  assert.match(script, /scheduler_loop_resume_status/);
  assert.match(script, /agent_lifecycle_pool_status/);
  assert.match(script, /agent_lifecycle_pool_open/);
  assert.match(script, /agent_lifecycle_pool_unevaluated/);
  assert.match(script, /agent_lifecycle_pool_unclosed/);
  assert.match(script, /agent_lifecycle_pool_timed_out/);
  assert.match(script, /agent_lifecycle_pool_heartbeats/);
  assert.match(script, /agent_lifecycle_pool_latest_heartbeat/);
  assert.match(script, /agent_lifecycle_pool_latest_timeout/);
  assert.match(script, /agent_lifecycle_pool_next_action/);
  assert.match(script, /operations_timeline/);
  assert.match(script, /counter_operation_events/);
  assert.match(script, /next_action_readout_action/);
  assert.match(script, /next_action_terminal_status/);
  assert.match(script, /next_action_terminal_action/);
  assert.match(script, /next_action_terminal_reason/);
  assert.match(script, /scheduler_loop_strategy/);
  assert.match(script, /shard_review_executor/);
  assert.match(script, /shard_review_next/);
  assert.match(script, /shard_review_profile/);
  assert.match(script, /runNextAction/);
  assert.match(script, /projected_next_action/);
  assert.match(script, /approved_bounded_real_reviewer/);
  assert.match(script, /counter_scheduler_dispatch_steps/);
  assert.match(script, /runSchedulerDispatch/);
  assert.match(script, /approved_mock_non_dry_run/);
  assert.match(script, /runAutonomousSchedulerLoop/);
  assert.match(script, /resumeAutonomousSchedulerLoop/);
  assert.match(script, /projectionMode/);
  assert.match(script, /interactive-fixture/);
  assert.match(script, /release-readout/);
  assert.match(script, /LONG_ENGLISH_STATUS_PATTERN/);
  assert.match(script, /当前目标来自最新续跑状态/);
  assert.match(read("apps/workbench/styles.css"), /padding:\s*18px 16px calc\(18px \+ 64px \+ env\(safe-area-inset-bottom, 0px\)\)/);
  assert.match(read("apps/workbench/styles.css"), /scroll-padding-bottom:\s*calc\(64px \+ env\(safe-area-inset-bottom, 0px\)\)/);
  assert.match(read("apps/workbench/styles.css"), /\.mobile-tabbar\s*{[\s\S]*min-height:\s*64px;/);
  assert.match(read("apps/workbench/styles.css"), /data-projection-mode="release-readout"[\s\S]*data-scheduler-dispatch/);
  assert.match(source, /enqueueSchedulerNextCycle/);
  assert.match(source, /submitRequirement/);
  assert.match(source, /\/api\/workbench\/requirements/);
  assert.match(source, /updatePlanReview/);
  assert.match(source, /\/api\/workbench\/plan-reviews/);
  assert.match(source, /runAutonomousSchedulerLoop/);
  assert.match(script, /submitRequirement/);
  assert.match(script, /updatePlanReview/);
  assert.match(script, /auto_advance_after_plan_review/);
  assert.match(script, /正在确认方案并进入开发/);
  assert.match(script, /开发中/);
  assert.match(script, /requirement_intake/);
  assert.match(script, /plan_review_status/);
  assert.match(script, /等待大模型生成方案/);
  assert.match(script, /已生成方案，等待你审核/);
  assert.doesNotMatch(script, /由大模型根据需求生成验收方案（plan review 待审核）/);
  assert.match(script, /调度失败/);
  assert.match(script, /调度已拦截/);
  assert.match(script, /recordProviderHealth/);
  assert.match(script, /连通写入失败/);
  assert.match(source, /current-session-workbench-projection\.json/);
  assert.doesNotMatch(script, /console\.log|PROCESS\.md|PROJECT_STATUS\.json/);
});

test("scheduler dispatch writeback accepts translated rendered pass without weakening raw semantics", () => {
  const checker = read("tools/check-scheduler-dispatch-writeback.mjs");

  assert.equal(isRenderedSchedulerDispatchPassStatus("pass"), true);
  assert.equal(isRenderedSchedulerDispatchPassStatus("通过"), true);
  assert.equal(isRenderedSchedulerDispatchPassStatus("未通过"), false);
  assert.equal(isRenderedSchedulerDispatchPassStatus("失败"), false);
  assert.equal(isRenderedSchedulerDispatchPassStatus("blocked"), false);
  assert.match(checker, /summary\.record_status === "pass"/);
  assert.match(checker, /summary\.projection_scheduler_status === "pass"/);
  assert.match(checker, /summary\.projection_scheduler_steps === 3/);
  assert.match(checker, /projection\.scheduler_dispatch\.status === "pass"/);
  assert.match(checker, /projection\.scheduler_dispatch\.step_count === 3/);
  assert.doesNotMatch(checker, /projection\.scheduler_dispatch\.status[\s\S]*isRenderedSchedulerDispatchPassStatus/);
});

test("browser events gate accepts only semantic cleared scheduler loop recovery readouts", () => {
  const checker = read("tools/check-workbench-browser-events.mjs");

  assert.match(checker, /CLEARED_SCHEDULER_LOOP_RECOVERY_COPY = "等待状态上报；下一步查看推荐任务。"/);
  assert.match(checker, /IDLE_SCHEDULER_LOOP_RECOVERY_COPY = "空闲，等待可派发任务"/);
  assert.match(checker, /NO_SOURCE_RESUME_ATTEMPT_COPY = "该通道未启用；无阻塞时继续主任务。"/);
  assert.match(checker, /RAW_SCHEDULER_LOOP_RECOVERY_TOKENS = new Set/);
  assert.match(checker, /RAW_RESUME_ATTEMPT_CLAIM_TOKENS = new Set/);
  assert.match(checker, /"no_dispatchable_scheduler_actions"/);
  assert.match(checker, /"scheduler_loop_resume_attempt"/);
  assert.match(checker, /function isClearedSchedulerLoopRecoveryReadout/);
  assert.match(checker, /function isNoSourceResumeAttemptReadout/);
  assert.match(checker, /RAW_SCHEDULER_LOOP_RECOVERY_TOKENS\.has\(normalized\)[\s\S]*return false/);
  assert.match(checker, /RAW_RESUME_ATTEMPT_CLAIM_TOKENS\.has\(normalized\)[\s\S]*return false/);
  assert.match(checker, /assert\(isClearedSchedulerLoopRecoveryReadout\(resumedLoopRecovery\)/);
  assert.match(checker, /assert\(isNoSourceResumeAttemptReadout\(resumedLoopAttempt\)/);
  assert.doesNotMatch(checker, /resumedLoopRecovery === "空闲"/);
  assert.doesNotMatch(checker, /resumedLoopAttempt === "未配置"/);
});

test("desktop shell is fixed viewport without horizontal overflow by design", () => {
  const css = read("apps/workbench/styles.css");

  assert.match(css, /body\s*{[\s\S]*overflow:\s*hidden;/);
  assert.match(css, /\.desktop-app\s*{[\s\S]*width:\s*100vw;[\s\S]*height:\s*100dvh;/);
  assert.match(css, /\.workbench\s*{[\s\S]*min-width:\s*0;/);
});

test("workbench files avoid legacy and managed project references", () => {
  const combined = [...FILES, "apps/workbench/projection-source.js"].map(read).join("\n");

  assert.doesNotMatch(combined, /stock_dashboard|legacy\/|local-control-server|dashboard-ui/);
});

test("frontend refactor constraints document is durable and codifies antd + next.js single-page app rules", () => {
  const constraints = read("apps/workbench/FRONTEND_REFACTOR_CONSTRAINTS.md");

  // Stack constraints
  assert.match(constraints, /Ant Design/);
  assert.match(constraints, /antd/);
  assert.match(constraints, /React/);
  assert.match(constraints, /Next\.js/);
  assert.match(constraints, /App Router/);

  // Component / layout rules
  assert.match(constraints, /禁止自造基础组件/);
  assert.match(constraints, /布局组件强制走 antd/);
  assert.match(constraints, /Layout/);
  assert.match(constraints, /Sider/);
  assert.match(constraints, /单页 app 形态必须保留/);
  assert.match(constraints, /原有 CSS 默认不保留/);

  // Project structure anchors
  assert.match(constraints, /apps\/workbench\/app\//);
  assert.match(constraints, /apps\/workbench\/lib\/api\//);

  // Inventory anchors (so the migration baseline cannot silently drift)
  assert.match(constraints, /apps\/workbench\/desktop\.html/);
  assert.match(constraints, /apps\/workbench\/mobile\.html/);
  assert.match(constraints, /apps\/workbench\/workbench\.js/);
  assert.match(constraints, /apps\/workbench\/projection-source\.js/);
  assert.match(constraints, /apps\/workbench\/styles\.css/);
  assert.match(constraints, /\/api\/workbench\/projection/);
  assert.match(constraints, /\/api\/workbench\/events/);
  assert.match(constraints, /\/api\/workbench\/requirements/);

  // Gate mapping (so future refactors cannot weaken acceptance gates)
  assert.match(constraints, /check:workbench:browser-events/);
  assert.match(constraints, /check:workbench:frontend-acceptance/);
  assert.match(constraints, /check:closeout/);

  // Forbidden second UI framework
  assert.doesNotMatch(constraints, /shadcn|chakra|MUI/i);
});

test("frontend migration inventory baseline is durable and enumerates entries, views, assets, scripts, and APIs", () => {
  const inventory = read("apps/workbench/FRONTEND_MIGRATION_INVENTORY.md");

  // Step 1 framing
  assert.match(inventory, /Frontend Migration Inventory/);
  assert.match(inventory, /Step 1/);
  assert.match(inventory, /requirement-unknown-20260526033003/);
  assert.match(inventory, /FRONTEND_REFACTOR_CONSTRAINTS\.md/);

  // 1. Native entries
  assert.match(inventory, /apps\/workbench\/desktop\.html/);
  assert.match(inventory, /apps\/workbench\/mobile\.html/);
  assert.match(inventory, /\/projects\/ai-control-platform/);

  // 2. SPA tabs (must keep single-page-app form)
  for (const tab of [
    "overview",
    "requirements",
    "projects",
    "flow",
    "agents",
    "risks",
    "governance",
    "runs"
  ]) {
    assert.match(inventory, new RegExp(`\\b${tab}\\b`));
  }

  // 3. Static resources
  assert.match(inventory, /apps\/workbench\/styles\.css/);
  assert.match(inventory, /apps\/workbench\/favicon\.svg/);

  // 4. Application scripts (no inline scripts allowed)
  assert.match(inventory, /apps\/workbench\/workbench\.js/);
  assert.match(inventory, /apps\/workbench\/projection-source\.js/);

  // 5. Backend API surface that the new Next.js client must keep calling
  for (const path of [
    "/api/workbench/projection",
    "/api/workbench/projections",
    "/api/workbench/events",
    "/api/workbench/snapshots",
    "/api/workbench/requirements",
    "/api/workbench/plan-reviews",
    "/api/workbench/reviewer-provider-health",
    "/api/workbench/reviewer-shard-result",
    "/api/workbench/agent-lifecycle-pool",
    "/api/workbench/next-action",
    "/api/workbench/scheduler-dispatch",
    "/api/workbench/scheduler-dispatch-plan",
    "/api/workbench/scheduler-dispatch-run",
    "/api/workbench/scheduler-next-cycle",
    "/api/workbench/autonomous-scheduler-loop",
    "/api/workbench/autonomous-scheduler-loop-resume",
    "/api/workbench/project-status-continuation",
    "/api/workbench/context-pack-cycle",
    "/api/workbench/context-work-packages-run",
    "/api/workbench/reviewer-shard-run",
    "/api/workbench/workbench-browser-events-run"
  ]) {
    assert.match(inventory, new RegExp(path.replace(/[/-]/g, (c) => `\\${c}`)));
  }

  // 6. Data binding contract (must survive antd migration)
  for (const key of [
    "data-bind",
    "data-list",
    "data-workbench-tab",
    "data-requirement-form",
    "data-requirement-submit",
    "data-plan-review-action",
    "data-scheduler-dispatch",
    "data-autonomous-scheduler-loop",
    "data-workbench-next-action",
    "data-provider-health",
    "data-history-select"
  ]) {
    assert.match(inventory, new RegExp(key));
  }

  // 7. Migration slice ordering + rollback evidence
  assert.match(inventory, /迁移清单/);
  assert.match(inventory, /回退/);
  assert.match(inventory, /check:workbench:browser-events/);
  assert.match(inventory, /check:workbench:frontend-acceptance/);
  assert.match(inventory, /check:closeout/);
  assert.match(inventory, /served-route/);

  // Forbidden drift: do not silently allow a second base component library
  assert.doesNotMatch(inventory, /shadcn|chakra|\bMUI\b/i);
});

test("workbench controls do not show success when operator event persistence fails", () => {
  const script = read("apps/workbench/workbench.js");

  assert.match(script, /事件写入失败/);
  assert.match(script, /事件未写入/);
  assert.match(script, /button\.dataset\.eventState = "recorded"/);
  assert.match(script, /catch \{[\s\S]*button\.dataset\.eventState = "failed";[\s\S]*return;[\s\S]*\}/);
});

test("next.js + antd skeleton is durable: package, config, layout, providers, theme, entry, api client are present", () => {
  // Step 02/7 of the requirement-unknown-20260526033003 frontend refactor:
  // a Next.js (App Router) + Ant Design skeleton must exist under
  // `apps/workbench/`. This test fixes the skeleton's shape so subsequent
  // slices cannot silently drop the antd-only baseline or break SPA form.

  // 1. Package manifest must select Next.js App Router + antd + React 18 + TS.
  const pkg = JSON.parse(read("apps/workbench/package.json"));
  assert.equal(pkg.private, true);
  assert.ok(pkg.scripts && pkg.scripts.build && pkg.scripts.dev,
    "next dev / build scripts must be present");
  assert.match(pkg.scripts.build, /next build/);
  assert.match(pkg.scripts.dev, /next dev/);
  assert.ok(pkg.dependencies, "dependencies must be declared");
  for (const dep of [
    "next",
    "react",
    "react-dom",
    "antd",
    "@ant-design/icons",
    "@ant-design/nextjs-registry"
  ]) {
    assert.ok(pkg.dependencies[dep], `missing required dependency: ${dep}`);
  }
  assert.ok(
    pkg.devDependencies && pkg.devDependencies.typescript,
    "typescript must be a devDependency"
  );
  // Forbid a second base UI framework slipping in.
  const allDeps = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {})
  };
  for (const banned of [
    "@mui/material",
    "@chakra-ui/react",
    "shadcn-ui",
    "@shadcn/ui"
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(allDeps, banned),
      false,
      `forbidden second UI framework dependency: ${banned}`
    );
  }

  // 2. Next.js config + TS config exist and stay declarative.
  const nextConfig = read("apps/workbench/next.config.mjs");
  assert.match(nextConfig, /reactStrictMode/);
  assert.match(nextConfig, /WORKBENCH_API_BASE/);
  // antd v5 在 App Router 下需要 transpilePackages，否则 build 时
  // server components 客户端清单会丢失 barrel optimized 子模块。
  assert.match(nextConfig, /transpilePackages/);
  assert.match(nextConfig, /"antd"/);
  assert.match(nextConfig, /"@ant-design\/icons"/);
  const tsConfig = JSON.parse(read("apps/workbench/tsconfig.json"));
  assert.equal(tsConfig.compilerOptions.strict, true);
  assert.equal(tsConfig.compilerOptions.jsx, "preserve");
  assert.ok(tsConfig.compilerOptions.paths && tsConfig.compilerOptions.paths["@/*"],
    "tsconfig must expose '@/*' path alias");

  // 3. App Router root layout uses antd via AppProviders + WorkbenchShell.
  const layout = read("apps/workbench/app/layout.tsx");
  assert.match(layout, /AppProviders/);
  assert.match(layout, /WorkbenchShell/);
  assert.match(layout, /<html lang="zh-CN">/);

  // 4. Providers wire ConfigProvider + AntdRegistry + AntdApp.
  const providers = read("apps/workbench/app/providers.tsx");
  assert.match(providers, /"use client";/);
  assert.match(providers, /@ant-design\/nextjs-registry/);
  assert.match(providers, /antd\/locale\/zh_CN/);
  assert.match(providers, /ConfigProvider/);
  assert.match(providers, /AntdRegistry/);

  // 5. Shell is built from antd Layout / Sider / Header / Menu (no naked
  //    divs trying to re-implement layout primitives).
  const shell = read("apps/workbench/app/shell.tsx");
  assert.match(shell, /"use client";/);
  assert.match(shell, /from "antd"/);
  assert.match(shell, /Layout/);
  assert.match(shell, /Sider/);
  assert.match(shell, /Header/);
  assert.match(shell, /Content/);
  assert.match(shell, /Menu/);
  assert.match(shell, /usePathname/);
  assert.match(shell, /useRouter/);
  // The SPA tabs from FRONTEND_MIGRATION_INVENTORY.md must survive here.
  for (const key of [
    "overview",
    "requirements",
    "projects",
    "flow",
    "agents",
    "risks",
    "governance",
    "runs"
  ]) {
    assert.match(shell, new RegExp(`key: "${key}"`));
  }

  // 6. Theme tokens centralised in app/theme.ts (no per-component hard-coding).
  const themeFile = read("apps/workbench/app/theme.ts");
  assert.match(themeFile, /ThemeConfig/);
  assert.match(themeFile, /colorPrimary/);
  assert.match(themeFile, /Layout:/);

  // 7. Entry page uses antd components only (no naked div / inline css spree).
  const page = read("apps/workbench/app/page.tsx");
  assert.match(page, /from "antd"/);
  assert.match(page, /Card/);
  assert.match(page, /Descriptions/);
  assert.match(page, /WORKBENCH_API_ENDPOINTS/);
  // Loading / error / 404 boundaries also via antd.
  assert.match(read("apps/workbench/app/loading.tsx"), /Skeleton/);
  assert.match(read("apps/workbench/app/error.tsx"), /Result/);
  assert.match(read("apps/workbench/app/not-found.tsx"), /Result/);

  // 8. API client base + endpoint surface stays in sync with the inventory.
  const api = read("apps/workbench/lib/api/index.ts");
  assert.match(api, /WORKBENCH_API_BASE/);
  assert.match(api, /WORKBENCH_API_ENDPOINTS/);
  assert.match(api, /fetchWorkbenchJson/);
  for (const path of [
    "/api/workbench/projection",
    "/api/workbench/projections",
    "/api/workbench/events",
    "/api/workbench/requirements",
    "/api/workbench/plan-reviews",
    "/api/workbench/scheduler-dispatch",
    "/api/workbench/autonomous-scheduler-loop"
  ]) {
    assert.match(api, new RegExp(path.replace(/[/-]/g, (c) => `\\${c}`)));
  }
  const projectionApi = read("apps/workbench/lib/api/projection.ts");
  assert.match(projectionApi, /fetchCurrentProjection/);
  assert.match(projectionApi, /fetchProjectionHistory/);

  // 9. Readme documents the local interop matrix between workbench-server
  //    (4180) and the new Next.js skeleton (4181) so future agents do not
  //    duplicate backend semantics in the new frontend.
  const readme = read("apps/workbench/README.md");
  assert.match(readme, /Next\.js \(App Router\) \+ Ant Design/);
  assert.match(readme, /workbench-server\.mjs/);
  assert.match(readme, /4180/);
  assert.match(readme, /4181/);
  assert.match(readme, /WORKBENCH_API_BASE/);
  assert.match(readme, /npm run build/);
});
