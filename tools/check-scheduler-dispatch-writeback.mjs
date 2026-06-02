#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createSchedulerDispatchPlan } from "../src/workflow/scheduler-dispatch-plan.js";
import {
  WORKBENCH_MOUNT_PREFIX,
  withRuntime
} from "./check-workbench-next-served-route.mjs";

const RENDERED_SCHEDULER_DISPATCH_PASS_STATUSES = new Set(["pass", "通过"]);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function valueAfter(flag, args = process.argv.slice(2)) {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : "";
}

function writeArtifact(outputPath, artifact) {
  if (!outputPath) return null;
  mkdirSync(dirname(resolve(outputPath)), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
  return outputPath;
}

export function isRenderedSchedulerDispatchPassStatus(value) {
  return RENDERED_SCHEDULER_DISPATCH_PASS_STATUSES.has(String(value || "").trim());
}

function assertRenderedSchedulerDispatchPassStatus(value, pagePath) {
  assert(
    isRenderedSchedulerDispatchPassStatus(value),
    `${pagePath} must render scheduler dispatch accepted pass status`
  );
}

function request(url) {
  return new Promise((resolveRequest, reject) => {
    const req = httpRequest(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolveRequest({
        status: res.statusCode,
        json: () => JSON.parse(body)
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

function runNode(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

function removeReviewerShardCompletion(workflowState) {
  const reviewerShardEventTypes = new Set([
    "reviewer_shard_result",
    "reviewer_shard_aggregate"
  ]);
  const reviewerShardArtifactPrefixes = [
    "reviewer-shard-result",
    "reviewer-shard-aggregate"
  ];

  workflowState.manifest.events = (workflowState.manifest.events || [])
    .filter((event) => !reviewerShardEventTypes.has(event.type));
  workflowState.manifest.artifacts = (workflowState.manifest.artifacts || [])
    .filter((artifact) => !reviewerShardArtifactPrefixes.some((prefix) => String(artifact.id).startsWith(prefix)));
  workflowState.manifest.review_findings = (workflowState.manifest.review_findings || [])
    .filter((finding) => finding.category !== "reviewer");
  workflowState.artifact_ledger.artifacts = (workflowState.artifact_ledger.artifacts || [])
    .filter((artifact) => !reviewerShardArtifactPrefixes.some((prefix) => String(artifact.id).startsWith(prefix)));
}

async function verifyWorkbenchPage(browser, baseUrl, viewportName, contextOptions, expected) {
  const page = await browser.newPage(contextOptions);
  await page.goto(`${baseUrl}${WORKBENCH_MOUNT_PREFIX}/?workbench_event_controls=1`, { waitUntil: "domcontentloaded" });
  await page.locator(".ant-layout").first().waitFor({ state: "visible", timeout: 30000 });
  await page.locator('[data-component="workbench-nav"]').first().waitFor({ state: "visible", timeout: 30000 });
  await page.locator('[data-next-readout="scheduler_dispatch_status"]').first().waitFor({ state: "visible", timeout: 30000 });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});

  const status = (await page.textContent('[data-next-readout="scheduler_dispatch_status"]'))?.trim();
  const steps = (await page.textContent('[data-next-readout="scheduler_dispatch_steps"]'))?.trim();
  const inspection = await page.evaluate(() => ({
    legacy_data_bind_count: document.querySelectorAll("[data-bind]").length,
    desktop_shell_count: document.querySelectorAll(".desktop-shell").length,
    mobile_shell_count: document.querySelectorAll(".mobile-shell").length,
    has_legacy_static_entry: document.documentElement.outerHTML.includes("apps/workbench/desktop.html") ||
      document.documentElement.outerHTML.includes("apps/workbench/mobile.html") ||
      document.documentElement.outerHTML.includes("workbench.js")
  }));
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  const screenshotPath = join(expected.screenshot_dir, `${viewportName}-next-scheduler-dispatch.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false });
  await page.close();

  assertRenderedSchedulerDispatchPassStatus(status, viewportName);
  assert(steps === "3", `${viewportName} must render scheduler dispatch step count`);
  assert(inspection.legacy_data_bind_count === 0, `${viewportName} must not render legacy data-bind shell`);
  assert(inspection.desktop_shell_count === 0, `${viewportName} must not render legacy desktop shell`);
  assert(inspection.mobile_shell_count === 0, `${viewportName} must not render legacy mobile shell`);
  assert(inspection.has_legacy_static_entry === false, `${viewportName} must not reference legacy static entry files`);
  assert(dimensions.scrollWidth <= dimensions.width, `${viewportName} must not overflow horizontally`);

  return {
    path: `${WORKBENCH_MOUNT_PREFIX}/`,
    route_family: "nextjs_app_router",
    viewport: viewportName,
    scheduler_dispatch_status: status,
    scheduler_dispatch_steps: steps,
    legacy_static_shell_used: false,
    inspection,
    dimensions,
    screenshot: screenshotPath
  };
}

export async function runSchedulerDispatchWritebackCheck() {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/scheduler-dispatch-writeback-"));
  const inputPath = join(snapshotsRoot, "scheduler-writeback-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const stateDbPath = join(snapshotsRoot, "workbench-state.sqlite");
  const planPath = join(snapshotsRoot, "scheduler-writeback-plan.json");
  const outputPath = join(snapshotsRoot, "scheduler-writeback-run.json");
  const workflowState = JSON.parse(readFileSync("docs/examples/current-session-workbench-input.json", "utf8"));
  const projectionId = "scheduler-writeback";
  removeReviewerShardCompletion(workflowState);

  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: projectionId,
    items: [
      {
        id: projectionId,
        label: "Scheduler writeback",
        status: "trial",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }, null, 2));

  await withRuntime(async ({ baseUrl, apiPort }) => {
    const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
    const plan = createSchedulerDispatchPlan({
      project_status: {
        project: "ai-control-platform",
        blockers: [],
        next_step: "deterministic scheduler writeback trial"
      },
      run_evaluation: { status: "pass" },
      workflow_state: workflowState
    }, {
      workflow_state_input_path: relative(process.cwd(), inputPath),
      workbench_writeback_mode: "service",
      workbench_base_url: apiBaseUrl,
      projection_id: projectionId
    });
    writeFileSync(planPath, JSON.stringify(plan, null, 2));

    const cli = await runNode([
      "tools/run-scheduler-dispatch-plan.mjs",
      "--plan",
      planPath,
      "--output",
      outputPath,
      "--dry-run"
    ]);
    assert(cli.status === 0, cli.stderr || cli.stdout);
    const summary = JSON.parse(cli.stdout);
    assert(summary.record_status === "pass", "scheduler dispatch CLI must write back through workbench service");
    assert(summary.projection_scheduler_status === "pass", "writeback projection must expose pass status");
    assert(summary.projection_scheduler_steps === 3, "writeback projection must expose 3 scheduler steps");

    const projectionResponse = await request(`${apiBaseUrl}/api/workbench/projection?id=${projectionId}`);
    const projection = projectionResponse.json();
    assert(projectionResponse.status === 200, "projection response must be 200");
    assert(projection.scheduler_dispatch.status === "pass", "projection must persist scheduler dispatch pass");
    assert(projection.scheduler_dispatch.step_count === 3, "projection must persist scheduler dispatch step count");

    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    try {
      const desktop = await verifyWorkbenchPage(browser, baseUrl, "desktop", { viewport: { width: 1440, height: 900 } }, {
        projection_id: projectionId,
        screenshot_dir: snapshotsRoot
      });
      const mobile = await verifyWorkbenchPage(browser, baseUrl, "mobile", { viewport: { width: 390, height: 844 }, isMobile: true }, {
        projection_id: projectionId,
        screenshot_dir: snapshotsRoot
      });

      const artifact = {
        status: "pass",
        route_family: "nextjs_app_router",
        legacy_static_shell_used: false,
        created_at: new Date().toISOString(),
        projection_id: projectionId,
        cli: summary,
        projection: {
          scheduler_dispatch_status: projection.scheduler_dispatch.status,
          scheduler_dispatch_steps: projection.scheduler_dispatch.step_count
        },
        browser: {
          desktop,
          mobile
        }
      };
      const outputPath = valueAfter("--output") || "";
      writeArtifact(outputPath, artifact);
      console.log(JSON.stringify(outputPath ? { ...artifact, output: outputPath } : artifact, null, 2));
    } finally {
      await browser.close();
    }
  }, { historyPath, snapshotsRoot, stateDbPath });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runSchedulerDispatchWritebackCheck();
}
