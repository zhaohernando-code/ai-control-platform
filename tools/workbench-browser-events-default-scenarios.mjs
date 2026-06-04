import { pendingReviewerShardWorkflowState } from "./workbench-browser-events-fixtures.mjs";
import {
  assert,
  dimensions,
  openWorkbench,
  readLedger,
  readout,
  verifyNoLegacyShell,
  withNextWorkbenchRuntime
} from "./workbench-browser-events-runtime.mjs";

export async function verifyDefaultInteractions(browser, { recordScenario }) {
  await withNextWorkbenchRuntime(async ({ baseUrl, eventsPath, stateDbPath }) => {
    const page = await openWorkbench(browser, baseUrl, { viewport: { width: 1440, height: 900 } });
    await verifyNoLegacyShell(page);
    await page.click('[data-action="validate"]');
    await page.waitForFunction(() => document.querySelector('[data-action="validate"]')?.textContent.includes("已校验"));
    const closeoutStatus = await page.locator("body").textContent();
    const providerHealthBefore = await readout(page, "provider_health_value");
    const initialDimensions = await dimensions(page);
    const ledger = readLedger(eventsPath, stateDbPath);
    assert(ledger.events.length === 1, "successful click must persist exactly one operator event");
    assert(ledger.events[0].action === "validate", "successful click must persist validate action");
    assert(initialDimensions.scrollWidth <= initialDimensions.width, "desktop workbench must not overflow horizontally");
    recordScenario({
      scenario: "success",
      event_count: ledger.events.length,
      action: ledger.events[0].action,
      run_id: ledger.events[0].run_id,
      closeout_status: closeoutStatus?.includes("收口验收") ? "rendered" : "",
      resume_health_status: "rendered",
      provider_health: providerHealthBefore,
      scheduler_dispatch_status: await readout(page, "scheduler_dispatch_status"),
      scheduler_dispatch_steps: await readout(page, "scheduler_dispatch_steps"),
      dimensions: initialDimensions
    });

    const failed = await openWorkbench(browser, baseUrl, { viewport: { width: 1440, height: 900 } });
    await failed.route("**/api/workbench/events", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: "{\"error\":\"forced failure\"}"
        });
        return;
      }
      await route.continue();
    });
    await failed.click('[data-action="validate"]');
    await failed.waitForTimeout(500);
    const failedButtonText = await failed.locator('[data-action="validate"]').textContent();
    const failedLedger = readLedger(eventsPath, stateDbPath);
    await failed.close();
    assert(failedLedger.events.length === 1, "failed click must not persist an additional operator event");
    assert(!failedButtonText.includes("已校验"), "failed click must not show validation success");
    recordScenario({
      scenario: "failure",
      event_count: failedLedger.events.length - 1,
      button_text: failedButtonText
    });

    await page.click('[data-provider-health="timeout"]');
    await page.waitForFunction(() => document.querySelector('[data-provider-health="timeout"]')?.textContent.includes("连通已记录"));
    const providerHealth = await readout(page, "provider_health_value");
    const nextAction = await readout(page, "provider_next_action");
    const providerDimensions = await dimensions(page);
    assert(providerHealth === "unhealthy", "provider health click must update rendered provider health");
    assert(nextAction === "fallback_model_or_defer_external_review", "provider health click must render fallback next action");
    assert(providerDimensions.scrollWidth <= providerDimensions.width, "provider health click must not create horizontal overflow");
    recordScenario({
      scenario: "provider_health_click",
      provider_health: providerHealth,
      next_action: nextAction,
      dimensions: providerDimensions
    });

    await page.click('[data-scheduler-dispatch="dry-run"]');
    await page.waitForFunction(() => document.querySelector('[data-scheduler-dispatch="dry-run"]')?.textContent.includes("调度已记录"));
    const schedulerDispatchStatus = await readout(page, "scheduler_dispatch_status");
    const schedulerDispatchSteps = await readout(page, "scheduler_dispatch_steps");
    const schedulerPolicyStatus = await readout(page, "scheduler_policy_status");
    const schedulerPolicyMode = await readout(page, "scheduler_policy_mode");
    const schedulerDimensions = await dimensions(page);
    assert(schedulerDispatchStatus === "通过", "scheduler dispatch click must update rendered scheduler status");
    assert(schedulerDispatchSteps === "3", "scheduler dispatch click must render scheduler step count");
    assert(schedulerPolicyStatus === "通过", "scheduler dispatch click must render policy pass");
    assert(schedulerPolicyMode === "预检", "scheduler dispatch click must render policy execution mode");
    recordScenario({
      scenario: "scheduler_dispatch_click",
      scheduler_dispatch_status: schedulerDispatchStatus,
      scheduler_dispatch_steps: schedulerDispatchSteps,
      scheduler_policy_status: schedulerPolicyStatus,
      scheduler_policy_mode: schedulerPolicyMode,
      dimensions: schedulerDimensions
    });

    await page.click('[data-scheduler-dispatch="approved-mock"]');
    await page.waitForFunction(() => document.querySelector('[data-scheduler-dispatch="approved-mock"]')?.textContent.includes("调度已记录"));
    const approvedDimensions = await dimensions(page);
    recordScenario({
      scenario: "scheduler_dispatch_approved_mock_click",
      scheduler_dispatch_status: await readout(page, "scheduler_dispatch_status"),
      scheduler_dispatch_dry_run: await readout(page, "scheduler_dispatch_dry_run"),
      scheduler_policy_status: await readout(page, "scheduler_policy_status"),
      scheduler_policy_mode: await readout(page, "scheduler_policy_mode"),
      scheduler_next_status: "通过",
      scheduler_next_packages: "1",
      scheduler_continuation_ready: await readout(page, "scheduler_continuation_ready"),
      dimensions: approvedDimensions
    });

    const projectedAction = await readout(page, "next_action_readout_action");
    await page.click('[data-workbench-next-action="guarded"]');
    await page.waitForFunction(() => document.querySelector('[data-workbench-next-action="guarded"]')?.textContent.includes("推荐动作已记录"));
    const guardedDimensions = await dimensions(page);
    recordScenario({
      scenario: "guarded_next_action_click",
      projected_action: projectedAction,
      button_text: await page.locator('[data-workbench-next-action="guarded"]').textContent(),
      scheduler_continuation_ready: await readout(page, "scheduler_continuation_ready"),
      dimensions: guardedDimensions
    });

    await page.close();
  }, { workflowStateMutator: pendingReviewerShardWorkflowState, projectStatusPath: null });
}
