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
    await page.close();

    const ledger = readLedger(eventsPath);
    assert(ledger.events.length === 1, "successful click must persist exactly one operator event");
    assert(ledger.events[0].action === "validate", "successful click must persist validate action");
    assert(ledger.events[0].run_id, "successful click must persist run_id");
    assert(ledger.events[0].cycle_id, "successful click must persist cycle_id");
    assert(dimensions.scrollWidth <= dimensions.width, "desktop workbench must not overflow horizontally");

    console.log(JSON.stringify({
      scenario: "success",
      event_count: ledger.events.length,
      action: ledger.events[0].action,
      run_id: ledger.events[0].run_id,
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

const browser = await chromium.launch({ headless: true });
try {
  await verifySuccessfulClick(browser);
  await verifyFailedClickDoesNotShowSuccess(browser);
} finally {
  await browser.close();
}
