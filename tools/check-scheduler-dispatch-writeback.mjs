#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import { createSchedulerDispatchPlan } from "../src/workflow/scheduler-dispatch-plan.js";
import { createWorkbenchServer } from "./workbench-server.mjs";

const RENDERED_SCHEDULER_DISPATCH_PASS_STATUSES = new Set(["pass", "通过"]);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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

async function withWorkbenchServer(options, fn) {
  const server = createWorkbenchServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

async function verifyWorkbenchPage(browser, baseUrl, pagePath, viewport, expected) {
  const page = await browser.newPage(viewport);
  const projectionUrl = encodeURIComponent(`/api/workbench/projection?id=${expected.projection_id}`);
  const historyUrl = encodeURIComponent("/api/workbench/projections");
  await page.goto(`${baseUrl}${pagePath}?projection=${projectionUrl}&history=${historyUrl}`, { waitUntil: "networkidle" });

  const status = await page.textContent('[data-bind="scheduler_dispatch_status"]');
  const steps = await page.textContent('[data-bind="scheduler_dispatch_steps"]');
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  const screenshotPath = join(expected.screenshot_dir, pagePath.includes("mobile") ? "mobile-scheduler-dispatch.png" : "desktop-scheduler-dispatch.png");
  await page.screenshot({ path: screenshotPath, fullPage: false });
  await page.close();

  assertRenderedSchedulerDispatchPassStatus(status, pagePath);
  assert(steps === "3", `${pagePath} must render scheduler dispatch step count`);
  assert(dimensions.scrollWidth <= dimensions.width, `${pagePath} must not overflow horizontally`);

  return {
    path: pagePath,
    scheduler_dispatch_status: status,
    scheduler_dispatch_steps: steps,
    dimensions,
    screenshot: screenshotPath
  };
}

export async function runSchedulerDispatchWritebackCheck() {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/scheduler-dispatch-writeback-"));
  const inputPath = join(snapshotsRoot, "scheduler-writeback-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
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

  await withWorkbenchServer({ historyPath, snapshotsRoot }, async (baseUrl) => {
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
      workbench_base_url: baseUrl,
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

    const projectionResponse = await request(`${baseUrl}/api/workbench/projection?id=${projectionId}`);
    const projection = projectionResponse.json();
    assert(projectionResponse.status === 200, "projection response must be 200");
    assert(projection.scheduler_dispatch.status === "pass", "projection must persist scheduler dispatch pass");
    assert(projection.scheduler_dispatch.step_count === 3, "projection must persist scheduler dispatch step count");

    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    try {
      const desktop = await verifyWorkbenchPage(browser, baseUrl, "/apps/workbench/desktop.html", { viewport: { width: 1440, height: 900 } }, {
        projection_id: projectionId,
        screenshot_dir: snapshotsRoot
      });
      const mobile = await verifyWorkbenchPage(browser, baseUrl, "/apps/workbench/mobile.html", { viewport: { width: 390, height: 844 }, isMobile: true }, {
        projection_id: projectionId,
        screenshot_dir: snapshotsRoot
      });

      console.log(JSON.stringify({
        status: "pass",
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
      }, null, 2));
    } finally {
      await browser.close();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runSchedulerDispatchWritebackCheck();
}
