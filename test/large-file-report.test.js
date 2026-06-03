import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { createLargeFileReport, findDuplicateJsonKeys } from "../tools/report-large-files.mjs";
import { tempDir } from "./helpers/temp-dir.js";

function writeLines(root, path, count) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n")}\n`);
}

function manifest(files, threshold = 3) {
  return JSON.stringify({
    threshold,
    reviewed_at: "2026-06-02",
    files
  }, null, 2);
}

test("duplicate JSON keys are reported before parse-last-wins can hide them", () => {
  const duplicates = findDuplicateJsonKeys(`{
    "threshold": 500,
    "files": {
      "src/a.js": { "lines": 10, "status": "accepted", "status": "planned_refactor" },
      "src/a.js": { "lines": 10, "status": "accepted" }
    }
  }`);

  assert.deepEqual(duplicates.map((item) => item.path), [
    "files.src/a.js.status",
    "files.src/a.js"
  ]);
});

test("report fails when a manifest line count is stale", (t) => {
  const root = tempDir(t, "large-file-report-stale-");
  writeLines(root, "src/large.js", 5);
  const report = createLargeFileReport({
    root,
    manifestText: manifest({
      "src/large.js": {
        lines: 4,
        reason: "fixture",
        status: "planned_refactor",
        reviewed_at: "2026-06-02"
      }
    }),
    trackedFiles: ["src/large.js"]
  });

  assert.equal(report.status, "fail");
  assert.ok(report.issues.some((issue) => issue.code === "stale_line_count"));
});

test("planned_refactor growth without split plan is a hard issue", (t) => {
  const root = tempDir(t, "large-file-report-growth-");
  writeLines(root, "src/large.js", 6);
  const report = createLargeFileReport({
    root,
    manifestText: manifest({
      "src/large.js": {
        lines: 5,
        reason: "fixture",
        status: "planned_refactor",
        reviewed_at: "2026-06-02"
      }
    }),
    trackedFiles: ["src/large.js"]
  });

  assert.equal(report.status, "fail");
  assert.ok(report.issues.some((issue) => issue.code === "planned_refactor_growth_without_split_plan"));
});

test("planned_refactor growth with split plan is still stale but not an unjustified growth issue", (t) => {
  const root = tempDir(t, "large-file-report-growth-plan-");
  writeLines(root, "src/large.js", 6);
  const report = createLargeFileReport({
    root,
    manifestText: manifest({
      "src/large.js": {
        lines: 5,
        reason: "fixture",
        status: "planned_refactor",
        reviewed_at: "2026-06-02",
        split_plan: "Extract fixture helpers before accepting further growth."
      }
    }),
    trackedFiles: ["src/large.js"]
  });

  assert.equal(report.status, "fail");
  assert.ok(report.issues.some((issue) => issue.code === "stale_line_count"));
  assert.ok(!report.issues.some((issue) => issue.code === "planned_refactor_growth_without_split_plan"));
});

test("planned_refactor shrink is reported as a warning, not a hard failure", (t) => {
  const root = tempDir(t, "large-file-report-shrink-");
  writeLines(root, "src/large.js", 4);
  const report = createLargeFileReport({
    root,
    manifestText: manifest({
      "src/large.js": {
        lines: 5,
        reason: "fixture",
        status: "planned_refactor",
        reviewed_at: "2026-06-02"
      }
    }),
    trackedFiles: ["src/large.js"]
  });

  assert.equal(report.status, "pass");
  assert.deepEqual(report.issues, []);
  assert.ok(report.warnings.some((warning) => warning.code === "line_count_below_manifest"));
});

test("accepted shrink is also a warning instead of a hard failure", (t) => {
  const root = tempDir(t, "large-file-report-accepted-shrink-");
  writeLines(root, "src/large.js", 4);
  const report = createLargeFileReport({
    root,
    manifestText: manifest({
      "src/large.js": {
        lines: 5,
        reason: "fixture",
        status: "accepted",
        reviewed_at: "2026-06-02"
      }
    }),
    trackedFiles: ["src/large.js"]
  });

  assert.equal(report.status, "pass");
  assert.deepEqual(report.issues, []);
  assert.ok(report.warnings.some((warning) => warning.code === "line_count_below_manifest"));
});

test("tracked files above the threshold must be present in the manifest", (t) => {
  const root = tempDir(t, "large-file-report-missing-entry-");
  writeLines(root, "src/untracked-large.js", 5);
  const report = createLargeFileReport({
    root,
    manifestText: manifest({}),
    trackedFiles: ["src/untracked-large.js"]
  });

  assert.equal(report.status, "fail");
  assert.ok(report.issues.some((issue) => issue.code === "missing_large_file_manifest_entry"));
});

test("manifest entries must point to real files and include governance fields", (t) => {
  const root = tempDir(t, "large-file-report-entry-fields-");
  writeLines(root, "src/large.js", 5);
  const report = createLargeFileReport({
    root,
    manifestText: manifest({
      "src/large.js": {
        lines: 5,
        status: "planned_refactor"
      },
      "src/missing.js": {
        lines: 5,
        reason: "fixture",
        status: "planned_refactor"
      },
      "src/missing-fields-and-file.js": {
        lines: 5
      }
    }),
    trackedFiles: ["src/large.js"]
  });

  assert.equal(report.status, "fail");
  assert.ok(report.issues.some((issue) => issue.code === "manifest_entry_missing_governance_fields"));
  assert.ok(report.issues.some((issue) => issue.code === "manifest_file_missing"));
  assert.ok(report.issues.some((issue) => (
    issue.code === "manifest_entry_missing_governance_fields" &&
    issue.path === "src/missing-fields-and-file.js"
  )));
  assert.ok(report.issues.some((issue) => (
    issue.code === "manifest_file_missing" &&
    issue.path === "src/missing-fields-and-file.js"
  )));
});

test("report surfaces a structured issue when tracked files cannot be listed", (t) => {
  const root = tempDir(t, "large-file-report-no-git-");
  writeLines(root, "src/large.js", 5);
  const report = createLargeFileReport({
    root,
    manifestText: manifest({
      "src/large.js": {
        lines: 5,
        reason: "fixture",
        status: "planned_refactor",
        reviewed_at: "2026-06-02"
      }
    })
  });

  assert.equal(report.status, "fail");
  assert.ok(report.issues.some((issue) => issue.code === "tracked_files_unavailable"));
});

test("CLI keeps git stderr clean when tracked files cannot be listed", (t) => {
  const root = tempDir(t, "large-file-report-cli-no-git-");
  writeLines(root, "src/large.js", 5);
  writeFileSync(join(root, ".largefile-manifest.json"), manifest({
    "src/large.js": {
      lines: 5,
      reason: "fixture",
      status: "planned_refactor",
      reviewed_at: "2026-06-02"
    }
  }));

  const result = spawnSync(process.execPath, [
    new URL("../tools/report-large-files.mjs", import.meta.url).pathname,
    "--fail-on-issues"
  ], {
    cwd: root,
    encoding: "utf8"
  });
  const report = JSON.parse(result.stdout);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.ok(report.issues.some((issue) => issue.code === "tracked_files_unavailable"));
});

test("CLI does not expose a disable-baseline bypass flag", (t) => {
  const root = tempDir(t, "large-file-report-cli-disable-baseline-");
  writeFileSync(join(root, ".largefile-manifest.json"), manifest({}));

  const result = spawnSync(process.execPath, [
    new URL("../tools/report-large-files.mjs", import.meta.url).pathname,
    "--disable-baseline",
    "--fail-on-issues"
  ], {
    cwd: root,
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown option: --disable-baseline/);
});

test("passing report returns planned_refactor queue in current line-count order", (t) => {
  const root = tempDir(t, "large-file-report-pass-");
  writeLines(root, "src/a.js", 6);
  writeLines(root, "src/b.js", 8);
  const report = createLargeFileReport({
    root,
    manifestText: manifest({
      "src/a.js": {
        lines: 6,
        reason: "fixture",
        status: "planned_refactor",
        reviewed_at: "2026-06-02"
      },
      "src/b.js": {
        lines: 8,
        reason: "fixture",
        status: "planned_refactor",
        reviewed_at: "2026-06-02"
      }
    }),
    trackedFiles: ["src/a.js", "src/b.js"]
  });

  assert.equal(report.status, "pass");
  assert.deepEqual(report.queue.map((item) => item.path), ["src/b.js", "src/a.js"]);
  assert.deepEqual(report.queue.map((item) => item.priority), ["LFG-Q01", "LFG-Q02"]);
});

test("baseline comparison rejects manifest line ceiling increases", (t) => {
  const root = tempDir(t, "large-file-report-ceiling-increase-");
  writeLines(root, "src/large.js", 6);
  const report = createLargeFileReport({
    root,
    manifestText: manifest({
      "src/large.js": {
        lines: 6,
        reason: "fixture",
        status: "planned_refactor",
        reviewed_at: "2026-06-03"
      }
    }),
    baselineManifestText: manifest({
      "src/large.js": {
        lines: 5,
        reason: "fixture",
        status: "planned_refactor",
        reviewed_at: "2026-06-02"
      }
    }),
    trackedFiles: ["src/large.js"],
    baselineTrackedFiles: ["src/large.js"],
    baselineLineCounts: { "src/large.js": 5 }
  });

  assert.equal(report.status, "fail");
  assert.ok(report.issues.some((issue) => issue.code === "manifest_line_ceiling_increased"));
  assert.ok(report.issues.some((issue) => issue.code === "known_large_file_growth"));
});

test("growth plans do not override the baseline debt ceiling", (t) => {
  const root = tempDir(t, "large-file-report-growth-plan-baseline-");
  writeLines(root, "src/large.js", 6);
  const report = createLargeFileReport({
    root,
    manifestText: manifest({
      "src/large.js": {
        lines: 6,
        reason: "fixture",
        status: "planned_refactor",
        reviewed_at: "2026-06-03",
        growth_justification: "This should not bypass the baseline ceiling."
      }
    }),
    baselineManifestText: manifest({
      "src/large.js": {
        lines: 5,
        reason: "fixture",
        status: "planned_refactor",
        reviewed_at: "2026-06-02"
      }
    }),
    trackedFiles: ["src/large.js"],
    baselineTrackedFiles: ["src/large.js"],
    baselineLineCounts: { "src/large.js": 5 }
  });

  assert.equal(report.status, "fail");
  assert.ok(report.issues.some((issue) => issue.code === "known_large_file_growth"));
});

test("accepted files are not allowed to grow above baseline", (t) => {
  const root = tempDir(t, "large-file-report-accepted-growth-");
  writeLines(root, "src/accepted.js", 6);
  const report = createLargeFileReport({
    root,
    manifestText: manifest({
      "src/accepted.js": {
        lines: 6,
        reason: "fixture",
        status: "accepted",
        reviewed_at: "2026-06-03"
      }
    }),
    baselineManifestText: manifest({
      "src/accepted.js": {
        lines: 5,
        reason: "fixture",
        status: "accepted",
        reviewed_at: "2026-06-02"
      }
    }),
    trackedFiles: ["src/accepted.js"],
    baselineTrackedFiles: ["src/accepted.js"],
    baselineLineCounts: { "src/accepted.js": 5 }
  });

  assert.equal(report.status, "fail");
  assert.ok(report.issues.some((issue) => issue.code === "known_large_file_growth"));
});

test("new large files cannot be registered in the manifest as a bypass", (t) => {
  const root = tempDir(t, "large-file-report-new-large-bypass-");
  writeLines(root, "src/new-large.js", 6);
  const report = createLargeFileReport({
    root,
    manifestText: manifest({
      "src/new-large.js": {
        lines: 6,
        reason: "fixture",
        status: "accepted",
        reviewed_at: "2026-06-03"
      }
    }),
    baselineManifestText: manifest({}),
    trackedFiles: ["src/new-large.js"],
    baselineTrackedFiles: [],
    baselineLineCounts: {}
  });

  assert.equal(report.status, "fail");
  assert.ok(report.issues.some((issue) => issue.code === "new_large_file_manifest_entry"));
  assert.ok(report.issues.some((issue) => issue.code === "new_large_file_added"));
});

test("total large-file debt cannot increase relative to baseline", (t) => {
  const root = tempDir(t, "large-file-report-total-debt-");
  writeLines(root, "src/a.js", 5);
  writeLines(root, "src/b.js", 5);
  const report = createLargeFileReport({
    root,
    manifestText: manifest({
      "src/a.js": {
        lines: 5,
        reason: "fixture",
        status: "planned_refactor",
        reviewed_at: "2026-06-03"
      },
      "src/b.js": {
        lines: 5,
        reason: "fixture",
        status: "planned_refactor",
        reviewed_at: "2026-06-03"
      }
    }),
    baselineManifestText: manifest({
      "src/a.js": {
        lines: 5,
        reason: "fixture",
        status: "planned_refactor",
        reviewed_at: "2026-06-02"
      }
    }),
    trackedFiles: ["src/a.js", "src/b.js"],
    baselineTrackedFiles: ["src/a.js"],
    baselineLineCounts: { "src/a.js": 5 }
  });

  assert.equal(report.status, "fail");
  assert.ok(report.issues.some((issue) => issue.code === "total_large_file_debt_increased"));
});

test("new near-threshold files are surfaced before they become large files", (t) => {
  const root = tempDir(t, "large-file-report-near-threshold-");
  writeLines(root, "src/near.js", 350);
  const report = createLargeFileReport({
    root,
    manifestText: manifest({}, 500),
    baselineManifestText: manifest({}, 500),
    trackedFiles: ["src/near.js"],
    baselineTrackedFiles: [],
    baselineLineCounts: {}
  });

  assert.equal(report.status, "pass");
  assert.ok(report.warnings.some((warning) => warning.code === "new_near_threshold_file"));
});

test("accepted files above 750 lines require an unexpired rechallenge marker", (t) => {
  const root = tempDir(t, "large-file-report-rechallenge-");
  writeLines(root, "test/accepted-large.test.js", 751);
  const report = createLargeFileReport({
    root,
    manifestText: manifest({
      "test/accepted-large.test.js": {
        lines: 751,
        reason: "fixture",
        status: "accepted",
        reviewed_at: "2026-06-03"
      }
    }, 500),
    trackedFiles: ["test/accepted-large.test.js"],
    now: new Date("2026-06-03T00:00:00.000Z")
  });

  assert.equal(report.status, "fail");
  assert.ok(report.issues.some((issue) => issue.code === "accepted_large_file_rechallenge_missing"));
});

test("expired accepted-file rechallenge markers fail closed", (t) => {
  const root = tempDir(t, "large-file-report-rechallenge-expired-");
  writeLines(root, "test/accepted-large.test.js", 751);
  const report = createLargeFileReport({
    root,
    manifestText: manifest({
      "test/accepted-large.test.js": {
        lines: 751,
        reason: "fixture",
        status: "accepted",
        reviewed_at: "2026-06-03",
        rechallenge_due: "2026-06-01"
      }
    }, 500),
    trackedFiles: ["test/accepted-large.test.js"],
    now: new Date("2026-06-03T00:00:00.000Z")
  });

  assert.equal(report.status, "fail");
  assert.ok(report.issues.some((issue) => issue.code === "accepted_large_file_rechallenge_expired"));
});
