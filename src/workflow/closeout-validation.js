import { readFileSync } from "node:fs";

import { validateFrontendAcceptanceRunArtifact } from "./frontend-acceptance.js";

export const WORKBENCH_BROWSER_EVENTS_RUN_VERSION = "workbench-browser-events-run.v1";
export const FRONTEND_ACCEPTANCE_RUN_VERSION = "frontend-acceptance-run.v1";
export const FRONTEND_ACCEPTANCE_RELEASE_TARGET = "latest_projection";
export const PROJECTED_NEXT_ACTION_STRATEGY_LABEL = "按推荐动作推进";

const RENDERED_PASS_STATUSES = new Set(["pass", "passed", "ok", "success", "succeeded", "通过"]);

export function isRenderedPassStatus(value) {
  return RENDERED_PASS_STATUSES.has(String(value || "").trim().toLowerCase());
}

function assertRenderedPassStatus(value, message) {
  if (!isRenderedPassStatus(value)) {
    throw new Error(message);
  }
}

export function validateWorkbenchBrowserEventsArtifact(path) {
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
  assertRenderedPassStatus(
    lifecycleCleanup.cleanup_after_status,
    "workbench browser events artifact is missing lifecycle cleanup pass evidence"
  );
  if (
    lifecycleCleanupLoop.cleanup_after_open !== "0" ||
    lifecycleCleanupLoop.cleanup_after_unevaluated !== "0" ||
    lifecycleCleanupLoop.cleanup_after_unclosed !== "0" ||
    lifecycleCleanupLoop.projected_action !== "cleanup_agent_lifecycle_pool" ||
    lifecycleCleanupLoop.scheduler_loop_strategy !== PROJECTED_NEXT_ACTION_STRATEGY_LABEL ||
    lifecycleCleanupLoop.next_action_readout !== "resume_autonomous_scheduler_loop"
  ) {
    throw new Error("workbench browser events artifact is missing autonomous lifecycle cleanup loop evidence");
  }
  assertRenderedPassStatus(
    lifecycleCleanupLoop.cleanup_after_status,
    "workbench browser events artifact is missing autonomous lifecycle cleanup loop evidence"
  );
  assertRenderedPassStatus(
    lifecycleCleanupLoop.scheduler_loop_status,
    "workbench browser events artifact is missing autonomous lifecycle cleanup loop evidence"
  );
  if (scenarios.some((scenario) => scenario.dimensions && scenario.dimensions.scrollWidth > scenario.dimensions.width)) {
    throw new Error("workbench browser events artifact contains horizontal overflow");
  }
}

export function validateFrontendAcceptanceArtifact(path) {
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
  const validation = validateFrontendAcceptanceRunArtifact(artifact, {
    requireDurableReleaseEvidence: true
  });
  if (validation.status !== "pass") {
    const firstIssue = validation.issues[0] || {};
    throw new Error(`frontend acceptance artifact is missing durable workflow/projection evidence: ${firstIssue.code || "unknown_issue"}`);
  }
}
