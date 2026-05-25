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
  assert.match(source, /runAutonomousSchedulerLoop/);
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

test("workbench controls do not show success when operator event persistence fails", () => {
  const script = read("apps/workbench/workbench.js");

  assert.match(script, /事件写入失败/);
  assert.match(script, /事件未写入/);
  assert.match(script, /button\.dataset\.eventState = "recorded"/);
  assert.match(script, /catch \{[\s\S]*button\.dataset\.eventState = "failed";[\s\S]*return;[\s\S]*\}/);
});
