import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createArtifactLedger } from "../src/workflow/artifact-ledger.js";
import { createReviewerGateRequest } from "../src/workflow/llm-reviewer-gate.js";
import { recordReviewerScopeSplitPlan } from "../src/workflow/reviewer-scope-splitter.js";
import {
  createReviewerShardPrompt,
  getPendingReviewerShards,
  runReviewerShard
} from "../src/workflow/reviewer-shard-runner.js";
import { createRunManifest } from "../src/workflow/run-manifest.js";

function contextPack() {
  return {
    requirement_summary: "固化 reviewer shard runner",
    host: "platform_core",
    target_project_id: "ai-control-platform",
    owned_files: ["src/workflow/reviewer-shard-runner.js", "test/reviewer-shard-runner.test.js"],
    acceptance_gates: ["node --test test/reviewer-shard-runner.test.js"],
    subtasks: [
      {
        id: "reviewer-shard-runner",
        title: "Reviewer shard runner",
        owned_files: ["src/workflow/reviewer-shard-runner.js"]
      }
    ]
  };
}

function workflowState() {
  const manifest = createRunManifest({
    run_id: "run-shard-runner",
    cycle_id: "cycle-shard-runner",
    goal: "固化 reviewer shard runner",
    context_pack: contextPack(),
    work_packages: [{ id: "reviewer-shard-runner", status: "completed", owned_files: ["src/workflow/reviewer-shard-runner.js"] }],
    artifacts: [],
    gate_results: [],
    review_findings: [],
    recovery_attempts: []
  });
  const state = {
    manifest,
    artifact_ledger: createArtifactLedger({
      run_id: manifest.run_id,
      cycle_id: manifest.cycle_id,
      artifacts: []
    })
  };

  const split = recordReviewerScopeSplitPlan(state, {
    request: createReviewerGateRequest({
      run_id: manifest.run_id,
      cycle_id: manifest.cycle_id,
      scope: "Review shard runner.",
      files: ["src/workflow/reviewer-shard-runner.js", "src/workflow/reviewer-shard-results.js"],
      questions: ["runner 是否能自动记录和聚合？"]
    }),
    mode: "tool_timeout_recovery",
    no_tools: true,
    created_at: "2026-05-21T21:00:00.000Z"
  });
  assert.equal(split.status, "pass");
  return split.workflow_state;
}

test("reviewer shard runner lists pending shards and builds read-only prompts", () => {
  const pending = getPendingReviewerShards(workflowState());
  const prompt = createReviewerShardPrompt(pending.shards[0]);

  assert.equal(pending.status, "pass");
  assert.equal(pending.pending_shards, 2);
  assert.match(prompt, /只读 reviewer shard/);
  assert.match(prompt, /Allowed tools: none/);
  assert.match(prompt, /Return JSON findings only/);
});

test("reviewer shard runner records one shard and leaves remaining shard pending", async () => {
  const result = await runReviewerShard(workflowState(), {
    shard_id: "reviewer-scope-shard-001",
    created_at: "2026-05-21T21:01:00.000Z",
    executor: async ({ shard, prompt }) => {
      assert.equal(shard.id, "reviewer-scope-shard-001");
      assert.match(prompt, /reviewer-scope-shard-001/);
      return { status: "pass", findings: [] };
    }
  });

  assert.equal(result.status, "pass");
  assert.equal(result.phase, "shard_recorded");
  assert.equal(result.pending_shards, 1);
  assert.equal(result.workflow_state.manifest.events.at(-1).type, "reviewer_shard_result");
});

test("reviewer shard runner aggregates automatically after the last shard", async () => {
  const first = await runReviewerShard(workflowState(), {
    shard_id: "reviewer-scope-shard-001",
    created_at: "2026-05-21T21:02:00.000Z",
    executor: async () => ({ status: "pass", findings: [] })
  });
  const second = await runReviewerShard(first.workflow_state, {
    shard_id: "reviewer-scope-shard-002",
    created_at: "2026-05-21T21:03:00.000Z",
    executor: async () => ({
      status: "fail",
      findings: [
        {
          id: "runner-shard-finding",
          status: "fail",
          severity: "medium",
          category: "reviewer",
          message: "runner aggregate finding"
        }
      ]
    })
  });

  assert.equal(second.status, "pass");
  assert.equal(second.phase, "aggregated");
  assert.equal(second.aggregate.status, "fail");
  assert.equal(second.workflow_state.manifest.events.at(-1).type, "reviewer_shard_aggregate");
  assert.ok(second.workflow_state.manifest.review_findings.some((finding) => finding.finding_id === "runner-shard-finding"));
});

test("reviewer shard runner records provider health for timeout findings", async () => {
  const result = await runReviewerShard(workflowState(), {
    shard_id: "reviewer-scope-shard-001",
    created_at: "2026-05-21T21:04:00.000Z",
    record_provider_health_on_timeout: true,
    executor: async () => ({
      status: "fail",
      findings: [
        {
          id: "runner-timeout",
          status: "fail",
          severity: "medium",
          category: "reviewer_timeout",
          message: "reviewer shard timed out"
        }
      ]
    })
  });

  assert.equal(result.status, "pass");
  assert.equal(result.provider_health.recovery_status, "needs_smoke_check");
  assert.deepEqual(result.provider_health.scheduled_actions, ["provider_smoke_check"]);
  assert.equal(result.workflow_state.manifest.events.at(-1).type, "reviewer_provider_health");
});

test("reviewer shard runner fails closed without executor or pending shard", async () => {
  const missingExecutor = await runReviewerShard(workflowState(), {
    shard_id: "reviewer-scope-shard-001"
  });
  assert.equal(missingExecutor.status, "fail");
  assert.ok(missingExecutor.issues.some((item) => item.code === "missing_reviewer_shard_executor"));

  const unknownShard = await runReviewerShard(workflowState(), {
    shard_id: "reviewer-scope-shard-999",
    executor: async () => ({ status: "pass", findings: [] })
  });
  assert.equal(unknownShard.status, "fail");
  assert.ok(unknownShard.issues.some((item) => item.code === "reviewer_shard_not_pending"));
});

test("run-reviewer-shard CLI executes pending shards with mock executor", () => {
  const dir = mkdtempSync(join(tmpdir(), "reviewer-shard-runner-cli-"));
  const inputPath = join(dir, "input.json");
  const outputPath = join(dir, "output.json");
  writeFileSync(inputPath, JSON.stringify(workflowState(), null, 2));

  const first = execFileSync(process.execPath, [
    "tools/run-reviewer-shard.mjs",
    "--input",
    inputPath,
    "--output",
    outputPath,
    "--shard-id",
    "reviewer-scope-shard-001",
    "--mock-status",
    "pass",
    "--created-at",
    "2026-05-21T21:10:00.000Z"
  ], { encoding: "utf8" });
  const firstSummary = JSON.parse(first);

  assert.equal(firstSummary.status, "pass");
  assert.equal(firstSummary.phase, "shard_recorded");
  assert.equal(firstSummary.pending_shards, 1);

  const second = execFileSync(process.execPath, [
    "tools/run-reviewer-shard.mjs",
    "--input",
    outputPath,
    "--output",
    outputPath,
    "--shard-id",
    "reviewer-scope-shard-002",
    "--mock-findings-json",
    JSON.stringify([{ id: "runner-cli-finding", status: "fail", severity: "medium", category: "reviewer", message: "cli finding" }]),
    "--mock-status",
    "fail",
    "--created-at",
    "2026-05-21T21:11:00.000Z"
  ], { encoding: "utf8" });
  const secondSummary = JSON.parse(second);
  const state = JSON.parse(readFileSync(outputPath, "utf8"));

  assert.equal(secondSummary.status, "pass");
  assert.equal(secondSummary.phase, "aggregated");
  assert.equal(secondSummary.aggregate.failed_finding_count, 1);
  assert.ok(state.manifest.review_findings.some((finding) => finding.finding_id === "runner-cli-finding"));
});

test("run-reviewer-shard CLI records provider health on timeout findings", () => {
  const dir = mkdtempSync(join(tmpdir(), "reviewer-shard-runner-timeout-cli-"));
  const inputPath = join(dir, "input.json");
  const outputPath = join(dir, "output.json");
  writeFileSync(inputPath, JSON.stringify(workflowState(), null, 2));

  const output = execFileSync(process.execPath, [
    "tools/run-reviewer-shard.mjs",
    "--input",
    inputPath,
    "--output",
    outputPath,
    "--shard-id",
    "reviewer-scope-shard-001",
    "--mock-findings-json",
    JSON.stringify([{ id: "cli-timeout", status: "fail", severity: "medium", category: "reviewer_timeout", message: "timeout" }]),
    "--mock-status",
    "fail",
    "--record-provider-health",
    "--created-at",
    "2026-05-21T21:12:00.000Z"
  ], { encoding: "utf8" });
  const summary = JSON.parse(output);
  const state = JSON.parse(readFileSync(outputPath, "utf8"));

  assert.equal(summary.status, "pass");
  assert.equal(summary.provider_health.provider_health, "unknown");
  assert.deepEqual(summary.provider_health.scheduled_actions, ["provider_smoke_check"]);
  assert.equal(state.manifest.events.at(-1).type, "reviewer_provider_health");
});

test("run-reviewer-shard CLI fails closed on unreadable input", () => {
  const result = spawnSync(process.execPath, [
    "tools/run-reviewer-shard.mjs",
    "--input",
    "/no/such/file.json",
    "--output",
    "/tmp/unused.json"
  ], { encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /reviewer_shard_run_input_failed/);
});
