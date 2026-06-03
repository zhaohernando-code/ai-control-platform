#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { findDuplicateJsonKeys } from "./json-duplicate-key-scan.mjs";
import { validateReductionTarget } from "./large-file-reduction-targets.mjs";

export { findDuplicateJsonKeys } from "./json-duplicate-key-scan.mjs";

const DEFAULT_MANIFEST = ".largefile-manifest.json";
const DEFAULT_BASE_REF = "origin/main";
const CHECKED_EXTENSIONS = new Set([".js", ".mjs", ".ts", ".tsx", ".py", ".css"]);
const ALLOWED_STATUSES = new Set(["accepted", "planned_refactor"]);
const NEAR_THRESHOLD = 300;
const NEAR_THRESHOLD_ALLOWED_DELTA = 600;

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

function gitOutput(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function resolveBaselineRef(root, baseRef) {
  try {
    const mergeBase = gitOutput(root, ["merge-base", "HEAD", baseRef]).trim();
    return mergeBase || baseRef;
  } catch {
    return baseRef;
  }
}

function gitTrackedFiles(root, ref) {
  return gitOutput(root, ["ls-tree", "-r", "--name-only", ref])
    .split("\n")
    .filter(Boolean);
}

function gitFileText(root, ref, path) {
  try {
    return gitOutput(root, ["show", `${ref}:${path}`]);
  } catch {
    return null;
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

function isCheckedFile(path) {
  return CHECKED_EXTENSIONS.has(extension(path));
}

function lineCountFromMap(map, path) {
  if (!map) return null;
  const value = map[path];
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function buildCurrentLineCounts(root, files) {
  const lineCounts = {};
  for (const file of files) {
    if (!isCheckedFile(file)) continue;
    const lines = readFileLines(root, file);
    if (lines !== null) lineCounts[file] = lines;
  }
  return lineCounts;
}

function buildGitLineCounts(root, ref, files) {
  const lineCounts = {};
  for (const file of files) {
    if (!isCheckedFile(file)) continue;
    const text = gitFileText(root, ref, file);
    if (text !== null) lineCounts[file] = countLines(text);
  }
  return lineCounts;
}

function debtFor(lineCounts, threshold, max = Infinity, predicate = () => true) {
  return Object.entries(lineCounts)
    .filter(([path, lines]) => predicate(path, lines) && lines > threshold && lines <= max)
    .reduce((sum, [, lines]) => sum + lines, 0);
}

function loadBaseline(root, manifestPath, options, trackedFileIssues) {
  if (!options.baselineManifestText && !options.baselineTrackedFiles && options.trackedFiles) return null;

  if (options.baselineManifestText || options.baselineTrackedFiles || options.baselineLineCounts) {
    return {
      ref: options.baselineRef || "provided",
      manifest: options.baselineManifestText ? JSON.parse(options.baselineManifestText) : { files: {} },
      trackedFiles: options.baselineTrackedFiles || [],
      lineCounts: options.baselineLineCounts || {}
    };
  }

  if (trackedFileIssues.length) return null;
  try {
    const requestedRef = options.baseRef || DEFAULT_BASE_REF;
    const ref = resolveBaselineRef(root, requestedRef);
    const manifestText = gitFileText(root, ref, manifestPath);
    if (manifestText === null) {
      return {
        ref,
        error: {
          code: "baseline_manifest_unavailable",
          severity: "error",
          message: `Unable to read ${manifestPath} from baseline ${ref}`
        }
      };
    }
    const trackedFiles = gitTrackedFiles(root, ref);
    return {
      ref,
      manifest: JSON.parse(manifestText),
      trackedFiles,
      lineCounts: buildGitLineCounts(root, ref, trackedFiles)
    };
  } catch (error) {
    return {
      ref: options.baseRef || DEFAULT_BASE_REF,
      error: {
        code: "baseline_unavailable",
        severity: "error",
        message: `Unable to load large-file baseline from ${options.baseRef || DEFAULT_BASE_REF}`,
        detail: String(error.message || "").split(/\r?\n/)[0].slice(0, 200)
      }
    };
  }
}

function isExpiredDate(value, now = new Date()) {
  if (!value) return false;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return true;
  return time < now.getTime();
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
  const currentLineCounts = buildCurrentLineCounts(root, trackedFiles);
  const baseline = loadBaseline(root, manifestPath, options, trackedFileResult.issues);
  if (baseline?.error) issues.push(baseline.error);
  const baselineManifestFiles = baseline?.manifest?.files || {};
  const baselineLineCounts = baseline?.lineCounts || {};

  for (const [path, entry] of Object.entries(manifestFiles)) {
    const actualLines = currentLineCounts[path] ?? readFileLines(root, path);
    const manifestLines = Number(entry.lines);
    const baselineEntry = baselineManifestFiles[path];
    const baselineManifestLines = baselineEntry ? Number(baselineEntry.lines) : null;
    if (!entry.reason || !entry.status) {
      issues.push({
        code: "manifest_entry_missing_governance_fields",
        severity: "error",
        path,
        message: `Manifest entry ${path} must include reason and status`
      });
    }
    if (entry.status && !ALLOWED_STATUSES.has(entry.status)) {
      issues.push({
        code: "manifest_entry_invalid_status",
        severity: "error",
        path,
        status: entry.status,
        allowed_statuses: [...ALLOWED_STATUSES],
        message: `Manifest entry ${path} has unsupported status ${entry.status}`
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
    if (baselineEntry && Number.isFinite(baselineManifestLines) && manifestLines > baselineManifestLines) {
      issues.push({
        code: "manifest_line_ceiling_increased",
        severity: "error",
        path,
        baseline_manifest_lines: baselineManifestLines,
        manifest_lines: manifestLines,
        message: `Manifest line ceiling for ${path} increased from ${baselineManifestLines} to ${manifestLines}`
      });
    }
    const baselineLines = lineCountFromMap(baselineLineCounts, path);
    if (baseline && !baselineEntry && actualLines > threshold && (baselineLines === null || baselineLines <= threshold)) {
      issues.push({
        code: "new_large_file_manifest_entry",
        severity: "error",
        path,
        current_lines: actualLines,
        message: `${path} is a new large-file manifest entry; new large files cannot be registered as a normal bypass`
      });
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
    const reductionTarget = validateReductionTarget({ path, entry, currentLines: actualLines, threshold });
    issues.push(...reductionTarget.issues);
    if (reductionTarget.summary) record.reduction_target = reductionTarget.summary;
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
    if (entry.status === "accepted" && actualLines > 750 && !entry.rechallenge_due) {
      issues.push({
        code: "accepted_large_file_rechallenge_missing",
        severity: "error",
        path,
        current_lines: actualLines,
        message: `${path} is accepted above 750 lines and must include an unexpired rechallenge_due marker`
      });
    } else if (entry.status === "accepted" && actualLines > 750 && isExpiredDate(entry.rechallenge_due, options.now)) {
      issues.push({
        code: "accepted_large_file_rechallenge_expired",
        severity: "error",
        path,
        current_lines: actualLines,
        rechallenge_due: entry.rechallenge_due,
        message: `${path} accepted large-file rechallenge_due marker has expired`
      });
    }
  }

  for (const file of trackedFiles) {
    if (!isCheckedFile(file)) continue;
    const actualLines = currentLineCounts[file];
    if (actualLines === null || actualLines === undefined) continue;
    const baselineLines = lineCountFromMap(baselineLineCounts, file);
    if (baselineLines !== null && actualLines > baselineLines && (actualLines > threshold || baselineLines > threshold)) {
      issues.push({
        code: "known_large_file_growth",
        severity: "error",
        path: file,
        baseline_lines: baselineLines,
        current_lines: actualLines,
        message: `${file} grew from ${baselineLines} to ${actualLines}; known large-file debt may not grow`
      });
    }
    if (baseline && baselineLines === null && actualLines > threshold) {
      issues.push({
        code: "new_large_file_added",
        severity: "error",
        path: file,
        current_lines: actualLines,
        message: `${file} is a new tracked file above ${threshold} lines`
      });
    }
    if (baseline && baselineLines === null && actualLines > NEAR_THRESHOLD && actualLines <= threshold) {
      warnings.push({
        code: "new_near_threshold_file",
        severity: "warning",
        path: file,
        current_lines: actualLines,
        message: `${file} is a new tracked file above ${NEAR_THRESHOLD} lines and below the large-file threshold`
      });
    }
    if (actualLines <= threshold) continue;
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

  if (baseline && !baseline.error) {
    const currentLargeDebt = debtFor(currentLineCounts, threshold);
    const baselineLargeDebt = debtFor(baselineLineCounts, threshold);
    if (currentLargeDebt > baselineLargeDebt) {
      issues.push({
        code: "total_large_file_debt_increased",
        severity: "error",
        baseline_large_file_debt: baselineLargeDebt,
        current_large_file_debt: currentLargeDebt,
        message: `Total large-file debt increased from ${baselineLargeDebt} to ${currentLargeDebt}`
      });
    }
    const currentNearDebt = debtFor(currentLineCounts, NEAR_THRESHOLD, threshold);
    const baselineNearDebt = debtFor(baselineLineCounts, NEAR_THRESHOLD, threshold);
    if (currentNearDebt > baselineNearDebt + NEAR_THRESHOLD_ALLOWED_DELTA) {
      issues.push({
        code: "near_threshold_debt_increased",
        severity: "error",
        baseline_near_threshold_debt: baselineNearDebt,
        current_near_threshold_debt: currentNearDebt,
        allowed_delta: NEAR_THRESHOLD_ALLOWED_DELTA,
        message: `Near-threshold file debt increased from ${baselineNearDebt} to ${currentNearDebt}`
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
    baseline_ref: baseline?.ref || null,
    threshold,
    near_threshold: NEAR_THRESHOLD,
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
    } else if (arg === "--base-ref") {
      options.baseRef = args.shift();
    } else if (arg === "--help") {
      options.help = true;
    } else if (arg.startsWith("--")) {
      options.unknownArg = arg;
    } else {
      options.manifestPath = arg;
    }
  }
  return options;
}

function printHelp() {
  console.log("usage: report-large-files.mjs [--manifest .largefile-manifest.json] [--threshold 500] [--base-ref origin/main] [--fail-on-issues]");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.unknownArg) {
    console.error(`unknown option: ${options.unknownArg}`);
    process.exitCode = 1;
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
