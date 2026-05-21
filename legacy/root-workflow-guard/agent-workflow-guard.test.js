"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "agent-workflow-guard.js");
const LOW_NOISE_HOOKS = path.join(__dirname, "codex-hooks.low-noise.json");

function buildRoot() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-workflow-guard-"));
  const platformPath = path.join(rootDir, "projects", "ai-control-platform");
  const projectPath = path.join(rootDir, "projects", "dashboard-ui");
  const stockProjectPath = path.join(rootDir, "projects", "stock_dashboard");
  const chatProjectPath = path.join(rootDir, "projects", "lobechat");
  fs.mkdirSync(platformPath, { recursive: true });
  fs.mkdirSync(projectPath, { recursive: true });
  fs.mkdirSync(stockProjectPath, { recursive: true });
  fs.mkdirSync(chatProjectPath, { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, "WORKSPACE_INDEX.json"),
    `${JSON.stringify({
      workspace_root: rootDir,
      projects: [
        {
          project_id: "ai-control-platform",
          display_name: "AI Control Platform",
          aliases: ["新中台", "中台", "自动化平台", "ops workbench"],
          keywords: ["platform core", "任务编排", "recovery engine", "llm reviewer"],
          repo_path: platformPath,
          project_type: "platform-core",
          canonical_docs: [path.join(platformPath, "PROJECT_STATUS.json")],
        },
        {
          project_id: "dashboard-ui",
          display_name: "Dashboard UI",
          aliases: ["中台看板"],
          keywords: ["control plane"],
          repo_path: projectPath,
          entry_routes: { user: "https://hernando-zhao.cn/middle" },
          canonical_docs: [path.join(projectPath, "PROJECT_STATUS.json")],
        },
        {
          project_id: "stock_dashboard",
          display_name: "Stock Dashboard",
          aliases: ["股票看板", "ashare dashboard", "stock dashboard"],
          keywords: ["stock", "data quality"],
          repo_path: stockProjectPath,
          entry_routes: { user: "https://hernando-zhao.cn/stocks" },
          canonical_docs: [path.join(stockProjectPath, "PROJECT_STATUS.json")],
        },
        {
          project_id: "lobechat",
          display_name: "LobeChat",
          aliases: ["聊天项目", "lobechat"],
          keywords: ["chat"],
          repo_path: chatProjectPath,
          canonical_docs: [path.join(chatProjectPath, "PROJECT_STATUS.json")],
        },
      ],
    }, null, 2)}\n`,
  );
  return { rootDir, projectPath };
}

function runGuard(rootDir, event, payload, agent = "codex") {
  return spawnSync(process.execPath, [SCRIPT, "--agent", agent, "--event", event], {
    cwd: payload.cwd || rootDir,
    input: JSON.stringify({ hook_event_name: event, ...payload }),
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_WORKFLOW_ROOT: rootDir,
    },
  });
}

function runGit(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return String(result.stdout || "").trim();
}

function initializeRepo(projectPath, remotePath) {
  runGit(path.dirname(remotePath), ["init", "--bare", "--initial-branch=main", remotePath]);
  runGit(projectPath, ["init", "--initial-branch=main"]);
  runGit(projectPath, ["config", "user.email", "tester@example.com"]);
  runGit(projectPath, ["config", "user.name", "Tester"]);
  fs.writeFileSync(path.join(projectPath, "README.md"), "base\n");
  fs.writeFileSync(path.join(projectPath, "PROJECT_STATUS.json"), "{}\n");
  runGit(projectPath, ["add", "."]);
  runGit(projectPath, ["commit", "-m", "base"]);
  runGit(projectPath, ["remote", "add", "origin", remotePath]);
  runGit(projectPath, ["push", "-u", "origin", "main"]);
}

test("Codex low-noise hook config avoids all tool lifecycle hooks", () => {
  const config = JSON.parse(fs.readFileSync(LOW_NOISE_HOOKS, "utf8"));
  assert.ok(config.hooks.SessionStart);
  assert.ok(config.hooks.UserPromptSubmit);
  assert.ok(config.hooks.Stop);
  assert.equal(config.hooks.PreToolUse, undefined);
  assert.equal(config.hooks.PostToolUse, undefined);
});

test("PreToolUse blocks canonical checkout mutation", () => {
  const { rootDir, projectPath } = buildRoot();
  try {
    const result = runGuard(rootDir, "PreToolUse", {
      session_id: "canonical",
      cwd: projectPath,
      tool_name: "apply_patch",
      tool_input: { command: "*** Update File: README.md\n" },
    });
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /canonical checkout/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Claude PreToolUse emits blocking JSON with exit code 2", () => {
  const { rootDir, projectPath } = buildRoot();
  try {
    const result = runGuard(rootDir, "PreToolUse", {
      session_id: "claude-canonical",
      cwd: projectPath,
      tool_name: "Write",
      tool_input: { file_path: path.join(projectPath, "README.md") },
    }, "claude");
    assert.equal(result.status, 2);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /canonical checkout/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("PreToolUse allows isolated worker worktree mutation", () => {
  const { rootDir } = buildRoot();
  const worktreePath = path.join(rootDir, "worker-workspaces", "dashboard-ui", "20260503-demo-taskabcd");
  fs.mkdirSync(worktreePath, { recursive: true });
  try {
    const result = runGuard(rootDir, "PreToolUse", {
      session_id: "worktree",
      cwd: worktreePath,
      tool_name: "apply_patch",
      tool_input: { command: "*** Update File: README.md\n" },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("PostToolUse records evidence silently on successful pass", () => {
  const { rootDir } = buildRoot();
  const worktreePath = path.join(rootDir, "worker-workspaces", "dashboard-ui", "20260503-demo-taskabcd");
  fs.mkdirSync(worktreePath, { recursive: true });
  try {
    const result = runGuard(rootDir, "PostToolUse", {
      session_id: "posttool-silent",
      cwd: worktreePath,
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: { stdout: "npm test passed", stderr: "" },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("UserPromptSubmit prefers explicit worktree cwd over noisy prompt route", () => {
  const { rootDir } = buildRoot();
  const worktreePath = path.join(rootDir, ".codex-system", "worktrees", "ashare-dashboard", "20260503-task");
  fs.mkdirSync(worktreePath, { recursive: true });
  try {
    const result = runGuard(rootDir, "UserPromptSubmit", {
      session_id: "route-cwd",
      cwd: worktreePath,
      prompt: "The task brief contains old LobeChat docs, but this worker is already in the stock dashboard worktree.",
    });
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.match(output.hookSpecificOutput.additionalContext, /stock_dashboard/);
    assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /lobechat/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("UserPromptSubmit lets explicit platform-core prompt override stock cwd", () => {
  const { rootDir } = buildRoot();
  const stockWorktreePath = path.join(rootDir, ".codex-system", "worktrees", "stock_dashboard", "20260521-task");
  fs.mkdirSync(stockWorktreePath, { recursive: true });
  try {
    const result = runGuard(rootDir, "UserPromptSubmit", {
      session_id: "route-platform-over-cwd",
      cwd: stockWorktreePath,
      prompt: "建立一个全新的中台仓库，防止跑偏，并实现 Recovery Engine 和 LLM Reviewer 门禁。",
    });
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.match(output.hookSpecificOutput.additionalContext, /ai-control-platform/);
    assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /stock_dashboard/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Stop blocks completion claims without closeout evidence after mutation", () => {
  const { rootDir } = buildRoot();
  const worktreePath = path.join(rootDir, "worker-workspaces", "dashboard-ui", "20260503-demo-taskabcd");
  fs.mkdirSync(worktreePath, { recursive: true });
  try {
    runGuard(rootDir, "PreToolUse", {
      session_id: "closeout",
      cwd: worktreePath,
      tool_name: "apply_patch",
      tool_input: { command: "*** Update File: README.md\n" },
    });
    const result = runGuard(rootDir, "Stop", {
      session_id: "closeout",
      cwd: worktreePath,
      last_assistant_message: "Implemented and verified.",
    });
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.decision, "block");
    assert.match(output.reason, /Workflow closeout gate is incomplete/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Stop catches dirty git state without per-tool mutation hooks", () => {
  const { rootDir, projectPath } = buildRoot();
  const remotePath = path.join(rootDir, "remote.git");
  try {
    initializeRepo(projectPath, remotePath);
    fs.appendFileSync(path.join(projectPath, "README.md"), "dirty change\n");
    const result = runGuard(rootDir, "Stop", {
      session_id: "stop-only-dirty",
      cwd: projectPath,
      last_assistant_message: "Completed.",
    });
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.decision, "block");
    assert.match(output.reason, /commit or intentionally resolve dirty git state/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Stop blocks completion when canonical branch is not pushed to upstream", () => {
  const { rootDir, projectPath } = buildRoot();
  const remotePath = path.join(rootDir, "remote.git");
  const worktreePath = path.join(rootDir, "worker-workspaces", "dashboard-ui", "20260503-demo-taskabcd");
  fs.mkdirSync(worktreePath, { recursive: true });
  try {
    runGit(rootDir, ["init", "--bare", "--initial-branch=main", remotePath]);
    runGit(projectPath, ["init", "--initial-branch=main"]);
    runGit(projectPath, ["config", "user.email", "tester@example.com"]);
    runGit(projectPath, ["config", "user.name", "Tester"]);
    fs.writeFileSync(path.join(projectPath, "README.md"), "base\n");
    runGit(projectPath, ["add", "README.md"]);
    runGit(projectPath, ["commit", "-m", "base"]);
    runGit(projectPath, ["remote", "add", "origin", remotePath]);
    runGit(projectPath, ["push", "-u", "origin", "main"]);
    fs.writeFileSync(path.join(projectPath, "README.md"), "base\nlocal\n");
    runGit(projectPath, ["add", "README.md"]);
    runGit(projectPath, ["commit", "-m", "local-only"]);

    runGuard(rootDir, "PreToolUse", {
      session_id: "unpushed",
      cwd: worktreePath,
      tool_name: "apply_patch",
      tool_input: { command: "*** Update File: PROJECT_STATUS.json\n" },
    });
    for (const command of ["npm test", "browser https://hernando-zhao.cn/middle", "git commit -m closeout", "publish-local-runtime"]) {
      runGuard(rootDir, "PostToolUse", {
        session_id: "unpushed",
        cwd: worktreePath,
        tool_name: "Bash",
        tool_input: { command },
        tool_response: { stdout: command, stderr: "" },
      });
    }
    const result = runGuard(rootDir, "Stop", {
      session_id: "unpushed",
      cwd: worktreePath,
      last_assistant_message: "Implemented, verified, published and merged.",
    });
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.decision, "block");
    assert.match(output.reason, /push\/merge the canonical branch .* to its upstream remote/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Stop blocks completion when task worktree commit is not merged to main", () => {
  const { rootDir, projectPath } = buildRoot();
  const remotePath = path.join(rootDir, "remote.git");
  const worktreePath = path.join(rootDir, "worker-workspaces", "dashboard-ui", "20260504-task-unmerged");
  try {
    runGit(rootDir, ["init", "--bare", "--initial-branch=main", remotePath]);
    runGit(projectPath, ["init", "--initial-branch=main"]);
    runGit(projectPath, ["config", "user.email", "tester@example.com"]);
    runGit(projectPath, ["config", "user.name", "Tester"]);
    fs.writeFileSync(path.join(projectPath, "README.md"), "base\n");
    fs.writeFileSync(path.join(projectPath, "PROJECT_STATUS.json"), "{}\n");
    runGit(projectPath, ["add", "."]);
    runGit(projectPath, ["commit", "-m", "base"]);
    runGit(projectPath, ["remote", "add", "origin", remotePath]);
    runGit(projectPath, ["push", "-u", "origin", "main"]);
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    runGit(projectPath, ["worktree", "add", "-b", "task/dashboard-ui/unmerged", worktreePath]);
    runGit(worktreePath, ["config", "user.email", "tester@example.com"]);
    runGit(worktreePath, ["config", "user.name", "Tester"]);
    fs.writeFileSync(path.join(worktreePath, "README.md"), "base\ntask change\n");
    runGit(worktreePath, ["add", "README.md"]);
    runGit(worktreePath, ["commit", "-m", "task change"]);

    runGuard(rootDir, "PreToolUse", {
      session_id: "unmerged-worktree",
      cwd: worktreePath,
      tool_name: "apply_patch",
      tool_input: { command: "*** Update File: PROJECT_STATUS.json\n" },
    });
    for (const command of ["npm test", "browser https://hernando-zhao.cn/middle", "git commit -m task", "publish-local-runtime"]) {
      runGuard(rootDir, "PostToolUse", {
        session_id: "unmerged-worktree",
        cwd: worktreePath,
        tool_name: "Bash",
        tool_input: { command },
        tool_response: { stdout: command, stderr: "" },
      });
    }
    const result = runGuard(rootDir, "Stop", {
      session_id: "unmerged-worktree",
      cwd: worktreePath,
      last_assistant_message: "Implemented, verified, published, merged, pushed, and completed.",
    });
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.decision, "block");
    assert.match(output.reason, /merge task worktree commit/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Stop checks each mutated project against its own canonical branch", () => {
  const { rootDir } = buildRoot();
  const stockProjectPath = path.join(rootDir, "projects", "stock_dashboard");
  const chatProjectPath = path.join(rootDir, "projects", "lobechat");
  const stockRemotePath = path.join(rootDir, "stock-remote.git");
  const chatRemotePath = path.join(rootDir, "chat-remote.git");
  const stockWorktreePath = path.join(rootDir, "worker-workspaces", "stock_dashboard", "20260505-stock-task");
  const chatWorktreePath = path.join(rootDir, "worker-workspaces", "lobechat", "20260505-chat-task");
  try {
    initializeRepo(stockProjectPath, stockRemotePath);
    initializeRepo(chatProjectPath, chatRemotePath);

    fs.mkdirSync(path.dirname(stockWorktreePath), { recursive: true });
    fs.mkdirSync(path.dirname(chatWorktreePath), { recursive: true });
    runGit(stockProjectPath, ["worktree", "add", "-b", "task/stock_dashboard/multi", stockWorktreePath]);
    runGit(chatProjectPath, ["worktree", "add", "-b", "task/lobechat/multi", chatWorktreePath]);
    for (const worktreePath of [stockWorktreePath, chatWorktreePath]) {
      runGit(worktreePath, ["config", "user.email", "tester@example.com"]);
      runGit(worktreePath, ["config", "user.name", "Tester"]);
      fs.appendFileSync(path.join(worktreePath, "README.md"), "task change\n");
      runGit(worktreePath, ["add", "README.md"]);
      runGit(worktreePath, ["commit", "-m", "task change"]);
    }
    runGit(stockProjectPath, ["merge", "--ff-only", "task/stock_dashboard/multi"]);
    runGit(stockProjectPath, ["push", "origin", "main"]);
    runGit(chatProjectPath, ["merge", "--ff-only", "task/lobechat/multi"]);
    runGit(chatProjectPath, ["push", "origin", "main"]);

    for (const cwd of [stockWorktreePath, chatWorktreePath]) {
      runGuard(rootDir, "PreToolUse", {
        session_id: "multi-project-closeout",
        cwd,
        tool_name: "apply_patch",
        tool_input: { command: "*** Update File: PROJECT_STATUS.json\n" },
      });
    }
    for (const command of ["npm test", "browser https://hernando-zhao.cn/projects/ashare-dashboard/", "git add PROCESS.md && git commit -m docs", "git merge --ff-only task", "git push origin main", "publish-local-runtime"]) {
      runGuard(rootDir, "PostToolUse", {
        session_id: "multi-project-closeout",
        cwd: stockWorktreePath,
        tool_name: "Bash",
        tool_input: { command },
        tool_response: { stdout: command, stderr: "" },
      });
    }
    const result = runGuard(rootDir, "Stop", {
      session_id: "multi-project-closeout",
      cwd: stockWorktreePath,
      last_assistant_message: "Implemented, verified, published, merged, pushed, and completed.",
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
