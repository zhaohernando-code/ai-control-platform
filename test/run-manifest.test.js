import assert from "node:assert/strict";
import test from "node:test";

import { evaluateRunResult, PASS } from "../src/workflow/autonomous-run.js";
import {
  appendRunEvent,
  buildRunResultFromManifest,
  createRunManifest,
  validateRunManifest
} from "../src/workflow/run-manifest.js";

function validContextPack(overrides = {}) {
  return {
    requirement_summary: "为新中台实现平台中立 run manifest 与 artifact ledger 基座",
    host: "platform_core",
    target_project_id: "ai-control-platform",
    non_goals: ["不修改 stock_dashboard", "不实现 task DAG 执行器"],
    forbidden_actions: ["不得写入业务项目", "不得回退他人改动"],
    owned_files: [
      "src/workflow/run-manifest.js",
      "test/run-manifest.test.js",
      "src/workflow/artifact-ledger.js",
      "test/artifact-ledger.test.js",
      "docs/contracts/RUN_MANIFEST_LEDGER_DAG_CN.md"
    ],
    acceptance_gates: ["node --test test/run-manifest.test.js test/artifact-ledger.test.js"],
    rollback_conditions: ["context pack 不 ready", "work package 越过 Context Pack"],
    subtasks: [
      {
        id: "manifest",
        title: "Run manifest runtime",
        owned_files: ["src/workflow/run-manifest.js", "test/run-manifest.test.js"]
      },
      {
        id: "ledger",
        title: "Artifact ledger runtime",
        owned_files: ["src/workflow/artifact-ledger.js", "test/artifact-ledger.test.js"],
        depends_on: ["manifest"]
      }
    ],
    ...overrides
  };
}

function validManifest(overrides = {}) {
  return createRunManifest({
    run_id: "run-c",
    cycle_id: "cycle-20260521",
    goal: "实现平台中立 run manifest 与 artifact ledger 基座",
    context_pack: validContextPack(),
    artifacts: [{ id: "patch", status: "pass" }],
    gate_results: [{ gate_id: "unit-tests", status: "pass" }],
    review_findings: [],
    recovery_attempts: [],
    ...overrides
  });
}

test("run manifest validates and can feed evaluateRunResult", () => {
  const manifest = validManifest({
    work_packages: [
      { id: "manifest", title: "Run manifest runtime", status: "completed" },
      { id: "ledger", title: "Artifact ledger runtime", status: "completed" }
    ]
  });

  const validation = validateRunManifest(manifest);
  const runResult = buildRunResultFromManifest(manifest);
  const evaluation = evaluateRunResult(runResult);

  assert.equal(validation.status, "pass");
  assert.deepEqual(Object.keys(runResult), [
    "run_id",
    "cycle_id",
    "work_packages",
    "artifacts",
    "gate_results",
    "review_findings",
    "recovery_attempts"
  ]);
  assert.equal(evaluation.status, PASS);
});

test("run manifest fails without context pack", () => {
  const manifest = validManifest({ context_pack: null, work_packages: [] });

  const validation = validateRunManifest(manifest);

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some((issue) => issue.code === "context_pack_not_ready"));
});

test("run manifest rejects work packages outside generated context package set", () => {
  const manifest = validManifest({
    work_packages: [
      { id: "manifest", status: "completed" },
      { id: "unowned-extra", status: "completed" }
    ]
  });

  const validation = validateRunManifest(manifest);

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some((issue) => issue.code === "work_package_out_of_context"));
});

test("appendRunEvent returns a new manifest without mutating the original", () => {
  const manifest = validManifest({ events: [{ id: "event-1", type: "created", created_at: "2026-05-21T00:00:00.000Z" }] });

  const nextManifest = appendRunEvent(manifest, {
    id: "event-2",
    type: "gate",
    message: "unit tests passed",
    created_at: "2026-05-21T00:01:00.000Z"
  });

  assert.notEqual(nextManifest, manifest);
  assert.equal(manifest.events.length, 1);
  assert.equal(nextManifest.events.length, 2);
  assert.equal(nextManifest.events[1].message, "unit tests passed");
  assert.equal(nextManifest.updated_at, "2026-05-21T00:01:00.000Z");
});
