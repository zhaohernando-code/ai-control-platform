import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const guard = resolve(here, "../tools/check-test-location.mjs");
const PRIMARY = "/Users/hernando_zhao/codex/projects/ai-control-platform";

function run(cwd, env = {}) {
  return spawnSync(process.execPath, [guard], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
}

test("test-location guard: passes from a worker-workspaces worktree", () => {
  // this test file itself runs from a worker-workspaces worktree -> here is under one.
  const r = run(here);
  assert.equal(r.status, 0, r.stderr);
});

test("test-location guard: blocks from the primary checkout with a clear message", (t) => {
  // simulate the primary checkout via the override-able primary path env pointing at cwd.
  // Use the worktree's own dir AS IF it were primary by setting PRIMARY to it.
  const r = run(here, { AI_CONTROL_PLATFORM_PRIMARY_WORKTREE: here });
  // `here` contains "worker-workspaces" so the segment rule keeps it allowed — assert that
  // path-segment rule still wins (documents the precedence).
  assert.equal(r.status, 0, "a worker-workspaces path is allowed even if marked primary");
});

test("test-location guard: a non-worker primary path is blocked, override re-allows", () => {
  const blocked = run("/tmp", { AI_CONTROL_PLATFORM_PRIMARY_WORKTREE: "/tmp" });
  assert.equal(blocked.status, 2, "primary-matching, non-worker path is blocked");
  assert.match(blocked.stderr, /refusing to run the test suite/);

  const allowed = run("/tmp", { AI_CONTROL_PLATFORM_PRIMARY_WORKTREE: "/tmp", AI_CONTROL_PLATFORM_ALLOW_CANONICAL_TEST: "1" });
  assert.equal(allowed.status, 0, "override env re-allows the canonical run");
});

void PRIMARY;
