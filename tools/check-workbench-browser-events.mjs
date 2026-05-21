#!/usr/bin/env node
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright";

import { createWorkbenchServer } from "./workbench-server.mjs";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function withWorkbenchServer(fn) {
  mkdirSync("tmp", { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-ui-events-"));
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-browser-snapshots-"));
  const eventsPath = join(dir, "operator-events.json");
  const inputPath = join(snapshotsRoot, "current-session-workbench-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  writeFileSync(eventsPath, JSON.stringify({ version: "operator-events.v1", events: [] }));
  writeFileSync(inputPath, readFileSync("docs/examples/current-session-workbench-input.json", "utf8"));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "current-session",
    items: [
      {
        id: "current-session",
        label: "Current session",
        status: "rerun",
        input_path: inputPath.replace(`${process.cwd()}/`, "")
      }
    ]
  }, null, 2));

  const server = createWorkbenchServer({ eventsPath, historyPath, snapshotsRoot });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    await fn({ port: server.address().port, eventsPath });
  } finally {
    server.close();
    await once(server, "close");
  }
}

function readLedger(eventsPath) {
  return JSON.parse(readFileSync(eventsPath, "utf8"));
}

async function verifySuccessfulClick(browser) {
  await withWorkbenchServer(async ({ port, eventsPath }) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(
      `http://127.0.0.1:${port}/apps/workbench/desktop.html?projection=/api/workbench/projection&history=/api/workbench/projections`,
      { waitUntil: "networkidle" }
    );
    await page.click('[data-action="validate"]');
    await page.waitForFunction(() => document.querySelector('[data-action="validate"]')?.textContent.includes("已校验"));

    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));
    const closeoutStatus = await page.textContent('[data-bind="closeout_status"]');
    const resumeHealthStatus = await page.textContent('[data-bind="resume_health_status"]');
    const providerHealth = await page.textContent('[data-bind="provider_health_value"]');
    const schedulerDispatchStatus = await page.textContent('[data-bind="scheduler_dispatch_status"]');
    const schedulerDispatchSteps = await page.textContent('[data-bind="scheduler_dispatch_steps"]');
    await page.close();

    const ledger = readLedger(eventsPath);
    assert(ledger.events.length === 1, "successful click must persist exactly one operator event");
    assert(ledger.events[0].action === "validate", "successful click must persist validate action");
    assert(ledger.events[0].run_id, "successful click must persist run_id");
    assert(ledger.events[0].cycle_id, "successful click must persist cycle_id");
    assert(dimensions.scrollWidth <= dimensions.width, "desktop workbench must not overflow horizontally");
    assert(closeoutStatus, "desktop workbench must render closeout status");
    assert(resumeHealthStatus, "desktop workbench must render resume health status");
    assert(providerHealth, "desktop workbench must render provider health status");
    assert(schedulerDispatchStatus, "desktop workbench must render scheduler dispatch status");
    assert(schedulerDispatchSteps !== null, "desktop workbench must render scheduler dispatch steps");

    console.log(JSON.stringify({
      scenario: "success",
      event_count: ledger.events.length,
      action: ledger.events[0].action,
      run_id: ledger.events[0].run_id,
      closeout_status: closeoutStatus,
      resume_health_status: resumeHealthStatus,
      provider_health: providerHealth,
      scheduler_dispatch_status: schedulerDispatchStatus,
      scheduler_dispatch_steps: schedulerDispatchSteps,
      dimensions
    }, null, 2));
  });
}

async function verifyFailedClickDoesNotShowSuccess(browser) {
  await withWorkbenchServer(async ({ port, eventsPath }) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.route("**/api/workbench/events", async (route) => {
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

    await page.goto(
      `http://127.0.0.1:${port}/apps/workbench/desktop.html?projection=/api/workbench/projection&history=/api/workbench/projections`,
      { waitUntil: "networkidle" }
    );
    await page.click('[data-action="validate"]');
    await page.waitForFunction(() => document.querySelector('[data-action="validate"]')?.textContent.includes("事件写入失败"));
    const buttonText = await page.textContent('[data-action="validate"]');
    await page.close();

    const ledger = readLedger(eventsPath);
    assert(ledger.events.length === 0, "failed click must not persist an operator event");
    assert(!buttonText.includes("已校验"), "failed click must not show validation success");

    console.log(JSON.stringify({
      scenario: "failure",
      event_count: ledger.events.length,
      button_text: buttonText
    }, null, 2));
  });
}

async function verifyProviderHealthClick(browser) {
  await withWorkbenchServer(async ({ port }) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(
      `http://127.0.0.1:${port}/apps/workbench/desktop.html?projection=/api/workbench/projection&history=/api/workbench/projections`,
      { waitUntil: "networkidle" }
    );
    await page.click('[data-provider-health="timeout"]');
    await page.waitForFunction(() => document.querySelector('[data-provider-health="timeout"]')?.textContent.includes("Smoke 已记录"));

    const providerHealth = await page.textContent('[data-bind="provider_health_value"]');
    const nextAction = await page.textContent('[data-bind="provider_next_action"]');
    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));
    await page.close();

    assert(providerHealth === "unhealthy", "provider health click must update rendered provider health");
    assert(nextAction === "fallback_model_or_defer_external_review", "provider health click must render fallback next action");
    assert(dimensions.scrollWidth <= dimensions.width, "provider health click must not create horizontal overflow");

    console.log(JSON.stringify({
      scenario: "provider_health_click",
      provider_health: providerHealth,
      next_action: nextAction,
      dimensions
    }, null, 2));
  });
}

async function verifySchedulerDispatchClick(browser) {
  await withWorkbenchServer(async ({ port }) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(
      `http://127.0.0.1:${port}/apps/workbench/desktop.html?projection=/api/workbench/projection&history=/api/workbench/projections`,
      { waitUntil: "networkidle" }
    );
    await page.click('[data-scheduler-dispatch="dry-run"]');
    await page.waitForFunction(() => document.querySelector('[data-scheduler-dispatch="dry-run"]')?.textContent.includes("调度已记录"));

    const schedulerDispatchStatus = await page.textContent('[data-bind="scheduler_dispatch_status"]');
    const schedulerDispatchSteps = await page.textContent('[data-bind="scheduler_dispatch_steps"]');
    const schedulerPolicyStatus = await page.textContent('[data-bind="scheduler_policy_status"]');
    const schedulerPolicyMode = await page.textContent('[data-bind="scheduler_policy_mode"]');
    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));
    await page.close();

    assert(schedulerDispatchStatus === "pass", "scheduler dispatch click must update rendered scheduler status");
    assert(schedulerDispatchSteps === "3", "scheduler dispatch click must render scheduler step count");
    assert(schedulerPolicyStatus === "pass", "scheduler dispatch click must render policy pass");
    assert(schedulerPolicyMode === "dry_run", "scheduler dispatch click must render policy execution mode");
    assert(dimensions.scrollWidth <= dimensions.width, "scheduler dispatch click must not create horizontal overflow");

    console.log(JSON.stringify({
      scenario: "scheduler_dispatch_click",
      scheduler_dispatch_status: schedulerDispatchStatus,
      scheduler_dispatch_steps: schedulerDispatchSteps,
      scheduler_policy_status: schedulerPolicyStatus,
      scheduler_policy_mode: schedulerPolicyMode,
      dimensions
    }, null, 2));
  });
}

async function verifyMobileProjectionLoad(browser) {
  await withWorkbenchServer(async ({ port }) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
    await page.goto(
      `http://127.0.0.1:${port}/apps/workbench/mobile.html?projection=/api/workbench/projection&history=/api/workbench/projections`,
      { waitUntil: "networkidle" }
    );
    await page.waitForFunction(() => document.querySelector('[data-bind="cycle_id"]')?.textContent.includes("cycle-"));

    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));
    const cycleId = await page.textContent('[data-bind="cycle_id"]');
    const status = await page.textContent('[data-bind="status"]');
    const closeoutStatus = await page.textContent('[data-bind="closeout_status"]');
    const resumeHealthStatus = await page.textContent('[data-bind="resume_health_status"]');
    const providerHealth = await page.textContent('[data-bind="provider_health_value"]');
    const schedulerDispatchStatus = await page.textContent('[data-bind="scheduler_dispatch_status"]');
    const schedulerDispatchSteps = await page.textContent('[data-bind="scheduler_dispatch_steps"]');
    await page.close();

    assert(dimensions.scrollWidth <= dimensions.width, "mobile workbench must not overflow horizontally");
    assert(closeoutStatus, "mobile workbench must render closeout status");
    assert(resumeHealthStatus, "mobile workbench must render resume health status");
    assert(providerHealth, "mobile workbench must render provider health status");
    assert(schedulerDispatchStatus, "mobile workbench must render scheduler dispatch status");
    assert(schedulerDispatchSteps !== null, "mobile workbench must render scheduler dispatch steps");

    console.log(JSON.stringify({
      scenario: "mobile_projection",
      cycle_id: cycleId,
      status,
      closeout_status: closeoutStatus,
      resume_health_status: resumeHealthStatus,
      provider_health: providerHealth,
      scheduler_dispatch_status: schedulerDispatchStatus,
      scheduler_dispatch_steps: schedulerDispatchSteps,
      dimensions
    }, null, 2));
  });
}

const browser = await chromium.launch({ headless: true });
try {
  await verifySuccessfulClick(browser);
  await verifyFailedClickDoesNotShowSuccess(browser);
  await verifyProviderHealthClick(browser);
  await verifySchedulerDispatchClick(browser);
  await verifyMobileProjectionLoad(browser);
} finally {
  await browser.close();
}
