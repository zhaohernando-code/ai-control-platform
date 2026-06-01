import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  acquireRiskCloseoutLock,
  blockedStateForStaleRisk,
  cleanupDecisionForRun,
  closeoutWorktreeReport,
  inspectRiskCloseoutLock,
  parseGitWorktreePorcelain,
  releaseRiskCloseoutLock,
  staleInProgressRiskActions
} from "../tools/risk-closeout-recovery.mjs";
import { tempDir } from "./helpers/temp-dir.js";

const NOW = new Date("2026-06-01T08:00:00.000Z");

function baseRisk(overrides = {}) {
  return {
    id: "risk-test-stale",
    title: "Stale risk",
    source: "unit-test",
    created_at: "2026-05-30T00:00:00.000Z",
    updated_at: "2026-05-30T00:00:00.000Z",
    status: "in_progress",
    severity: "medium",
    scope: ["tools/example.mjs"],
    owned_files: ["tools/example.mjs"],
    acceptance_gates: ["node --test test/example.test.js"],
    attempted_count: 1,
    last_agent_run_id: "run-old",
    evidence: [{ type: "analysis", summary: "started" }],
    ...overrides
  };
}

test("run lock rejects concurrent closeout runs and releases by run id", (t) => {
  const dir = tempDir(t, "risk-closeout-lock-");
  const lockPath = join(dir, "closeout.lock");

  const acquired = acquireRiskCloseoutLock(lockPath, {
    run_id: "run-1",
    owner: "unit-test",
    branch: "task/risk-closeout",
    worktree_path: "/tmp/worktree"
  }, { now: NOW });
  const blocked = acquireRiskCloseoutLock(lockPath, { run_id: "run-2" }, { now: NOW });
  const wrongRelease = releaseRiskCloseoutLock(lockPath, "run-2");
  const released = releaseRiskCloseoutLock(lockPath, "run-1");

  assert.equal(acquired.status, "acquired");
  assert.equal(blocked.status, "locked");
  assert.equal(blocked.acquired, false);
  assert.equal(wrongRelease.status, "mismatch");
  assert.equal(released.status, "released");
  assert.equal(existsSync(lockPath), false);
});

test("stale run lock is reported for recovery instead of overwritten", (t) => {
  const dir = tempDir(t, "risk-closeout-stale-lock-");
  const lockPath = join(dir, "closeout.lock");
  acquireRiskCloseoutLock(lockPath, { run_id: "run-old" }, { now: new Date("2026-05-30T00:00:00.000Z") });

  const inspected = inspectRiskCloseoutLock(lockPath, { now: NOW, staleAfterMs: 60 * 60 * 1000 });
  const reacquired = acquireRiskCloseoutLock(lockPath, { run_id: "run-new" }, { now: NOW, staleAfterMs: 60 * 60 * 1000 });

  assert.equal(inspected.status, "stale");
  assert.equal(reacquired.status, "stale");
  assert.equal(reacquired.acquired, false);
});

test("stale in_progress risks produce resume-or-block actions", () => {
  const ledger = {
    risks: [
      baseRisk(),
      baseRisk({
        id: "risk-fresh",
        updated_at: "2026-06-01T07:55:00.000Z",
        last_agent_run_id: "run-fresh"
      }),
      baseRisk({ id: "risk-open", status: "open" })
    ]
  };

  const actions = staleInProgressRiskActions(ledger, {
    now: NOW,
    staleAfterMs: 60 * 60 * 1000
  });

  assert.deepEqual(actions.map((action) => action.risk_id), ["risk-test-stale"]);
  assert.equal(actions[0].action, "resume_or_mark_blocked");
  assert.equal(actions[0].last_agent_run_id, "run-old");
});

test("stale risks can be converted to blocked recovery state", () => {
  const blocked = blockedStateForStaleRisk(baseRisk(), { now: NOW });

  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blockage.condition_met, false);
  assert.match(blocked.blockage.recovery_conditions.join(" "), /inspect last_agent_run_id/);
  assert.equal(blocked.evidence.at(-1).type, "analysis");
});

test("worktree scanner finds closeout-related cleanup candidates", () => {
  const porcelain = [
    "worktree /Users/example/codex/projects/ai-control-platform",
    "HEAD abc",
    "branch refs/heads/main",
    "",
    "worktree /Users/example/codex/worker-workspaces/ai-control-platform/20260520-risk-closeout-old",
    "HEAD def",
    "branch refs/heads/task/risk-closeout-old",
    "",
    "worktree /Users/example/codex/worker-workspaces/ai-control-platform/20260601-feature",
    "HEAD ghi",
    "branch refs/heads/task/feature"
  ].join("\n");
  const parsed = parseGitWorktreePorcelain(porcelain);
  const report = closeoutWorktreeReport([
    { ...parsed[0], created_at: "2026-05-01T00:00:00.000Z" },
    { ...parsed[1], created_at: "2026-05-20T00:00:00.000Z" },
    { ...parsed[2], created_at: "2026-06-01T00:00:00.000Z" }
  ], { now: NOW, maxAgeMs: 7 * 24 * 60 * 60 * 1000 });

  assert.equal(parsed.length, 3);
  assert.deepEqual(report.map((item) => item.branch), ["task/risk-closeout-old"]);
  assert.equal(report[0].cleanup_candidate, true);
  assert.equal(report[0].reason, "older_than_policy");
});

test("cleanup decisions remove only successful runs with preserved artifacts", () => {
  assert.equal(cleanupDecisionForRun({
    success: true,
    artifacts_preserved: true,
    lock_released: true
  }).action, "remove_worktree");

  assert.equal(cleanupDecisionForRun({
    success: true,
    artifacts_preserved: false,
    lock_released: true
  }).action, "preserve_worktree");

  assert.equal(cleanupDecisionForRun({
    success: false,
    artifacts_preserved: true,
    lock_released: true
  }).action, "preserve_worktree");

  assert.equal(cleanupDecisionForRun({
    success: false,
    artifacts_preserved: true,
    lock_released: true
  }, { forceCleanup: true }).action, "remove_worktree");
});
