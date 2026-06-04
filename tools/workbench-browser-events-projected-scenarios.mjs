import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createWorkbenchProjection } from "../src/workflow/workbench-projection.js";
import {
  clearRequirementIntakeState,
  injectTerminalNextActionState,
  isClearedSchedulerLoopRecoveryReadout,
  isNoSourceResumeAttemptReadout,
  pendingReviewerShardWorkflowState,
  writePendingReviewerProjectStatus
} from "./workbench-browser-events-fixtures.mjs";
import {
  assert,
  dimensions,
  openWorkbench,
  readout,
  withNextWorkbenchRuntime
} from "./workbench-browser-events-runtime.mjs";

export async function verifyProjectedLoops(browser, { recordScenario }) {
  await withNextWorkbenchRuntime(async ({ baseUrl }) => {
    const page = await openWorkbench(browser, baseUrl, { viewport: { width: 1440, height: 900 } });
    await page.click('[data-autonomous-scheduler-loop="projected-mock"]');
    await page.waitForFunction(() => document.querySelector('[data-autonomous-scheduler-loop="projected-mock"]')?.textContent.includes("投影推进已记录"));
    recordScenario({
      scenario: "projected_mock_loop_click",
      scheduler_loop_status: await readout(page, "scheduler_loop_status"),
      scheduler_loop_iterations: await readout(page, "scheduler_loop_iterations"),
      scheduler_loop_strategy: await readout(page, "scheduler_loop_strategy"),
      shard_review_completed: await readout(page, "shard_review_completed"),
      shard_review_status: await readout(page, "shard_review_status"),
      shard_review_executor: await readout(page, "shard_review_executor"),
      shard_review_budget: await readout(page, "shard_review_budget"),
      next_action_readout: await readout(page, "next_action_readout_action"),
      dimensions: await dimensions(page)
    });
    await page.close();
  }, {
    workflowStateMutator: pendingReviewerShardWorkflowState,
    projectStatusFactory: writePendingReviewerProjectStatus
  });

  const calls = [];
  await withNextWorkbenchRuntime(async ({ baseUrl }) => {
    const page = await openWorkbench(browser, baseUrl, { viewport: { width: 1440, height: 900 } });
    await page.click('[data-autonomous-scheduler-loop="projected-real"]');
    await page.waitForFunction(() => document.querySelector('[data-autonomous-scheduler-loop="projected-real"]')?.textContent.includes("投影推进已记录"));
    const result = {
      scenario: "projected_real_partial_shard_readout",
      scheduler_loop_status: await readout(page, "scheduler_loop_status"),
      scheduler_loop_iterations: await readout(page, "scheduler_loop_iterations"),
      scheduler_loop_strategy: await readout(page, "scheduler_loop_strategy"),
      shard_review_completed: await readout(page, "shard_review_completed"),
      shard_review_next: await readout(page, "shard_review_next"),
      shard_review_executor: await readout(page, "shard_review_executor"),
      shard_review_budget: await readout(page, "shard_review_budget"),
      next_action_readout: await readout(page, "next_action_readout_action"),
      dimensions: await dimensions(page)
    };
    await page.close();
    assert(calls.length === 1 && calls[0] === "reviewer-scope-shard-001", "projected real partial run must execute only the first shard");
    assert(result.shard_review_next === "reviewer-scope-shard-002", "projected real partial loop must render next pending shard");
    assert(result.next_action_readout === "run_reviewer_scope_shard", "projected real partial loop must recommend the next shard");
    recordScenario(result);
  }, {
    workflowStateMutator: pendingReviewerShardWorkflowState,
    projectStatusPath: null,
    realReviewerExecutor: async ({ shard }) => {
      calls.push(shard.id);
      return {
        status: "pass",
        findings: [],
        provenance: {
          executor_kind: "browser_test_real_reviewer",
          provider: "deepseek",
          model: "deepseek-v4-pro",
          timeout_seconds: 90,
          external_call_budget_used: 1
        }
      };
    }
  });
}

export async function verifyTerminalReadout(browser, { recordScenario }) {
  await withNextWorkbenchRuntime(async ({ baseUrl }) => {
    const desktop = await openWorkbench(browser, baseUrl, { viewport: { width: 1440, height: 900 } });
    const mobile = await openWorkbench(browser, baseUrl, { viewport: { width: 390, height: 844 }, isMobile: true });
    const desktopReadout = await readout(desktop, "next_action_readout_action");
    const desktopTerminalStatus = await readout(desktop, "next_action_terminal_status");
    const desktopTerminalAction = await readout(desktop, "next_action_terminal_action");
    const desktopTerminalReason = await readout(desktop, "next_action_terminal_reason");
    const mobileTerminalStatus = await readout(mobile, "next_action_terminal_status");
    const mobileTerminalAction = await readout(mobile, "next_action_terminal_action");
    const mobileTerminalReason = await readout(mobile, "next_action_terminal_reason");
    const desktopDimensions = await dimensions(desktop);
    const mobileDimensions = await dimensions(mobile);
    await desktop.close();
    await mobile.close();
    assert(desktopReadout === "inspect_scheduler_loop", "terminal next-action scenario must render inspect readout");
    assert(desktopTerminalAction === "inspect_scheduler_loop", "desktop terminal action must render inspect action");
    assert(desktopTerminalReason.includes("projected next action"), "desktop terminal reason must render stop reason");
    assert(mobileTerminalAction === "inspect_scheduler_loop", "mobile terminal action must render inspect action");
    assert(mobileTerminalReason.includes("projected next action"), "mobile terminal reason must render stop reason");
    recordScenario({
      scenario: "terminal_next_action_readout",
      next_action_readout: desktopReadout,
      desktop_terminal_status: desktopTerminalStatus,
      desktop_terminal_action: desktopTerminalAction,
      desktop_terminal_reason: desktopTerminalReason,
      mobile_terminal_status: mobileTerminalStatus,
      mobile_terminal_action: mobileTerminalAction,
      mobile_terminal_reason: mobileTerminalReason,
      desktop_dimensions: desktopDimensions,
      mobile_dimensions: mobileDimensions
    });
  }, {
    workflowStateMutator: (workflowState) => {
      clearRequirementIntakeState(workflowState);
      injectTerminalNextActionState(workflowState);
    },
    projectStatusPath: null
  });
}

export async function verifyAutonomousLoopAndMobile(browser, { recordScenario }) {
  await withNextWorkbenchRuntime(async ({ baseUrl }) => {
    const page = await openWorkbench(browser, baseUrl, { viewport: { width: 1440, height: 900 } });
    await page.click('[data-autonomous-scheduler-loop="bounded"]');
    await page.waitForFunction(() => document.querySelector('[data-autonomous-scheduler-loop="bounded"]')?.textContent.includes("调度轮次已记录"));
    const schedulerLoopStatus = await readout(page, "scheduler_loop_status");
    const schedulerLoopIterations = await readout(page, "scheduler_loop_iterations");
    const schedulerLoopRecovery = await readout(page, "scheduler_loop_recovery");
    await page.click('[data-autonomous-scheduler-loop-resume="bounded"]');
    await page.waitForFunction(() => document.querySelector('[data-autonomous-scheduler-loop-resume="bounded"]')?.textContent.includes("续跑已记录"));
    const resumedLoopStatus = await readout(page, "scheduler_loop_status");
    const resumedLoopRecovery = await readout(page, "scheduler_loop_recovery");
    const resumedLoopAttempt = await readout(page, "scheduler_loop_resume_status");
    const operationEventCount = await readout(page, "counter_operation_events");
    const operationRows = await page.locator('[data-next-list="operations_timeline"] .ant-card').count();
    const nextActionReadout = await readout(page, "next_action_readout_action");
    const pageDimensions = await dimensions(page);
    await page.close();
    assert(schedulerLoopStatus === "通过", "autonomous scheduler loop click must render loop pass");
    assert(schedulerLoopIterations === "1", "autonomous scheduler loop click must render one loop iteration");
    assert(schedulerLoopRecovery === "就绪", "autonomous scheduler loop click must render recovery readiness");
    assert(resumedLoopStatus === "通过", "autonomous scheduler loop resume must render loop pass");
    assert(isClearedSchedulerLoopRecoveryReadout(resumedLoopRecovery), "autonomous scheduler loop resume must render cleared idle recovery when no actions remain");
    assert(isNoSourceResumeAttemptReadout(resumedLoopAttempt), "resume target projection should not claim the source resume attempt");
    assert(Number(operationEventCount) >= 1, "autonomous scheduler loop resume must render operation event count");
    assert(operationRows >= 1, "autonomous scheduler loop resume must render operation timeline rows");
    assert(nextActionReadout, "autonomous scheduler loop resume must render next-action readout");
    recordScenario({
      scenario: "autonomous_scheduler_loop_click",
      scheduler_loop_status: schedulerLoopStatus,
      scheduler_loop_iterations: schedulerLoopIterations,
      scheduler_loop_recovery: schedulerLoopRecovery,
      resumed_loop_status: resumedLoopStatus,
      resumed_loop_recovery: resumedLoopRecovery,
      resumed_loop_attempt: resumedLoopAttempt,
      operation_events: operationEventCount,
      operation_rows: operationRows,
      next_action_readout: nextActionReadout,
      dimensions: pageDimensions
    });
  }, { workflowStateMutator: pendingReviewerShardWorkflowState, projectStatusPath: null });

  await withNextWorkbenchRuntime(async ({ baseUrl }) => {
    const page = await openWorkbench(browser, baseUrl, { viewport: { width: 390, height: 844 }, isMobile: true });
    const pageDimensions = await dimensions(page);
    assert(pageDimensions.scrollWidth <= pageDimensions.width, "mobile workbench must not overflow horizontally");
    const projectOverview = await page.locator("body").textContent();
    const operationRows = await page.locator('[data-next-list="operations_timeline"] .ant-card').count();
    recordScenario({
      scenario: "mobile_projection",
      project_overview: projectOverview?.includes("AI Control Platform") ? "AI Control Platform" : "",
      projects_total: String(await readout(page, "global_goals_total")),
      closeout_status: projectOverview?.includes("收口验收") ? "rendered" : "",
      resume_health_status: projectOverview?.includes("恢复健康") ? "rendered" : "",
      provider_health: await readout(page, "provider_health_value"),
      scheduler_dispatch_status: await readout(page, "scheduler_dispatch_status"),
      scheduler_dispatch_steps: await readout(page, "scheduler_dispatch_steps"),
      scheduler_continuation_ready: await readout(page, "scheduler_continuation_ready"),
      scheduler_loop_status: await readout(page, "scheduler_loop_status"),
      scheduler_loop_recovery: await readout(page, "scheduler_loop_recovery"),
      scheduler_loop_resume_status: await readout(page, "scheduler_loop_resume_status"),
      agent_lifecycle_pool_status: await readout(page, "agent_lifecycle_pool_status"),
      agent_lifecycle_pool_open: await readout(page, "agent_lifecycle_pool_open"),
      agent_lifecycle_pool_unevaluated: await readout(page, "agent_lifecycle_pool_unevaluated"),
      agent_lifecycle_pool_unclosed: await readout(page, "agent_lifecycle_pool_unclosed"),
      agent_lifecycle_pool_timed_out: await readout(page, "agent_lifecycle_pool_timed_out"),
      agent_lifecycle_pool_heartbeats: await readout(page, "agent_lifecycle_pool_heartbeats"),
      global_goals_completed: await readout(page, "global_goals_completed"),
      global_goals_total: await readout(page, "global_goals_total"),
      global_goals_blocked: await readout(page, "global_goals_blocked"),
      agent_lifecycle_pool_next_action: await readout(page, "agent_lifecycle_pool_next_action"),
      operation_rows: operationRows,
      next_action_readout: await readout(page, "next_action_readout_action"),
      dimensions: pageDimensions
    });
    await page.close();
  });
}

export async function verifyLatestDurableGlobalGoalLifecycleProjection(browser, { recordScenario }) {
  const durableProjectionId = "headless-live-context-cycle-1779570720000";
  const durableInputPath = resolve("docs/examples/headless-live-context-cycle-1779570720000.workbench-input.json");
  const durableWorkflowState = JSON.parse(readFileSync(durableInputPath, "utf8"));
  const durableProjection = createWorkbenchProjection(durableWorkflowState);
  await withNextWorkbenchRuntime(async ({ baseUrl }) => {
    const desktop = await openWorkbench(browser, baseUrl, { viewport: { width: 1440, height: 900 } });
    const mobile = await openWorkbench(browser, baseUrl, { viewport: { width: 390, height: 844 }, isMobile: true });
    const desktopDimensions = await dimensions(desktop);
    const mobileDimensions = await dimensions(mobile);
    recordScenario({
      scenario: "latest_durable_global_goal_lifecycle_projection",
      projection_id: durableProjectionId,
      durable_input_path: durableInputPath,
      desktop_global_completed: await readout(desktop, "global_goals_completed"),
      desktop_global_total: await readout(desktop, "global_goals_total"),
      desktop_global_blocked: await readout(desktop, "global_goals_blocked"),
      desktop_lifecycle_status: await readout(desktop, "agent_lifecycle_pool_status"),
      desktop_lifecycle_open: await readout(desktop, "agent_lifecycle_pool_open"),
      desktop_lifecycle_unevaluated: await readout(desktop, "agent_lifecycle_pool_unevaluated"),
      desktop_lifecycle_unclosed: await readout(desktop, "agent_lifecycle_pool_unclosed"),
      desktop_lifecycle_heartbeats: await readout(desktop, "agent_lifecycle_pool_heartbeats"),
      mobile_global_completed: await readout(mobile, "global_goals_completed"),
      mobile_global_total: await readout(mobile, "global_goals_total"),
      mobile_global_blocked: await readout(mobile, "global_goals_blocked"),
      mobile_lifecycle_status: await readout(mobile, "agent_lifecycle_pool_status"),
      mobile_lifecycle_open: await readout(mobile, "agent_lifecycle_pool_open"),
      mobile_lifecycle_unevaluated: await readout(mobile, "agent_lifecycle_pool_unevaluated"),
      mobile_lifecycle_unclosed: await readout(mobile, "agent_lifecycle_pool_unclosed"),
      mobile_lifecycle_heartbeats: await readout(mobile, "agent_lifecycle_pool_heartbeats"),
      expected_lifecycle_completed: String(durableProjection.agent_lifecycle_pool.completed),
      expected_lifecycle_evaluated: String(durableProjection.agent_lifecycle_pool.evaluated),
      expected_lifecycle_closed: String(durableProjection.agent_lifecycle_pool.closed),
      desktop_dimensions: desktopDimensions,
      mobile_dimensions: mobileDimensions
    });
    assert(await readout(desktop, "global_goals_completed") === String(durableProjection.global_goal_completion.completed), "desktop durable projection must render expected completed global goals");
    assert(await readout(mobile, "global_goals_total") === String(durableProjection.global_goal_completion.total), "mobile durable projection must render expected total global goals");
    assert(await readout(desktop, "agent_lifecycle_pool_heartbeats") === String(durableProjection.agent_lifecycle_pool.heartbeat_count), "desktop durable projection must render expected lifecycle heartbeats");
    assert(await readout(mobile, "agent_lifecycle_pool_open") === String(durableProjection.agent_lifecycle_pool.open), "mobile durable projection must render expected lifecycle open count");
    await desktop.close();
    await mobile.close();
  }, {
    projectionId: durableProjectionId,
    projectionLabel: "Headless live context cycle",
    workflowStateFactory: () => durableWorkflowState,
    projectStatusPath: null
  });
}
