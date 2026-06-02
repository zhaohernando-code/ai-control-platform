import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  codeReviewPathExclusion,
  createCodeReviewCoverageDispatch,
  evaluateCodeReviewCoverageDispatch
} from "../src/workflow/code-review-coverage-dispatch.js";

function currentCoverageArtifact() {
  return JSON.parse(readFileSync("docs/examples/code-review-coverage-current.json", "utf8"));
}

const IGNORED_SOURCE_DIRS = new Set([".next", "node_modules", "tmp", "dist", "build"]);
const SOURCE_FILE_PATTERN = /\.(css|[cm]?js|jsx|[cm]?ts|tsx)$/;

function listSourceFiles(root) {
  const files = [];
  for (const entry of readdirSync(root)) {
    if (IGNORED_SOURCE_DIRS.has(entry)) continue;
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...listSourceFiles(path));
      continue;
    }
    if (SOURCE_FILE_PATTERN.test(path)) {
      files.push(path.replace(/\\/g, "/"));
    }
  }
  return files.sort();
}

test("code review coverage excludes dependencies, VCS metadata, temp files, build output, and caches", () => {
  const excludedPaths = [
    "node_modules/pkg/index.js",
    ".git/config",
    ".next/server/app.js",
    ".nuxt/dist/server.js",
    ".turbo/cache/file",
    ".cache/tool.json",
    "dist/app.js",
    "build/server.js",
    "coverage/lcov.info",
    "tmp/review.json",
    "temp/review.json",
    "logs/app.log",
    ".pytest_cache/v/cache",
    ".venv/lib/site.py",
    "vendor/library/source.js",
    "src/app.min.js",
    "src/app.js.map",
    "src/output.log",
    "src/output.tmp",
    "src/output.cache",
    "src/client.generated.ts",
    "src/client.gen.ts"
  ];

  for (const path of excludedPaths) {
    const record = codeReviewPathExclusion(path);
    assert.equal(record.excluded, true, path);
    assert.ok(record.reason, path);
  }

  assert.equal(codeReviewPathExclusion("src/workflow/self-governance.js").excluded, false);
  assert.equal(codeReviewPathExclusion("src/workflow/module.mjs").excluded, false);
  assert.equal(codeReviewPathExclusion("src/workflow/module.cjs").excluded, false);
  assert.equal(codeReviewPathExclusion("src/workflow/module.mts").excluded, false);
  assert.equal(codeReviewPathExclusion("src/workflow/module.cts").excluded, false);
  assert.equal(codeReviewPathExclusion("test/self-governance.test.js").excluded, false);
});

test("missing code quality review shard creates a supplement dispatch package", () => {
  const result = evaluateCodeReviewCoverageDispatch({
    version: "code-review-coverage.v1",
    id: "coverage-run",
    summary: {
      denominator_files: [
        "src/workflow/autonomous-continuation.js",
        "node_modules/pkg/index.js"
      ]
    },
    shards: [
      {
        id: "workflow-continuation",
        status: "missing",
        files: [
          "src/workflow/autonomous-continuation.js",
          "node_modules/pkg/index.js"
        ]
      }
    ]
  });

  assert.equal(result.status, "needs_dispatch");
  assert.equal(result.supplemental_work_packages.length, 1);
  assert.equal(result.supplemental_work_packages[0].action, "run_code_quality_review_shard");
  assert.equal(result.supplemental_work_packages[0].governance_action, "supplement_code_review_coverage");
  assert.equal(result.supplemental_work_packages[0].dimension, "code_quality");
  assert.ok(result.supplemental_work_packages[0].acceptance_gates.includes("npm run check:code-review-coverage"));
});

test("dispatch package owned files exclude hard-excluded paths", () => {
  const result = evaluateCodeReviewCoverageDispatch({
    version: "code-review-coverage.v1",
    shards: [
      {
        id: "mixed-scope",
        status: "failed",
        files: [
          "src/workflow/code-review-coverage-dispatch.js",
          "tmp/generated-review.json",
          "dist/app.bundle.js",
          ".git/config",
          "node_modules/pkg/index.js"
        ]
      }
    ]
  });

  const workPackage = result.supplemental_work_packages[0];
  assert.deepEqual(workPackage.owned_files, ["src/workflow/code-review-coverage-dispatch.js"]);
  assert.deepEqual(workPackage.code_review_coverage.first_party_files, ["src/workflow/code-review-coverage-dispatch.js"]);
  assert.equal(workPackage.code_review_coverage.excluded_files.length, 4);
});

test("all audited first-party shards pass while excluded files stay outside the denominator", () => {
  const result = evaluateCodeReviewCoverageDispatch({
    version: "code-review-coverage.v1",
    summary: {
      denominator_files: [
        "src/workflow/self-governance-scanner.js",
        "test/self-governance.test.js",
        "node_modules/pkg/index.js",
        "tmp/review.json",
        "dist/app.js"
      ]
    },
    shards: [
      {
        id: "scanner",
        status: "audited",
        files: ["src/workflow/self-governance-scanner.js", "node_modules/pkg/index.js"],
        evidence: ["test/self-governance.test.js"]
      },
      {
        id: "scanner-tests",
        status: "covered",
        files: ["test/self-governance.test.js", "tmp/review.json", "dist/app.js"],
        evidence: ["node --test test/self-governance.test.js"]
      }
    ]
  });

  assert.equal(result.status, "pass");
  assert.deepEqual(result.first_party_files, [
    "src/workflow/self-governance-scanner.js",
    "test/self-governance.test.js"
  ]);
  assert.equal(result.excluded_file_count, 3);
  assert.deepEqual(result.supplemental_work_packages, []);
});

test("summary missing shard count without shard evidence creates generic supplement package", () => {
  const result = evaluateCodeReviewCoverageDispatch({
    version: "code-review-coverage.v1",
    summary: {
      missing_shard_count: 1,
      denominator_files: [
        "src/workflow/code-review-coverage-dispatch.js",
        "node_modules/pkg/index.js"
      ]
    },
    shards: []
  });

  assert.equal(result.status, "needs_dispatch");
  assert.equal(result.supplemental_work_packages.length, 1);
  assert.equal(result.supplemental_work_packages[0].shard_id, "missing-shard-1");
  assert.deepEqual(result.supplemental_work_packages[0].owned_files, ["src/workflow/code-review-coverage-dispatch.js"]);
});

test("manifest code_review_coverage event can drive coverage dispatch", () => {
  const dispatch = createCodeReviewCoverageDispatch({
    workflow_state: {
      manifest: {
        events: [
          {
            type: "code_review_coverage",
            payload: {
              version: "code-review-coverage.v1",
              shards: [
                {
                  id: "manifest-shard",
                  status: "needs_rerun",
                  files: ["src/workflow/autonomous-continuation.js", "coverage/lcov.info"]
                }
              ]
            }
          }
        ]
      }
    }
  });

  assert.equal(dispatch.status, "needs_dispatch");
  assert.equal(dispatch.package_ids[0], "code-review-coverage-manifest-shard");
});

test("current coverage artifact covers all Workbench app routes, hooks, and API base layer files", () => {
  const result = evaluateCodeReviewCoverageDispatch(currentCoverageArtifact());
  const covered = new Set(result.first_party_files);
  const currentWorkbenchFiles = [
    ...listSourceFiles("apps/workbench/app"),
    ...listSourceFiles("apps/workbench/lib")
  ];
  const missing = currentWorkbenchFiles.filter((file) => !covered.has(file));

  assert.equal(result.status, "pass");
  assert.deepEqual(missing, []);
  assert.ok(covered.has("apps/workbench/app/page.tsx"));
  assert.ok(covered.has("apps/workbench/app/requirements/page.tsx"));
  assert.ok(covered.has("apps/workbench/app/shell.tsx"));
  assert.ok(covered.has("apps/workbench/lib/api/index.ts"));
  assert.ok(covered.has("apps/workbench/lib/hooks/useProjection.ts"));
});
