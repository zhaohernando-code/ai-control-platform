#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { createSqliteWorkbenchStateStore } from "../src/workflow/workbench-state-store.js";
import { verifyDefaultInteractions } from "./workbench-browser-events-default-scenarios.mjs";
import {
  verifyLifecycleCleanup,
  verifyLifecycleCleanupLoop,
  verifyLifecycleTimeoutReadout
} from "./workbench-browser-events-lifecycle-scenarios.mjs";
import {
  verifyAutonomousLoopAndMobile,
  verifyLatestDurableGlobalGoalLifecycleProjection,
  verifyProjectedLoops,
  verifyTerminalReadout
} from "./workbench-browser-events-projected-scenarios.mjs";
import {
  assert,
  workbenchApiUrl,
  withNextWorkbenchRuntime
} from "./workbench-browser-events-runtime.mjs";

const WORKBENCH_BROWSER_EVENTS_RUN_VERSION = "workbench-browser-events-run.v1";
const scenarioResults = [];
const REQUIRED_SCENARIOS = [
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
];
const SCENARIO_GROUPS = [
  {
    name: "default_interactions",
    scenarios: [
      "success",
      "failure",
      "provider_health_click",
      "scheduler_dispatch_click",
      "scheduler_dispatch_approved_mock_click",
      "guarded_next_action_click"
    ],
    run: verifyDefaultInteractions
  },
  {
    name: "lifecycle_timeout",
    scenarios: ["agent_lifecycle_pool_timeout_readout"],
    run: verifyLifecycleTimeoutReadout
  },
  {
    name: "lifecycle_cleanup",
    scenarios: ["agent_lifecycle_pool_cleanup_click"],
    run: verifyLifecycleCleanup
  },
  {
    name: "lifecycle_cleanup_loop",
    scenarios: ["agent_lifecycle_pool_cleanup_loop_click"],
    run: verifyLifecycleCleanupLoop
  },
  {
    name: "projected_loops",
    scenarios: ["projected_mock_loop_click", "projected_real_partial_shard_readout"],
    run: verifyProjectedLoops
  },
  {
    name: "terminal_readout",
    scenarios: ["terminal_next_action_readout"],
    run: verifyTerminalReadout
  },
  {
    name: "autonomous_loop_and_mobile",
    scenarios: ["autonomous_scheduler_loop_click", "mobile_projection"],
    run: verifyAutonomousLoopAndMobile
  },
  {
    name: "durable_global_goal_lifecycle",
    scenarios: ["latest_durable_global_goal_lifecycle_projection"],
    run: verifyLatestDurableGlobalGoalLifecycleProjection
  }
];

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

function assertScenarioContract() {
  const planned = SCENARIO_GROUPS.flatMap((group) => group.scenarios);
  const actual = scenarioResults.map((result) => result.scenario);
  assert(planned.length === REQUIRED_SCENARIOS.length, "scenario group mapping must cover every required scenario");
  assert(actual.length === REQUIRED_SCENARIOS.length, "browser-events gate must record every required scenario");
  for (const scenario of REQUIRED_SCENARIOS) {
    assert(planned.includes(scenario), `scenario group mapping missing required scenario: ${scenario}`);
    assert(actual.includes(scenario), `browser-events gate missing required scenario: ${scenario}`);
  }
  assert(new Set(planned).size === planned.length, "scenario group mapping must not duplicate scenario names");
  assert(new Set(actual).size === actual.length, "browser-events gate must not record duplicate scenario names");
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
    required_scenarios: REQUIRED_SCENARIOS,
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
  const url = workbenchApiUrl(baseUrl, "/api/workbench/workbench-browser-events-run");
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

const recordContext = { recordScenario };
const { chromium } = await import("playwright");
const browser = await chromium.launch({ headless: true });
try {
  for (const group of SCENARIO_GROUPS) {
    await group.run(browser, recordContext);
  }
} finally {
  await browser.close();
}
assertScenarioContract();

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
