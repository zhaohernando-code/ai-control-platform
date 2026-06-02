#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { createSqliteWorkbenchStateStore } from "../src/workflow/workbench-state-store.js";
import { createWorkbenchProjection } from "../src/workflow/workbench-projection.js";
import {
  WORKBENCH_MOUNT_PREFIX,
  withRuntime
} from "./check-workbench-next-served-route.mjs";

const WORKBENCH_BROWSER_EVENTS_RUN_VERSION = "workbench-browser-events-run.v1";
const scenarioResults = [];
const CLEARED_LIFECYCLE_NEXT_ACTION_COPY = "等待状态上报；下一步查看推荐任务。";
const CLEARED_SCHEDULER_LOOP_RECOVERY_COPY = "等待状态上报；下一步查看推荐任务。";
const IDLE_SCHEDULER_LOOP_RECOVERY_COPY = "空闲，等待可派发任务";
const NO_SOURCE_RESUME_ATTEMPT_COPY = "该通道未启用；无阻塞时继续主任务。";
const RAW_SCHEDULER_LOOP_RECOVERY_TOKENS = new Set([
  "idle",
  "ready",
  "not_configured",
  "no_next_action",
  "wait_for_new_work",
  "resume_from_latest_projection",
  "start_bounded_loop",
  "inspect_latest_loop_run",
  "inspect_scheduler_loop",
  "resume_autonomous_scheduler_loop",
  "no_dispatchable_scheduler_actions"
]);
const RAW_RESUME_ATTEMPT_CLAIM_TOKENS = new Set([
  "not_configured",
  "pass",
  "fail",
  "blocked",
  "ready",
  "scheduler_loop_resume_attempt",
  "resume_autonomous_scheduler_loop"
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

function isClearedSchedulerLoopRecoveryReadout(value) {
  const normalized = String(value || "").trim();
  if (RAW_SCHEDULER_LOOP_RECOVERY_TOKENS.has(normalized)) return false;
  return normalized === CLEARED_SCHEDULER_LOOP_RECOVERY_COPY ||
    normalized === IDLE_SCHEDULER_LOOP_RECOVERY_COPY ||
    normalized === "就绪";
}

function isNoSourceResumeAttemptReadout(value) {
  const normalized = String(value || "").trim();
  if (RAW_RESUME_ATTEMPT_CLAIM_TOKENS.has(normalized)) return false;
  return normalized === NO_SOURCE_RESUME_ATTEMPT_COPY ||
    normalized === "--";
}

function clearRequirementIntakeState(workflowState) {
  if (workflowState.project_status) {
    delete workflowState.project_status.plan_reviews;
    delete workflowState.project_status.requirement_intake;
  }
  workflowState.manifest.events = (workflowState.manifest.events || [])
    .filter((event) => event.type !== "requirement_intake_submitted");
  workflowState.manifest.artifacts = (workflowState.manifest.artifacts || [])
    .filter((artifact) => artifact.metadata?.type !== "requirement_intake_submitted");
  workflowState.artifact_ledger.artifacts = (workflowState.artifact_ledger.artifacts || [])
    .filter((artifact) => artifact.metadata?.type !== "requirement_intake_submitted");
}

function clearSchedulerLoopState(workflowState) {
  const schedulerEventTypes = new Set(["autonomous_scheduler_loop_run", "scheduler_loop_resume_attempt"]);
  workflowState.manifest.events = (workflowState.manifest.events || [])
    .filter((event) => !schedulerEventTypes.has(event.type));
  workflowState.manifest.artifacts = (workflowState.manifest.artifacts || [])
    .filter((artifact) => !schedulerEventTypes.has(artifact.metadata?.type));
  workflowState.artifact_ledger.artifacts = (workflowState.artifact_ledger.artifacts || [])
    .filter((artifact) => !schedulerEventTypes.has(artifact.metadata?.type));
}

function pendingReviewerShardWorkflowState(workflowState) {
  clearRequirementIntakeState(workflowState);
  clearSchedulerLoopState(workflowState);
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

function createRunArtifact() {
  return {
    version: WORKBENCH_BROWSER_EVENTS_RUN_VERSION,
    status: "pass",
    created_at: new Date().toISOString(),
    route_family: "nextjs_app_router",
    legacy_static_shell_used: false,
    legacy_interactions_replayed: true,
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
  const url = new URL(`${WORKBENCH_MOUNT_PREFIX}/api/workbench/workbench-browser-events-run`, baseUrl);
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

async function withNextWorkbenchRuntime(fn, options = {}) {
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

function readLedger(eventsPath, stateDbPath = "") {
  if (stateDbPath) return createSqliteWorkbenchStateStore({ dbPath: stateDbPath }).readEvents();
  return JSON.parse(readFileSync(eventsPath, "utf8"));
}

async function openWorkbench(browser, baseUrl, viewport) {
  const page = await browser.newPage(viewport);
  await page.goto(`${baseUrl}${WORKBENCH_MOUNT_PREFIX}/?workbench_event_controls=1`, { waitUntil: "domcontentloaded" });
  await page.locator(".ant-layout").first().waitFor({ state: "visible", timeout: 30000 });
  await page.locator('[data-component="workbench-nav"]').first().waitFor({ state: "visible", timeout: 30000 });
  await page.locator('[data-action="validate"]').first().waitFor({ state: "visible", timeout: 30000 });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  return page;
}

async function readout(page, name) {
  return (await page.locator(`[data-next-readout="${name}"]`).first().textContent())?.trim() || "";
}

async function dimensions(page) {
  return page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
}

async function verifyNoLegacyShell(page) {
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

async function verifyDefaultInteractions(browser) {
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

async function verifyLifecycleTimeoutReadout(browser) {
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

async function verifyLifecycleCleanup(browser) {
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

async function verifyLifecycleCleanupLoop(browser) {
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

async function verifyProjectedLoops(browser) {
  await withNextWorkbenchRuntime(async ({ baseUrl }) => {
    const page = await openWorkbench(browser, baseUrl, { viewport: { width: 1440, height: 900 } });
    await page.click('[data-autonomous-scheduler-loop="projected-mock"]');
    await page.waitForFunction(() => document.querySelector('[data-autonomous-scheduler-loop="projected-mock"]')?.textContent.includes("投影推进已记录"));
    recordScenario({
      scenario: "projected_mock_loop_click",
      scheduler_loop_status: await readout(page, "scheduler_loop_status"),
      scheduler_loop_iterations: await readout(page, "scheduler_loop_iterations"),
      scheduler_loop_strategy: await readout(page, "scheduler_loop_strategy"),
      shard_review_completed: await readout(page, "shard_review_completed"),
      shard_review_status: await readout(page, "shard_review_status"),
      shard_review_executor: await readout(page, "shard_review_executor"),
      shard_review_budget: await readout(page, "shard_review_budget"),
      next_action_readout: await readout(page, "next_action_readout_action"),
      dimensions: await dimensions(page)
    });
    await page.close();
  }, {
    workflowStateMutator: pendingReviewerShardWorkflowState,
    projectStatusFactory: writePendingReviewerProjectStatus
  });

  const calls = [];
  await withNextWorkbenchRuntime(async ({ baseUrl }) => {
    const page = await openWorkbench(browser, baseUrl, { viewport: { width: 1440, height: 900 } });
    await page.click('[data-autonomous-scheduler-loop="projected-real"]');
    await page.waitForFunction(() => document.querySelector('[data-autonomous-scheduler-loop="projected-real"]')?.textContent.includes("投影推进已记录"));
    const result = {
      scenario: "projected_real_partial_shard_readout",
      scheduler_loop_status: await readout(page, "scheduler_loop_status"),
      scheduler_loop_iterations: await readout(page, "scheduler_loop_iterations"),
      scheduler_loop_strategy: await readout(page, "scheduler_loop_strategy"),
      shard_review_completed: await readout(page, "shard_review_completed"),
      shard_review_next: await readout(page, "shard_review_next"),
      shard_review_executor: await readout(page, "shard_review_executor"),
      shard_review_budget: await readout(page, "shard_review_budget"),
      next_action_readout: await readout(page, "next_action_readout_action"),
      dimensions: await dimensions(page)
    };
    await page.close();
    assert(calls.length === 1 && calls[0] === "reviewer-scope-shard-001", "projected real partial run must execute only the first shard");
    assert(result.shard_review_next === "reviewer-scope-shard-002", "projected real partial loop must render next pending shard");
    assert(result.next_action_readout === "run_reviewer_scope_shard", "projected real partial loop must recommend the next shard");
    recordScenario(result);
  }, {
    workflowStateMutator: pendingReviewerShardWorkflowState,
    projectStatusPath: null,
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

async function verifyTerminalReadout(browser) {
  await withNextWorkbenchRuntime(async ({ baseUrl }) => {
    const desktop = await openWorkbench(browser, baseUrl, { viewport: { width: 1440, height: 900 } });
    const mobile = await openWorkbench(browser, baseUrl, { viewport: { width: 390, height: 844 }, isMobile: true });
    const desktopReadout = await readout(desktop, "next_action_readout_action");
    const desktopTerminalStatus = await readout(desktop, "next_action_terminal_status");
    const desktopTerminalAction = await readout(desktop, "next_action_terminal_action");
    const desktopTerminalReason = await readout(desktop, "next_action_terminal_reason");
    const mobileTerminalStatus = await readout(mobile, "next_action_terminal_status");
    const mobileTerminalAction = await readout(mobile, "next_action_terminal_action");
    const mobileTerminalReason = await readout(mobile, "next_action_terminal_reason");
    const desktopDimensions = await dimensions(desktop);
    const mobileDimensions = await dimensions(mobile);
    await desktop.close();
    await mobile.close();
    assert(desktopReadout === "inspect_scheduler_loop", "terminal next-action scenario must render inspect readout");
    assert(desktopTerminalAction === "inspect_scheduler_loop", "desktop terminal action must render inspect action");
    assert(desktopTerminalReason.includes("projected next action"), "desktop terminal reason must render stop reason");
    assert(mobileTerminalAction === "inspect_scheduler_loop", "mobile terminal action must render inspect action");
    assert(mobileTerminalReason.includes("projected next action"), "mobile terminal reason must render stop reason");
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
  }, {
    workflowStateMutator: (workflowState) => {
      clearRequirementIntakeState(workflowState);
      injectTerminalNextActionState(workflowState);
    },
    projectStatusPath: null
  });
}

async function verifyAutonomousLoopAndMobile(browser) {
  await withNextWorkbenchRuntime(async ({ baseUrl }) => {
    const page = await openWorkbench(browser, baseUrl, { viewport: { width: 1440, height: 900 } });
    await page.click('[data-autonomous-scheduler-loop="bounded"]');
    await page.waitForFunction(() => document.querySelector('[data-autonomous-scheduler-loop="bounded"]')?.textContent.includes("调度轮次已记录"));
    const schedulerLoopStatus = await readout(page, "scheduler_loop_status");
    const schedulerLoopIterations = await readout(page, "scheduler_loop_iterations");
    const schedulerLoopRecovery = await readout(page, "scheduler_loop_recovery");
    await page.click('[data-autonomous-scheduler-loop-resume="bounded"]');
    await page.waitForFunction(() => document.querySelector('[data-autonomous-scheduler-loop-resume="bounded"]')?.textContent.includes("续跑已记录"));
    const resumedLoopStatus = await readout(page, "scheduler_loop_status");
    const resumedLoopRecovery = await readout(page, "scheduler_loop_recovery");
    const resumedLoopAttempt = await readout(page, "scheduler_loop_resume_status");
    const operationEventCount = await readout(page, "counter_operation_events");
    const operationRows = await page.locator('[data-next-list="operations_timeline"] .ant-card').count();
    const nextActionReadout = await readout(page, "next_action_readout_action");
    const pageDimensions = await dimensions(page);
    await page.close();
    assert(schedulerLoopStatus === "通过", "autonomous scheduler loop click must render loop pass");
    assert(schedulerLoopIterations === "1", "autonomous scheduler loop click must render one loop iteration");
    assert(schedulerLoopRecovery === "就绪", "autonomous scheduler loop click must render recovery readiness");
    assert(resumedLoopStatus === "通过", "autonomous scheduler loop resume must render loop pass");
    assert(isClearedSchedulerLoopRecoveryReadout(resumedLoopRecovery), "autonomous scheduler loop resume must render cleared idle recovery when no actions remain");
    assert(isNoSourceResumeAttemptReadout(resumedLoopAttempt), "resume target projection should not claim the source resume attempt");
    assert(Number(operationEventCount) >= 1, "autonomous scheduler loop resume must render operation event count");
    assert(operationRows >= 1, "autonomous scheduler loop resume must render operation timeline rows");
    assert(nextActionReadout, "autonomous scheduler loop resume must render next-action readout");
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
      dimensions: pageDimensions
    });
  }, { workflowStateMutator: pendingReviewerShardWorkflowState, projectStatusPath: null });

  await withNextWorkbenchRuntime(async ({ baseUrl }) => {
    const page = await openWorkbench(browser, baseUrl, { viewport: { width: 390, height: 844 }, isMobile: true });
    const pageDimensions = await dimensions(page);
    assert(pageDimensions.scrollWidth <= pageDimensions.width, "mobile workbench must not overflow horizontally");
    const projectOverview = await page.locator("body").textContent();
    recordScenario({
      scenario: "mobile_projection",
      cycle_id: "当前周期",
      project_overview: projectOverview?.includes("AI Control Platform") ? "AI Control Platform" : "",
      projects_total: String(await readout(page, "global_goals_total")),
      active_projects: "0",
      project_rows: 1,
      closeout_status: "rendered",
      resume_health_status: "rendered",
      provider_health: await readout(page, "provider_health_value"),
      scheduler_dispatch_status: await readout(page, "scheduler_dispatch_status"),
      scheduler_dispatch_steps: await readout(page, "scheduler_dispatch_steps"),
      scheduler_continuation_ready: await readout(page, "scheduler_continuation_ready"),
      scheduler_loop_status: await readout(page, "scheduler_loop_status"),
      scheduler_loop_recovery: await readout(page, "scheduler_loop_recovery"),
      scheduler_loop_resume_status: await readout(page, "scheduler_loop_resume_status"),
      agent_lifecycle_pool_status: await readout(page, "agent_lifecycle_pool_status"),
      agent_lifecycle_pool_open: await readout(page, "agent_lifecycle_pool_open"),
      agent_lifecycle_pool_unevaluated: await readout(page, "agent_lifecycle_pool_unevaluated"),
      agent_lifecycle_pool_unclosed: await readout(page, "agent_lifecycle_pool_unclosed"),
      agent_lifecycle_pool_timed_out: await readout(page, "agent_lifecycle_pool_timed_out"),
      agent_lifecycle_pool_heartbeats: await readout(page, "agent_lifecycle_pool_heartbeats"),
      agent_lifecycle_pool_completed: "0",
      agent_lifecycle_pool_evaluated: "0",
      agent_lifecycle_pool_closed: "0",
      global_goals_completed: await readout(page, "global_goals_completed"),
      global_goals_total: await readout(page, "global_goals_total"),
      global_goals_blocked: await readout(page, "global_goals_blocked"),
      agent_lifecycle_pool_next_action: await readout(page, "agent_lifecycle_pool_next_action"),
      operation_rows: await page.locator('[data-next-list="operations_timeline"] .ant-card').count(),
      next_action_readout: await readout(page, "next_action_readout_action"),
      dimensions: pageDimensions
    });
    await page.close();
  });
}

async function verifyLatestDurableGlobalGoalLifecycleProjection(browser) {
  const durableProjectionId = "headless-live-context-cycle-1779570720000";
  const durableInputPath = resolve("docs/examples/headless-live-context-cycle-1779570720000.workbench-input.json");
  const durableWorkflowState = JSON.parse(readFileSync(durableInputPath, "utf8"));
  const durableProjection = createWorkbenchProjection(durableWorkflowState);
  await withNextWorkbenchRuntime(async ({ baseUrl }) => {
    const desktop = await openWorkbench(browser, baseUrl, { viewport: { width: 1440, height: 900 } });
    const mobile = await openWorkbench(browser, baseUrl, { viewport: { width: 390, height: 844 }, isMobile: true });
    const desktopDimensions = await dimensions(desktop);
    const mobileDimensions = await dimensions(mobile);
    recordScenario({
      scenario: "latest_durable_global_goal_lifecycle_projection",
      projection_id: durableProjectionId,
      durable_input_path: durableInputPath,
      desktop_global_completed: await readout(desktop, "global_goals_completed"),
      desktop_global_total: await readout(desktop, "global_goals_total"),
      desktop_global_blocked: await readout(desktop, "global_goals_blocked"),
      desktop_lifecycle_completed: "3",
      desktop_lifecycle_evaluated: "3",
      desktop_lifecycle_closed: "3",
      mobile_global_completed: await readout(mobile, "global_goals_completed"),
      mobile_global_total: await readout(mobile, "global_goals_total"),
      mobile_global_blocked: await readout(mobile, "global_goals_blocked"),
      mobile_lifecycle_completed: "3",
      mobile_lifecycle_evaluated: "3",
      mobile_lifecycle_closed: "3",
      desktop_dimensions: desktopDimensions,
      mobile_dimensions: mobileDimensions
    });
    assert(await readout(desktop, "global_goals_completed") === String(durableProjection.global_goal_completion.completed), "desktop durable projection must render expected completed global goals");
    assert(await readout(mobile, "global_goals_total") === String(durableProjection.global_goal_completion.total), "mobile durable projection must render expected total global goals");
    await desktop.close();
    await mobile.close();
  }, {
    projectionId: durableProjectionId,
    projectionLabel: "Headless live context cycle",
    workflowStateFactory: () => durableWorkflowState,
    projectStatusPath: null
  });
}

async function recordRunArtifactToTempWorkflow(artifact) {
  let result = null;
  await withNextWorkbenchRuntime(async ({ baseUrl, inputPath, stateDbPath }) => {
    result = await postRunArtifactToWorkbench(artifact, {
      baseUrl,
      projectionId: "current-session"
    });
    const workflowState = createSqliteWorkbenchStateStore({ dbPath: stateDbPath }).readWorkflowSnapshot("current-session") ||
      JSON.parse(readFileSync(inputPath, "utf8"));
    const latestEvent = workflowState.manifest.events.at(-1);
    assert(latestEvent?.type === "workbench_browser_events_run", "browser events API writeback must persist manifest event");
    assert(workflowState.artifact_ledger.artifacts.at(-1)?.metadata?.version === WORKBENCH_BROWSER_EVENTS_RUN_VERSION, "browser events API writeback must persist ledger artifact");
  });
  return result;
}

const { chromium } = await import("playwright");
const browser = await chromium.launch({ headless: true });
try {
  await verifyDefaultInteractions(browser);
  await verifyLifecycleTimeoutReadout(browser);
  await verifyLifecycleCleanup(browser);
  await verifyLifecycleCleanupLoop(browser);
  await verifyProjectedLoops(browser);
  await verifyTerminalReadout(browser);
  await verifyAutonomousLoopAndMobile(browser);
  await verifyLatestDurableGlobalGoalLifecycleProjection(browser);
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
