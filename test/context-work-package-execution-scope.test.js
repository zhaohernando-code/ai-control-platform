import assert from "node:assert/strict";
import test from "node:test";

import {
  contextWorkPackageRequiresCodeOutput,
  evaluateContextExecutionScope,
  evaluateContextWorkspaceMutation,
  isContextWorkerWorktree,
  isSameOrInsideExecutionPath
} from "../src/workflow/context-work-package-execution-scope.js";

test("context execution scope identifies code-output work packages", () => {
  assert.equal(contextWorkPackageRequiresCodeOutput({ action: "execute_requirement_plan_step" }), true);
  assert.equal(contextWorkPackageRequiresCodeOutput({ action: "repair" }), true);
  assert.equal(contextWorkPackageRequiresCodeOutput({ title: "实施源码调整" }), true);
  assert.equal(contextWorkPackageRequiresCodeOutput({ action: "summarize_status", title: "Read projection" }), false);
  assert.equal(contextWorkPackageRequiresCodeOutput({ action: "continue_global_goal" }), false);
  assert.equal(contextWorkPackageRequiresCodeOutput({ action: "retry_agent_worker" }), false);
});

test("context execution scope blocks code output in the primary worktree", () => {
  const result = evaluateContextExecutionScope([{
    id: "runtime",
    action: "execute_requirement_plan_step"
  }], {
    execution_cwd: "/repo/ai-control-platform",
    primary_worktree_path: "/repo/ai-control-platform"
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.phase, "execution_worktree_isolation");
  assert.ok(result.issues.some((issue) => issue.code === "code_output_requires_isolated_worktree"));
  assert.equal(result.completion_authority.allows_work_package_completion, false);
});

test("context execution scope allows isolated worker worktrees and sibling task worktrees", () => {
  assert.equal(isContextWorkerWorktree("/repo/worker-workspaces/ai-control-platform/task-1", {
    primary_worktree_path: "/repo/ai-control-platform"
  }), true);
  assert.equal(isContextWorkerWorktree("/repo/task-worktrees/ai-control-platform/task-1", {
    primary_worktree_path: "/repo/ai-control-platform"
  }), true);
  assert.equal(isContextWorkerWorktree("/repo/ai-control-platform/subdir", {
    primary_worktree_path: "/repo/ai-control-platform"
  }), false);
});

test("context execution scope snapshots no-code workspace state", () => {
  const result = evaluateContextExecutionScope([{ id: "status", action: "summarize_status" }], {
    execution_cwd: "/repo/ai-control-platform",
    gitStatusProvider: () => " M docs/status.md\n"
  });

  assert.equal(result.status, "pass");
  assert.equal(result.requires_code_output, false);
  assert.equal(result.workspace_porcelain_before, "M docs/status.md");
});

test("context workspace mutation guard fails closed for no-code mutations", () => {
  const result = evaluateContextWorkspaceMutation({
    execution_cwd: "/repo/ai-control-platform",
    requires_code_output: false,
    workspace_porcelain_before: "",
    gitStatusProvider: () => " M docs/status.md\n"
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.phase, "workspace_mutation_guard");
  assert.ok(result.issues.some((issue) => issue.code === "unexpected_workspace_mutation"));
  assert.equal(result.completion_authority.allows_work_package_completion, false);
});

test("context workspace mutation guard skips code-output and explicit skip cases", () => {
  assert.equal(evaluateContextWorkspaceMutation({
    requires_code_output: true,
    workspace_porcelain_before: "",
    gitStatusProvider: () => " M src/workflow/file.js\n"
  }).status, "pass");
  assert.equal(evaluateContextWorkspaceMutation({
    skip_workspace_mutation_check: true,
    workspace_porcelain_before: "",
    gitStatusProvider: () => " M docs/status.md\n"
  }).status, "pass");
});

test("isSameOrInsideExecutionPath rejects sibling and parent escapes", () => {
  assert.equal(isSameOrInsideExecutionPath("/repo/ai-control-platform/src/file.js", "/repo/ai-control-platform"), true);
  assert.equal(isSameOrInsideExecutionPath("/repo/ai-control-platform", "/repo/ai-control-platform"), true);
  assert.equal(isSameOrInsideExecutionPath("/repo/ai-control-platform-other/src/file.js", "/repo/ai-control-platform"), false);
  assert.equal(isSameOrInsideExecutionPath("/repo/outside/file.js", "/repo/ai-control-platform"), false);
});
