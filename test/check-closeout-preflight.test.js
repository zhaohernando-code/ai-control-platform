import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureCloseoutDependencyReadiness
} from "../tools/check-closeout.mjs";

const PROJECT_ROOT = "/tmp/ai-control-platform";

function makeLogger() {
  return {
    logs: [],
    errors: [],
    log(message) {
      this.logs.push(String(message));
    },
    error(message) {
      this.errors.push(String(message));
    }
  };
}

function runPreflight(options = {}) {
  const calls = [];
  const logger = makeLogger();
  const existingPaths = new Set(options.existingPaths || [
    `${PROJECT_ROOT}/package-lock.json`,
    `${PROJECT_ROOT}/apps/workbench/package-lock.json`
  ]);
  const resolvedPackages = new Set(options.resolvedPackages || []);
  const resolver = options.resolver || ((packageName, cwd) => resolvedPackages.has(`${cwd}:${packageName}`));
  const result = ensureCloseoutDependencyReadiness({
    projectRoot: PROJECT_ROOT,
    env: options.env || {},
    logger,
    exists: (path) => existingPaths.has(path),
    resolver,
    spawn: (command, args, spawnOptions) => {
      calls.push({ command, args, cwd: spawnOptions.cwd, timeout: spawnOptions.timeout });
      if (options.afterSpawnResolvedPackages) {
        for (const entry of options.afterSpawnResolvedPackages) resolvedPackages.add(entry);
      }
      return options.spawnResult || { status: 0 };
    },
    installTimeoutMs: 1234
  });
  return { result, calls, logger };
}

test("closeout dependency preflight installs root Playwright when missing", () => {
  const { result, calls } = runPreflight({
    resolvedPackages: [`${PROJECT_ROOT}/apps/workbench:next`],
    afterSpawnResolvedPackages: [`${PROJECT_ROOT}:playwright`]
  });

  assert.equal(result.status, "pass");
  assert.deepEqual(calls.map((call) => call.cwd), [PROJECT_ROOT]);
  assert.deepEqual(calls[0].args, ["ci"]);
});

test("closeout dependency preflight installs Workbench Next when missing", () => {
  const { result, calls } = runPreflight({
    resolvedPackages: [`${PROJECT_ROOT}:playwright`],
    afterSpawnResolvedPackages: [`${PROJECT_ROOT}/apps/workbench:next`]
  });

  assert.equal(result.status, "pass");
  assert.deepEqual(calls.map((call) => call.cwd), [`${PROJECT_ROOT}/apps/workbench`]);
});

test("closeout dependency preflight skips install when required dependencies resolve", () => {
  const { result, calls } = runPreflight({
    resolvedPackages: [`${PROJECT_ROOT}:playwright`, `${PROJECT_ROOT}/apps/workbench:next`]
  });

  assert.equal(result.status, "pass");
  assert.equal(result.action, "skipped");
  assert.deepEqual(calls, []);
});

test("closeout dependency preflight fails closed when npm ci fails", () => {
  const { result, calls } = runPreflight({
    resolvedPackages: [`${PROJECT_ROOT}/apps/workbench:next`],
    spawnResult: { status: 1 }
  });

  assert.equal(result.status, "fail");
  assert.equal(result.exitCode, 3);
  assert.equal(result.dependency.id, "root-playwright");
  assert.equal(calls.length, 1);
});

test("closeout dependency preflight fails closed when lockfile is missing", () => {
  const { result, calls } = runPreflight({
    resolvedPackages: [`${PROJECT_ROOT}/apps/workbench:next`],
    existingPaths: [`${PROJECT_ROOT}/apps/workbench/package-lock.json`]
  });

  assert.equal(result.status, "fail");
  assert.equal(result.exitCode, 2);
  assert.equal(result.dependency.lockfile, "package-lock.json");
  assert.deepEqual(calls, []);
});

test("closeout dependency preflight opt-out fails fast when dependencies are missing", () => {
  const { result, calls } = runPreflight({
    env: { AI_CONTROL_CLOSEOUT_SKIP_DEPENDENCY_PREFLIGHT: "1" },
    resolvedPackages: [`${PROJECT_ROOT}/apps/workbench:next`]
  });

  assert.equal(result.status, "fail");
  assert.equal(result.exitCode, 4);
  assert.deepEqual(result.missing_dependencies.map((item) => item.id), ["root-playwright"]);
  assert.deepEqual(calls, []);
});

test("closeout dependency preflight force installs even when dependencies resolve", () => {
  const { result, calls } = runPreflight({
    env: { AI_CONTROL_CLOSEOUT_FORCE_DEPENDENCY_INSTALL: "1" },
    resolvedPackages: [`${PROJECT_ROOT}:playwright`, `${PROJECT_ROOT}/apps/workbench:next`]
  });

  assert.equal(result.status, "pass");
  assert.deepEqual(calls.map((call) => call.cwd), [PROJECT_ROOT, `${PROJECT_ROOT}/apps/workbench`]);
});

test("closeout dependency preflight catches corrupted installs after npm ci", () => {
  const { result, calls } = runPreflight({
    resolvedPackages: [`${PROJECT_ROOT}/apps/workbench:next`]
  });

  assert.equal(result.status, "fail");
  assert.equal(result.exitCode, 5);
  assert.deepEqual(result.unresolved_dependencies.map((item) => item.id), ["root-playwright"]);
  assert.equal(calls.length, 1);
});

test("closeout dependency preflight installs only the missing dependency", () => {
  const { result, calls } = runPreflight({
    resolvedPackages: [`${PROJECT_ROOT}:playwright`],
    afterSpawnResolvedPackages: [`${PROJECT_ROOT}/apps/workbench:next`]
  });

  assert.equal(result.status, "pass");
  assert.deepEqual(calls.map((call) => call.cwd), [`${PROJECT_ROOT}/apps/workbench`]);
});

test("closeout dependency preflight fails closed on npm ci timeout error", () => {
  const { result, calls } = runPreflight({
    resolvedPackages: [`${PROJECT_ROOT}/apps/workbench:next`],
    spawnResult: { status: null, signal: "SIGTERM", error: new Error("spawnSync npm ETIMEDOUT") }
  });

  assert.equal(result.status, "fail");
  assert.equal(result.exitCode, 3);
  assert.match(result.install.error, /ETIMEDOUT/);
  assert.equal(calls[0].timeout, 1234);
});
