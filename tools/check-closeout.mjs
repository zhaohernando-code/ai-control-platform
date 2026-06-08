#!/usr/bin/env node
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
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
const CLOSEOUT_CHILD_TIMEOUT_MS = Number.parseInt(process.env.AI_CONTROL_CLOSEOUT_CHILD_TIMEOUT_MS || "", 10) || 15 * 60 * 1000;
const CLOSEOUT_DEPENDENCY_INSTALL_TIMEOUT_MS =
  Number.parseInt(process.env.AI_CONTROL_CLOSEOUT_DEPENDENCY_INSTALL_TIMEOUT_MS || "", 10) || 2 * 60 * 1000;
const SKIP_DEPENDENCY_PREFLIGHT_ENV = "AI_CONTROL_CLOSEOUT_SKIP_DEPENDENCY_PREFLIGHT";
const FORCE_DEPENDENCY_INSTALL_ENV = "AI_CONTROL_CLOSEOUT_FORCE_DEPENDENCY_INSTALL";
const CLOSEOUT_DEPENDENCIES = [
  {
    id: "root-playwright",
    label: "root Playwright",
    cwd: ".",
    packageName: "playwright",
    lockfile: "package-lock.json",
    installCommand: ["npm", "ci"]
  },
  {
    id: "workbench-next",
    label: "Workbench Next.js",
    cwd: "apps/workbench",
    packageName: "next",
    lockfile: "apps/workbench/package-lock.json",
    installCommand: ["npm", "ci"]
  }
];

function withoutLiveRouteEvidenceEnv(env = process.env) {
  const nextEnv = { ...env };
  delete nextEnv[LIVE_ROUTE_EVIDENCE_ENV];
  return nextEnv;
}

function run(label, args, options = {}) {
  console.log(`\n[closeout] ${label}`);
  const result = spawnSync(process.execPath, args, {
    stdio: "inherit",
    env: options.env || process.env,
    timeout: CLOSEOUT_CHILD_TIMEOUT_MS
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function resolvePackageFrom(packageName, cwd) {
  try {
    createRequire(join(cwd, "package.json")).resolve(packageName);
    return true;
  } catch {
    return false;
  }
}

function dependencyStatus(dependency, projectRoot, resolver) {
  const cwd = join(projectRoot, dependency.cwd);
  return {
    ...dependency,
    absoluteCwd: cwd,
    lockfilePath: join(projectRoot, dependency.lockfile),
    resolved: resolver(dependency.packageName, cwd)
  };
}

export function ensureCloseoutDependencyReadiness(options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const env = options.env || process.env;
  const logger = options.logger || console;
  const exists = options.exists || existsSync;
  const spawn = options.spawn || spawnSync;
  const resolver = options.resolver || resolvePackageFrom;
  const installTimeoutMs = options.installTimeoutMs || CLOSEOUT_DEPENDENCY_INSTALL_TIMEOUT_MS;
  const skipInstall = env[SKIP_DEPENDENCY_PREFLIGHT_ENV] === "1";
  const forceInstall = env[FORCE_DEPENDENCY_INSTALL_ENV] === "1";
  const initialDependencies = CLOSEOUT_DEPENDENCIES.map((dependency) => dependencyStatus(dependency, projectRoot, resolver));
  const dependenciesToInstall = initialDependencies.filter((dependency) => forceInstall || !dependency.resolved);
  const installs = [];

  logger.log("\n[closeout] dependency readiness");

  if (dependenciesToInstall.length === 0) {
    const result = {
      status: "pass",
      action: "skipped",
      reason: "required closeout dependencies already resolve",
      dependencies: initialDependencies.map(({ id, label, resolved }) => ({ id, label, resolved }))
    };
    logger.log(JSON.stringify(result, null, 2));
    return result;
  }

  if (skipInstall) {
    const result = {
      status: "fail",
      exitCode: 4,
      reason: "dependency preflight skipped and required closeout dependencies are missing",
      missing_dependencies: dependenciesToInstall
        .filter((dependency) => !dependency.resolved)
        .map(({ id, label, cwd, packageName }) => ({ id, label, cwd, packageName }))
    };
    logger.error(JSON.stringify(result, null, 2));
    return result;
  }

  for (const dependency of dependenciesToInstall) {
    if (!exists(dependency.lockfilePath)) {
      const result = {
        status: "fail",
        exitCode: 2,
        reason: "package-lock.json missing; cannot perform reproducible closeout dependency install",
        dependency: {
          id: dependency.id,
          label: dependency.label,
          cwd: dependency.cwd,
          lockfile: dependency.lockfile
        },
        installs
      };
      logger.error(JSON.stringify(result, null, 2));
      return result;
    }

    logger.log(JSON.stringify({
      status: "installing",
      dependency: dependency.id,
      cwd: dependency.cwd,
      command: dependency.installCommand.join(" ")
    }, null, 2));
    const installResult = spawn(dependency.installCommand[0], dependency.installCommand.slice(1), {
      cwd: dependency.absoluteCwd,
      stdio: "inherit",
      env,
      timeout: installTimeoutMs
    });
    installs.push({
      dependency: dependency.id,
      cwd: dependency.cwd,
      status: installResult.status ?? null,
      signal: installResult.signal ?? null,
      error: installResult.error?.message || null
    });
    if (installResult.error || installResult.status !== 0) {
      const result = {
        status: "fail",
        exitCode: 3,
        reason: "closeout dependency install failed",
        dependency: {
          id: dependency.id,
          label: dependency.label,
          cwd: dependency.cwd,
          command: dependency.installCommand.join(" ")
        },
        install: installs.at(-1)
      };
      logger.error(JSON.stringify(result, null, 2));
      return result;
    }
  }

  const finalDependencies = CLOSEOUT_DEPENDENCIES.map((dependency) => dependencyStatus(dependency, projectRoot, resolver));
  const unresolvedDependencies = finalDependencies.filter((dependency) => !dependency.resolved);
  if (unresolvedDependencies.length > 0) {
    const result = {
      status: "fail",
      exitCode: 5,
      reason: "closeout dependencies still do not resolve after install",
      unresolved_dependencies: unresolvedDependencies.map(({ id, label, cwd, packageName }) => ({ id, label, cwd, packageName })),
      installs
    };
    logger.error(JSON.stringify(result, null, 2));
    return result;
  }

  const result = {
    status: "pass",
    action: "installed",
    installs,
    dependencies: finalDependencies.map(({ id, label, resolved }) => ({ id, label, resolved }))
  };
  logger.log(JSON.stringify(result, null, 2));
  return result;
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
  const dependencyReadiness = ensureCloseoutDependencyReadiness();
  if (dependencyReadiness.status !== "pass") {
    process.exit(dependencyReadiness.exitCode || 1);
  }

  const testFiles = readdirSync("test")
    .filter((file) => file.endsWith(".test.js"))
    .sort()
    .map((file) => join("test", file));

  run("unit tests", ["--test", ...testFiles], { env: withoutLiveRouteEvidenceEnv() });
  run("project onboarding", ["tools/check-project-onboarding-sync.mjs", "project-manifest.json", "/Users/hernando_zhao/codex/WORKSPACE_INDEX.json"]);
  run("git worktree isolation", ["tools/check-git-worktree-isolation.mjs"]);
  run("large file governance", ["tools/report-large-files.mjs", "--fail-on-issues"]);
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
  run("workbench frontend acceptance", ["tools/check-workbench-next-frontend-acceptance.mjs", "--output", frontendAcceptanceArtifactPath]);
  validateFrontendAcceptanceArtifact(frontendAcceptanceArtifactPath);
  run("scheduler dispatch writeback", ["tools/check-scheduler-dispatch-writeback.mjs"]);

  console.log("\n[closeout] pass");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCloseoutChecks();
}
