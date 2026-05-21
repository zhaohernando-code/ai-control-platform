#!/usr/bin/env node
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-ui-events-"));
  const eventsPath = join(dir, "operator-events.json");
  writeFileSync(eventsPath, JSON.stringify({ version: "operator-events.v1", events: [] }));

  const server = createWorkbenchServer({ eventsPath });
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

    console.log(JSON.stringify({
      scenario: "success",
      event_count: ledger.events.length,
      action: ledger.events[0].action,
      run_id: ledger.events[0].run_id,
      closeout_status: closeoutStatus,
      resume_health_status: resumeHealthStatus,
      provider_health: providerHealth,
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
    await page.close();

    assert(dimensions.scrollWidth <= dimensions.width, "mobile workbench must not overflow horizontally");
    assert(closeoutStatus, "mobile workbench must render closeout status");
    assert(resumeHealthStatus, "mobile workbench must render resume health status");
    assert(providerHealth, "mobile workbench must render provider health status");

    console.log(JSON.stringify({
      scenario: "mobile_projection",
      cycle_id: cycleId,
      status,
      closeout_status: closeoutStatus,
      resume_health_status: resumeHealthStatus,
      provider_health: providerHealth,
      dimensions
    }, null, 2));
  });
}

const browser = await chromium.launch({ headless: true });
try {
  await verifySuccessfulClick(browser);
  await verifyFailedClickDoesNotShowSuccess(browser);
  await verifyMobileProjectionLoad(browser);
} finally {
  await browser.close();
}
