import assert from "node:assert/strict";
import test from "node:test";

import { createArtifactLedger } from "../src/workflow/artifact-ledger.js";
import { createReviewerGateRequest } from "../src/workflow/llm-reviewer-gate.js";
import {
  createReviewerScopeSplitFact,
  createReviewerScopeSplitPlan,
  recordReviewerScopeSplitPlan
} from "../src/workflow/reviewer-scope-splitter.js";
import { createRunManifest } from "../src/workflow/run-manifest.js";

function contextPack() {
  return {
    requirement_summary: "固化 reviewer scope split 调度事实",
    host: "platform_core",
    target_project_id: "ai-control-platform",
    owned_files: ["src/workflow/reviewer-scope-splitter.js", "test/reviewer-scope-splitter.test.js"],
    acceptance_gates: ["node --test test/reviewer-scope-splitter.test.js"],
    subtasks: [
      {
        id: "reviewer-scope-split",
        title: "Reviewer scope split facts",
        owned_files: ["src/workflow/reviewer-scope-splitter.js"]
      }
    ]
  };
}

function workflowState() {
  const manifest = createRunManifest({
    run_id: "run-scope-split",
    cycle_id: "cycle-scope-split",
    goal: "固化 reviewer scope split 调度事实",
    context_pack: contextPack(),
    work_packages: [{ id: "reviewer-scope-split", status: "completed", owned_files: ["src/workflow/reviewer-scope-splitter.js"] }],
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

function reviewerRequest(overrides = {}) {
  return createReviewerGateRequest({
    run_id: "run-scope-split",
    cycle_id: "cycle-scope-split",
    scope: "Review reviewer splitting.",
    files: [
      "src/workflow/llm-reviewer-gate.js",
      "src/workflow/reviewer-provider-health.js",
      "src/workflow/autonomous-continuation.js",
      "src/workflow/workbench-projection.js",
      "src/workflow/model-router.js"
    ],
    questions: [
      "是否会重复调度超时路径？",
      "是否有状态持久化证据？",
      "是否保持只读？",
      "是否能被 continuation 消费？"
    ],
    ...overrides
  });
}

test("reviewer scope split creates bounded shards for oversized requests", () => {
  const plan = createReviewerScopeSplitPlan({
    request: reviewerRequest(),
    profile: "process_guard",
    created_at: "2026-05-21T20:20:00.000Z"
  });

  assert.equal(plan.status, "pass");
  assert.equal(plan.split_required, true);
  assert.equal(plan.shard_count, 4);
  assert.ok(plan.shards.every((shard) => shard.files.length <= 3));
  assert.ok(plan.shards.every((shard) => shard.questions.length <= 3));
  assert.ok(plan.shards.every((shard) => shard.prompt_chars <= 2200));
  assert.deepEqual(plan.shards[0].allowed_tools, ["read", "grep", "glob"]);
});

test("reviewer scope split can produce no-tool shards after tool-path timeout", () => {
  const plan = createReviewerScopeSplitPlan({
    request: reviewerRequest({
      files: ["src/workflow/model-router.js", "src/workflow/llm-reviewer-gate.js"],
      questions: ["工具路径超时后是否拆小？"]
    }),
    mode: "tool_timeout_recovery",
    no_tools: true
  });

  assert.equal(plan.status, "pass");
  assert.equal(plan.split_required, true);
  assert.equal(plan.shard_count, 2);
  assert.equal(plan.effective_scope_limits.max_files, 1);
  assert.ok(plan.shards.every((shard) => shard.dispatch_mode === "no_tools"));
  assert.ok(plan.shards.every((shard) => shard.allowed_tools.length === 0));
  assert.ok(plan.shards.every((shard) => shard.files.length === 1));
});

test("reviewer scope split marks long prompts as prompt-split required", () => {
  const plan = createReviewerScopeSplitFact({
    request: reviewerRequest({
      files: ["src/workflow/llm-reviewer-gate.js"],
      questions: ["长 prompt 是否被拆分？"]
    }),
    profile: "quick",
    prompt: "x".repeat(4000)
  });

  assert.equal(plan.status, "pass");
  assert.equal(plan.prompt_split_required, true);
  assert.equal(plan.shard_count, 3);
  assert.deepEqual(plan.shard_ids, ["reviewer-scope-shard-001", "reviewer-scope-shard-002", "reviewer-scope-shard-003"]);
  assert.ok(plan.shards.every((shard) => shard.prompt_chars <= 1600));
});

test("reviewer scope split persistence writes manifest event and artifact ledger", () => {
  const recorded = recordReviewerScopeSplitPlan(workflowState(), {
    request: reviewerRequest(),
    profile: "process_guard",
    created_at: "2026-05-21T20:25:00.000Z"
  });

  assert.equal(recorded.status, "pass");
  assert.equal(recorded.workflow_state.manifest.events.at(-1).type, "reviewer_scope_split");
  assert.equal(recorded.workflow_state.manifest.events.at(-1).status, "planned");
  assert.equal(recorded.workflow_state.artifact_ledger.artifacts.at(-1).producer, "reviewer-scope-splitter");
  assert.equal(recorded.workflow_state.artifact_ledger.artifacts.at(-1).metadata.shard_count, 4);

  const second = recordReviewerScopeSplitPlan(recorded.workflow_state, {
    request: reviewerRequest({ files: ["src/workflow/llm-reviewer-gate.js"], questions: ["是否在边界内？"] }),
    created_at: "2026-05-21T20:26:00.000Z"
  });

  assert.equal(second.status, "pass");
  assert.notEqual(second.workflow_state.manifest.events.at(-1).artifact_id, recorded.workflow_state.manifest.events.at(-1).artifact_id);
  assert.match(second.workflow_state.manifest.events.at(-1).artifact_id, /-002$/);
});

test("reviewer scope split persistence fails closed on workflow identity mismatch", () => {
  const state = workflowState();
  const result = recordReviewerScopeSplitPlan({
    ...state,
    artifact_ledger: {
      ...state.artifact_ledger,
      cycle_id: "wrong-cycle"
    }
  }, {
    request: reviewerRequest()
  });

  assert.equal(result.status, "fail");
  assert.ok(result.issues.some((item) => item.code === "workflow_state_cycle_mismatch"));
  assert.equal(result.workflow_state, undefined);
});
