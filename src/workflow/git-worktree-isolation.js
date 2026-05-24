import { isAbsolute, relative, resolve } from "node:path";

export const GIT_WORKTREE_ISOLATION_GATE_ID = "git-worktree-isolation";
export const CHILD_WORKER_ROLE = "child_worker";

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeToken(value) {
  return normalizeString(value).toLowerCase().replace(/[\s-]+/g, "_");
}

function normalizePath(value) {
  const text = normalizeString(value);
  return text ? resolve(text) : "";
}

function dirtyEntriesFromPorcelain(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

function issue(code, message, path) {
  return { code, message, path, gate_id: GIT_WORKTREE_ISOLATION_GATE_ID };
}

function isSameOrInsidePath(candidatePath, rootPath) {
  const candidate = normalizePath(candidatePath);
  const root = normalizePath(rootPath);
  if (!candidate || !root) return false;
  const pathToCandidate = relative(root, candidate);
  return pathToCandidate === "" || Boolean(pathToCandidate && !pathToCandidate.startsWith("..") && !isAbsolute(pathToCandidate));
}

function pathContainsSegment(candidatePath, segment) {
  const normalizedSegment = normalizeString(segment);
  if (!normalizedSegment) return false;
  return normalizePath(candidatePath).split(/[\\/]+/).includes(normalizedSegment);
}

function worktreePath(input, ...keys) {
  for (const key of keys) {
    const value = input[key];
    if (normalizeString(value)) return normalizePath(value);
  }
  return "";
}

export function evaluateGitWorktreeIsolation(input = {}) {
  const branch = normalizeString(input.branch);
  const dirtyEntries = dirtyEntriesFromPorcelain(input.porcelain || input.status || "");
  const allowDirtyMain = input.allow_dirty_main === true || input.allowDirtyMain === true;
  const role = normalizeToken(input.execution_role || input.executionRole || input.role);
  const currentWorktreePath = worktreePath(input, "current_worktree_path", "currentWorktreePath", "worktree_path", "worktreePath", "cwd");
  const primaryWorktreePath = worktreePath(input, "primary_worktree_path", "primaryWorktreePath", "main_worktree_path", "mainWorktreePath");
  const workerWorkspacesRoot = worktreePath(input, "worker_workspaces_root", "workerWorkspacesRoot", "worker_workspace_root", "workerWorkspaceRoot");
  const issues = [];
  const warnings = [];

  if (!branch) {
    issues.push(issue("git_branch_unknown", "git branch must be known before closeout", "branch"));
  }
  if (branch === "main" && dirtyEntries.length > 0 && !allowDirtyMain) {
    issues.push(issue(
      "dirty_main_worktree_not_allowed",
      "main branch must stay clean; bounded implementation work must run in an isolated worktree or non-main branch",
      "porcelain"
    ));
  }
  if (role === CHILD_WORKER_ROLE) {
    if (!currentWorktreePath) {
      issues.push(issue("child_worker_worktree_unknown", "child_worker execution must declare the current git worktree path", "current_worktree_path"));
    }
    if (!primaryWorktreePath) {
      issues.push(issue("primary_worktree_unknown", "child_worker execution must know the primary platform worktree path before implementation", "primary_worktree_path"));
    }
    if (currentWorktreePath && primaryWorktreePath && isSameOrInsidePath(currentWorktreePath, primaryWorktreePath)) {
      issues.push(issue(
        "child_worker_primary_worktree_not_allowed",
        "child_worker implementation must run in an isolated worker worktree, not the primary platform worktree",
        "current_worktree_path"
      ));
    }
    if (
      currentWorktreePath &&
      primaryWorktreePath &&
      !isSameOrInsidePath(currentWorktreePath, primaryWorktreePath) &&
      (
        (workerWorkspacesRoot && !isSameOrInsidePath(currentWorktreePath, workerWorkspacesRoot)) ||
        (!workerWorkspacesRoot && !pathContainsSegment(currentWorktreePath, "worker-workspaces"))
      )
    ) {
      warnings.push(issue(
        "child_worker_worktree_outside_preferred_worker_workspaces",
        "child_worker worktree is outside the primary worktree but not under the preferred worker-workspaces root",
        "current_worktree_path"
      ));
    }
  }

  return {
    gate_id: GIT_WORKTREE_ISOLATION_GATE_ID,
    status: issues.length > 0 ? "fail" : "pass",
    role,
    branch,
    current_worktree_path: currentWorktreePath,
    primary_worktree_path: primaryWorktreePath,
    worker_workspaces_root: workerWorkspacesRoot,
    worker_workspace_aligned: Boolean(
      currentWorktreePath &&
        (
          (workerWorkspacesRoot && isSameOrInsidePath(currentWorktreePath, workerWorkspacesRoot)) ||
          (!workerWorkspacesRoot && pathContainsSegment(currentWorktreePath, "worker-workspaces"))
        )
    ),
    dirty_count: dirtyEntries.length,
    dirty_entries: dirtyEntries.slice(0, 20),
    issues,
    warnings
  };
}
