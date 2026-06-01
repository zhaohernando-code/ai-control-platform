import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function parseTime(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : NaN;
}

function nowDate(value) {
  return value instanceof Date ? value : new Date(value || Date.now());
}

function lockFile(lockPath) {
  return join(lockPath, "lock.json");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function lockAgeMs(lock, now) {
  const acquiredAt = parseTime(lock?.acquired_at);
  if (!Number.isFinite(acquiredAt)) return Infinity;
  return now.getTime() - acquiredAt;
}

export function inspectRiskCloseoutLock(lockPath, options = {}) {
  const now = nowDate(options.now);
  const staleAfterMs = Number.isFinite(options.staleAfterMs) ? options.staleAfterMs : 60 * 60 * 1000;
  if (!existsSync(lockPath)) {
    return {
      status: "unlocked",
      stale: false,
      lock: null
    };
  }
  let lock = null;
  try {
    lock = readJson(lockFile(lockPath));
  } catch (error) {
    return {
      status: "invalid",
      stale: true,
      lock: null,
      issues: [{ code: "lock_unreadable", message: error.message, path: lockFile(lockPath) }]
    };
  }
  const stale = lockAgeMs(lock, now) > staleAfterMs;
  return {
    status: stale ? "stale" : "locked",
    stale,
    lock
  };
}

export function acquireRiskCloseoutLock(lockPath, metadata = {}, options = {}) {
  const now = nowDate(options.now);
  const inspected = inspectRiskCloseoutLock(lockPath, options);
  if (inspected.status === "locked") {
    return {
      status: "locked",
      acquired: false,
      lock: inspected.lock,
      issues: [{ code: "risk_closeout_lock_held", message: "another risk closeout run holds the lock", path: lockPath }]
    };
  }
  if (inspected.status === "stale" || inspected.status === "invalid") {
    return {
      status: inspected.status,
      acquired: false,
      lock: inspected.lock,
      issues: [{ code: "risk_closeout_lock_stale", message: "stale lock requires recovery before a new run", path: lockPath }]
    };
  }
  mkdirSync(lockPath, { recursive: false });
  const lock = {
    version: "risk-closeout-lock.v1",
    run_id: metadata.run_id || `risk-closeout-${now.toISOString()}`,
    owner: metadata.owner || "unknown",
    branch: metadata.branch || null,
    worktree_path: metadata.worktree_path || null,
    acquired_at: now.toISOString()
  };
  writeJson(lockFile(lockPath), lock);
  return {
    status: "acquired",
    acquired: true,
    lock,
    issues: []
  };
}

export function releaseRiskCloseoutLock(lockPath, runId) {
  const inspected = inspectRiskCloseoutLock(lockPath);
  if (inspected.status === "unlocked") {
    return { status: "unlocked", released: false, issues: [] };
  }
  if (inspected.status === "invalid") {
    return { status: "invalid", released: false, issues: inspected.issues };
  }
  if (nonEmptyString(runId) && inspected.lock?.run_id !== runId) {
    return {
      status: "mismatch",
      released: false,
      issues: [{ code: "risk_closeout_lock_run_mismatch", message: "lock run_id does not match release request", path: lockPath }]
    };
  }
  rmSync(lockPath, { recursive: true, force: true });
  return { status: "released", released: true, issues: [] };
}

export function staleInProgressRiskActions(ledger, options = {}) {
  const now = nowDate(options.now);
  const staleAfterMs = Number.isFinite(options.staleAfterMs) ? options.staleAfterMs : 24 * 60 * 60 * 1000;
  return asArray(ledger?.risks)
    .filter((risk) => isObject(risk) && risk.status === "in_progress")
    .map((risk) => {
      const updatedAt = parseTime(risk.updated_at);
      const stale = !Number.isFinite(updatedAt) || now.getTime() - updatedAt > staleAfterMs;
      return {
        risk_id: risk.id,
        stale,
        action: stale ? "resume_or_mark_blocked" : "keep_running",
        last_agent_run_id: risk.last_agent_run_id || null,
        updated_at: risk.updated_at || null
      };
    })
    .filter((action) => options.includeFresh === true || action.stale);
}

export function blockedStateForStaleRisk(risk, options = {}) {
  if (!isObject(risk)) return null;
  const now = nowDate(options.now);
  return {
    ...risk,
    status: "blocked",
    updated_at: now.toISOString(),
    blockage: {
      blocker_description: options.blocker_description || "stale in_progress risk requires recovery before closeout can continue",
      blocker_owner: options.blocker_owner || "risk-closeout-runner",
      recovery_conditions: asArray(options.recovery_conditions).length > 0
        ? options.recovery_conditions
        : [
            "inspect last_agent_run_id and worktree status",
            "resume the run or create a new bounded repair attempt"
          ],
      last_condition_check: now.toISOString(),
      condition_met: false
    },
    evidence: [
      ...asArray(risk.evidence),
      {
        type: "analysis",
        summary: "Risk was stale in_progress and was marked blocked for recovery.",
        created_at: now.toISOString()
      }
    ]
  };
}

export function parseGitWorktreePorcelain(text) {
  const worktrees = [];
  let current = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) worktrees.push(current);
      current = { path: line.slice("worktree ".length), branch: null, head: null, detached: false };
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (current && line === "detached") {
      current.detached = true;
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

export function closeoutWorktreeReport(worktrees, options = {}) {
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : 7 * 24 * 60 * 60 * 1000;
  const now = nowDate(options.now);
  const closeoutSlugs = asArray(options.closeoutSlugs).length > 0
    ? options.closeoutSlugs
    : ["risk-closeout", "risk-policy", "risk-reviewer", "known-risk"];
  return asArray(worktrees)
    .filter((worktree) => {
      const haystack = `${worktree.path || ""} ${worktree.branch || ""}`.toLowerCase();
      return closeoutSlugs.some((slug) => haystack.includes(slug));
    })
    .map((worktree) => {
      const createdAt = parseTime(worktree.created_at);
      const old = Number.isFinite(createdAt) && now.getTime() - createdAt > maxAgeMs;
      return {
        ...worktree,
        old,
        cleanup_candidate: old || worktree.merged === true,
        reason: worktree.merged === true ? "merged" : (old ? "older_than_policy" : "active_or_recent")
      };
    });
}

export function cleanupDecisionForRun(run = {}, options = {}) {
  if (run.success === true && run.artifacts_preserved === true && run.lock_released !== false) {
    return {
      action: "remove_worktree",
      preserve: false,
      reason: "successful run has preserved artifacts and released lock"
    };
  }
  if (run.success === true && run.artifacts_preserved !== true) {
    return {
      action: "preserve_worktree",
      preserve: true,
      reason: "successful run still lacks preserved artifacts"
    };
  }
  if (options.forceCleanup === true && run.artifacts_preserved === true) {
    return {
      action: "remove_worktree",
      preserve: false,
      reason: "forced cleanup after preserving failure evidence"
    };
  }
  return {
    action: "preserve_worktree",
    preserve: true,
    reason: "failed or incomplete run worktree is needed for recovery evidence"
  };
}
