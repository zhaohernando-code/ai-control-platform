import assert from "node:assert/strict";
import test from "node:test";
import { evaluateMainlineReleaseReadiness } from "../src/workflow/mainline-release-readiness.js";

// Branch coverage for mainline-release-readiness.js (baseline 41.94% branch). This gate decides
// whether a mainline/release closeout may proceed; each guard is a pure function of the git/route
// facts passed in, so every reject branch is honestly reachable without touching git.

// A fully-ready input (public-route requirement waived) that should pass cleanly.
const ready = {
  branch: "main",
  head_commit: "abc123",
  remote_ref: "origin/main",
  remote_commit: "abc123",
  ahead_count: 0,
  behind_count: 0,
  dirty_count: 0,
  require_public_route: false
};

test("evaluateMainlineReleaseReadiness: a fully-ready state passes with no issues", () => {
  const r = evaluateMainlineReleaseReadiness(ready);
  assert.equal(r.status, "pass");
  assert.deepEqual(r.issues, []);
});

test("evaluateMainlineReleaseReadiness: each git precondition violation raises its own issue", () => {
  const cases = [
    [{ branch: "feature-x" }, "not_on_mainline_branch"],
    [{ dirty_count: 3 }, "dirty_worktree_blocks_mainline_release"],
    [{ head_commit: "" }, "missing_local_head_commit"],
    [{ remote_ref: "origin/release" }, "unexpected_mainline_remote_ref"],
    [{ remote_commit: "" }, "missing_remote_mainline_commit"],
    [{ head_commit: "aaa", remote_commit: "bbb" }, "local_head_not_on_remote_mainline"],
    [{ ahead_count: 2 }, "local_commits_not_pushed_to_mainline"],
    [{ behind_count: 1 }, "local_mainline_behind_remote"]
  ];
  for (const [override, code] of cases) {
    const r = evaluateMainlineReleaseReadiness({ ...ready, ...override });
    assert.equal(r.status, "fail", `${code} should fail the gate`);
    assert.ok(r.issues.some((i) => i.code === code), `expected issue ${code}, got ${r.issues.map((i) => i.code).join(",")}`);
  }
});

test("evaluateMainlineReleaseReadiness: missing ahead/behind counts are flagged as unknown", () => {
  const r = evaluateMainlineReleaseReadiness({ ...ready, ahead_count: undefined, behind_count: undefined });
  assert.equal(r.status, "fail");
  assert.ok(r.issues.some((i) => i.code === "missing_remote_ahead_count"));
  assert.ok(r.issues.some((i) => i.code === "missing_remote_behind_count"));
});

test("evaluateMainlineReleaseReadiness: requiring a public route fails when the live-route gate did not pass", () => {
  const r = evaluateMainlineReleaseReadiness({ ...ready, require_public_route: true });
  assert.equal(r.status, "fail");
  assert.ok(r.issues.some((i) => i.code === "public_release_route_gate_not_passed"));
});
