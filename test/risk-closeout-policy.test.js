import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateRiskCloseoutPolicy,
  loadRiskCloseoutPolicy,
  ownerAuthorizationStateForRisk,
  validateRiskCloseoutPolicy
} from "../tools/risk-closeout-policy.mjs";

const NOW = new Date("2026-06-01T08:00:00.000Z");

function policy(overrides = {}) {
  return {
    version: "ai-governed-risk-closeout-policy.v1",
    auto_merge: true,
    auto_publish: true,
    max_severity_auto_merge: "medium",
    require_two_model_review_for: ["critical", "high", "public-route", "launchagent", "edge-proxy"],
    require_live_verification_for_user_visible_changes: true,
    max_files_changed: 3,
    max_lines_changed: 200,
    allowed_paths: ["docs/governance/", "tools/", "test/", "package.json"],
    forbidden_paths: [".git/", "node_modules/", "docs/examples/*.sqlite"],
    rollback_on_live_failure: true,
    stop_on_new_high_risk_discovery: true,
    owner_authorization_required_for: [
      "critical",
      "high",
      "forbidden",
      "policy",
      "auto_merge",
      "auto_publish",
      "severity_exceeds"
    ],
    ...overrides
  };
}

function reviewer(overrides = {}) {
  return {
    reviewer_id: "reviewer-openai",
    model: "gpt-5",
    verdict: "pass",
    blocking_findings: [],
    non_blocking_findings: [],
    ...overrides
  };
}

function fixedRisk(overrides = {}) {
  return {
    id: "risk-test-policy",
    title: "Policy test risk",
    source: "unit-test",
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    status: "fixed",
    severity: "medium",
    scope: ["tools/example.mjs"],
    owned_files: ["tools/example.mjs"],
    acceptance_gates: ["node --test test/example.test.js"],
    attempted_count: 1,
    evidence: [{
      type: "test",
      summary: "targeted test passed",
      command: "node --test test/example.test.js",
      exit_code: 0
    }],
    resolution: { fixed_by_commit: "abc123", test_added: true },
    review: { reviewers: [reviewer()] },
    release: null,
    depends_on: [],
    ...overrides
  };
}

function issueCodes(decision) {
  return decision.issues.map((item) => item.code);
}

test("policy loader fails closed for invalid policy files", () => {
  const loaded = loadRiskCloseoutPolicy("docs/governance/does-not-exist-policy.json");

  assert.equal(loaded.status, "fail");
  assert.equal(loaded.policy, null);
  assert.ok(issueCodes(loaded).includes("policy_load_failed"));
});

test("policy validation rejects missing required controls", () => {
  const result = validateRiskCloseoutPolicy({
    version: "wrong",
    auto_merge: true,
    unexpected: true
  });

  assert.equal(result.status, "fail");
  assert.ok(issueCodes(result).includes("invalid_policy_version"));
  assert.ok(issueCodes(result).includes("policy_missing_required_field"));
  assert.ok(issueCodes(result).includes("policy_unknown_field"));
});

test("merge and publish are allowed when policy, paths, reviewers, live check, and rollback all pass", () => {
  const decision = evaluateRiskCloseoutPolicy(policy(), {
    now: NOW,
    changedFiles: ["tools/risk-closeout-policy.mjs", "test/risk-closeout-policy.test.js"],
    linesChanged: 120,
    userVisibleChange: true,
    rollback_procedure: "git revert abc123 && restart workbench LaunchAgent",
    risks: [
      fixedRisk({
        evidence: [
          { type: "test", summary: "targeted test passed", command: "node --test test/example.test.js", exit_code: 0 },
          { type: "live_check", summary: "public route verified", command: "node tools/check-workbench-live-route.mjs", exit_code: 0 }
        ]
      })
    ]
  });

  assert.equal(decision.status, "pass");
  assert.equal(decision.merge_allowed, true);
  assert.equal(decision.publish_allowed, true);
});

test("merge checker enforces severity and two-model reviewer policy", () => {
  const decision = evaluateRiskCloseoutPolicy(policy(), {
    now: NOW,
    changedFiles: ["tools/risk-closeout-policy.mjs"],
    linesChanged: 30,
    risks: [fixedRisk({ severity: "high" })]
  });

  assert.equal(decision.merge_allowed, false);
  assert.equal(decision.owner_authorization_required, true);
  assert.ok(issueCodes(decision).includes("severity_exceeds_auto_merge_policy"));
  assert.ok(issueCodes(decision).includes("closeout_gate_failed"));
});

test("merge checker enforces allowed and forbidden changed paths", () => {
  const decision = evaluateRiskCloseoutPolicy(policy(), {
    now: NOW,
    changedFiles: ["apps/workbench/app/page.tsx", "docs/examples/local.sqlite", "../outside.js"],
    linesChanged: 30,
    risks: [fixedRisk()]
  });

  assert.equal(decision.merge_allowed, false);
  assert.ok(issueCodes(decision).includes("changed_path_not_allowed"));
  assert.ok(issueCodes(decision).includes("changed_path_forbidden"));
  assert.ok(issueCodes(decision).includes("unsafe_changed_path"));
});

test("merge checker enforces change size limits and new high-risk discovery stop", () => {
  const decision = evaluateRiskCloseoutPolicy(policy({ max_files_changed: 1, max_lines_changed: 10 }), {
    now: NOW,
    changedFiles: ["tools/a.mjs", "tools/b.mjs"],
    linesChanged: 11,
    newHighRiskDiscovered: true,
    risks: [fixedRisk()]
  });

  assert.equal(decision.merge_allowed, false);
  assert.ok(issueCodes(decision).includes("changed_file_count_exceeds_policy"));
  assert.ok(issueCodes(decision).includes("changed_line_count_exceeds_policy"));
  assert.ok(issueCodes(decision).includes("new_high_risk_discovery"));
});

test("publish checker requires live verification and rollback for user-visible changes", () => {
  const decision = evaluateRiskCloseoutPolicy(policy(), {
    now: NOW,
    changedFiles: ["tools/risk-closeout-policy.mjs"],
    linesChanged: 30,
    userVisibleChange: true,
    risks: [fixedRisk()]
  });

  assert.equal(decision.publish_allowed, false);
  assert.ok(issueCodes(decision).includes("publish_missing_live_verification"));
  assert.ok(issueCodes(decision).includes("publish_missing_rollback"));
});

test("disabled auto merge and auto publish block unattended release", () => {
  const decision = evaluateRiskCloseoutPolicy(policy({ auto_merge: false, auto_publish: false }), {
    now: NOW,
    changedFiles: ["tools/risk-closeout-policy.mjs"],
    linesChanged: 30,
    risks: [fixedRisk()]
  });

  assert.equal(decision.merge_allowed, false);
  assert.equal(decision.publish_allowed, false);
  assert.ok(issueCodes(decision).includes("auto_merge_disabled"));
  assert.ok(issueCodes(decision).includes("auto_publish_disabled"));
});

test("out-of-policy decisions can produce requires_owner_authorization ledger state", () => {
  const risk = fixedRisk();
  const decision = evaluateRiskCloseoutPolicy(policy({ auto_merge: false }), {
    now: NOW,
    changedFiles: ["tools/risk-closeout-policy.mjs"],
    linesChanged: 30,
    risks: [risk]
  });
  const updated = ownerAuthorizationStateForRisk(risk, decision, { now: NOW });

  assert.equal(updated.status, "requires_owner_authorization");
  assert.equal(updated.updated_at, NOW.toISOString());
  assert.match(updated.evidence.at(-1).summary, /auto_merge_disabled/);
});
