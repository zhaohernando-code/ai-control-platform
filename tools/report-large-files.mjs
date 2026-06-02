#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MANIFEST = ".largefile-manifest.json";
const CHECKED_EXTENSIONS = new Set([".js", ".ts", ".tsx", ".py", ".css"]);

function repoRelative(root, path) {
  return relative(root, resolve(root, path)).split(sep).join("/");
}

function extension(path) {
  const index = path.lastIndexOf(".");
  return index === -1 ? "" : path.slice(index);
}

export function countLines(text) {
  if (!text) return 0;
  return text.endsWith("\n") ? text.slice(0, -1).split(/\r?\n/).length : text.split(/\r?\n/).length;
}

function parseJsonString(text, state) {
  const start = state.index;
  state.index += 1;
  let escaped = false;
  while (state.index < text.length) {
    const char = text[state.index];
    state.index += 1;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      return JSON.parse(text.slice(start, state.index));
    }
  }
  throw new SyntaxError("Unterminated JSON string");
}

function skipWhitespace(text, state) {
  while (/\s/.test(text[state.index] || "")) state.index += 1;
}

function parseLiteral(text, state, literal) {
  if (text.slice(state.index, state.index + literal.length) !== literal) {
    throw new SyntaxError(`Expected ${literal}`);
  }
  state.index += literal.length;
}

function parseNumber(text, state) {
  const match = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(state.index));
  if (!match) throw new SyntaxError("Expected JSON number");
  state.index += match[0].length;
}

function parseArray(text, state, path, duplicates) {
  state.index += 1;
  skipWhitespace(text, state);
  if (text[state.index] === "]") {
    state.index += 1;
    return;
  }
  let itemIndex = 0;
  while (state.index < text.length) {
    parseValue(text, state, `${path}[${itemIndex}]`, duplicates);
    skipWhitespace(text, state);
    if (text[state.index] === "]") {
      state.index += 1;
      return;
    }
    if (text[state.index] !== ",") throw new SyntaxError("Expected comma in JSON array");
    state.index += 1;
    skipWhitespace(text, state);
    itemIndex += 1;
  }
  throw new SyntaxError("Unterminated JSON array");
}

function parseObject(text, state, path, duplicates) {
  state.index += 1;
  const keys = new Set();
  skipWhitespace(text, state);
  if (text[state.index] === "}") {
    state.index += 1;
    return;
  }
  while (state.index < text.length) {
    if (text[state.index] !== "\"") throw new SyntaxError("Expected JSON object key");
    const key = parseJsonString(text, state);
    const keyPath = path ? `${path}.${key}` : key;
    if (keys.has(key)) {
      duplicates.push({
        code: "duplicate_json_key",
        path: keyPath,
        key
      });
    }
    keys.add(key);
    skipWhitespace(text, state);
    if (text[state.index] !== ":") throw new SyntaxError("Expected colon after JSON key");
    state.index += 1;
    parseValue(text, state, keyPath, duplicates);
    skipWhitespace(text, state);
    if (text[state.index] === "}") {
      state.index += 1;
      return;
    }
    if (text[state.index] !== ",") throw new SyntaxError("Expected comma in JSON object");
    state.index += 1;
    skipWhitespace(text, state);
  }
  throw new SyntaxError("Unterminated JSON object");
}

function parseValue(text, state, path, duplicates) {
  skipWhitespace(text, state);
  const char = text[state.index];
  if (char === "{") return parseObject(text, state, path, duplicates);
  if (char === "[") return parseArray(text, state, path, duplicates);
  if (char === "\"") return parseJsonString(text, state);
  if (char === "t") return parseLiteral(text, state, "true");
  if (char === "f") return parseLiteral(text, state, "false");
  if (char === "n") return parseLiteral(text, state, "null");
  return parseNumber(text, state);
}

export function findDuplicateJsonKeys(text) {
  const duplicates = [];
  const state = { index: 0 };
  parseValue(text, state, "", duplicates);
  skipWhitespace(text, state);
  if (state.index !== text.length) throw new SyntaxError("Unexpected trailing JSON content");
  return duplicates;
}

function defaultTrackedFiles(root) {
  try {
    return {
      files: execFileSync("git", ["ls-files"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      })
        .split("\n")
        .filter(Boolean),
      issues: []
    };
  } catch (error) {
    return {
      files: [],
      issues: [{
        code: "tracked_files_unavailable",
        severity: "error",
        message: "Unable to list tracked files with git ls-files",
        detail: String(error.message || "").split(/\r?\n/)[0].slice(0, 200)
      }]
    };
  }
}

function hasGrowthPlan(entry) {
  return Boolean(
    entry?.split_plan ||
    entry?.growth_justification ||
    entry?.next_split_plan ||
    entry?.refactor_plan
  );
}

function readFileLines(root, path) {
  const absolute = resolve(root, path);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) return null;
  return countLines(readFileSync(absolute, "utf8"));
}

export function createLargeFileReport(options = {}) {
  const root = resolve(options.root || process.cwd());
  const manifestPath = options.manifestPath || DEFAULT_MANIFEST;
  const manifestText = options.manifestText ?? readFileSync(resolve(root, manifestPath), "utf8");
  const duplicateIssues = findDuplicateJsonKeys(manifestText);
  const manifest = JSON.parse(manifestText);
  const threshold = Number(options.threshold ?? manifest.threshold);
  const issues = duplicateIssues.map((issue) => ({
    ...issue,
    severity: "error",
    message: `Duplicate JSON key ${issue.key} at ${issue.path}`
  }));
  const trackedFileResult = options.trackedFiles
    ? { files: options.trackedFiles, issues: [] }
    : defaultTrackedFiles(root);
  const trackedFiles = trackedFileResult.files;
  issues.push(...trackedFileResult.issues);
  const warnings = [];
  const manifestFiles = manifest.files || {};
  const entries = [];

  for (const [path, entry] of Object.entries(manifestFiles)) {
    const actualLines = readFileLines(root, path);
    const manifestLines = Number(entry.lines);
    if (!entry.reason || !entry.status) {
      issues.push({
        code: "manifest_entry_missing_governance_fields",
        severity: "error",
        path,
        message: `Manifest entry ${path} must include reason and status`
      });
    }
    if (actualLines === null) {
      issues.push({
        code: "manifest_file_missing",
        severity: "error",
        path,
        message: `Manifest entry ${path} does not exist`
      });
      continue;
    }
    const record = {
      path,
      status: entry.status || null,
      manifest_lines: manifestLines,
      current_lines: actualLines,
      delta: actualLines - manifestLines,
      reason: entry.reason || "",
      reviewed_at: entry.reviewed_at || null
    };
    entries.push(record);
    if (!Number.isFinite(manifestLines)) {
      issues.push({
        code: "stale_line_count",
        severity: "error",
        path,
        manifest_lines: manifestLines,
        current_lines: actualLines,
        message: `Manifest line count for ${path} is ${manifestLines}, current count is ${actualLines}`
      });
    } else if (actualLines > manifestLines) {
      issues.push({
        code: "stale_line_count",
        severity: "error",
        path,
        manifest_lines: manifestLines,
        current_lines: actualLines,
        message: `Manifest line count for ${path} is ${manifestLines}, current count is ${actualLines}`
      });
    } else if (actualLines < manifestLines) {
      warnings.push({
        code: "line_count_below_manifest",
        severity: "warning",
        path,
        manifest_lines: manifestLines,
        current_lines: actualLines,
        message: `${path} is below the manifest line count; refresh the manifest after confirming the shrink was intentional`
      });
    }
    if (entry.status === "planned_refactor" && actualLines > manifestLines && !hasGrowthPlan(entry)) {
      issues.push({
        code: "planned_refactor_growth_without_split_plan",
        severity: "error",
        path,
        manifest_lines: manifestLines,
        current_lines: actualLines,
        message: `${path} grew while already planned for refactor but has no growth justification or split plan`
      });
    }
  }

  for (const file of trackedFiles) {
    if (!CHECKED_EXTENSIONS.has(extension(file))) continue;
    const actualLines = readFileLines(root, file);
    if (actualLines === null || actualLines <= threshold) continue;
    if (!manifestFiles[file]) {
      issues.push({
        code: "missing_large_file_manifest_entry",
        severity: "error",
        path: file,
        current_lines: actualLines,
        message: `${file} has ${actualLines} lines and is missing from ${manifestPath}`
      });
    }
  }

  const queue = entries
    .filter((entry) => entry.status === "planned_refactor")
    .sort((a, b) => b.current_lines - a.current_lines || a.path.localeCompare(b.path))
    .map((entry, index) => ({
      priority: `LFG-Q${String(index + 1).padStart(2, "0")}`,
      ...entry
    }));

  return {
    version: "large-file-report.v1",
    status: issues.length ? "fail" : "pass",
    manifest_path: repoRelative(root, manifestPath),
    threshold,
    reviewed_at: manifest.reviewed_at || null,
    planned_refactor_count: queue.length,
    manifest_entry_count: entries.length,
    queue,
    issues,
    warnings
  };
}

function parseArgs(argv) {
  const args = [...argv];
  const options = { failOnIssues: false };
  while (args.length) {
    const arg = args.shift();
    if (arg === "--fail-on-issues") {
      options.failOnIssues = true;
    } else if (arg === "--manifest") {
      options.manifestPath = args.shift();
    } else if (arg === "--threshold") {
      options.threshold = Number(args.shift());
    } else if (arg === "--help") {
      options.help = true;
    } else {
      options.manifestPath = arg;
    }
  }
  return options;
}

function printHelp() {
  console.log("usage: report-large-files.mjs [--manifest .largefile-manifest.json] [--threshold 500] [--fail-on-issues]");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const report = createLargeFileReport(options);
  console.log(JSON.stringify(report, null, 2));
  if (options.failOnIssues && report.status !== "pass") {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
