import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizePath(value) {
  const text = normalizeString(value);
  return text ? resolve(text) : "";
}

function issue(code, message, path) {
  return { code, message, path };
}

export function isSameOrInsideExecutionPath(candidatePath, rootPath) {
  const candidate = normalizePath(candidatePath);
  const root = normalizePath(rootPath);
  if (!candidate || !root) return false;
  const pathToCandidate = relative(root, candidate);
  return pathToCandidate === "" || Boolean(pathToCandidate && !pathToCandidate.startsWith("..") && !isAbsolute(pathToCandidate));
}

export function readContextWorkspacePorcelain(cwd = "", options = {}) {
  if (typeof options.gitStatusProvider === "function") {
    return normalizeString(options.gitStatusProvider({ cwd }));
  }
  if (typeof options.git_status_provider === "function") {
    return normalizeString(options.git_status_provider({ cwd }));
  }
  const root = normalizePath(cwd || process.cwd());
  const result = spawnSync("git", ["-C", root, "status", "--short", "--untracked-files=all"], {
    encoding: "utf8",
    timeout: 10000
  });
  if (result.status !== 0) return "";
  return normalizeString(result.stdout);
}

export function contextWorkPackageRequiresCodeOutput(workPackage = {}) {
  const action = normalizeString(workPackage.action || workPackage.type).toLowerCase();
  const title = normalizeString(workPackage.title || workPackage.reason).toLowerCase();
  if (action === "execute_requirement_plan_step") return true;
  if (/implement|implementation|repair|fix|code|generate|write|modify|refactor/.test(action)) return true;
  if (/实施|修复|代码|生成|修改|重构|实现/.test(title)) return true;
  return false;
}

export function isContextWorkerWorktree(cwd = "", options = {}) {
  const executionCwd = normalizePath(cwd);
  const primary = normalizePath(
    options.primary_worktree_path ||
    options.primaryWorktreePath ||
    process.env.AI_CONTROL_PLATFORM_PRIMARY_WORKTREE ||
    "/Users/hernando_zhao/codex/projects/ai-control-platform"
  );
  if (!executionCwd) return false;
  if (executionCwd.split(/[\\/]+/).includes("worker-workspaces")) return true;
  return primary && !isSameOrInsideExecutionPath(executionCwd, primary);
}

export function contextExecutionCwdFromOptions(options = {}) {
  return normalizePath(options.execution_cwd || options.executionCwd || options.cwd || process.cwd());
}

export function contextWorkspaceMutationBlocked(beforePorcelain, afterPorcelain) {
  return normalizeString(beforePorcelain) !== normalizeString(afterPorcelain);
}

export function evaluateContextExecutionScope(selected = [], options = {}) {
  const executionCwd = contextExecutionCwdFromOptions(options);
  const requiresCodeOutput = selected.some(contextWorkPackageRequiresCodeOutput);
  if (requiresCodeOutput && !isContextWorkerWorktree(executionCwd, options)) {
    return {
      status: "blocked",
      phase: "execution_worktree_isolation",
      issues: [
        issue(
          "code_output_requires_isolated_worktree",
          "code-output context work packages must execute in an isolated worker worktree, not the primary platform worktree",
          "execution_cwd"
        )
      ],
      execution_cwd: executionCwd,
      requires_code_output: requiresCodeOutput,
      workspace_porcelain_before: null,
      allows_work_package_completion: false,
      completion_authority: {
        allows_work_package_completion: false,
        authority: "worktree_isolation",
        evidence_kind: "pre_dispatch_gate",
        reason: "implementation work packages require isolated worker worktree execution"
      }
    };
  }

  return {
    status: "pass",
    phase: "execution_scope",
    issues: [],
    execution_cwd: executionCwd,
    requires_code_output: requiresCodeOutput,
    workspace_porcelain_before: requiresCodeOutput || options.skip_workspace_mutation_check === true
      ? null
      : readContextWorkspacePorcelain(executionCwd, options)
  };
}

export function evaluateContextWorkspaceMutation(options = {}) {
  if (options.requires_code_output === true || options.skip_workspace_mutation_check === true) {
    return {
      status: "pass",
      phase: "workspace_mutation_guard",
      issues: [],
      workspace_mutation: null
    };
  }

  const before = options.workspace_porcelain_before ?? null;
  const after = options.workspace_porcelain_after ?? readContextWorkspacePorcelain(options.execution_cwd, options);
  if (!contextWorkspaceMutationBlocked(before, after)) {
    return {
      status: "pass",
      phase: "workspace_mutation_guard",
      issues: [],
      workspace_mutation: {
        before,
        after
      }
    };
  }

  return {
    status: "blocked",
    phase: "workspace_mutation_guard",
    issues: [
      issue(
        "unexpected_workspace_mutation",
        "no-code context work package execution changed the git worktree",
        "git.status"
      )
    ],
    workspace_mutation: {
      before,
      after
    },
    allows_work_package_completion: false,
    completion_authority: {
      allows_work_package_completion: false,
      authority: "workspace_mutation_guard",
      evidence_kind: "unexpected_workspace_mutation",
      reason: "no-code execution cannot complete after mutating the worktree"
    }
  };
}
