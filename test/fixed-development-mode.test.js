import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { evaluateFixedDevelopmentModeGate } from "../src/workflow/fixed-development-mode-gate.js";
import { evaluateGitWorktreeIsolation } from "../src/workflow/git-worktree-isolation.js";

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function requireAll(text, path, snippets) {
  for (const snippet of snippets) {
    assert.match(text, snippet, `${path} should include ${snippet}`);
  }
}

test("fixed development mode docs preserve main/child roles and recovery rules", () => {
  const requiredDocs = {
    "AGENTS.md": [
      /主进程负责目标判断/,
      /子进程只负责/,
      /每个子进程完成后必须自评/,
      /上下文压缩/,
      /durable 状态/,
      /workbench continuation/,
      /禁止主进程绕过 Context Pack/,
      /runtime gate/
    ],
    "PROCESS.md": [
      /固定开发模式持久化/,
      /标准职责不可反转/,
      /每个子进程必须自评/,
      /不合格先改流程\/gate/,
      /恢复必须从 durable 状态开始/,
      /全局不跑偏/,
      /多模型协同必须可审计/,
      /runtime gate/
    ],
    "PROJECT_RULES.md": [
      /固定开发模式执行/,
      /主进程负责目标判断/,
      /子进程只负责/,
      /上下文压缩/,
      /workbench continuation/,
      /model routing plan/,
      /runtime gate/
    ],
    "docs/contracts/AUTONOMOUS_DEVELOPMENT_FLOW_CN.md": [
      /固定职责/,
      /子进程负责受限实现/,
      /子进程是否给出跑偏评估/,
      /压缩恢复和禁止事项/,
      /禁止主进程绕过调度\/验收闭环/,
      /pending global goals/,
      /runtime gate/
    ]
  };

  for (const [path, snippets] of Object.entries(requiredDocs)) {
    requireAll(read(path), path, snippets);
  }
});

test("process hardening fixture records direct implementation drift as completed hardening", () => {
  const input = JSON.parse(read("docs/examples/process-hardening-current.json"));
  const finding = input.review_findings.find((item) => item.id === "main-process-direct-implementation-drift");
  const hardening = input.hardening_items.find((item) => item.finding_id === "main-process-direct-implementation-drift");

  assert.equal(finding?.category, "process_gap");
  assert.equal(finding?.severity, "p1");
  assert.match(finding?.message || "", /Main process direct implementation/);

  assert.equal(hardening?.status, "completed");
  assert.match(hardening?.enforcement_target || "", /AGENTS\.md/);
  assert.match(hardening?.enforcement_target || "", /src\/workflow\/fixed-development-mode-gate\.js/);
  assert.match(hardening?.enforcement_target || "", /src\/workflow\/context-work-package-runner\.js/);
  assert.match(hardening?.enforcement_target || "", /test\/context-work-package-runner\.test\.js/);
  assert.match(hardening?.enforcement_target || "", /test\/fixed-development-mode\.test\.js/);
  assert.match(hardening?.verification || "", /npm run check:process-hardening/);
});

test("project status keeps fixed development mode on the current next work", () => {
  const status = JSON.parse(read("PROJECT_STATUS.json"));

  assert.match(status.latest_update, /Fixed development mode/);
  assert.match(status.latest_update, /main process/);
  assert.match(status.latest_update, /child processes/);
  if (status.status === "complete") {
    assert.equal(status.next_step, "");
    return;
  }
  const currentWork = [status.latest_update, status.next_step].join("\n");
  assert.match(currentWork, /fixed main-process\/child-process loop|Fixed development mode/);
  assert.match(currentWork, /agent lifecycle|bounded child processes/);
  assert.match(currentWork, /fact recording|evaluates bounded child processes/);
  assert.match(currentWork, /cleanup execution|instead of treating implementation edits as success/);
  assert.match(currentWork, /spawned child processes|child processes/);
});

test("fixed development mode runtime gate evaluates dispatch inputs", () => {
  const pass = evaluateFixedDevelopmentModeGate({
    manifest: {
      context_pack: {
        host: "platform_core",
        target_project_id: "ai-control-platform",
        owned_files: ["src/workflow/context-work-package-runner.js"],
        subtasks: [{ id: "runtime", owned_files: ["src/workflow/context-work-package-runner.js"] }]
      },
      work_packages: []
    },
    selected_work_packages: [{ id: "runtime", owned_files: ["src/workflow/context-work-package-runner.js"] }]
  });

  assert.equal(pass.status, "pass");
  assert.equal(pass.gate_id, "fixed-development-mode-dispatch");
  assert.equal(pass.checked_work_package_count, 1);

  const fail = evaluateFixedDevelopmentModeGate({
    manifest: {
      context_pack: {
        host: "managed_project",
        target_project_id: "stock_dashboard",
        owned_files: ["../stock_dashboard/src/foo.js"],
        subtasks: [{ id: "runtime", owned_files: ["../stock_dashboard/src/foo.js"] }]
      },
      work_packages: []
    },
    selected_work_packages: [{ id: "runtime", owned_files: ["../stock_dashboard/src/foo.js"] }]
  });

  assert.equal(fail.status, "fail");
  assert.ok(fail.issues.some((item) => item.code === "fixed_mode_host_not_platform_core"));
  assert.ok(fail.issues.some((item) => item.code === "fixed_mode_target_not_platform"));
  assert.ok(fail.issues.some((item) => item.code === "fixed_mode_managed_project_owned_file"));
});

test("fixed development mode runtime gate checks all declared owned file sources", () => {
  const result = evaluateFixedDevelopmentModeGate({
    manifest: {
      context_pack: {
        host: "platform_core",
        target_project_id: "ai-control-platform",
        owned_files: ["../stock_dashboard/src/root.js", "src/workflow/context-work-package-runner.js"],
        subtasks: [
          {
            id: "runtime",
            owned_files: ["../stock_dashboard/src/subtask.js", "src/workflow/context-work-package-runner.js"]
          }
        ]
      },
      work_packages: []
    },
    selected_work_packages: [{ id: "runtime", owned_files: ["src/workflow/context-work-package-runner.js"] }]
  });

  assert.equal(result.status, "fail");
  assert.ok(result.issues.some((item) => item.code === "fixed_mode_context_managed_project_owned_file"));
  assert.ok(result.issues.some((item) => item.code === "fixed_mode_subtask_managed_project_owned_file"));
  assert.ok(!result.issues.some((item) => item.code === "fixed_mode_managed_project_owned_file"));
});

test("git worktree isolation blocks dirty main but allows isolated branch work", () => {
  const dirtyMain = evaluateGitWorktreeIsolation({
    branch: "main",
    porcelain: " M src/workflow/example.js\n?? test/example.test.js\n"
  });
  assert.equal(dirtyMain.status, "fail");
  assert.equal(dirtyMain.dirty_count, 2);
  assert.ok(dirtyMain.issues.some((item) => item.code === "dirty_main_worktree_not_allowed"));

  const dirtyWorkBranch = evaluateGitWorktreeIsolation({
    branch: "work/frontend-gate",
    porcelain: " M src/workflow/example.js\n"
  });
  assert.equal(dirtyWorkBranch.status, "pass");
  assert.equal(dirtyWorkBranch.dirty_count, 1);

  const cleanMain = evaluateGitWorktreeIsolation({ branch: "main", porcelain: "" });
  assert.equal(cleanMain.status, "pass");
});

test("git worktree isolation is role aware for child worker execution", () => {
  const primaryWorktree = "/repo/ai-control-platform";
  const workerRoot = "/repo/worker-workspaces";

  const childInPrimaryWorktree = evaluateGitWorktreeIsolation({
    role: "child_worker",
    branch: "work/integration-closeout",
    porcelain: " M src/workflow/git-worktree-isolation.js\n",
    current_worktree_path: primaryWorktree,
    primary_worktree_path: primaryWorktree,
    worker_workspaces_root: workerRoot
  });
  assert.equal(childInPrimaryWorktree.status, "fail");
  assert.ok(childInPrimaryWorktree.issues.some((item) => item.code === "child_worker_primary_worktree_not_allowed"));

  const childInWorkerWorktree = evaluateGitWorktreeIsolation({
    execution_role: "child_worker",
    branch: "task/ai-control-platform/role-gate",
    porcelain: " M src/workflow/git-worktree-isolation.js\n",
    current_worktree_path: "/repo/worker-workspaces/ai-control-platform/role-gate",
    primary_worktree_path: primaryWorktree,
    worker_workspaces_root: workerRoot
  });
  assert.equal(childInWorkerWorktree.status, "pass");
  assert.equal(childInWorkerWorktree.worker_workspace_aligned, true);

  const childWithoutKnownPrimary = evaluateGitWorktreeIsolation({
    role: "child_worker",
    branch: "task/ai-control-platform/role-gate",
    porcelain: "",
    current_worktree_path: "/repo/worker-workspaces/ai-control-platform/role-gate"
  });
  assert.equal(childWithoutKnownPrimary.status, "fail");
  assert.ok(childWithoutKnownPrimary.issues.some((item) => item.code === "primary_worktree_unknown"));

  const integrationInPrimaryWorktree = evaluateGitWorktreeIsolation({
    role: "main_orchestrator",
    branch: "work/integration-closeout",
    porcelain: " M PROCESS.md\n",
    current_worktree_path: primaryWorktree,
    primary_worktree_path: primaryWorktree,
    worker_workspaces_root: workerRoot
  });
  assert.equal(integrationInPrimaryWorktree.status, "pass");
});
