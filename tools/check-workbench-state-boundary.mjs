#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const SCAN_ROOTS = ["tools", "src", "apps", "test"];
const SKIP_DIRS = new Set(["node_modules", "tmp", "coverage", "dist", ".git", ".claude"]);
const SERVER_FILE = "tools/workbench-server.mjs";
const ALLOWED_FIXTURE_FILE_STATE_FILES = new Set([
  "test/workbench-server.test.js"
]);

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const rel = relative(process.cwd(), path);
    if (SKIP_DIRS.has(entry) || rel.startsWith("tmp/")) continue;
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path, files);
      continue;
    }
    if (/\.(mjs|js|cjs|ts|tsx)$/.test(entry)) files.push(rel);
  }
  return files;
}

function lineNumber(source, index) {
  return source.slice(0, index).split(/\r?\n/).length;
}

function issue(file, line, code, message) {
  return { file, line, code, message };
}

function importedWorkbenchServer(source) {
  return /createWorkbenchServer/.test(source);
}

function hasSqliteStateMode(source) {
  return /\b(stateDbPath|stateDb|state_db|stateStore)\b/.test(source);
}

function createServerCallIssues(file, source) {
  if (file === SERVER_FILE || !importedWorkbenchServer(source)) return [];
  const issues = [];
  const fixtureMatches = [...source.matchAll(/allowFixtureFileState\s*:\s*true/g)];
  for (const match of fixtureMatches) {
    if (!ALLOWED_FIXTURE_FILE_STATE_FILES.has(file)) {
      issues.push(issue(
        file,
        lineNumber(source, match.index),
        "workbench_fixture_file_state_not_allowed",
        "allowFixtureFileState is only allowed in the explicit workbench server fixture test"
      ));
    }
  }

  if (!hasSqliteStateMode(source) && fixtureMatches.length === 0) {
    const call = source.match(/createWorkbenchServer\s*\(/);
    issues.push(issue(
      file,
      call ? lineNumber(source, call.index) : 1,
      "workbench_server_without_sqlite_state",
      "createWorkbenchServer callers must pass stateDbPath/stateStore, or an explicit test-only fixture file-state exception"
    ));
  }

  if (file.startsWith("tools/") && fixtureMatches.length > 0) {
    issues.push(issue(
      file,
      lineNumber(source, fixtureMatches[0].index),
      "tool_uses_fixture_file_state",
      "tools must not start Workbench in fixture file-state mode"
    ));
  }

  return issues;
}

function main() {
  const files = SCAN_ROOTS.flatMap((root) => walk(root));
  const issues = files.flatMap((file) => createServerCallIssues(file, readFileSync(file, "utf8")));
  const result = {
    status: issues.length === 0 ? "pass" : "fail",
    checked_files: files.length,
    rule: "Workbench runtime state must use SQLite; JSON history/input/event files are allowed only as seed fixtures or offline artifacts.",
    allowed_fixture_file_state_files: [...ALLOWED_FIXTURE_FILE_STATE_FILES],
    issues
  };
  console.log(JSON.stringify(result, null, 2));
  if (issues.length > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
