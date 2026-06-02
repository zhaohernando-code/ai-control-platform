import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const PLAYWRIGHT_CLI_DIR = ".playwright-cli";
const SAMPLE_LOG = `${PLAYWRIGHT_CLI_DIR}/console-2026-06-01T06-25-17-467Z.log`;

test("Playwright CLI diagnostics are ignored local artifacts", () => {
  const gitignore = readFileSync(".gitignore", "utf8");
  const projectRules = readFileSync("PROJECT_RULES.md", "utf8");

  assert.match(gitignore, /^\.playwright-cli\/$/m);
  assert.match(projectRules, /\.playwright-cli\/` 控制台日志属于本地临时诊断产物/);
  assert.match(projectRules, /git status --short` 干净检查/);

  assert.equal(execFileSync("git", ["check-ignore", SAMPLE_LOG], { encoding: "utf8" }).trim(), SAMPLE_LOG);
});

test("a generated Playwright CLI console log does not dirty git status", () => {
  mkdirSync(PLAYWRIGHT_CLI_DIR, { recursive: true });
  writeFileSync(join(PLAYWRIGHT_CLI_DIR, "console-test.log"), "local diagnostic output\n");

  try {
    const status = execFileSync("git", ["status", "--short", "--", PLAYWRIGHT_CLI_DIR], { encoding: "utf8" });
    assert.equal(status, "");
  } finally {
    rmSync(PLAYWRIGHT_CLI_DIR, { recursive: true, force: true });
  }
});
