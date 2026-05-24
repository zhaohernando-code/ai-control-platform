export const GIT_WORKTREE_ISOLATION_GATE_ID = "git-worktree-isolation";

function normalizeString(value) {
  return String(value || "").trim();
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

export function evaluateGitWorktreeIsolation(input = {}) {
  const branch = normalizeString(input.branch);
  const dirtyEntries = dirtyEntriesFromPorcelain(input.porcelain || input.status || "");
  const allowDirtyMain = input.allow_dirty_main === true || input.allowDirtyMain === true;
  const issues = [];

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

  return {
    gate_id: GIT_WORKTREE_ISOLATION_GATE_ID,
    status: issues.length > 0 ? "fail" : "pass",
    branch,
    dirty_count: dirtyEntries.length,
    dirty_entries: dirtyEntries.slice(0, 20),
    issues
  };
}
