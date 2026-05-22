import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const FILES = [
  "apps/workbench/desktop.html",
  "apps/workbench/mobile.html",
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
  assert.match(desktop, /data-history-select/);
  assert.match(mobile, /data-history-select/);
  assert.match(desktop, /data-bind="closeout_status"/);
  assert.match(mobile, /data-bind="closeout_status"/);
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
  assert.match(desktop, /data-bind="counter_scheduler_dispatch_steps"/);
  assert.match(mobile, /data-bind="counter_scheduler_dispatch_steps"/);
  assert.match(desktop, /data-list="operations_timeline"/);
  assert.match(mobile, /data-list="operations_timeline"/);
  assert.match(desktop, /data-bind="counter_operation_events"/);
  assert.match(mobile, /data-bind="counter_operation_events"/);
  assert.match(desktop, /data-bind="next_action_readout_action"/);
  assert.match(mobile, /data-bind="next_action_readout_action"/);
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
  assert.match(source, /enqueueSchedulerNextCycle/);
  assert.match(source, /runAutonomousSchedulerLoop/);
  assert.match(script, /调度失败/);
  assert.match(script, /调度已拦截/);
  assert.match(script, /recordProviderHealth/);
  assert.match(script, /Smoke 写入失败/);
  assert.match(source, /current-session-workbench-projection\.json/);
  assert.doesNotMatch(script, /console\.log|PROCESS\.md|PROJECT_STATUS\.json/);
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
