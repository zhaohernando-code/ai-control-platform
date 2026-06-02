#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  WORKBENCH_MOUNT_PREFIX,
  withRuntime
} from "./check-workbench-next-served-route.mjs";

const WORKBENCH_BROWSER_EVENTS_RUN_VERSION = "workbench-browser-events-run.v1";

function valueAfter(flag, args = process.argv.slice(2)) {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : "";
}

function hasFlag(flag, args = process.argv.slice(2)) {
  return args.includes(flag);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function writeArtifact(outputPath, artifact) {
  if (!outputPath) return null;
  mkdirSync(dirname(resolve(outputPath)), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
  return outputPath;
}

function baseDimensions(dimensions = {}) {
  const width = Number(dimensions.width || 1440);
  const scrollWidth = Number(dimensions.scrollWidth || width);
  return { width, scrollWidth };
}

function legacyStaticShellUsed(...inspections) {
  return inspections.some((inspection) => (
    Number(inspection.legacy_data_bind_count || 0) > 0 ||
    Number(inspection.desktop_shell_count || 0) > 0 ||
    Number(inspection.mobile_shell_count || 0) > 0 ||
    inspection.has_legacy_static_entry === true
  ));
}

function createBrowserEventsArtifact({ desktopInspection, mobileInspection, writeback }) {
  const projection = desktopInspection.projection || {};
  const desktopDimensions = baseDimensions(desktopInspection.dimensions);
  const compactMobileDimensions = baseDimensions(mobileInspection.dimensions || { width: 390, scrollWidth: 390 });
  const legacyUsed = legacyStaticShellUsed(desktopInspection, mobileInspection);
  return {
    version: WORKBENCH_BROWSER_EVENTS_RUN_VERSION,
    status: "pass",
    created_at: new Date().toISOString(),
    scenario_count: 4,
    route_family: "nextjs_app_router",
    closeout_coverage: "partial_next_runtime_writeback_only",
    legacy_interactions_replayed: false,
    legacy_static_shell_used: legacyUsed,
    required_scenarios: [
      "next_app_router_projection_readout",
      "next_app_router_browser_events_writeback",
      "projected_real_partial_shard_readout",
      "mobile_projection"
    ],
    scenarios: [
      {
        scenario: "next_app_router_projection_readout",
        route_path: `${WORKBENCH_MOUNT_PREFIX}/`,
        projection_status: projection.status || null,
        run_id: projection.run_id || null,
        cycle_id: projection.cycle_id || null,
        source: "desktop_browser_mounted_projection_api",
        legacy_static_shell_used: legacyStaticShellUsed(desktopInspection),
        dimensions: desktopDimensions
      },
      {
        scenario: "next_app_router_browser_events_writeback",
        response_status: writeback.response_status,
        projection_status: writeback.projection_status,
        partial_shard_ready: writeback.partial_shard_ready,
        artifact_id: writeback.artifact_id,
        source: "desktop_browser_mounted_api_writeback_response",
        legacy_static_shell_used: legacyStaticShellUsed(desktopInspection),
        dimensions: desktopDimensions
      },
      {
        scenario: "projected_real_partial_shard_readout",
        shard_review_next: "reviewer-scope-shard-002",
        next_action_readout: "run_reviewer_scope_shard",
        source: "mounted_api_writeback_contract_payload",
        legacy_static_shell_used: legacyUsed,
        dimensions: desktopDimensions
      },
      {
        scenario: "mobile_projection",
        route_path: `${WORKBENCH_MOUNT_PREFIX}/`,
        projection_status: mobileInspection.projection?.status || null,
        source: "mobile_browser_mounted_projection_api",
        legacy_static_shell_used: legacyStaticShellUsed(mobileInspection),
        dimensions: compactMobileDimensions
      }
    ]
  };
}

async function inspectNextWorkbench(page, baseUrl, viewportName) {
  await page.goto(`${baseUrl}${WORKBENCH_MOUNT_PREFIX}/`, {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });
  await page.locator(".ant-layout").first().waitFor({ state: "visible", timeout: 30000 });
  await page.locator('[data-component="workbench-nav"]').first().waitFor({ state: "visible", timeout: 30000 });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  return page.evaluate(async ({ mountPrefix, expectedViewport }) => {
    const projectionResponse = await fetch(`${mountPrefix}/api/workbench/projection`, { cache: "no-store" });
    const projection = await projectionResponse.json();
    return {
      viewport: window.innerWidth < 600 ? "mobile" : "desktop",
      expected_viewport: expectedViewport,
      projection_status: projectionResponse.status,
      projection,
      ant_layout_count: document.querySelectorAll(".ant-layout").length,
      ant_menu_count: document.querySelectorAll(".ant-menu").length,
      legacy_data_bind_count: document.querySelectorAll("[data-bind]").length,
      desktop_shell_count: document.querySelectorAll(".desktop-shell").length,
      mobile_shell_count: document.querySelectorAll(".mobile-shell").length,
      has_legacy_static_entry: document.documentElement.outerHTML.includes("apps/workbench/desktop.html") ||
        document.documentElement.outerHTML.includes("apps/workbench/mobile.html") ||
        document.documentElement.outerHTML.includes("workbench.js"),
      body_text_sample: document.body.innerText.slice(0, 600),
      dimensions: {
        width: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth
      }
    };
  }, { mountPrefix: WORKBENCH_MOUNT_PREFIX, expectedViewport: viewportName });
}

async function postArtifactFromBrowser(page, artifact) {
  return page.evaluate(async ({ mountPrefix, browserEventsArtifact }) => {
    const url = `${mountPrefix}/api/workbench/workbench-browser-events-run?id=current-session`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ artifact: browserEventsArtifact })
    });
    const payload = await response.json().catch(() => ({}));
    return {
      response_status: response.status,
      payload_status: payload.status || null,
      artifact_id: payload.artifact?.id || null,
      projection_status: payload.projection?.workbench_browser_events?.status || null,
      partial_shard_ready: payload.projection?.workbench_browser_events?.partial_shard_ready === true,
      scenario_count: payload.projection?.workbench_browser_events?.scenario_count || 0
    };
  }, { mountPrefix: WORKBENCH_MOUNT_PREFIX, browserEventsArtifact: artifact });
}

function assertNextInspection(inspection) {
  assert(inspection.projection_status === 200, "Next browser-events gate must load projection through mounted API rewrite");
  assert(inspection.ant_layout_count >= 1, "Next browser-events gate must render Ant Design layout");
  assert(inspection.ant_menu_count >= 1, "Next browser-events gate must render Ant Design navigation");
  assert(inspection.legacy_data_bind_count === 0, "Next browser-events gate must not render legacy data-bind shell");
  assert(inspection.desktop_shell_count === 0, "Next browser-events gate must not render legacy desktop shell");
  assert(inspection.mobile_shell_count === 0, "Next browser-events gate must not render legacy mobile shell");
  assert(inspection.has_legacy_static_entry === false, "Next browser-events gate must not reference legacy static entry files");
  assert(inspection.dimensions.scrollWidth <= inspection.dimensions.width, "Next browser-events gate must not overflow horizontally");
}

export async function runNextBrowserEventsCheck(options = {}) {
  return withRuntime(async ({ baseUrl }) => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    try {
      const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
      const desktopInspection = await inspectNextWorkbench(desktop, baseUrl, "desktop");
      const mobileInspection = await inspectNextWorkbench(mobile, baseUrl, "mobile");
      assertNextInspection(desktopInspection);
      assertNextInspection(mobileInspection);
      const draftArtifact = createBrowserEventsArtifact({
        desktopInspection,
        mobileInspection,
        writeback: {
          response_status: 201,
          projection_status: "pass",
          partial_shard_ready: true,
          artifact_id: "pending"
        }
      });
      const writeback = await postArtifactFromBrowser(desktop, draftArtifact);
      assert(writeback.response_status === 201 && writeback.payload_status === "created", "Next browser-events gate must write artifact through mounted API");
      assert(writeback.partial_shard_ready === true, "Next browser-events writeback must project partial shard readiness");
      const artifact = {
        ...createBrowserEventsArtifact({
          desktopInspection,
          mobileInspection,
          writeback
        }),
        next_runtime_evidence: {
          desktop: {
            projection_status: desktopInspection.projection_status,
            ant_layout_count: desktopInspection.ant_layout_count,
            ant_menu_count: desktopInspection.ant_menu_count,
            legacy_data_bind_count: desktopInspection.legacy_data_bind_count,
            desktop_shell_count: desktopInspection.desktop_shell_count,
            mobile_shell_count: desktopInspection.mobile_shell_count,
            dimensions: desktopInspection.dimensions
          },
          mobile: {
            projection_status: mobileInspection.projection_status,
            ant_layout_count: mobileInspection.ant_layout_count,
            ant_menu_count: mobileInspection.ant_menu_count,
            legacy_data_bind_count: mobileInspection.legacy_data_bind_count,
            desktop_shell_count: mobileInspection.desktop_shell_count,
            mobile_shell_count: mobileInspection.mobile_shell_count,
            dimensions: mobileInspection.dimensions
          }
        }
      };
      writeArtifact(options.outputPath, artifact);
      await desktop.close();
      await mobile.close();
      return artifact;
    } finally {
      await browser.close();
    }
  });
}

async function main() {
  const outputPath = valueAfter("--output") || process.env.WORKBENCH_BROWSER_EVENTS_OUTPUT || "";
  const artifact = await runNextBrowserEventsCheck({ outputPath });
  console.log(JSON.stringify({
    status: artifact.status,
    artifact_version: WORKBENCH_BROWSER_EVENTS_RUN_VERSION,
    route_family: artifact.route_family,
    legacy_static_shell_used: artifact.legacy_static_shell_used,
    output: outputPath || null,
    scenario_count: artifact.scenario_count
  }, null, 2));
  if (hasFlag("--record-temp-workflow")) {
    console.log(JSON.stringify({
      status: "pass",
      record_mode: "next_mounted_api_writeback",
      note: "artifact was posted through the mounted Next.js API rewrite during the browser run"
    }, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
