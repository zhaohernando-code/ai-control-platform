#!/usr/bin/env node
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const WORKBENCH_BROWSER_EVENTS_RUN_VERSION = "workbench-browser-events-run.v1";

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
  if (scenarios.some((scenario) => scenario.dimensions && scenario.dimensions.scrollWidth > scenario.dimensions.width)) {
    throw new Error("workbench browser events artifact contains horizontal overflow");
  }
}

const testFiles = readdirSync("test")
  .filter((file) => file.endsWith(".test.js"))
  .sort()
  .map((file) => join("test", file));

run("unit tests", ["--test", ...testFiles]);
run("project onboarding", ["tools/check-project-onboarding-sync.mjs", "project-manifest.json", "/Users/hernando_zhao/codex/WORKSPACE_INDEX.json"]);
run("process hardening", ["tools/check-process-hardening.mjs", "docs/examples/process-hardening-current.json"]);
const closeoutTmp = mkdtempSync(join(tmpdir(), "ai-control-platform-closeout-"));
const browserEventsArtifactPath = join(closeoutTmp, "workbench-browser-events-run.json");
run("workbench browser events", ["tools/check-workbench-browser-events.mjs", "--output", browserEventsArtifactPath, "--record-temp-workflow"]);
validateWorkbenchBrowserEventsArtifact(browserEventsArtifactPath);
run("scheduler dispatch writeback", ["tools/check-scheduler-dispatch-writeback.mjs"]);

console.log("\n[closeout] pass");
