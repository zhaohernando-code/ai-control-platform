import {
  CLEARED_LIFECYCLE_NEXT_ACTION_COPY,
  injectLifecycleCleanupState,
  injectLifecycleTimeoutState,
  writeLifecycleCleanupProjectStatus
} from "./workbench-browser-events-fixtures.mjs";
import {
  assert,
  dimensions,
  openWorkbench,
  readout,
  withNextWorkbenchRuntime
} from "./workbench-browser-events-runtime.mjs";

export async function verifyLifecycleTimeoutReadout(browser, { recordScenario }) {
  await withNextWorkbenchRuntime(async ({ baseUrl }) => {
    const desktop = await openWorkbench(browser, baseUrl, { viewport: { width: 1440, height: 900 } });
    const mobile = await openWorkbench(browser, baseUrl, { viewport: { width: 390, height: 844 }, isMobile: true });
    const desktopStatus = await readout(desktop, "agent_lifecycle_pool_status");
    const mobileStatus = await readout(mobile, "agent_lifecycle_pool_status");
    const desktopTimedOut = await readout(desktop, "agent_lifecycle_pool_timed_out");
    const mobileTimedOut = await readout(mobile, "agent_lifecycle_pool_timed_out");
    const desktopHeartbeats = await readout(desktop, "agent_lifecycle_pool_heartbeats");
    const mobileHeartbeats = await readout(mobile, "agent_lifecycle_pool_heartbeats");
    const desktopLatestHeartbeat = await readout(desktop, "agent_lifecycle_pool_latest_heartbeat");
    const mobileLatestHeartbeat = await readout(mobile, "agent_lifecycle_pool_latest_heartbeat");
    const desktopLatestTimeout = await readout(desktop, "agent_lifecycle_pool_latest_timeout");
    const mobileLatestTimeout = await readout(mobile, "agent_lifecycle_pool_latest_timeout");
    const desktopNextActionStatus = await readout(desktop, "next_action_terminal_status");
    const desktopDimensions = await dimensions(desktop);
    const mobileDimensions = await dimensions(mobile);
    await desktop.close();
    await mobile.close();

    assert(desktopStatus === "受阻", "desktop timeout lifecycle pool must render blocked status");
    assert(mobileStatus === "受阻", "mobile timeout lifecycle pool must render blocked status");
    assert(desktopTimedOut === "1" && mobileTimedOut === "1", "lifecycle pool must render one timeout");
    assert(desktopHeartbeats === "1" && mobileHeartbeats === "1", "lifecycle pool must render one heartbeat");
    assert(desktopLatestHeartbeat.includes("2026-05-22T08:16:00.000Z"), "desktop lifecycle pool must render latest heartbeat");
    assert(mobileLatestHeartbeat.includes("2026-05-22T08:16:00.000Z"), "mobile lifecycle pool must render latest heartbeat");
    assert(desktopLatestTimeout.includes("2026-05-22T08:20:00.000Z"), "desktop lifecycle pool must render latest timeout");
    assert(mobileLatestTimeout.includes("2026-05-22T08:20:00.000Z"), "mobile lifecycle pool must render latest timeout");
    recordScenario({
      scenario: "agent_lifecycle_pool_timeout_readout",
      desktop_status: desktopStatus,
      desktop_timed_out: desktopTimedOut,
      desktop_heartbeats: desktopHeartbeats,
      desktop_latest_heartbeat: desktopLatestHeartbeat,
      desktop_latest_timeout: desktopLatestTimeout,
      desktop_next_action_status: desktopNextActionStatus,
      mobile_status: mobileStatus,
      mobile_timed_out: mobileTimedOut,
      mobile_heartbeats: mobileHeartbeats,
      mobile_latest_heartbeat: mobileLatestHeartbeat,
      mobile_latest_timeout: mobileLatestTimeout,
      desktop_dimensions: desktopDimensions,
      mobile_dimensions: mobileDimensions
    });
  }, { workflowStateMutator: injectLifecycleTimeoutState });
}

export async function verifyLifecycleCleanup(browser, { recordScenario }) {
  await withNextWorkbenchRuntime(async ({ baseUrl }) => {
    const page = await openWorkbench(browser, baseUrl, { viewport: { width: 1440, height: 900 } });
    const cleanupBeforeStatus = await readout(page, "agent_lifecycle_pool_status");
    const cleanupBeforeOpen = await readout(page, "agent_lifecycle_pool_open");
    const cleanupBeforeUnevaluated = await readout(page, "agent_lifecycle_pool_unevaluated");
    const cleanupBeforeUnclosed = await readout(page, "agent_lifecycle_pool_unclosed");
    const cleanupBeforeNextAction = await readout(page, "agent_lifecycle_pool_next_action");
    const projectedAction = await readout(page, "next_action_readout_action");
    await page.click('[data-workbench-next-action="guarded"]');
    await page.waitForFunction(() => document.querySelector('[data-workbench-next-action="guarded"]')?.textContent.includes("推荐动作已记录"));
    const cleanupAfterStatus = await readout(page, "agent_lifecycle_pool_status");
    const cleanupAfterOpen = await readout(page, "agent_lifecycle_pool_open");
    const cleanupAfterUnevaluated = await readout(page, "agent_lifecycle_pool_unevaluated");
    const cleanupAfterUnclosed = await readout(page, "agent_lifecycle_pool_unclosed");
    const cleanupAfterNextAction = await readout(page, "agent_lifecycle_pool_next_action");
    const nextActionReadout = await readout(page, "next_action_readout_action");
    const pageDimensions = await dimensions(page);
    await page.close();

    assert(cleanupBeforeStatus === "unevaluated", "lifecycle cleanup scenario must start with unevaluated pool");
    assert(cleanupBeforeOpen === "0", "completed lifecycle worker should not remain open before cleanup");
    assert(cleanupBeforeUnevaluated === "1", "lifecycle cleanup scenario must start with one unevaluated worker");
    assert(cleanupBeforeUnclosed === "1", "lifecycle cleanup scenario must start with one unclosed worker");
    assert(cleanupBeforeNextAction === "cleanup_agent_lifecycle_pool", "lifecycle pool must render cleanup next action before guarded click");
    assert(projectedAction === "cleanup_agent_lifecycle_pool", "guarded next action must execute lifecycle cleanup projection");
    assert(cleanupAfterStatus === "通过", "guarded lifecycle cleanup must render pass after execution");
    assert(cleanupAfterOpen === "0", "guarded lifecycle cleanup must leave no open workers");
    assert(cleanupAfterUnevaluated === "0", "guarded lifecycle cleanup must leave no unevaluated workers");
    assert(cleanupAfterUnclosed === "0", "guarded lifecycle cleanup must leave no unclosed workers");
    assert(cleanupAfterNextAction === CLEARED_LIFECYCLE_NEXT_ACTION_COPY, "guarded lifecycle cleanup must render cleared lifecycle next action");
    assert(nextActionReadout !== "cleanup_agent_lifecycle_pool", "guarded lifecycle cleanup must advance next-action readout");
    recordScenario({
      scenario: "agent_lifecycle_pool_cleanup_click",
      cleanup_before_status: cleanupBeforeStatus,
      cleanup_before_open: cleanupBeforeOpen,
      cleanup_before_unevaluated: cleanupBeforeUnevaluated,
      cleanup_before_unclosed: cleanupBeforeUnclosed,
      cleanup_before_next_action: cleanupBeforeNextAction,
      projected_action: projectedAction,
      cleanup_after_status: cleanupAfterStatus,
      cleanup_after_open: cleanupAfterOpen,
      cleanup_after_unevaluated: cleanupAfterUnevaluated,
      cleanup_after_unclosed: cleanupAfterUnclosed,
      cleanup_after_next_action: cleanupAfterNextAction,
      next_action_readout: nextActionReadout,
      dimensions: pageDimensions
    });
  }, {
    workflowStateMutator: injectLifecycleCleanupState,
    projectStatusFactory: writeLifecycleCleanupProjectStatus
  });
}

export async function verifyLifecycleCleanupLoop(browser, { recordScenario }) {
  await withNextWorkbenchRuntime(async ({ baseUrl }) => {
    const page = await openWorkbench(browser, baseUrl, { viewport: { width: 1440, height: 900 } });
    const cleanupBeforeStatus = await readout(page, "agent_lifecycle_pool_status");
    const projectedAction = await readout(page, "next_action_readout_action");
    await page.click('[data-autonomous-scheduler-loop="projected-mock"]');
    await page.waitForFunction(() => document.querySelector('[data-autonomous-scheduler-loop="projected-mock"]')?.textContent.includes("投影推进已记录"));
    const result = {
      scenario: "agent_lifecycle_pool_cleanup_loop_click",
      cleanup_before_status: cleanupBeforeStatus,
      projected_action: projectedAction,
      scheduler_loop_status: await readout(page, "scheduler_loop_status"),
      scheduler_loop_strategy: await readout(page, "scheduler_loop_strategy"),
      cleanup_after_status: await readout(page, "agent_lifecycle_pool_status"),
      cleanup_after_open: await readout(page, "agent_lifecycle_pool_open"),
      cleanup_after_unevaluated: await readout(page, "agent_lifecycle_pool_unevaluated"),
      cleanup_after_unclosed: await readout(page, "agent_lifecycle_pool_unclosed"),
      next_action_readout: await readout(page, "next_action_readout_action"),
      dimensions: await dimensions(page)
    };
    await page.close();
    assert(result.cleanup_before_status === "unevaluated", "lifecycle loop cleanup scenario must start with unevaluated pool");
    assert(result.projected_action === "cleanup_agent_lifecycle_pool", "projected loop must start from lifecycle cleanup action");
    assert(result.scheduler_loop_status === "通过", "projected lifecycle cleanup loop must render loop pass");
    assert(result.scheduler_loop_strategy === "按推荐动作推进", "projected lifecycle cleanup loop must render translated projected strategy");
    assert(result.cleanup_after_status === "通过", "projected lifecycle cleanup loop must render lifecycle pass");
    assert(result.cleanup_after_open === "0", "projected lifecycle cleanup loop must leave no open workers");
    assert(result.cleanup_after_unevaluated === "0", "projected lifecycle cleanup loop must leave no unevaluated workers");
    assert(result.cleanup_after_unclosed === "0", "projected lifecycle cleanup loop must leave no unclosed workers");
    assert(result.next_action_readout !== "cleanup_agent_lifecycle_pool", "projected lifecycle cleanup loop must advance next-action readout");
    recordScenario(result);
  }, {
    workflowStateMutator: injectLifecycleCleanupState,
    projectStatusFactory: writeLifecycleCleanupProjectStatus
  });
}
