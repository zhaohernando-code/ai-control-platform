import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import test from "node:test";

const root = new URL("../", import.meta.url);
const checkedExtensions = new Set([".js", ".ts", ".tsx", ".py", ".css"]);

function readText(path) {
  return readFileSync(new URL(path, root), "utf8");
}

function trackedFiles() {
  return execFileSync("git", ["ls-files"], {
    cwd: root,
    encoding: "utf8"
  })
    .split("\n")
    .filter(Boolean)
    .filter((path) => existsSync(new URL(path, root)));
}

function extension(path) {
  const index = path.lastIndexOf(".");
  return index === -1 ? "" : path.slice(index);
}

function lineCount(path) {
  const text = readText(path);
  if (!text) return 0;
  return text.endsWith("\n") ? text.slice(0, -1).split(/\r?\n/).length : text.split(/\r?\n/).length;
}

test("ai-control-platform is enrolled in shared large-file governance", () => {
  const manifest = JSON.parse(readText(".largefile-manifest.json"));

  assert.equal(manifest.threshold, 500);
  assert.equal(manifest.reviewed_at, "2026-05-28");

  const missing = [];
  for (const path of trackedFiles()) {
    if (!checkedExtensions.has(extension(path))) continue;
    const lines = lineCount(path);
    if (lines <= manifest.threshold) continue;
    const entry = manifest.files[path];
    if (!entry || entry.lines < lines || !entry.reason || !entry.status) {
      missing.push({ path, lines, entry });
    }
  }

  assert.deepEqual(missing, []);
});

test("git hook installer uses shared pre-commit governance without replacing shared pre-push", () => {
  const script = readText("scripts/install-git-hooks.sh");
  const packageJson = JSON.parse(readText("package.json"));
  const projectRules = readText("PROJECT_RULES.md");
  const processDoc = readText("PROCESS.md");

  assert.equal(packageJson.scripts["install:git-hooks"], "bash scripts/install-git-hooks.sh");
  assert.match(script, /core\.hooksPath \.\.\/\.\.\/\.githooks/);
  assert.match(script, /shared_pre_commit/);
  assert.doesNotMatch(script, /pre-push/);
  assert.match(projectRules, /scripts\/install-git-hooks\.sh/);
  assert.match(processDoc, /\.largefile-manifest\.json/);
});

test("governance enrollment test paths are repository relative", () => {
  assert.equal(relative(new URL(".", root).pathname, new URL("package.json", root).pathname), "package.json");
});
