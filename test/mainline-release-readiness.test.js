import assert from "node:assert/strict";
import test from "node:test";

import { evaluateMainlineReleaseReadiness } from "../src/workflow/mainline-release-readiness.js";

function passingInput(overrides = {}) {
  return {
    branch: "main",
    head_commit: "abc123",
    remote_ref: "origin/main",
    remote_commit: "abc123",
    ahead_count: 0,
    behind_count: 0,
    dirty_entries: [],
    live_route_gate: {
      status: "pass",
      evidence_status: "pass"
    },
    live_route_evidence: {
      status: "pass",
      public_route_verified: true,
      workbench_rendered: true,
      mounted_api_verified: true
    },
    ...overrides
  };
}

test("mainline release readiness passes only when local head equals remote mainline and public route is verified", () => {
  const result = evaluateMainlineReleaseReadiness(passingInput());

  assert.equal(result.status, "pass");
  assert.equal(result.head_commit, "abc123");
  assert.equal(result.remote_commit, "abc123");
  assert.equal(result.live_route_status, "pass");
  assert.deepEqual(result.issues, []);
});

test("mainline release readiness rejects pushed-to-branch or unpushed local states", () => {
  const result = evaluateMainlineReleaseReadiness(passingInput({
    branch: "feature/requirement-intake",
    head_commit: "local456",
    remote_commit: "abc123",
    ahead_count: 1
  }));

  assert.equal(result.status, "fail");
  assert.ok(result.issues.some((item) => item.code === "not_on_mainline_branch"));
  assert.ok(result.issues.some((item) => item.code === "local_head_not_on_remote_mainline"));
  assert.ok(result.issues.some((item) => item.code === "local_commits_not_pushed_to_mainline"));
});

test("mainline release readiness rejects dirty worktree and unverified live route", () => {
  const result = evaluateMainlineReleaseReadiness(passingInput({
    dirty_entries: [" M tools/check-closeout.mjs"],
    live_route_gate: {
      status: "fail",
      evidence_status: "missing"
    },
    live_route_evidence: {
      status: "fail"
    }
  }));

  assert.equal(result.status, "fail");
  assert.ok(result.issues.some((item) => item.code === "dirty_worktree_blocks_mainline_release"));
  assert.ok(result.issues.some((item) => item.code === "public_release_route_gate_not_passed"));
  assert.ok(result.issues.some((item) => item.code === "public_release_route_evidence_not_accepted"));
  assert.ok(result.issues.some((item) => item.code === "public_release_route_artifact_not_passed"));
});
