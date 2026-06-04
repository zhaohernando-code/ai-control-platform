import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function normalizeString(value) {
  return String(value || "").trim();
}

export function createFixture(root, runId) {
  const fixtureDir = join(root, runId);
  mkdirSync(join(fixtureDir, "src"), { recursive: true });
  mkdirSync(join(fixtureDir, "test"), { recursive: true });
  writeFileSync(join(fixtureDir, "package.json"), `${JSON.stringify({
    type: "module",
    scripts: { test: "node --test test/math.test.js" }
  }, null, 2)}\n`);
  writeFileSync(join(fixtureDir, "src", "math.js"), [
    "export function sum(a, b) {",
    "  return a - b;",
    "}",
    ""
  ].join("\n"));
  writeFileSync(join(fixtureDir, "test", "math.test.js"), [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "import { sum } from '../src/math.js';",
    "",
    "test('sum adds two numbers', () => {",
    "  assert.equal(sum(2, 3), 5);",
    "});",
    ""
  ].join("\n"));
  writeFileSync(join(fixtureDir, ".gitignore"), "node_modules\n");
  spawnSync("git", ["init"], { cwd: fixtureDir, encoding: "utf8" });
  spawnSync("git", ["add", "."], { cwd: fixtureDir, encoding: "utf8" });
  spawnSync("git", ["commit", "-m", "fixture baseline"], {
    cwd: fixtureDir,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Development Flow Fixture",
      GIT_AUTHOR_EMAIL: "dev-flow@example.invalid",
      GIT_COMMITTER_NAME: "Development Flow Fixture",
      GIT_COMMITTER_EMAIL: "dev-flow@example.invalid"
    }
  });
  return fixtureDir;
}

export function runFixtureTests(fixtureDir) {
  const result = spawnSync(process.execPath, ["--test", "test/math.test.js"], {
    cwd: fixtureDir,
    encoding: "utf8",
    timeout: 30000
  });
  return {
    command: "node --test test/math.test.js",
    status: result.status === 0 ? "pass" : "fail",
    exit_code: result.status,
    stdout_excerpt: normalizeString(result.stdout).slice(-1200),
    stderr_excerpt: normalizeString(result.stderr).slice(-1200)
  };
}

export function gitChangedFiles(fixtureDir) {
  const result = spawnSync("git", ["diff", "--name-only"], {
    cwd: fixtureDir,
    encoding: "utf8"
  });
  return normalizeString(result.stdout).split(/\r?\n/).map(normalizeString).filter(Boolean);
}

export function gitHead(fixtureDir) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: fixtureDir,
    encoding: "utf8"
  });
  return normalizeString(result.stdout);
}

export function gitChangedFilesSince(fixtureDir, baselineCommit = "") {
  const committed = baselineCommit
    ? spawnSync("git", ["diff", "--name-only", `${baselineCommit}..HEAD`], {
      cwd: fixtureDir,
      encoding: "utf8"
    })
    : { stdout: "" };
  return [
    ...new Set([
      ...normalizeString(committed.stdout).split(/\r?\n/),
      ...gitChangedFiles(fixtureDir)
    ].map(normalizeString).filter(Boolean))
  ];
}

export function gitDiffStat(fixtureDir) {
  const result = spawnSync("git", ["diff", "--stat", "--", "."], {
    cwd: fixtureDir,
    encoding: "utf8"
  });
  return normalizeString(result.stdout);
}
