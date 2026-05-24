#!/usr/bin/env node
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { chromium } from "playwright";

import { createWorkbenchServer } from "./workbench-server.mjs";

const WORKBENCH_BROWSER_EVENTS_RUN_VERSION = "workbench-browser-events-run.v1";
const scenarioResults = [];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function valueAfter(flag, args = process.argv.slice(2)) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

function hasFlag(flag, args = process.argv.slice(2)) {
  return args.includes(flag);
}

function recordScenario(result) {
  scenarioResults.push(result);
  console.log(JSON.stringify(result, null, 2));
}

function pendingReviewerShardWorkflowState(workflowState) {
  const reviewerShardEventTypes = new Set([
    "reviewer_shard_result",
    "reviewer_shard_aggregate",
    "project_status_continuation",
    "context_pack_cycle_materialized",
    "context_pack_cycle_created",
    "context_work_packages_run"
  ]);
  const reviewerShardArtifactPrefixes = [
    "reviewer-shard-result",
    "reviewer-shard-aggregate",
    "project-status-continuation",
    "context-pack-cycle",
    "context-work-packages-run"
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

function writePendingReviewerProjectStatus(dir) {
  const projectStatus = {
    project: "ai-control-platform",
    status: "in_progress",
    blockers: [],
    next_step: "",
    global_goals: [
      {
        id: "reviewer-loop-browser-fixture",
        title: "Reviewer loop browser fixture",
        status: "in_progress",
        next_step: "Run pending reviewer shards through projected scheduler loop.",
        owned_files: ["src/workflow/reviewer-shard-runner.js"]
      }
    ]
  };
  const path = join(dir, "PROJECT_STATUS.reviewer-loop.json");
  writeFileSync(path, `${JSON.stringify(projectStatus, null, 2)}\n`);
  return path;
}

function writeLifecycleCleanupProjectStatus(dir) {
  const projectStatus = {
    project: "ai-control-platform",
    status: "in_progress",
    blockers: [],
    next_step: "Run isolated lifecycle cleanup browser-event scenario.",
    global_goals: [
      {
        id: "lifecycle-cleanup-browser-fixture",
        title: "Lifecycle cleanup browser fixture",
        status: "in_progress",
        next_step: "Exercise cleanup_agent_lifecycle_pool through projected scheduler controls.",
        owned_files: ["src/workflow/agent-lifecycle-pool.js"]
      }
    ]
  };
  const path = join(dir, "PROJECT_STATUS.lifecycle-cleanup.json");
  writeFileSync(path, `${JSON.stringify(projectStatus, null, 2)}\n`);
  return path;
}

function createRunArtifact() {
  return {
    version: WORKBENCH_BROWSER_EVENTS_RUN_VERSION,
    status: "pass",
    created_at: new Date().toISOString(),
    scenario_count: scenarioResults.length,
    required_scenarios: [
      "success",
      "failure",
      "provider_health_click",
      "scheduler_dispatch_click",
      "scheduler_dispatch_approved_mock_click",
      "guarded_next_action_click",
      "agent_lifecycle_pool_timeout_readout",
      "agent_lifecycle_pool_cleanup_click",
      "agent_lifecycle_pool_cleanup_loop_click",
      "projected_mock_loop_click",
      "projected_real_partial_shard_readout",
      "terminal_next_action_readout",
      "autonomous_scheduler_loop_click",
      "latest_durable_global_goal_lifecycle_projection",
      "mobile_projection"
    ],
    scenarios: scenarioResults
  };
}

function writeRunArtifact(outputPath, artifact) {
  if (!outputPath) return null;
  const resolved = resolve(outputPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(artifact, null, 2)}\n`);
  return resolved;
}

async function postRunArtifactToWorkbench(artifact, { baseUrl, projectionId = null }) {
  const url = new URL("/api/workbench/workbench-browser-events-run", baseUrl);
  if (projectionId) url.searchParams.set("id", projectionId);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ artifact })
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status !== 201 || payload.status !== "created") {
    throw new Error(`workbench browser events API writeback failed: ${response.status} ${JSON.stringify(payload)}`);
  }
  if (payload.projection?.workbench_browser_events?.partial_shard_ready !== true) {
    throw new Error("workbench browser events API writeback did not project partial shard readiness");
  }
  return {
    status: "pass",
    response_status: response.status,
    artifact_id: payload.artifact?.id || null,
    projection_status: payload.projection?.workbench_browser_events?.status || null,
    partial_shard_ready: payload.projection?.workbench_browser_events?.partial_shard_ready === true
  };
}

async function withWorkbenchServer(fn, options = {}) {
  mkdirSync("tmp", { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-ui-events-"));
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-browser-snapshots-"));
  const eventsPath = join(dir, "operator-events.json");
  const projectStatusPath = options.projectStatusPath ||
    (typeof options.projectStatusFactory === "function" ? options.projectStatusFactory(dir) : undefined);
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
        input_path: inputPath.replace(`${process.cwd()}/`, "")
      }
    ]
  }, null, 2));

  const server = createWorkbenchServer({
    eventsPath,
    historyPath,
    snapshotsRoot,
    projectStatusPath,
    realReviewerExecutor: options.realReviewerExecutor
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    await fn({ port: server.address().port, eventsPath, inputPath, historyPath });
  } finally {
    server.close();
    await once(server, "close");
  }
}

async function recordRunArtifactToTempWorkflow(artifact) {
  let result = null;
  await withWorkbenchServer(async ({ port, inputPath }) => {
    result = await postRunArtifactToWorkbench(artifact, {
      baseUrl: `http://127.0.0.1:${port}`,
      projectionId: "current-session"
    });
    const workflowState = JSON.parse(readFileSync(inputPath, "utf8"));
    const latestEvent = workflowState.manifest.events.at(-1);
    assert(latestEvent?.type === "workbench_browser_events_run", "browser events API writeback must persist manifest event");
    assert(workflowState.artifact_ledger.artifacts.at(-1)?.metadata?.version === WORKBENCH_BROWSER_EVENTS_RUN_VERSION, "browser events API writeback must persist ledger artifact");
  });
  return result;
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

    recordScenario({
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
    });
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

    recordScenario({
      scenario: "failure",
      event_count: ledger.events.length,
      button_text: buttonText
    });
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
    await page.waitForFunction(() => document.querySelector('[data-provider-health="timeout"]')?.textContent.includes("连通已记录"));

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

    recordScenario({
      scenario: "provider_health_click",
      provider_health: providerHealth,
      next_action: nextAction,
      dimensions
    });
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

    assert(schedulerDispatchStatus === "通过", "scheduler dispatch click must update rendered scheduler status");
    assert(schedulerDispatchSteps === "3", "scheduler dispatch click must render scheduler step count");
    assert(schedulerPolicyStatus === "通过", "scheduler dispatch click must render policy pass");
    assert(schedulerPolicyMode === "预检", "scheduler dispatch click must render policy execution mode");
    assert(dimensions.scrollWidth <= dimensions.width, "scheduler dispatch click must not create horizontal overflow");

    recordScenario({
      scenario: "scheduler_dispatch_click",
      scheduler_dispatch_status: schedulerDispatchStatus,
      scheduler_dispatch_steps: schedulerDispatchSteps,
      scheduler_policy_status: schedulerPolicyStatus,
      scheduler_policy_mode: schedulerPolicyMode,
      dimensions
    });
  }, { workflowStateMutator: pendingReviewerShardWorkflowState });
}

async function verifyApprovedMockSchedulerDispatchClick(browser) {
  await withWorkbenchServer(async ({ port }) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(
      `http://127.0.0.1:${port}/apps/workbench/desktop.html?projection=/api/workbench/projection&history=/api/workbench/projections`,
      { waitUntil: "networkidle" }
    );
    await page.click('[data-scheduler-dispatch="approved-mock"]');
    await page.waitForFunction(() => document.querySelector('[data-scheduler-dispatch="approved-mock"]')?.textContent.includes("调度已记录"));

    const schedulerDispatchStatus = await page.textContent('[data-bind="scheduler_dispatch_status"]');
    const schedulerDispatchDryRun = await page.textContent('[data-bind="scheduler_dispatch_dry_run"]');
    const schedulerPolicyStatus = await page.textContent('[data-bind="scheduler_policy_status"]');
    const schedulerPolicyMode = await page.textContent('[data-bind="scheduler_policy_mode"]');
    const schedulerNextStatus = await page.textContent('[data-bind="scheduler_next_status"]');
    const schedulerNextPackages = await page.textContent('[data-bind="scheduler_next_packages"]');
    const schedulerContinuationReady = await page.textContent('[data-bind="scheduler_continuation_ready"]');
    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));
    await page.close();

    assert(schedulerDispatchStatus === "通过", "approved mock dispatch must render scheduler pass");
    assert(schedulerDispatchDryRun === "否", "approved mock dispatch must render translated non-dry-run copy");
    assert(schedulerPolicyStatus === "通过", "approved mock dispatch must render policy pass");
    assert(schedulerPolicyMode === "execute", "approved mock dispatch must render execute policy mode");
    assert(schedulerNextStatus === "通过", "approved mock dispatch must render next continuation status");
    assert(schedulerNextPackages === "1", "approved mock dispatch must render next work package count");
    assert(schedulerContinuationReady === "就绪", "approved mock dispatch must render translated scheduler continuation readiness");
    assert(dimensions.scrollWidth <= dimensions.width, "approved mock dispatch must not create horizontal overflow");

    recordScenario({
      scenario: "scheduler_dispatch_approved_mock_click",
      scheduler_dispatch_status: schedulerDispatchStatus,
      scheduler_dispatch_dry_run: schedulerDispatchDryRun,
      scheduler_policy_status: schedulerPolicyStatus,
      scheduler_policy_mode: schedulerPolicyMode,
      scheduler_next_status: schedulerNextStatus,
      scheduler_next_packages: schedulerNextPackages,
      scheduler_continuation_ready: schedulerContinuationReady,
      dimensions
    });
  }, { workflowStateMutator: pendingReviewerShardWorkflowState });
}

async function verifyGuardedNextActionClick(browser) {
  await withWorkbenchServer(async ({ port }) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(
      `http://127.0.0.1:${port}/apps/workbench/desktop.html?projection=/api/workbench/projection&history=/api/workbench/projections`,
      { waitUntil: "networkidle" }
    );
    await page.click('[data-scheduler-dispatch="approved-mock"]');
    await page.waitForFunction(() => document.querySelector('[data-scheduler-dispatch="approved-mock"]')?.textContent.includes("调度已记录"));
    const projectedAction = await page.textContent('[data-bind="next_action_readout_action"]');
    await page.click('[data-workbench-next-action="guarded"]');
    await page.waitForFunction(() => document.querySelector('[data-workbench-next-action="guarded"]')?.textContent.includes("推荐动作已记录"));

    const buttonText = await page.textContent('[data-workbench-next-action="guarded"]');
    const schedulerContinuationReady = await page.textContent('[data-bind="scheduler_continuation_ready"]');
    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));
    await page.close();

    assert(projectedAction === "enqueue_scheduler_next_cycle", "guarded next action must execute the projected enqueue action");
    assert(buttonText.includes("推荐动作已记录"), "guarded next action button must show persisted execution");
    assert(schedulerContinuationReady, "guarded next action must render a projection after execution");
    assert(dimensions.scrollWidth <= dimensions.width, "guarded next action must not create horizontal overflow");

    recordScenario({
      scenario: "guarded_next_action_click",
      projected_action: projectedAction,
      button_text: buttonText,
      scheduler_continuation_ready: schedulerContinuationReady,
      dimensions
    });
  }, { workflowStateMutator: pendingReviewerShardWorkflowState });
}

function injectLifecycleCleanupState(workflowState) {
  workflowState.manifest.events = workflowState.manifest.events.filter((event) => ![
    "WorkerSpawned",
    "WorkerCompleted",
    "WorkerHeartbeat",
    "WorkerTimeout",
    "WorkerEvaluation",
    "WorkerClosed",
    "PoolIterationClosed"
  ].includes(event.type));
  workflowState.manifest.artifacts = workflowState.manifest.artifacts.filter((artifact) => artifact.metadata?.type !== "agent_lifecycle_pool");
  workflowState.artifact_ledger.artifacts = workflowState.artifact_ledger.artifacts.filter((artifact) => artifact.metadata?.type !== "agent_lifecycle_pool");
  workflowState.manifest.events.push(
    {
      id: "worker-spawned-browser-lifecycle",
      type: "WorkerSpawned",
      status: "pass",
      created_at: "2026-05-22T08:15:00.000Z",
      metadata: { pool_id: "pool-browser-lifecycle", worker_id: "worker-browser-lifecycle" }
    },
    {
      id: "worker-completed-browser-lifecycle",
      type: "WorkerCompleted",
      status: "pass",
      created_at: "2026-05-22T08:16:00.000Z",
      metadata: { pool_id: "pool-browser-lifecycle", worker_id: "worker-browser-lifecycle" }
    }
  );
}

function injectLifecycleTimeoutState(workflowState) {
  workflowState.manifest.events = workflowState.manifest.events.filter((event) => ![
    "WorkerSpawned",
    "WorkerCompleted",
    "WorkerHeartbeat",
    "WorkerTimeout",
    "WorkerEvaluation",
    "WorkerClosed",
    "PoolIterationClosed"
  ].includes(event.type));
  workflowState.manifest.artifacts = workflowState.manifest.artifacts.filter((artifact) => artifact.metadata?.type !== "agent_lifecycle_pool");
  workflowState.artifact_ledger.artifacts = workflowState.artifact_ledger.artifacts.filter((artifact) => artifact.metadata?.type !== "agent_lifecycle_pool");
  workflowState.manifest.events.push(
    {
      id: "worker-spawned-browser-timeout",
      type: "WorkerSpawned",
      status: "pass",
      created_at: "2026-05-22T08:15:00.000Z",
      metadata: { pool_id: "pool-browser-timeout", worker_id: "worker-browser-timeout" }
    },
    {
      id: "worker-heartbeat-browser-timeout",
      type: "WorkerHeartbeat",
      status: "pass",
      created_at: "2026-05-22T08:16:00.000Z",
      metadata: { pool_id: "pool-browser-timeout", worker_id: "worker-browser-timeout" }
    },
    {
      id: "worker-timeout-browser-timeout",
      type: "WorkerTimeout",
      status: "fail",
      created_at: "2026-05-22T08:20:00.000Z",
      metadata: {
        pool_id: "pool-browser-timeout",
        worker_id: "worker-browser-timeout",
        issues: [{ code: "agent_lifecycle_worker_timeout", message: "worker-browser-timeout timed out" }]
      }
    }
  );
}

function injectTerminalNextActionState(workflowState) {
  workflowState.manifest.events = workflowState.manifest.events.filter((event) => event.type !== "autonomous_scheduler_loop_run");
  workflowState.manifest.events.push({
    id: "scheduler-loop-terminal-browser",
    type: "autonomous_scheduler_loop_run",
    status: "pass",
    created_at: "2026-05-22T09:00:00.000Z",
    artifact_id: "scheduler-loop-terminal-browser-artifact"
  });
  workflowState.artifact_ledger.artifacts.push({
    id: "scheduler-loop-terminal-browser-artifact",
    type: "scheduler_loop",
    status: "pass",
    created_at: "2026-05-22T09:00:00.000Z",
    metadata: {
      version: "autonomous-scheduler-loop-run.v1",
      status: "pass",
      phase: "terminal_projected_action",
      created_at: "2026-05-22T09:00:00.000Z",
      input: {
        start_projection_id: "current-session",
        max_iterations: 1,
        execution_profile: "approved_mock_non_dry_run",
        execution_strategy: "projected_next_action",
        snapshot_prefix: "terminal-browser"
      },
      result: {
        status: "pass",
        phase: "terminal_projected_action",
        issues: [],
        iterations: [
          {
            index: 1,
            status: "stopped",
            projection_id: "current-session",
            projected_action: "inspect_scheduler_loop",
            terminal_action: "inspect_scheduler_loop",
            terminal_reason: "projected next action is not executable"
          }
        ]
      }
    }
  });
}

async function verifyAgentLifecyclePoolTimeoutReadout(browser) {
  await withWorkbenchServer(async ({ port }) => {
    const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await desktop.goto(
      `http://127.0.0.1:${port}/apps/workbench/desktop.html?projection=/api/workbench/projection&history=/api/workbench/projections`,
      { waitUntil: "networkidle" }
    );
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
    await mobile.goto(
      `http://127.0.0.1:${port}/apps/workbench/mobile.html?projection=/api/workbench/projection&history=/api/workbench/projections`,
      { waitUntil: "networkidle" }
    );

    const desktopStatus = await desktop.textContent('[data-bind="agent_lifecycle_pool_status"]');
    const desktopTimedOut = await desktop.textContent('[data-bind="agent_lifecycle_pool_timed_out"]');
    const desktopHeartbeats = await desktop.textContent('[data-bind="agent_lifecycle_pool_heartbeats"]');
    const desktopLatestHeartbeat = await desktop.textContent('[data-bind="agent_lifecycle_pool_latest_heartbeat"]');
    const desktopLatestTimeout = await desktop.textContent('[data-bind="agent_lifecycle_pool_latest_timeout"]');
    const desktopNextActionStatus = await desktop.textContent('[data-bind="next_action_readout_status"]');
    const mobileStatus = await mobile.textContent('[data-bind="agent_lifecycle_pool_status"]');
    const mobileTimedOut = await mobile.textContent('[data-bind="agent_lifecycle_pool_timed_out"]');
    const mobileHeartbeats = await mobile.textContent('[data-bind="agent_lifecycle_pool_heartbeats"]');
    const mobileLatestHeartbeat = await mobile.textContent('[data-bind="agent_lifecycle_pool_latest_heartbeat"]');
    const mobileLatestTimeout = await mobile.textContent('[data-bind="agent_lifecycle_pool_latest_timeout"]');
    const desktopDimensions = await desktop.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));
    const mobileDimensions = await mobile.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));
    await desktop.close();
    await mobile.close();

    assert(desktopStatus === "受阻", "desktop timeout lifecycle pool must render blocked status");
    assert(desktopTimedOut === "1", "desktop lifecycle pool must render one timeout");
    assert(desktopHeartbeats === "1", "desktop lifecycle pool must render one heartbeat");
    assert(desktopLatestHeartbeat.includes("2026-05-22T08:16:00.000Z"), "desktop lifecycle pool must render latest heartbeat");
    assert(desktopLatestTimeout.includes("2026-05-22T08:20:00.000Z"), "desktop lifecycle pool must render latest timeout");
    assert(desktopNextActionStatus === "受阻", "timeout lifecycle next action must render blocked status");
    assert(mobileStatus === "受阻", "mobile timeout lifecycle pool must render blocked status");
    assert(mobileTimedOut === "1", "mobile lifecycle pool must render one timeout");
    assert(mobileHeartbeats === "1", "mobile lifecycle pool must render one heartbeat");
    assert(mobileLatestHeartbeat.includes("2026-05-22T08:16:00.000Z"), "mobile lifecycle pool must render latest heartbeat");
    assert(mobileLatestTimeout.includes("2026-05-22T08:20:00.000Z"), "mobile lifecycle pool must render latest timeout");
    assert(desktopDimensions.scrollWidth <= desktopDimensions.width, "desktop timeout readout must not create horizontal overflow");
    assert(mobileDimensions.scrollWidth <= mobileDimensions.width, "mobile timeout readout must not create horizontal overflow");

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

async function verifyAgentLifecyclePoolCleanupClick(browser) {
  await withWorkbenchServer(async ({ port }) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(
      `http://127.0.0.1:${port}/apps/workbench/desktop.html?projection=/api/workbench/projection&history=/api/workbench/projections`,
      { waitUntil: "networkidle" }
    );

    const cleanupBeforeStatus = await page.textContent('[data-bind="agent_lifecycle_pool_status"]');
    const cleanupBeforeOpen = await page.textContent('[data-bind="agent_lifecycle_pool_open"]');
    const cleanupBeforeUnevaluated = await page.textContent('[data-bind="agent_lifecycle_pool_unevaluated"]');
    const cleanupBeforeUnclosed = await page.textContent('[data-bind="agent_lifecycle_pool_unclosed"]');
    const cleanupBeforeNextAction = await page.textContent('[data-bind="agent_lifecycle_pool_next_action"]');
    const projectedAction = await page.textContent('[data-bind="next_action_readout_action"]');

    await page.click('[data-workbench-next-action="guarded"]');
    await page.waitForFunction(() => document.querySelector('[data-workbench-next-action="guarded"]')?.textContent.includes("推荐动作已记录"));

    const cleanupAfterStatus = await page.textContent('[data-bind="agent_lifecycle_pool_status"]');
    const cleanupAfterOpen = await page.textContent('[data-bind="agent_lifecycle_pool_open"]');
    const cleanupAfterUnevaluated = await page.textContent('[data-bind="agent_lifecycle_pool_unevaluated"]');
    const cleanupAfterUnclosed = await page.textContent('[data-bind="agent_lifecycle_pool_unclosed"]');
    const cleanupAfterNextAction = await page.textContent('[data-bind="agent_lifecycle_pool_next_action"]');
    const nextActionReadout = await page.textContent('[data-bind="next_action_readout_action"]');
    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));
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
    assert(cleanupAfterNextAction === "--", "guarded lifecycle cleanup must clear lifecycle next action");
    assert(nextActionReadout !== "cleanup_agent_lifecycle_pool", "guarded lifecycle cleanup must advance next-action readout");
    assert(dimensions.scrollWidth <= dimensions.width, "lifecycle cleanup click must not create horizontal overflow");

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
      dimensions
    });
  }, {
    workflowStateMutator: injectLifecycleCleanupState,
    projectStatusFactory: writeLifecycleCleanupProjectStatus
  });
}

async function verifyAgentLifecyclePoolCleanupLoopClick(browser) {
  await withWorkbenchServer(async ({ port }) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(
      `http://127.0.0.1:${port}/apps/workbench/desktop.html?projection=/api/workbench/projection&history=/api/workbench/projections`,
      { waitUntil: "networkidle" }
    );

    const cleanupBeforeStatus = await page.textContent('[data-bind="agent_lifecycle_pool_status"]');
    const projectedAction = await page.textContent('[data-bind="next_action_readout_action"]');
    await page.click('[data-autonomous-scheduler-loop="projected-mock"]');
    await page.waitForFunction(() => document.querySelector('[data-autonomous-scheduler-loop="projected-mock"]')?.textContent.includes("投影推进已记录"));

    const schedulerLoopStatus = await page.textContent('[data-bind="scheduler_loop_status"]');
    const schedulerLoopStrategy = await page.textContent('[data-bind="scheduler_loop_strategy"]');
    const cleanupAfterStatus = await page.textContent('[data-bind="agent_lifecycle_pool_status"]');
    const cleanupAfterOpen = await page.textContent('[data-bind="agent_lifecycle_pool_open"]');
    const cleanupAfterUnevaluated = await page.textContent('[data-bind="agent_lifecycle_pool_unevaluated"]');
    const cleanupAfterUnclosed = await page.textContent('[data-bind="agent_lifecycle_pool_unclosed"]');
    const nextActionReadout = await page.textContent('[data-bind="next_action_readout_action"]');
    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));
    await page.close();

    assert(cleanupBeforeStatus === "unevaluated", "lifecycle loop cleanup scenario must start with unevaluated pool");
    assert(projectedAction === "cleanup_agent_lifecycle_pool", "projected loop must start from lifecycle cleanup action");
    assert(schedulerLoopStatus === "通过", "projected lifecycle cleanup loop must render loop pass");
    assert(schedulerLoopStrategy === "按推荐动作推进", "projected lifecycle cleanup loop must render translated projected strategy");
    assert(cleanupAfterStatus === "通过", "projected lifecycle cleanup loop must render lifecycle pass");
    assert(cleanupAfterOpen === "0", "projected lifecycle cleanup loop must leave no open workers");
    assert(cleanupAfterUnevaluated === "0", "projected lifecycle cleanup loop must leave no unevaluated workers");
    assert(cleanupAfterUnclosed === "0", "projected lifecycle cleanup loop must leave no unclosed workers");
    assert(nextActionReadout !== "cleanup_agent_lifecycle_pool", "projected lifecycle cleanup loop must advance next-action readout");
    assert(dimensions.scrollWidth <= dimensions.width, "projected lifecycle cleanup loop must not create horizontal overflow");

    recordScenario({
      scenario: "agent_lifecycle_pool_cleanup_loop_click",
      cleanup_before_status: cleanupBeforeStatus,
      projected_action: projectedAction,
      scheduler_loop_status: schedulerLoopStatus,
      scheduler_loop_strategy: schedulerLoopStrategy,
      cleanup_after_status: cleanupAfterStatus,
      cleanup_after_open: cleanupAfterOpen,
      cleanup_after_unevaluated: cleanupAfterUnevaluated,
      cleanup_after_unclosed: cleanupAfterUnclosed,
      next_action_readout: nextActionReadout,
      dimensions
    });
  }, {
    workflowStateMutator: injectLifecycleCleanupState,
    projectStatusFactory: writeLifecycleCleanupProjectStatus
  });
}

async function verifyProjectedMockLoopClick(browser) {
  await withWorkbenchServer(async ({ port }) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(
      `http://127.0.0.1:${port}/apps/workbench/desktop.html?projection=/api/workbench/projection&history=/api/workbench/projections`,
      { waitUntil: "networkidle" }
    );
    await page.click('[data-autonomous-scheduler-loop="projected-mock"]');
    await page.waitForFunction(() => document.querySelector('[data-autonomous-scheduler-loop="projected-mock"]')?.textContent.includes("投影推进已记录"));

    const schedulerLoopStatus = await page.textContent('[data-bind="scheduler_loop_status"]');
    const schedulerLoopIterations = await page.textContent('[data-bind="scheduler_loop_iterations"]');
    const schedulerLoopStrategy = await page.textContent('[data-bind="scheduler_loop_strategy"]');
    const shardReviewCompleted = await page.textContent('[data-bind="shard_review_completed"]');
    const shardReviewStatus = await page.textContent('[data-bind="shard_review_status"]');
    const shardReviewExecutor = await page.textContent('[data-bind="shard_review_executor"]');
    const shardReviewBudget = await page.textContent('[data-bind="shard_review_budget"]');
    const nextActionReadout = await page.textContent('[data-bind="next_action_readout_action"]');
    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));
    await page.close();

    assert(schedulerLoopStatus === "通过", "projected mock loop must render loop pass");
    assert(schedulerLoopIterations === "2", "projected mock loop must run two reviewer shard iterations");
    assert(schedulerLoopStrategy === "按推荐动作推进", "projected mock loop must render translated projected strategy");
    assert(shardReviewCompleted === "2", "projected mock loop must render completed reviewer shards");
    assert(shardReviewStatus === "通过", "projected mock loop must aggregate reviewer shard status");
    assert(shardReviewExecutor === "mock", "projected mock loop must render mock reviewer executor");
    assert(shardReviewBudget === "0", "projected mock loop must render zero external reviewer budget");
    assert(nextActionReadout, "projected mock loop must render a follow-up next-action readout");
    assert(dimensions.scrollWidth <= dimensions.width, "projected mock loop must not create horizontal overflow");

    recordScenario({
      scenario: "projected_mock_loop_click",
      scheduler_loop_status: schedulerLoopStatus,
      scheduler_loop_iterations: schedulerLoopIterations,
      scheduler_loop_strategy: schedulerLoopStrategy,
      shard_review_completed: shardReviewCompleted,
      shard_review_status: shardReviewStatus,
      shard_review_executor: shardReviewExecutor,
      shard_review_budget: shardReviewBudget,
      next_action_readout: nextActionReadout,
      dimensions
    });
  }, {
    workflowStateMutator: pendingReviewerShardWorkflowState,
    projectStatusFactory: writePendingReviewerProjectStatus
  });
}

async function verifyProjectedRealPartialShardReadout(browser) {
  const calls = [];
  await withWorkbenchServer(async ({ port }) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(
      `http://127.0.0.1:${port}/apps/workbench/desktop.html?projection=/api/workbench/projection&history=/api/workbench/projections`,
      { waitUntil: "networkidle" }
    );
    await page.click('[data-autonomous-scheduler-loop="projected-real"]');
    await page.waitForFunction(() => document.querySelector('[data-autonomous-scheduler-loop="projected-real"]')?.textContent.includes("投影推进已记录"));

    const schedulerLoopStatus = await page.textContent('[data-bind="scheduler_loop_status"]');
    const schedulerLoopIterations = await page.textContent('[data-bind="scheduler_loop_iterations"]');
    const schedulerLoopStrategy = await page.textContent('[data-bind="scheduler_loop_strategy"]');
    const shardReviewCompleted = await page.textContent('[data-bind="shard_review_completed"]');
    const shardReviewNext = await page.textContent('[data-bind="shard_review_next"]');
    const shardReviewExecutor = await page.textContent('[data-bind="shard_review_executor"]');
    const shardReviewBudget = await page.textContent('[data-bind="shard_review_budget"]');
    const nextActionReadout = await page.textContent('[data-bind="next_action_readout_action"]');
    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));
    await page.close();

    assert(calls.length === 1 && calls[0] === "reviewer-scope-shard-001", "projected real partial run must execute only the first shard");
    assert(schedulerLoopStatus === "通过", "projected real partial loop must render loop pass");
    assert(schedulerLoopIterations === "1", "projected real partial loop must stay within one iteration");
    assert(schedulerLoopStrategy === "按推荐动作推进", "projected real partial loop must render translated projected strategy");
    assert(shardReviewCompleted === "1", "projected real partial loop must render one completed shard");
    assert(shardReviewNext === "reviewer-scope-shard-002", "projected real partial loop must render next pending shard");
    assert(shardReviewExecutor === "browser_test_real_reviewer", "projected real partial loop must render injected real executor");
    assert(shardReviewBudget === "1", "projected real partial loop must render one external reviewer call");
    assert(nextActionReadout === "run_reviewer_scope_shard", "projected real partial loop must recommend the next shard");
    assert(dimensions.scrollWidth <= dimensions.width, "projected real partial loop must not create horizontal overflow");

    recordScenario({
      scenario: "projected_real_partial_shard_readout",
      scheduler_loop_status: schedulerLoopStatus,
      scheduler_loop_iterations: schedulerLoopIterations,
      scheduler_loop_strategy: schedulerLoopStrategy,
      shard_review_completed: shardReviewCompleted,
      shard_review_next: shardReviewNext,
      shard_review_executor: shardReviewExecutor,
      shard_review_budget: shardReviewBudget,
      next_action_readout: nextActionReadout,
      dimensions
    });
  }, {
    workflowStateMutator: pendingReviewerShardWorkflowState,
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

async function verifyTerminalNextActionReadout(browser) {
  await withWorkbenchServer(async ({ port }) => {
    const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await desktop.goto(
      `http://127.0.0.1:${port}/apps/workbench/desktop.html?projection=/api/workbench/projection&history=/api/workbench/projections`,
      { waitUntil: "networkidle" }
    );
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
    await mobile.goto(
      `http://127.0.0.1:${port}/apps/workbench/mobile.html?projection=/api/workbench/projection&history=/api/workbench/projections`,
      { waitUntil: "networkidle" }
    );

    const desktopReadout = await desktop.textContent('[data-bind="next_action_readout_action"]');
    const desktopTerminalStatus = await desktop.textContent('[data-bind="next_action_terminal_status"]');
    const desktopTerminalAction = await desktop.textContent('[data-bind="next_action_terminal_action"]');
    const desktopTerminalReason = await desktop.textContent('[data-bind="next_action_terminal_reason"]');
    const mobileTerminalStatus = await mobile.textContent('[data-bind="next_action_terminal_status"]');
    const mobileTerminalAction = await mobile.textContent('[data-bind="next_action_terminal_action"]');
    const mobileTerminalReason = await mobile.textContent('[data-bind="next_action_terminal_reason"]');
    const desktopDimensions = await desktop.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));
    const mobileDimensions = await mobile.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));
    await desktop.close();
    await mobile.close();

    assert(desktopReadout === "inspect_scheduler_loop", "terminal next-action scenario must render inspect readout");
    assert(desktopTerminalStatus && desktopTerminalStatus !== "ready", "desktop terminal next-action status must render non-ready");
    assert(desktopTerminalAction === "inspect_scheduler_loop", "desktop terminal action must render inspect action");
    assert(desktopTerminalReason.includes("projected next action"), "desktop terminal reason must render stop reason");
    assert(mobileTerminalStatus && mobileTerminalStatus !== "ready", "mobile terminal next-action status must render non-ready");
    assert(mobileTerminalAction === "inspect_scheduler_loop", "mobile terminal action must render inspect action");
    assert(mobileTerminalReason.includes("projected next action"), "mobile terminal reason must render stop reason");
    assert(desktopDimensions.scrollWidth <= desktopDimensions.width, "desktop terminal readout must not create horizontal overflow");
    assert(mobileDimensions.scrollWidth <= mobileDimensions.width, "mobile terminal readout must not create horizontal overflow");

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
  }, { workflowStateMutator: injectTerminalNextActionState });
}

async function verifyAutonomousSchedulerLoopClick(browser) {
  await withWorkbenchServer(async ({ port }) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(
      `http://127.0.0.1:${port}/apps/workbench/desktop.html?projection=/api/workbench/projection&history=/api/workbench/projections`,
      { waitUntil: "networkidle" }
    );
    await page.waitForFunction(() => document.querySelector("[data-history-select]")?.options.length > 0);
    await page.click('[data-autonomous-scheduler-loop="bounded"]');
    await page.waitForFunction(() => document.querySelector('[data-autonomous-scheduler-loop="bounded"]')?.textContent.includes("调度轮次已记录"));

    const schedulerLoopStatus = await page.textContent('[data-bind="scheduler_loop_status"]');
    const schedulerLoopIterations = await page.textContent('[data-bind="scheduler_loop_iterations"]');
    const schedulerLoopRecovery = await page.textContent('[data-bind="scheduler_loop_recovery"]');
    await page.click('[data-autonomous-scheduler-loop-resume="bounded"]');
    await page.waitForFunction(() => document.querySelector('[data-autonomous-scheduler-loop-resume="bounded"]')?.textContent.includes("续跑已记录"));
    const resumedLoopStatus = await page.textContent('[data-bind="scheduler_loop_status"]');
    const resumedLoopRecovery = await page.textContent('[data-bind="scheduler_loop_recovery"]');
    const resumedLoopAttempt = await page.textContent('[data-bind="scheduler_loop_resume_status"]');
    const operationEventCount = await page.textContent('[data-bind="counter_operation_events"]');
    const operationRows = await page.locator('[data-list="operations_timeline"] article').count();
    const nextActionReadout = await page.textContent('[data-bind="next_action_readout_action"]');
    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));
    await page.close();

    assert(schedulerLoopStatus === "通过", "autonomous scheduler loop click must render loop pass");
    assert(schedulerLoopIterations === "1", "autonomous scheduler loop click must render one loop iteration");
    assert(schedulerLoopRecovery === "就绪", "autonomous scheduler loop click must render recovery readiness");
    assert(resumedLoopStatus === "通过", "autonomous scheduler loop resume must render loop pass");
    assert(resumedLoopRecovery === "空闲", "autonomous scheduler loop resume must render idle recovery when no actions remain");
    assert(resumedLoopAttempt === "未配置", "resume target projection should not claim the source resume attempt");
    assert(Number(operationEventCount) >= 1, "autonomous scheduler loop resume must render operation event count");
    assert(operationRows >= 1, "autonomous scheduler loop resume must render operation timeline rows");
    assert(nextActionReadout, "autonomous scheduler loop resume must render next-action readout");
    assert(dimensions.scrollWidth <= dimensions.width, "autonomous scheduler loop click must not create horizontal overflow");

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
      dimensions
    });
  }, { workflowStateMutator: pendingReviewerShardWorkflowState });
}

async function verifyLatestDurableGlobalGoalLifecycleProjection(browser) {
  const durableProjectionId = "headless-live-context-cycle-1779570720000";
  const durableInputPath = resolve("docs/examples/headless-live-context-cycle-1779570720000.workbench-input.json");
  const durableWorkflowState = JSON.parse(readFileSync(durableInputPath, "utf8"));
  await withWorkbenchServer(async ({ port }) => {
    const url = `http://127.0.0.1:${port}`;
    const projectionQuery = `?projection=/api/workbench/projection%3Fid%3D${durableProjectionId}&history=/api/workbench/projections`;
    const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await desktop.goto(`${url}/apps/workbench/desktop.html${projectionQuery}`, { waitUntil: "networkidle" });
    await desktop.waitForFunction((projectionId) => document.querySelector("[data-history-select]")?.selectedOptions[0]?.dataset.projectionId === projectionId, durableProjectionId);
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
    await mobile.goto(`${url}/apps/workbench/mobile.html${projectionQuery}`, { waitUntil: "networkidle" });
    await mobile.waitForFunction((projectionId) => document.querySelector("[data-history-select]")?.selectedOptions[0]?.dataset.projectionId === projectionId, durableProjectionId);

    const desktopGlobalCompleted = await desktop.textContent('[data-bind="global_goals_completed"]');
    const desktopGlobalTotal = await desktop.textContent('[data-bind="global_goals_total"]');
    const desktopGlobalBlocked = await desktop.textContent('[data-bind="global_goals_blocked"]');
    const desktopLifecycleCompleted = await desktop.textContent('[data-bind="agent_lifecycle_pool_completed"]');
    const desktopLifecycleEvaluated = await desktop.textContent('[data-bind="agent_lifecycle_pool_evaluated"]');
    const desktopLifecycleClosed = await desktop.textContent('[data-bind="agent_lifecycle_pool_closed"]');
    const mobileGlobalCompleted = await mobile.textContent('[data-bind="global_goals_completed"]');
    const mobileGlobalTotal = await mobile.textContent('[data-bind="global_goals_total"]');
    const mobileGlobalBlocked = await mobile.textContent('[data-bind="global_goals_blocked"]');
    const mobileLifecycleCompleted = await mobile.textContent('[data-bind="agent_lifecycle_pool_completed"]');
    const mobileLifecycleEvaluated = await mobile.textContent('[data-bind="agent_lifecycle_pool_evaluated"]');
    const mobileLifecycleClosed = await mobile.textContent('[data-bind="agent_lifecycle_pool_closed"]');
    const desktopDimensions = await desktop.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));
    const mobileDimensions = await mobile.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));
    await desktop.close();
    await mobile.close();

    assert(desktopGlobalCompleted === "3", "desktop latest projection must render three completed global goals");
    assert(desktopGlobalTotal === "3", "desktop latest projection must render three total global goals");
    assert(desktopGlobalBlocked === "0", "desktop latest projection must render zero blocked global goals");
    assert(desktopLifecycleCompleted === "3", "desktop latest projection must render three completed lifecycle workers");
    assert(desktopLifecycleEvaluated === "3", "desktop latest projection must render three evaluated lifecycle workers");
    assert(desktopLifecycleClosed === "3", "desktop latest projection must render three closed lifecycle workers");
    assert(mobileGlobalCompleted === "3", "mobile latest projection must render three completed global goals");
    assert(mobileGlobalTotal === "3", "mobile latest projection must render three total global goals");
    assert(mobileGlobalBlocked === "0", "mobile latest projection must render zero blocked global goals");
    assert(mobileLifecycleCompleted === "3", "mobile latest projection must render three completed lifecycle workers");
    assert(mobileLifecycleEvaluated === "3", "mobile latest projection must render three evaluated lifecycle workers");
    assert(mobileLifecycleClosed === "3", "mobile latest projection must render three closed lifecycle workers");
    assert(desktopDimensions.scrollWidth <= desktopDimensions.width, "desktop latest durable readout must not create horizontal overflow");
    assert(mobileDimensions.scrollWidth <= mobileDimensions.width, "mobile latest durable readout must not create horizontal overflow");

    recordScenario({
      scenario: "latest_durable_global_goal_lifecycle_projection",
      projection_id: durableProjectionId,
      durable_input_path: durableInputPath,
      desktop_global_completed: desktopGlobalCompleted,
      desktop_global_total: desktopGlobalTotal,
      desktop_global_blocked: desktopGlobalBlocked,
      desktop_lifecycle_completed: desktopLifecycleCompleted,
      desktop_lifecycle_evaluated: desktopLifecycleEvaluated,
      desktop_lifecycle_closed: desktopLifecycleClosed,
      mobile_global_completed: mobileGlobalCompleted,
      mobile_global_total: mobileGlobalTotal,
      mobile_global_blocked: mobileGlobalBlocked,
      mobile_lifecycle_completed: mobileLifecycleCompleted,
      mobile_lifecycle_evaluated: mobileLifecycleEvaluated,
      mobile_lifecycle_closed: mobileLifecycleClosed,
      desktop_dimensions: desktopDimensions,
      mobile_dimensions: mobileDimensions
    });
  }, {
    projectionId: durableProjectionId,
    projectionLabel: "Headless live context cycle",
    workflowStateFactory: () => durableWorkflowState
  });
}

async function verifyMobileProjectionLoad(browser) {
  await withWorkbenchServer(async ({ port }) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
    await page.goto(
      `http://127.0.0.1:${port}/apps/workbench/mobile.html?projection=/api/workbench/projection&history=/api/workbench/projections`,
      { waitUntil: "networkidle" }
    );
    await page.waitForFunction(() => document.querySelector('[data-bind="cycle_id"]')?.textContent.trim() === "当前周期");

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
    const schedulerContinuationReady = await page.textContent('[data-bind="scheduler_continuation_ready"]');
    const schedulerLoopStatus = await page.textContent('[data-bind="scheduler_loop_status"]');
    const schedulerLoopRecovery = await page.textContent('[data-bind="scheduler_loop_recovery"]');
    const schedulerLoopResumeStatus = await page.textContent('[data-bind="scheduler_loop_resume_status"]');
    const lifecyclePoolStatus = await page.textContent('[data-bind="agent_lifecycle_pool_status"]');
    const lifecyclePoolOpen = await page.textContent('[data-bind="agent_lifecycle_pool_open"]');
    const lifecyclePoolUnevaluated = await page.textContent('[data-bind="agent_lifecycle_pool_unevaluated"]');
    const lifecyclePoolUnclosed = await page.textContent('[data-bind="agent_lifecycle_pool_unclosed"]');
    const lifecyclePoolTimedOut = await page.textContent('[data-bind="agent_lifecycle_pool_timed_out"]');
    const lifecyclePoolHeartbeats = await page.textContent('[data-bind="agent_lifecycle_pool_heartbeats"]');
    const lifecyclePoolCompleted = await page.textContent('[data-bind="agent_lifecycle_pool_completed"]');
    const lifecyclePoolEvaluated = await page.textContent('[data-bind="agent_lifecycle_pool_evaluated"]');
    const lifecyclePoolClosed = await page.textContent('[data-bind="agent_lifecycle_pool_closed"]');
    const globalGoalsCompleted = await page.textContent('[data-bind="global_goals_completed"]');
    const globalGoalsTotal = await page.textContent('[data-bind="global_goals_total"]');
    const globalGoalsBlocked = await page.textContent('[data-bind="global_goals_blocked"]');
    const lifecyclePoolNextAction = await page.textContent('[data-bind="agent_lifecycle_pool_next_action"]');
    const operationRows = await page.locator('[data-list="operations_timeline"] article').count();
    const nextActionReadout = await page.textContent('[data-bind="next_action_readout_action"]');
    await page.close();

    assert(dimensions.scrollWidth <= dimensions.width, "mobile workbench must not overflow horizontally");
    assert(closeoutStatus, "mobile workbench must render closeout status");
    assert(resumeHealthStatus, "mobile workbench must render resume health status");
    assert(providerHealth, "mobile workbench must render provider health status");
    assert(schedulerDispatchStatus, "mobile workbench must render scheduler dispatch status");
    assert(schedulerDispatchSteps !== null, "mobile workbench must render scheduler dispatch steps");
    assert(schedulerContinuationReady, "mobile workbench must render scheduler continuation readiness");
    assert(schedulerLoopStatus, "mobile workbench must render scheduler loop status");
    assert(schedulerLoopRecovery, "mobile workbench must render scheduler loop recovery");
    assert(schedulerLoopResumeStatus, "mobile workbench must render scheduler loop resume attempt status");
    assert(lifecyclePoolStatus, "mobile workbench must render lifecycle pool status");
    assert(lifecyclePoolOpen !== null, "mobile workbench must render lifecycle open worker count");
    assert(lifecyclePoolUnevaluated !== null, "mobile workbench must render lifecycle unevaluated count");
    assert(lifecyclePoolUnclosed !== null, "mobile workbench must render lifecycle unclosed count");
    assert(lifecyclePoolTimedOut !== null, "mobile workbench must render lifecycle timeout count");
    assert(lifecyclePoolHeartbeats !== null, "mobile workbench must render lifecycle heartbeat count");
    assert(lifecyclePoolCompleted !== null, "mobile workbench must render lifecycle completed count");
    assert(lifecyclePoolEvaluated !== null, "mobile workbench must render lifecycle evaluated count");
    assert(lifecyclePoolClosed !== null, "mobile workbench must render lifecycle closed count");
    assert(globalGoalsCompleted !== null, "mobile workbench must render global goals completed count");
    assert(globalGoalsTotal !== null, "mobile workbench must render global goals total count");
    assert(globalGoalsBlocked !== null, "mobile workbench must render global goals blocked count");
    assert(lifecyclePoolNextAction !== null, "mobile workbench must render lifecycle next action");
    assert(operationRows >= 1, "mobile workbench must render operation timeline rows");
    assert(nextActionReadout, "mobile workbench must render next-action readout");

    recordScenario({
      scenario: "mobile_projection",
      cycle_id: cycleId,
      status,
      closeout_status: closeoutStatus,
      resume_health_status: resumeHealthStatus,
      provider_health: providerHealth,
      scheduler_dispatch_status: schedulerDispatchStatus,
      scheduler_dispatch_steps: schedulerDispatchSteps,
      scheduler_continuation_ready: schedulerContinuationReady,
      scheduler_loop_status: schedulerLoopStatus,
      scheduler_loop_recovery: schedulerLoopRecovery,
      scheduler_loop_resume_status: schedulerLoopResumeStatus,
      agent_lifecycle_pool_status: lifecyclePoolStatus,
      agent_lifecycle_pool_open: lifecyclePoolOpen,
      agent_lifecycle_pool_unevaluated: lifecyclePoolUnevaluated,
      agent_lifecycle_pool_unclosed: lifecyclePoolUnclosed,
      agent_lifecycle_pool_timed_out: lifecyclePoolTimedOut,
      agent_lifecycle_pool_heartbeats: lifecyclePoolHeartbeats,
      agent_lifecycle_pool_completed: lifecyclePoolCompleted,
      agent_lifecycle_pool_evaluated: lifecyclePoolEvaluated,
      agent_lifecycle_pool_closed: lifecyclePoolClosed,
      global_goals_completed: globalGoalsCompleted,
      global_goals_total: globalGoalsTotal,
      global_goals_blocked: globalGoalsBlocked,
      agent_lifecycle_pool_next_action: lifecyclePoolNextAction,
      operation_rows: operationRows,
      next_action_readout: nextActionReadout,
      dimensions
    });
  });
}

const browser = await chromium.launch({ headless: true });
try {
  await verifySuccessfulClick(browser);
  await verifyFailedClickDoesNotShowSuccess(browser);
  await verifyProviderHealthClick(browser);
  await verifySchedulerDispatchClick(browser);
  await verifyApprovedMockSchedulerDispatchClick(browser);
  await verifyGuardedNextActionClick(browser);
  await verifyAgentLifecyclePoolTimeoutReadout(browser);
  await verifyAgentLifecyclePoolCleanupClick(browser);
  await verifyAgentLifecyclePoolCleanupLoopClick(browser);
  await verifyProjectedMockLoopClick(browser);
  await verifyProjectedRealPartialShardReadout(browser);
  await verifyTerminalNextActionReadout(browser);
  await verifyAutonomousSchedulerLoopClick(browser);
  await verifyLatestDurableGlobalGoalLifecycleProjection(browser);
  await verifyMobileProjectionLoad(browser);
} finally {
  await browser.close();
}

const outputPath = valueAfter("--output") || process.env.WORKBENCH_BROWSER_EVENTS_OUTPUT || null;
const artifact = createRunArtifact();
const written = writeRunArtifact(outputPath, artifact);
if (written) {
  console.log(JSON.stringify({
    status: "pass",
    artifact_version: WORKBENCH_BROWSER_EVENTS_RUN_VERSION,
    output: written,
    scenario_count: scenarioResults.length
  }, null, 2));
}

const recordBaseUrl = valueAfter("--record-base-url") || process.env.WORKBENCH_BROWSER_EVENTS_RECORD_BASE_URL || null;
const recordProjectionId = valueAfter("--record-projection-id") || process.env.WORKBENCH_BROWSER_EVENTS_RECORD_PROJECTION_ID || null;
if (recordBaseUrl) {
  const recordResult = await postRunArtifactToWorkbench(artifact, {
    baseUrl: recordBaseUrl,
    projectionId: recordProjectionId
  });
  console.log(JSON.stringify({
    status: "pass",
    record_mode: "workbench_api",
    ...recordResult
  }, null, 2));
}

if (hasFlag("--record-temp-workflow") || process.env.WORKBENCH_BROWSER_EVENTS_RECORD_TEMP_WORKFLOW === "1") {
  const recordResult = await recordRunArtifactToTempWorkflow(artifact);
  console.log(JSON.stringify({
    status: "pass",
    record_mode: "temp_workflow_api",
    ...recordResult
  }, null, 2));
}
