#!/usr/bin/env node
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const WORKBENCH_BROWSER_EVENTS_RUN_VERSION = "workbench-browser-events-run.v1";
const FRONTEND_ACCEPTANCE_RUN_VERSION = "frontend-acceptance-run.v1";
const FRONTEND_ACCEPTANCE_RELEASE_TARGET = "latest_projection";
const PROJECTED_NEXT_ACTION_STRATEGY_LABEL = "按推荐动作推进";

function run(label, args) {
  console.log(`\n[closeout] ${label}`);
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function validateWorkbenchBrowserEventsArtifact(path) {
  const artifact = JSON.parse(readFileSync(path, "utf8"));
  const scenarios = Array.isArray(artifact.scenarios) ? artifact.scenarios : [];
  const byScenario = new Map(scenarios.map((scenario) => [scenario.scenario, scenario]));
  const partialReadout = byScenario.get("projected_real_partial_shard_readout") || {};
  const lifecycleTimeoutReadout = byScenario.get("agent_lifecycle_pool_timeout_readout") || {};
  const lifecycleCleanup = byScenario.get("agent_lifecycle_pool_cleanup_click") || {};
  const lifecycleCleanupLoop = byScenario.get("agent_lifecycle_pool_cleanup_loop_click") || {};
  if (artifact.version !== WORKBENCH_BROWSER_EVENTS_RUN_VERSION) {
    throw new Error("workbench browser events artifact has invalid version");
  }
  if (artifact.status !== "pass") {
    throw new Error("workbench browser events artifact did not pass");
  }
  if (partialReadout.shard_review_next !== "reviewer-scope-shard-002") {
    throw new Error("workbench browser events artifact is missing projected real partial shard readiness");
  }
  if (partialReadout.next_action_readout !== "run_reviewer_scope_shard") {
    throw new Error("workbench browser events artifact is missing projected real next action evidence");
  }
  if (
    lifecycleTimeoutReadout.desktop_timed_out !== "1" ||
    lifecycleTimeoutReadout.mobile_timed_out !== "1" ||
    lifecycleTimeoutReadout.desktop_heartbeats !== "1" ||
    lifecycleTimeoutReadout.mobile_heartbeats !== "1"
  ) {
    throw new Error("workbench browser events artifact is missing lifecycle heartbeat/timeout readout evidence");
  }
  if (lifecycleCleanup.cleanup_after_status !== "pass") {
    throw new Error("workbench browser events artifact is missing lifecycle cleanup pass evidence");
  }
  if (
    lifecycleCleanupLoop.cleanup_after_status !== "pass" ||
    lifecycleCleanupLoop.cleanup_after_open !== "0" ||
    lifecycleCleanupLoop.cleanup_after_unevaluated !== "0" ||
    lifecycleCleanupLoop.cleanup_after_unclosed !== "0" ||
    lifecycleCleanupLoop.projected_action !== "cleanup_agent_lifecycle_pool" ||
    lifecycleCleanupLoop.scheduler_loop_status !== "pass" ||
    lifecycleCleanupLoop.scheduler_loop_strategy !== PROJECTED_NEXT_ACTION_STRATEGY_LABEL ||
    lifecycleCleanupLoop.next_action_readout !== "inspect_scheduler_loop"
  ) {
    throw new Error("workbench browser events artifact is missing autonomous lifecycle cleanup loop evidence");
  }
  if (scenarios.some((scenario) => scenario.dimensions && scenario.dimensions.scrollWidth > scenario.dimensions.width)) {
    throw new Error("workbench browser events artifact contains horizontal overflow");
  }
}

function validateFrontendAcceptanceArtifact(path) {
  const artifact = JSON.parse(readFileSync(path, "utf8"));
  const findings = Array.isArray(artifact.findings) ? artifact.findings : [];
  const blockingFindings = findings.filter((finding) => (
    finding?.status !== "pass" && ["p0", "p1", "critical", "blocker", "fatal"].includes(String(finding?.severity || "").toLowerCase())
  ));
  const viewports = new Set((Array.isArray(artifact.viewport_results) ? artifact.viewport_results : [])
    .map((result) => result.viewport));
  if (artifact.version !== FRONTEND_ACCEPTANCE_RUN_VERSION) {
    throw new Error("frontend acceptance artifact has invalid version");
  }
  if (
    artifact.acceptance_target !== FRONTEND_ACCEPTANCE_RELEASE_TARGET ||
    artifact.acceptance_mode !== "release_default_latest_projection" ||
    artifact.release_default !== true
  ) {
    throw new Error("frontend acceptance artifact must validate the release default latest projection");
  }
  if (
    artifact.projection_evidence?.mode !== "latest" ||
    !artifact.projection_evidence?.projection_id ||
    artifact.projection_evidence.projection_id === "current-session"
  ) {
    throw new Error("frontend acceptance artifact is missing latest projection evidence");
  }
  if (artifact.status !== "pass") {
    throw new Error(`frontend acceptance artifact did not pass: ${blockingFindings[0]?.code || "unknown_blocker"}`);
  }
  if (blockingFindings.length > 0 || Number(artifact.blocking_count || 0) > 0) {
    throw new Error("frontend acceptance artifact contains blocking findings");
  }
  for (const viewport of ["desktop", "desktop_narrow", "mobile"]) {
    if (!viewports.has(viewport)) {
      throw new Error(`frontend acceptance artifact is missing ${viewport} viewport evidence`);
    }
  }
}

const testFiles = readdirSync("test")
  .filter((file) => file.endsWith(".test.js"))
  .sort()
  .map((file) => join("test", file));

run("unit tests", ["--test", ...testFiles]);
run("project onboarding", ["tools/check-project-onboarding-sync.mjs", "project-manifest.json", "/Users/hernando_zhao/codex/WORKSPACE_INDEX.json"]);
run("git worktree isolation", ["tools/check-git-worktree-isolation.mjs"]);
run("process hardening", ["tools/check-process-hardening.mjs", "docs/examples/process-hardening-current.json"]);
run("workbench live route acceptance", ["tools/check-workbench-live-route.mjs", "--project-status", "PROJECT_STATUS.json"]);
const closeoutTmp = mkdtempSync(join(tmpdir(), "ai-control-platform-closeout-"));
const browserEventsArtifactPath = join(closeoutTmp, "workbench-browser-events-run.json");
run("workbench browser events", ["tools/check-workbench-browser-events.mjs", "--output", browserEventsArtifactPath, "--record-temp-workflow"]);
validateWorkbenchBrowserEventsArtifact(browserEventsArtifactPath);
const frontendAcceptanceArtifactPath = join(closeoutTmp, "frontend-acceptance-run.json");
run("workbench frontend acceptance", ["tools/check-workbench-frontend-acceptance.mjs", "--output", frontendAcceptanceArtifactPath]);
validateFrontendAcceptanceArtifact(frontendAcceptanceArtifactPath);
run("scheduler dispatch writeback", ["tools/check-scheduler-dispatch-writeback.mjs"]);

console.log("\n[closeout] pass");
