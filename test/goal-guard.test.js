import assert from "node:assert/strict";
import test from "node:test";

import { assertGoalAlignment, evaluateGoalAlignment } from "../src/workflow/goal-guard.js";

function validInput(overrides = {}) {
  return {
    goal: "为新中台实现平台中立 Task DAG 与 Goal Guard 基座",
    workspace_project_id: "ai-control-platform",
    manifest: {
      project_id: "ai-control-platform",
      project_type: "platform-core"
    },
    context_pack: {
      host: "platform_core",
      target_project_id: "ai-control-platform",
      non_goals: ["不修改 stock_dashboard"],
      forbidden_actions: ["不得写入 legacy/", "不得回退他人改动"]
    },
    changed_files: [
      "src/workflow/task-dag.js",
      "test/task-dag.test.js",
      "src/workflow/goal-guard.js",
      "test/goal-guard.test.js"
    ],
    ...overrides
  };
}

test("goal alignment passes for platform work in ai-control-platform", () => {
  const result = assertGoalAlignment(validInput());

  assert.equal(result.status, "pass");
  assert.equal(result.classification, "platform_core");
});

test("platform goal targeting stock_dashboard fails", () => {
  const result = evaluateGoalAlignment(validInput({ workspace_project_id: "stock_dashboard" }));

  assert.equal(result.status, "fail");
  assert.ok(result.issues.some((issue) => issue.code === "platform_goal_target_mismatch"));
});

test("changed files outside project fail", () => {
  const result = evaluateGoalAlignment(
    validInput({
      changed_files: ["../stock_dashboard/src/workflow/task-dag.js"]
    })
  );

  assert.equal(result.status, "fail");
  assert.ok(result.issues.some((issue) => issue.code === "changed_file_out_of_scope"));
});

test("changed files in another project fail", () => {
  const result = evaluateGoalAlignment(
    validInput({
      changed_files: ["/Users/hernando_zhao/codex/projects/stock_dashboard/src/ashare_evidence/autonomous_flow.py"]
    })
  );

  assert.equal(result.status, "fail");
  assert.ok(result.issues.some((issue) => issue.code === "changed_file_other_project"));
});

test("legacy writes fail", () => {
  const result = evaluateGoalAlignment(
    validInput({
      changed_files: ["legacy/root-workflow-guard/agent-workflow-guard.js"]
    })
  );

  assert.equal(result.status, "fail");
  assert.ok(result.issues.some((issue) => issue.code === "legacy_write_forbidden"));
});

test("non-goals and forbidden actions fail when evidence matches", () => {
  const nonGoalResult = evaluateGoalAlignment(
    validInput({
      changed_files: ["src/workflow/task-dag.js"],
      artifact: {
        summary: "Added stock_dashboard scheduler behavior"
      }
    })
  );

  assert.equal(nonGoalResult.status, "fail");
  assert.ok(nonGoalResult.issues.some((issue) => issue.code === "context_constraint_violation"));

  const forbiddenActionResult = evaluateGoalAlignment(
    validInput({
      changed_files: ["src/workflow/goal-guard.js"],
      artifacts: [{ command: "git reset --hard HEAD" }]
    })
  );

  assert.equal(forbiddenActionResult.status, "fail");
  assert.ok(forbiddenActionResult.issues.some((issue) => issue.code === "context_constraint_violation"));
});
