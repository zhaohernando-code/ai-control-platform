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
      "projected_mock_loop_click",
      "projected_real_partial_shard_readout",
      "autonomous_scheduler_loop_click",
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

  const server = createWorkbenchServer({
    eventsPath,
    historyPath,
    snapshotsRoot,
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

    assert(schedulerDispatchStatus === "pass", "scheduler dispatch click must update rendered scheduler status");
    assert(schedulerDispatchSteps === "3", "scheduler dispatch click must render scheduler step count");
    assert(schedulerPolicyStatus === "pass", "scheduler dispatch click must render policy pass");
    assert(schedulerPolicyMode === "dry_run", "scheduler dispatch click must render policy execution mode");
    assert(dimensions.scrollWidth <= dimensions.width, "scheduler dispatch click must not create horizontal overflow");

    recordScenario({
      scenario: "scheduler_dispatch_click",
      scheduler_dispatch_status: schedulerDispatchStatus,
      scheduler_dispatch_steps: schedulerDispatchSteps,
      scheduler_policy_status: schedulerPolicyStatus,
      scheduler_policy_mode: schedulerPolicyMode,
      dimensions
    });
  });
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

    assert(schedulerDispatchStatus === "pass", "approved mock dispatch must render scheduler pass");
    assert(schedulerDispatchDryRun === "no", "approved mock dispatch must render non-dry-run");
    assert(schedulerPolicyStatus === "pass", "approved mock dispatch must render policy pass");
    assert(schedulerPolicyMode === "execute", "approved mock dispatch must render execute policy mode");
    assert(schedulerNextStatus === "pass", "approved mock dispatch must render next continuation status");
    assert(schedulerNextPackages === "3", "approved mock dispatch must render next work package count");
    assert(schedulerContinuationReady === "ready", "approved mock dispatch must render scheduler continuation readiness");
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
  });
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
    await page.waitForFunction(() => document.querySelector('[data-autonomous-scheduler-loop="projected-mock"]')?.textContent.includes("Projected Loop 已记录"));

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

    assert(schedulerLoopStatus === "pass", "projected mock loop must render loop pass");
    assert(schedulerLoopIterations === "2", "projected mock loop must run two reviewer shard iterations");
    assert(schedulerLoopStrategy === "projected_next_action", "projected mock loop must render projected strategy");
    assert(shardReviewCompleted === "2", "projected mock loop must render completed reviewer shards");
    assert(shardReviewStatus === "pass", "projected mock loop must aggregate reviewer shard status");
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
    await page.waitForFunction(() => document.querySelector('[data-autonomous-scheduler-loop="projected-real"]')?.textContent.includes("Projected Loop 已记录"));

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
    assert(schedulerLoopStatus === "pass", "projected real partial loop must render loop pass");
    assert(schedulerLoopIterations === "1", "projected real partial loop must stay within one iteration");
    assert(schedulerLoopStrategy === "projected_next_action", "projected real partial loop must render projected strategy");
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

async function verifyAutonomousSchedulerLoopClick(browser) {
  await withWorkbenchServer(async ({ port }) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(
      `http://127.0.0.1:${port}/apps/workbench/desktop.html?projection=/api/workbench/projection&history=/api/workbench/projections`,
      { waitUntil: "networkidle" }
    );
    await page.waitForFunction(() => document.querySelector("[data-history-select]")?.options.length > 0);
    await page.click('[data-autonomous-scheduler-loop="bounded"]');
    await page.waitForFunction(() => document.querySelector('[data-autonomous-scheduler-loop="bounded"]')?.textContent.includes("Loop 已记录"));

    const schedulerLoopStatus = await page.textContent('[data-bind="scheduler_loop_status"]');
    const schedulerLoopIterations = await page.textContent('[data-bind="scheduler_loop_iterations"]');
    const schedulerLoopRecovery = await page.textContent('[data-bind="scheduler_loop_recovery"]');
    await page.click('[data-autonomous-scheduler-loop-resume="bounded"]');
    await page.waitForFunction(() => document.querySelector('[data-autonomous-scheduler-loop-resume="bounded"]')?.textContent.includes("Resume 已记录"));
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

    assert(schedulerLoopStatus === "pass", "autonomous scheduler loop click must render loop pass");
    assert(schedulerLoopIterations === "1", "autonomous scheduler loop click must render one loop iteration");
    assert(schedulerLoopRecovery === "ready", "autonomous scheduler loop click must render recovery readiness");
    assert(resumedLoopStatus === "pass", "autonomous scheduler loop resume must render loop pass");
    assert(resumedLoopRecovery === "idle", "autonomous scheduler loop resume must render idle recovery when no actions remain");
    assert(resumedLoopAttempt === "not_configured", "resume target projection should not claim the source resume attempt");
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
    const schedulerContinuationReady = await page.textContent('[data-bind="scheduler_continuation_ready"]');
    const schedulerLoopStatus = await page.textContent('[data-bind="scheduler_loop_status"]');
    const schedulerLoopRecovery = await page.textContent('[data-bind="scheduler_loop_recovery"]');
    const schedulerLoopResumeStatus = await page.textContent('[data-bind="scheduler_loop_resume_status"]');
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
  await verifyProjectedMockLoopClick(browser);
  await verifyProjectedRealPartialShardReadout(browser);
  await verifyAutonomousSchedulerLoopClick(browser);
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
