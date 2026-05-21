import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createArtifactLedger } from "../src/workflow/artifact-ledger.js";
import { evaluateRunResult, RERUN } from "../src/workflow/autonomous-run.js";
import { createReviewerGateRequest } from "../src/workflow/llm-reviewer-gate.js";
import { recordReviewerScopeSplitPlan } from "../src/workflow/reviewer-scope-splitter.js";
import {
  createReviewerShardAggregate,
  createReviewerShardResult,
  recordReviewerShardAggregate,
  recordReviewerShardResult
} from "../src/workflow/reviewer-shard-results.js";
import { createRunManifest } from "../src/workflow/run-manifest.js";

function contextPack() {
  return {
    requirement_summary: "固化 reviewer shard 结果汇总",
    host: "platform_core",
    target_project_id: "ai-control-platform",
    owned_files: ["src/workflow/reviewer-shard-results.js", "test/reviewer-shard-results.test.js"],
    acceptance_gates: ["node --test test/reviewer-shard-results.test.js"],
    subtasks: [
      {
        id: "reviewer-shard-results",
        title: "Reviewer shard results",
        owned_files: ["src/workflow/reviewer-shard-results.js"]
      }
    ]
  };
}

function baseWorkflowState() {
  const manifest = createRunManifest({
    run_id: "run-shard-results",
    cycle_id: "cycle-shard-results",
    goal: "固化 reviewer shard 结果汇总",
    context_pack: contextPack(),
    work_packages: [{ id: "reviewer-shard-results", status: "completed", owned_files: ["src/workflow/reviewer-shard-results.js"] }],
    artifacts: [],
    gate_results: [],
    review_findings: [],
    recovery_attempts: []
  });

  return {
    manifest,
    artifact_ledger: createArtifactLedger({
      run_id: manifest.run_id,
      cycle_id: manifest.cycle_id,
      artifacts: []
    })
  };
}

function reviewerRequest() {
  return createReviewerGateRequest({
    run_id: "run-shard-results",
    cycle_id: "cycle-shard-results",
    scope: "Review shard result aggregation.",
    files: ["src/workflow/reviewer-scope-splitter.js", "src/workflow/reviewer-shard-results.js"],
    questions: ["分片结果是否能合并进 reviewer gate？"]
  });
}

function workflowStateWithSplit() {
  const recorded = recordReviewerScopeSplitPlan(baseWorkflowState(), {
    request: reviewerRequest(),
    mode: "tool_timeout_recovery",
    no_tools: true,
    created_at: "2026-05-21T20:40:00.000Z"
  });
  assert.equal(recorded.status, "pass");
  return recorded.workflow_state;
}

test("reviewer shard result normalizes findings with shard evidence", () => {
  const splitPlan = workflowStateWithSplit().manifest.events.at(-1).metadata;
  const result = createReviewerShardResult({
    split_plan: splitPlan,
    shard_id: "reviewer-scope-shard-001",
    findings: [
      {
        id: "missing-shard-test",
        status: "fail",
        severity: "medium",
        category: "reviewer",
        message: "missing focused shard aggregation test"
      }
    ],
    created_at: "2026-05-21T20:41:00.000Z"
  });

  assert.equal(result.status, "fail");
  assert.equal(result.shard_id, "reviewer-scope-shard-001");
  assert.equal(result.failed_finding_count, 1);
  assert.equal(result.findings[0].evidence.shard_id, "reviewer-scope-shard-001");
  assert.deepEqual(result.findings[0].evidence.files, ["src/workflow/reviewer-scope-splitter.js"]);
});

test("reviewer shard aggregate waits for pending shards", () => {
  const splitPlan = workflowStateWithSplit().manifest.events.at(-1).metadata;
  const result = createReviewerShardResult({
    split_plan: splitPlan,
    shard_id: "reviewer-scope-shard-001",
    findings: [],
    status: "pass"
  });
  const aggregate = createReviewerShardAggregate({
    split_plan: splitPlan,
    shard_results: [result]
  });

  assert.equal(aggregate.status, "pending");
  assert.equal(aggregate.completed_shards, 1);
  assert.equal(aggregate.pending_shards, 1);
  assert.deepEqual(aggregate.pending_shard_ids, ["reviewer-scope-shard-002"]);
});

test("reviewer shard aggregate merges shard findings and drives rerun decision", () => {
  const splitPlan = workflowStateWithSplit().manifest.events.at(-1).metadata;
  const first = createReviewerShardResult({
    split_plan: splitPlan,
    shard_id: "reviewer-scope-shard-001",
    findings: [{ id: "shard-one-pass", status: "pass", message: "ok" }]
  });
  const second = createReviewerShardResult({
    split_plan: splitPlan,
    shard_id: "reviewer-scope-shard-002",
    findings: [
      {
        id: "shard-two-finding",
        status: "fail",
        severity: "medium",
        category: "reviewer",
        message: "requires a focused aggregation guard"
      }
    ]
  });
  const aggregate = createReviewerShardAggregate({
    split_plan: splitPlan,
    shard_results: [first, second]
  });

  assert.equal(aggregate.status, "fail");
  assert.equal(aggregate.completed_shards, 2);
  assert.equal(aggregate.pending_shards, 0);
  assert.equal(aggregate.failed_finding_count, 1);

  const evaluation = evaluateRunResult({
    run_id: aggregate.run_id,
    cycle_id: aggregate.cycle_id,
    work_packages: [{ id: "reviewer-shards", status: "completed" }],
    artifacts: [{ id: "patch", status: "pass" }],
    gate_results: [{ gate_id: "tests", status: "pass" }],
    review_findings: aggregate.merged_findings,
    recovery_attempts: []
  });

  assert.equal(evaluation.status, RERUN);
});

test("reviewer shard result and aggregate persistence write durable review state", () => {
  const state = workflowStateWithSplit();
  const first = recordReviewerShardResult(state, {
    shard_id: "reviewer-scope-shard-001",
    status: "pass",
    findings: [],
    created_at: "2026-05-21T20:42:00.000Z"
  });
  assert.equal(first.status, "pass");
  assert.equal(first.workflow_state.manifest.events.at(-1).type, "reviewer_shard_result");
  assert.equal(first.workflow_state.artifact_ledger.artifacts.at(-1).producer, "reviewer-shard-result");

  const second = recordReviewerShardResult(first.workflow_state, {
    shard_id: "reviewer-scope-shard-002",
    findings: [
      {
        id: "shard-persisted-finding",
        status: "fail",
        severity: "medium",
        category: "reviewer",
        message: "persisted shard finding"
      }
    ],
    created_at: "2026-05-21T20:43:00.000Z"
  });
  assert.equal(second.status, "pass");

  const aggregate = recordReviewerShardAggregate(second.workflow_state, {
    created_at: "2026-05-21T20:44:00.000Z"
  });
  assert.equal(aggregate.status, "pass");
  assert.equal(aggregate.fact.status, "fail");
  assert.equal(aggregate.workflow_state.manifest.events.at(-1).type, "reviewer_shard_aggregate");
  assert.equal(aggregate.workflow_state.artifact_ledger.artifacts.at(-1).producer, "reviewer-shard-aggregate");
  assert.equal(aggregate.workflow_state.manifest.review_findings.length, 1);
  assert.equal(aggregate.workflow_state.manifest.review_findings[0].finding_id, "shard-persisted-finding");
});

test("reviewer shard persistence fails closed on unknown shard or identity mismatch", () => {
  const state = workflowStateWithSplit();
  const unknownShard = recordReviewerShardResult(state, {
    shard_id: "reviewer-scope-shard-999",
    findings: []
  });

  assert.equal(unknownShard.status, "fail");
  assert.ok(unknownShard.issues.some((item) => item.code === "missing_reviewer_scope_shard"));

  const mismatch = recordReviewerShardAggregate({
    ...state,
    artifact_ledger: {
      ...state.artifact_ledger,
      run_id: "wrong-run"
    }
  });

  assert.equal(mismatch.status, "fail");
  assert.ok(mismatch.issues.some((item) => item.code === "workflow_state_run_mismatch"));
});

test("record-reviewer-shard-result CLI writes shard results and aggregate facts", () => {
  const dir = mkdtempSync(join(tmpdir(), "reviewer-shard-result-cli-"));
  const inputPath = join(dir, "input.json");
  const outputPath = join(dir, "output.json");
  writeFileSync(inputPath, JSON.stringify(workflowStateWithSplit(), null, 2));

  execFileSync(process.execPath, [
    "tools/record-reviewer-shard-result.mjs",
    "--input",
    inputPath,
    "--output",
    outputPath,
    "--shard-id",
    "reviewer-scope-shard-001",
    "--status",
    "pass",
    "--created-at",
    "2026-05-21T20:45:00.000Z"
  ], { encoding: "utf8" });

  const output = execFileSync(process.execPath, [
    "tools/record-reviewer-shard-result.mjs",
    "--input",
    outputPath,
    "--output",
    outputPath,
    "--shard-id",
    "reviewer-scope-shard-002",
    "--findings-json",
    JSON.stringify([{ id: "cli-shard-finding", status: "fail", severity: "medium", category: "reviewer", message: "cli finding" }]),
    "--aggregate",
    "--created-at",
    "2026-05-21T20:46:00.000Z"
  ], { encoding: "utf8" });
  const summary = JSON.parse(output);
  const state = JSON.parse(readFileSync(outputPath, "utf8"));

  assert.equal(summary.status, "pass");
  assert.equal(summary.aggregate.status, "fail");
  assert.equal(summary.aggregate.completed_shards, 2);
  assert.equal(state.manifest.events.at(-1).type, "reviewer_shard_aggregate");
  assert.equal(state.manifest.review_findings[0].finding_id, "cli-shard-finding");
});

test("record-reviewer-shard-result CLI fails closed on unreadable input", () => {
  const result = spawnSync(process.execPath, [
    "tools/record-reviewer-shard-result.mjs",
    "--input",
    "/no/such/file.json",
    "--output",
    "/tmp/unused.json",
    "--shard-id",
    "reviewer-scope-shard-001"
  ], { encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /reviewer_shard_input_read_failed/);
});
