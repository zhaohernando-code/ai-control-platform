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
const AUDIT_SKILL_TRIAL_RUN_ENV = "AUDIT_SKILL_TRIAL_RUN";
const DEFAULT_AUDIT_SKILL_TRIAL_RUN_PATH = "docs/examples/audit-skill-trial-current.json";

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

export function runCloseoutChecks() {
  const testFiles = readdirSync("test")
    .filter((file) => file.endsWith(".test.js"))
    .sort()
    .map((file) => join("test", file));

  run("unit tests", ["--test", ...testFiles], { env: withoutLiveRouteEvidenceEnv() });
  run("project onboarding", ["tools/check-project-onboarding-sync.mjs", "project-manifest.json", "/Users/hernando_zhao/codex/WORKSPACE_INDEX.json"]);
  run("git worktree isolation", ["tools/check-git-worktree-isolation.mjs"]);
  run("process hardening", ["tools/check-process-hardening.mjs", "docs/examples/process-hardening-current.json"]);
  run("workbench live route acceptance", ["tools/check-workbench-live-route.mjs", "--project-status", "PROJECT_STATUS.json"]);
  run("workbench state boundary", ["tools/check-workbench-state-boundary.mjs"]);
  run("audit skill trial", ["tools/check-audit-skill-trial-run.mjs", process.env[AUDIT_SKILL_TRIAL_RUN_ENV] || DEFAULT_AUDIT_SKILL_TRIAL_RUN_PATH]);
  run("mainline release readiness", ["tools/check-mainline-release-readiness.mjs", "--project-status", "PROJECT_STATUS.json"]);
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
