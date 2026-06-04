import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { createSqliteWorkbenchStateStore } from "../src/workflow/workbench-state-store.js";
import {
  WORKBENCH_MOUNT_PREFIX,
  withRuntime
} from "./check-workbench-next-served-route.mjs";

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function workbenchApiUrl(baseUrl, pathname) {
  return new URL(`${WORKBENCH_MOUNT_PREFIX}${pathname}`, baseUrl);
}

export async function withNextWorkbenchRuntime(fn, options = {}) {
  mkdirSync("tmp", { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-next-ui-events-"));
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-next-browser-snapshots-"));
  const eventsPath = join(dir, "operator-events.json");
  const stateDbPath = join(dir, "workbench-state.sqlite");
  const projectStatusPath = Object.hasOwn(options, "projectStatusPath")
    ? options.projectStatusPath
    : (typeof options.projectStatusFactory === "function" ? options.projectStatusFactory(dir) : undefined);
  const inputPath = join(snapshotsRoot, "current-session-workbench-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  writeFileSync(eventsPath, JSON.stringify({ version: "operator-events.v1", events: [] }));
  const workflowState = typeof options.workflowStateFactory === "function"
    ? options.workflowStateFactory()
    : JSON.parse(readFileSync("docs/examples/current-session-workbench-input.json", "utf8"));
  if (typeof options.workflowStateMutator === "function") {
    options.workflowStateMutator(workflowState);
  }
  const projectionId = options.projectionId || "current-session";
  writeFileSync(inputPath, `${JSON.stringify(workflowState, null, 2)}\n`);
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: projectionId,
    items: [
      {
        id: projectionId,
        label: options.projectionLabel || "Current session",
        status: "rerun",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }, null, 2));

  return withRuntime(async ({ baseUrl }) => {
    await fn({ baseUrl, eventsPath, inputPath, historyPath, stateDbPath, projectionId });
  }, {
    eventsPath,
    historyPath,
    snapshotsRoot,
    stateDbPath,
    projectStatusPath,
    realReviewerExecutor: options.realReviewerExecutor
  });
}

export function readLedger(eventsPath, stateDbPath = "") {
  if (stateDbPath) return createSqliteWorkbenchStateStore({ dbPath: stateDbPath }).readEvents();
  return JSON.parse(readFileSync(eventsPath, "utf8"));
}

export async function openWorkbench(browser, baseUrl, viewport) {
  const page = await browser.newPage(viewport);
  await page.goto(`${baseUrl}${WORKBENCH_MOUNT_PREFIX}/?workbench_event_controls=1`, { waitUntil: "domcontentloaded" });
  await page.locator(".ant-layout").first().waitFor({ state: "visible", timeout: 30000 });
  await page.locator('[data-component="workbench-nav"]').first().waitFor({ state: "visible", timeout: 30000 });
  await page.locator('[data-action="validate"]').first().waitFor({ state: "visible", timeout: 30000 });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  return page;
}

export async function readout(page, name) {
  return (await page.locator(`[data-next-readout="${name}"]`).first().textContent())?.trim() || "";
}

export async function dimensions(page) {
  return page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
}

export async function verifyNoLegacyShell(page) {
  const legacy = await page.evaluate(() => ({
    dataBind: document.querySelectorAll("[data-bind]").length,
    desktopShell: document.querySelectorAll(".desktop-shell").length,
    mobileShell: document.querySelectorAll(".mobile-shell").length,
    referencesLegacy: document.documentElement.outerHTML.includes("apps/workbench/desktop.html") ||
      document.documentElement.outerHTML.includes("apps/workbench/mobile.html") ||
      document.documentElement.outerHTML.includes("workbench.js")
  }));
  assert(legacy.dataBind === 0, "Next browser-events gate must not render legacy data-bind shell");
  assert(legacy.desktopShell === 0, "Next browser-events gate must not render legacy desktop shell");
  assert(legacy.mobileShell === 0, "Next browser-events gate must not render legacy mobile shell");
  assert(legacy.referencesLegacy === false, "Next browser-events gate must not reference legacy static entries");
}
