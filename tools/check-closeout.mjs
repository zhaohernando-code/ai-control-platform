#!/usr/bin/env node
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import {
  validateFrontendAcceptanceArtifact,
  validateWorkbenchBrowserEventsArtifact
} from "../src/workflow/closeout-validation.js";

const LIVE_ROUTE_EVIDENCE_ENV = "WORKBENCH_LIVE_ROUTE_EVIDENCE";
const WORKBENCH_API_PORT = process.env.AI_CONTROL_WORKBENCH_API_PORT || "4182";
const WORKBENCH_HOST = process.env.AI_CONTROL_WORKBENCH_HOST || "127.0.0.1";
const MAINLINE_BRANCH = process.env.AI_CONTROL_MAINLINE_BRANCH || "main";
const REQUIRE_MAINLINE_CLOSEOUT = process.env.AI_CONTROL_CLOSEOUT_REQUIRE_MAINLINE === "1";

function withoutLiveRouteEvidenceEnv(env = process.env) {
  const nextEnv = { ...env };
  delete nextEnv[LIVE_ROUTE_EVIDENCE_ENV];
  return nextEnv;
}

function run(label, args, options = {}) {
  console.log(`\n[closeout] ${label}`);
  const result = spawnSync(process.execPath, args, { stdio: "inherit", env: options.env || process.env });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function gitOutput(args) {
  const result = spawnSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) return "";
  return String(result.stdout || "").trim();
}

function shouldRunMainlineReleaseReadiness() {
  const branch = gitOutput(["branch", "--show-current"]);
  return REQUIRE_MAINLINE_CLOSEOUT || branch === MAINLINE_BRANCH;
}

export function runCloseoutChecks() {
  const testFiles = readdirSync("test")
    .filter((file) => file.endsWith(".test.js"))
    .sort()
    .map((file) => join("test", file));

  run("unit tests", ["--test", "--test-force-exit", ...testFiles], { env: withoutLiveRouteEvidenceEnv() });
  run("project onboarding", ["tools/check-project-onboarding-sync.mjs", "project-manifest.json", "/Users/hernando_zhao/codex/WORKSPACE_INDEX.json"]);
  run("git worktree isolation", ["tools/check-git-worktree-isolation.mjs"]);
  run("process hardening", ["tools/check-process-hardening.mjs", "docs/examples/process-hardening-current.json"]);
  run("api route contract", ["tools/check-api-route-contract.mjs"]);
  run("workbench live route acceptance", ["tools/check-workbench-live-route.mjs", "--project-status", "PROJECT_STATUS.json"]);
  run("workbench public browser route", ["tools/check-workbench-public-browser-route.mjs"]);
  run("workbench state boundary", ["tools/check-workbench-state-boundary.mjs"]);
  run("workbench live state cleanliness", ["tools/check-workbench-live-state-cleanliness.mjs"]);
  run("development flow provider C2C governance", ["tools/check-development-flow-real.mjs"]);
  run("governance audit skill trial", [
    "tools/run-governance-audit-skill-trial.mjs",
    "--route", `http://${WORKBENCH_HOST}:4180/projects/ai-control-platform/flow`,
    "--output", "tmp/audit-skill-trial/closeout-governance-audit-current.json",
    "--raw-output", "tmp/audit-skill-trial/closeout-governance-audit-current.raw.txt",
    "--prompt-output", "tmp/audit-skill-trial/closeout-governance-audit-current.prompt.md",
    "--record-workbench-url", `http://${WORKBENCH_HOST}:${WORKBENCH_API_PORT}/api/workbench/governance-audit-skill-trial`
  ]);
  if (shouldRunMainlineReleaseReadiness()) {
    run("mainline release readiness", ["tools/check-mainline-release-readiness.mjs", "--project-status", "PROJECT_STATUS.json"]);
  } else {
    console.log("\n[closeout] mainline release readiness");
    console.log(JSON.stringify({
      status: "skipped",
      reason: "isolated worktree closeout defers mainline integration to the parent release step",
      require_mainline: REQUIRE_MAINLINE_CLOSEOUT,
      expected_mainline_branch: MAINLINE_BRANCH
    }, null, 2));
  }
  const closeoutTmp = mkdtempSync(join(tmpdir(), "ai-control-platform-closeout-"));
  const browserEventsArtifactPath = join(closeoutTmp, "workbench-browser-events-run.json");
  run("workbench browser events", ["tools/check-workbench-browser-events.mjs", "--output", browserEventsArtifactPath, "--record-temp-workflow"]);
  validateWorkbenchBrowserEventsArtifact(browserEventsArtifactPath);
  const frontendAcceptanceArtifactPath = join(closeoutTmp, "frontend-acceptance-run.json");
  run("workbench frontend acceptance", ["tools/check-workbench-frontend-acceptance.mjs", "--output", frontendAcceptanceArtifactPath]);
  validateFrontendAcceptanceArtifact(frontendAcceptanceArtifactPath);
  run("scheduler dispatch writeback", ["tools/check-scheduler-dispatch-writeback.mjs"]);

  console.log("\n[closeout] pass");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCloseoutChecks();
}
