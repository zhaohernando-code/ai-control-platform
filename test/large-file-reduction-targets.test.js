import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { createLargeFileReport } from "../tools/report-large-files.mjs";
import { minimumReductionFor } from "../tools/large-file-reduction-targets.mjs";
import { tempDir } from "./helpers/temp-dir.js";

function writeLines(root, path, count) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n")}\n`);
}

function manifest(files) {
  return JSON.stringify({
    threshold: 500,
    reviewed_at: "2026-06-03",
    files
  }, null, 2);
}

function target(baseLines, targetLines, minimumReduction = minimumReductionFor(baseLines)) {
  return {
    base_lines: baseLines,
    target_lines: targetLines,
    minimum_reduction: minimumReduction,
    terminal_condition: "Fixture must meet a material shrink target before phase closeout.",
    next_phase: "Continue splitting if the file remains above 500 lines."
  };
}

test("planned_refactor files above threshold require reduction targets", (t) => {
  const root = tempDir(t, "large-file-reduction-missing-target-");
  writeLines(root, "src/large.js", 600);
  const report = createLargeFileReport({
    root,
    manifestText: manifest({
      "src/large.js": {
        lines: 600,
        reason: "fixture",
        status: "planned_refactor",
        reviewed_at: "2026-06-03"
      }
    }),
    trackedFiles: ["src/large.js"]
  });

  assert.equal(report.status, "fail");
  assert.ok(report.issues.some((issue) => issue.code === "planned_refactor_missing_reduction_target"));
});

test("unsupported manifest statuses cannot bypass reduction governance", (t) => {
  const root = tempDir(t, "large-file-reduction-invalid-status-");
  writeLines(root, "src/large.js", 600);
  const report = createLargeFileReport({
    root,
    manifestText: manifest({
      "src/large.js": {
        lines: 600,
        reason: "fixture",
        status: "completed",
        reviewed_at: "2026-06-03"
      }
    }),
    trackedFiles: ["src/large.js"]
  });

  assert.equal(report.status, "fail");
  assert.ok(report.issues.some((issue) => issue.code === "manifest_entry_invalid_status"));
});

test("reduction targets must meet the material reduction criterion", (t) => {
  const root = tempDir(t, "large-file-reduction-too-weak-");
  writeLines(root, "src/huge.js", 2500);
  const report = createLargeFileReport({
    root,
    manifestText: manifest({
      "src/huge.js": {
        lines: 2500,
        reason: "fixture",
        status: "planned_refactor",
        reviewed_at: "2026-06-03",
        reduction_target: target(2500, 2300, 200)
      }
    }),
    trackedFiles: ["src/huge.js"]
  });

  assert.equal(report.status, "fail");
  assert.ok(report.issues.some((issue) => issue.code === "planned_refactor_reduction_target_too_weak"));
});

test("valid reduction targets are surfaced in the queue with target gap", (t) => {
  const root = tempDir(t, "large-file-reduction-valid-target-");
  writeLines(root, "src/large.js", 900);
  const report = createLargeFileReport({
    root,
    manifestText: manifest({
      "src/large.js": {
        lines: 900,
        reason: "fixture",
        status: "planned_refactor",
        reviewed_at: "2026-06-03",
        reduction_target: target(900, 750)
      }
    }),
    trackedFiles: ["src/large.js"]
  });

  assert.equal(report.status, "pass");
  assert.equal(report.queue[0].reduction_target.target_gap, 150);
  assert.equal(report.queue[0].reduction_target.target_met, false);
});

test("met reduction targets remain visible instead of auto-closing planned work", (t) => {
  const root = tempDir(t, "large-file-reduction-met-target-");
  writeLines(root, "src/large.js", 740);
  const report = createLargeFileReport({
    root,
    manifestText: manifest({
      "src/large.js": {
        lines: 900,
        reason: "fixture",
        status: "planned_refactor",
        reviewed_at: "2026-06-03",
        reduction_target: target(900, 750)
      }
    }),
    trackedFiles: ["src/large.js"]
  });

  assert.equal(report.status, "pass");
  assert.equal(report.queue[0].reduction_target.target_gap, 0);
  assert.equal(report.queue[0].reduction_target.target_met, true);
  assert.ok(report.warnings.some((warning) => warning.code === "line_count_below_manifest"));
});

test("existing mjs large files can be backfilled without a new-file bypass failure", (t) => {
  const root = tempDir(t, "large-file-reduction-mjs-backfill-");
  writeLines(root, "tools/existing.mjs", 700);
  const report = createLargeFileReport({
    root,
    manifestText: manifest({
      "tools/existing.mjs": {
        lines: 700,
        reason: "fixture",
        status: "planned_refactor",
        reviewed_at: "2026-06-03",
        reduction_target: target(700, 550)
      }
    }),
    baselineManifestText: manifest({}),
    trackedFiles: ["tools/existing.mjs"],
    baselineTrackedFiles: ["tools/existing.mjs"],
    baselineLineCounts: { "tools/existing.mjs": 700 }
  });

  assert.equal(report.status, "pass");
  assert.ok(!report.issues.some((issue) => issue.code === "new_large_file_manifest_entry"));
});

test("new mjs large files cannot use manifest backfill as a bypass", (t) => {
  const root = tempDir(t, "large-file-reduction-new-mjs-bypass-");
  writeLines(root, "tools/new-large.mjs", 700);
  const report = createLargeFileReport({
    root,
    manifestText: manifest({
      "tools/new-large.mjs": {
        lines: 700,
        reason: "fixture",
        status: "planned_refactor",
        reviewed_at: "2026-06-03",
        reduction_target: target(700, 550)
      }
    }),
    baselineManifestText: manifest({}),
    trackedFiles: ["tools/new-large.mjs"],
    baselineTrackedFiles: [],
    baselineLineCounts: {}
  });

  assert.equal(report.status, "fail");
  assert.ok(report.issues.some((issue) => issue.code === "new_large_file_manifest_entry"));
  assert.ok(report.issues.some((issue) => issue.code === "new_large_file_added"));
});
