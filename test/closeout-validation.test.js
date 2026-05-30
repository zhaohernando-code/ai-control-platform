import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.js";
import {
  isRenderedPassStatus,
  validateWorkbenchBrowserEventsArtifact,
  validateFrontendAcceptanceArtifact,
  WORKBENCH_BROWSER_EVENTS_RUN_VERSION,
  FRONTEND_ACCEPTANCE_RUN_VERSION,
  FRONTEND_ACCEPTANCE_RELEASE_TARGET,
  PROJECTED_NEXT_ACTION_STRATEGY_LABEL
} from "../src/workflow/closeout-validation.js";

// closeout-validation.js is a closeout GATE validator (baseline 53% line / 50% branch). These
// tests drive its real throw-on-invariant-violation behavior, not tautologies: each case
// asserts a specific guard fires (or doesn't), via real artifact JSON written to a temp file.

function writeArtifact(t, name, obj) {
  const dir = tempDir(t, "ai-control-platform-closeout-");
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(obj));
  return path;
}

// ---- isRenderedPassStatus (pure) ----------------------------------------------------------

test("isRenderedPassStatus: accepts the rendered pass tokens incl. localized 通过", () => {
  for (const v of ["pass", "passed", "ok", "success", "succeeded", "通过", " PASS ", "Success"]) {
    assert.equal(isRenderedPassStatus(v), true, `${JSON.stringify(v)} should be a pass status`);
  }
});

test("isRenderedPassStatus: rejects non-pass / empty / nullish", () => {
  for (const v of ["fail", "blocked", "", null, undefined, "rerun", "通過"]) {
    assert.equal(isRenderedPassStatus(v), false, `${JSON.stringify(v)} should not be a pass status`);
  }
});

// ---- a fully-valid browser-events artifact (happy path) -----------------------------------

function validBrowserEventsArtifact() {
  return {
    version: WORKBENCH_BROWSER_EVENTS_RUN_VERSION,
    status: "pass",
    scenarios: [
      { scenario: "projected_real_partial_shard_readout", shard_review_next: "reviewer-scope-shard-002", next_action_readout: "run_reviewer_scope_shard" },
      { scenario: "agent_lifecycle_pool_timeout_readout", desktop_timed_out: "1", mobile_timed_out: "1", desktop_heartbeats: "1", mobile_heartbeats: "1" },
      { scenario: "agent_lifecycle_pool_cleanup_click", cleanup_after_status: "pass" },
      {
        scenario: "agent_lifecycle_pool_cleanup_loop_click",
        cleanup_after_open: "0", cleanup_after_unevaluated: "0", cleanup_after_unclosed: "0",
        projected_action: "cleanup_agent_lifecycle_pool",
        scheduler_loop_strategy: PROJECTED_NEXT_ACTION_STRATEGY_LABEL,
        next_action_readout: "resume_autonomous_scheduler_loop",
        cleanup_after_status: "通过",
        scheduler_loop_status: "pass"
      }
    ]
  };
}

test("validateWorkbenchBrowserEventsArtifact: a complete valid artifact passes", (t) => {
  const path = writeArtifact(t, "be.json", validBrowserEventsArtifact());
  assert.doesNotThrow(() => validateWorkbenchBrowserEventsArtifact(path));
});

test("validateWorkbenchBrowserEventsArtifact: each invariant violation throws its own error", (t) => {
  const cases = [
    [(a) => { a.version = "wrong"; }, /invalid version/],
    [(a) => { a.status = "fail"; }, /did not pass/],
    [(a) => { a.scenarios[0].shard_review_next = "x"; }, /projected real partial shard readiness/],
    [(a) => { a.scenarios[0].next_action_readout = "x"; }, /projected real next action/],
    [(a) => { a.scenarios[1].desktop_timed_out = "0"; }, /lifecycle heartbeat\/timeout readout/],
    [(a) => { a.scenarios[2].cleanup_after_status = "fail"; }, /lifecycle cleanup pass evidence/],
    [(a) => { a.scenarios[3].projected_action = "x"; }, /autonomous lifecycle cleanup loop evidence/],
    [(a) => { a.scenarios[3].scheduler_loop_status = "fail"; }, /autonomous lifecycle cleanup loop evidence/],
    [(a) => { a.scenarios.push({ scenario: "x", dimensions: { scrollWidth: 800, width: 400 } }); }, /horizontal overflow/]
  ];
  for (const [mutate, re] of cases) {
    const artifact = validBrowserEventsArtifact();
    mutate(artifact);
    const path = writeArtifact(t, "be.json", artifact);
    assert.throws(() => validateWorkbenchBrowserEventsArtifact(path), re);
  }
});

// ---- frontend-acceptance artifact ---------------------------------------------------------

function validFrontendAcceptanceArtifact() {
  return {
    version: FRONTEND_ACCEPTANCE_RUN_VERSION,
    acceptance_target: FRONTEND_ACCEPTANCE_RELEASE_TARGET,
    acceptance_mode: "release_default_latest_projection",
    release_default: true,
    projection_evidence: { mode: "latest", projection_id: "proj-123" },
    status: "pass",
    findings: [],
    blocking_count: 0,
    viewport_results: [{ viewport: "desktop" }, { viewport: "desktop_narrow" }, { viewport: "mobile" }]
  };
}

test("validateFrontendAcceptanceArtifact: each gate violation throws before durable-evidence check", (t) => {
  const cases = [
    [(a) => { a.version = "wrong"; }, /invalid version/],
    [(a) => { a.release_default = false; }, /release default latest projection/],
    [(a) => { a.projection_evidence.projection_id = "current-session"; }, /missing latest projection evidence/],
    [(a) => { a.status = "fail"; a.findings = [{ status: "fail", severity: "p0", code: "boom" }]; }, /did not pass: boom/],
    [(a) => { a.viewport_results = [{ viewport: "desktop" }, { viewport: "mobile" }]; }, /missing desktop_narrow viewport/]
  ];
  for (const [mutate, re] of cases) {
    const artifact = validFrontendAcceptanceArtifact();
    mutate(artifact);
    const path = writeArtifact(t, "fa.json", artifact);
    assert.throws(() => validateFrontendAcceptanceArtifact(path), re);
  }
});

test("validateFrontendAcceptanceArtifact: blocking findings are rejected even when status=pass", (t) => {
  const artifact = validFrontendAcceptanceArtifact();
  artifact.blocking_count = 2; // status still "pass" but blocking_count>0 must throw
  const path = writeArtifact(t, "fa.json", artifact);
  assert.throws(() => validateFrontendAcceptanceArtifact(path), /contains blocking findings/);
});
