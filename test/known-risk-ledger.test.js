import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { evaluateKnownRiskLedger } from "../tools/risk-ledger.mjs";

const NOW = new Date("2026-06-01T08:00:00.000Z");
const TWO_MODEL_POLICY = {
  version: "ai-governed-risk-closeout-policy.v1",
  require_two_model_review_for: ["critical", "high", "public-route", "launchagent", "edge-proxy"]
};

function reviewer(overrides = {}) {
  return {
    reviewer_id: "reviewer-openai",
    model: "gpt-5",
    verdict: "pass",
    blocking_findings: [],
    non_blocking_findings: [],
    artifact: "docs/examples/reviewer-openai.json",
    ...overrides
  };
}

function baseRisk(overrides = {}) {
  return {
    id: "risk-test-001",
    title: "Test risk",
    source: "unit-test",
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    status: "open",
    severity: "medium",
    scope: ["src/example.js"],
    owned_files: ["src/example.js"],
    acceptance_gates: ["node --test test/example.test.js"],
    attempted_count: 0,
    last_agent_run_id: null,
    depends_on: [],
    superseded_by: null,
    resolution: null,
    deferral: null,
    blockage: null,
    evidence: [{
      type: "analysis",
      summary: "Unit test evidence",
      created_at: "2026-06-01T00:00:00.000Z"
    }],
    review: null,
    release: null,
    ...overrides
  };
}

function ledger(risks) {
  return {
    version: "known-risk-ledger.v1",
    updated_at: "2026-06-01T00:00:00.000Z",
    risks
  };
}

function issueCodes(result) {
  return result.issues.map((item) => item.code);
}

test("current known-risk ledger is structurally valid while open risks remain allowed before closeout", () => {
  const current = JSON.parse(readFileSync("docs/governance/known-risk-ledger.json", "utf8"));
  const result = evaluateKnownRiskLedger(current, { now: NOW });

  assert.equal(result.status, "pass");
  assert.equal(result.risk_count, 7);
  assert.equal(result.open_count, 3);
  assert.equal(result.terminal_count, 4);
});

test("require-closed mode fails while known risks are still open", () => {
  const result = evaluateKnownRiskLedger(ledger([baseRisk()]), {
    now: NOW,
    requireClosed: true
  });

  assert.equal(result.status, "fail");
  assert.ok(issueCodes(result).includes("risk_not_closed"));
});

test("fixed risks require a commit and verification evidence", () => {
  const result = evaluateKnownRiskLedger(ledger([
    baseRisk({
      status: "fixed",
      resolution: { test_added: true },
      evidence: [{ type: "analysis", summary: "Looks fixed" }]
    })
  ]), { now: NOW, requireClosed: true });

  assert.equal(result.status, "fail");
  assert.ok(issueCodes(result).includes("fixed_risk_missing_commit"));
  assert.ok(issueCodes(result).includes("fixed_risk_missing_verification"));
  assert.ok(issueCodes(result).includes("fixed_risk_missing_reviewer_pass"));
});

test("fixed risk with commit, test evidence, and reviewer pass passes closeout mode", () => {
  const result = evaluateKnownRiskLedger(ledger([
    baseRisk({
      status: "fixed",
      resolution: { fixed_by_commit: "abc123", test_added: true },
      evidence: [{ type: "test", summary: "targeted tests passed", command: "node --test test/example.test.js", exit_code: 0 }],
      review: { reviewers: [reviewer()] }
    })
  ]), { now: NOW, requireClosed: true });

  assert.equal(result.status, "pass");
});

test("fixed risk fails when reviewer verdict is fail or inconclusive", () => {
  const result = evaluateKnownRiskLedger(ledger([
    baseRisk({
      status: "fixed",
      resolution: { fixed_by_commit: "abc123", test_added: true },
      evidence: [{ type: "test", summary: "targeted tests passed", command: "node --test test/example.test.js", exit_code: 0 }],
      review: {
        reviewers: [
          reviewer({ reviewer_id: "reviewer-a", model: "gpt-5", verdict: "pass" }),
          reviewer({ reviewer_id: "reviewer-b", model: "deepseek-v4-pro", verdict: "inconclusive" })
        ]
      }
    })
  ]), { now: NOW, requireClosed: true });

  assert.equal(result.status, "fail");
  assert.ok(issueCodes(result).includes("fixed_risk_has_nonpassing_reviewer"));
});

test("fixed risk fails when reviewer leaves blocking findings", () => {
  const result = evaluateKnownRiskLedger(ledger([
    baseRisk({
      status: "fixed",
      resolution: { fixed_by_commit: "abc123", test_added: true },
      evidence: [{ type: "test", summary: "targeted tests passed", command: "node --test test/example.test.js", exit_code: 0 }],
      review: {
        reviewers: [
          reviewer({
            verdict: "pass",
            blocking_findings: ["The patch only changes the test fixture."]
          })
        ]
      }
    })
  ]), { now: NOW, requireClosed: true });

  assert.equal(result.status, "fail");
  assert.ok(issueCodes(result).includes("fixed_risk_has_blocking_review_findings"));
  assert.ok(issueCodes(result).includes("fixed_risk_missing_reviewer_pass"));
});

test("policy requires two distinct passing reviewer models for high risk closeout", () => {
  const result = evaluateKnownRiskLedger(ledger([
    baseRisk({
      status: "fixed",
      severity: "high",
      resolution: { fixed_by_commit: "abc123", test_added: true },
      evidence: [{ type: "test", summary: "targeted tests passed", command: "node --test test/example.test.js", exit_code: 0 }],
      review: { reviewers: [reviewer()] }
    })
  ]), { now: NOW, requireClosed: true, policy: TWO_MODEL_POLICY });

  assert.equal(result.status, "fail");
  assert.ok(issueCodes(result).includes("fixed_risk_missing_two_model_review"));
});

test("policy accepts two distinct passing reviewer models for high risk closeout", () => {
  const result = evaluateKnownRiskLedger(ledger([
    baseRisk({
      status: "fixed",
      severity: "high",
      resolution: { fixed_by_commit: "abc123", test_added: true },
      evidence: [{ type: "test", summary: "targeted tests passed", command: "node --test test/example.test.js", exit_code: 0 }],
      review: {
        reviewers: [
          reviewer({ reviewer_id: "reviewer-openai", model: "gpt-5" }),
          reviewer({ reviewer_id: "reviewer-deepseek", model: "deepseek-v4-pro" })
        ]
      }
    })
  ]), { now: NOW, requireClosed: true, policy: TWO_MODEL_POLICY });

  assert.equal(result.status, "pass");
});

test("policy scope tokens also require two-model review", () => {
  const result = evaluateKnownRiskLedger(ledger([
    baseRisk({
      status: "fixed",
      severity: "medium",
      scope: ["public route /projects/ai-control-platform/"],
      resolution: { fixed_by_commit: "abc123", test_added: true },
      evidence: [{ type: "live_check", summary: "public route verified", command: "node tools/check-workbench-live-route.mjs", exit_code: 0 }],
      review: { reviewers: [reviewer()] }
    })
  ]), { now: NOW, requireClosed: true, policy: TWO_MODEL_POLICY });

  assert.equal(result.status, "fail");
  assert.ok(issueCodes(result).includes("fixed_risk_missing_two_model_review"));
});

test("invalidated risks require evidence", () => {
  const result = evaluateKnownRiskLedger(ledger([
    baseRisk({
      status: "invalidated",
      evidence: []
    })
  ]), { now: NOW, requireClosed: true });

  assert.equal(result.status, "fail");
  assert.ok(issueCodes(result).includes("invalidated_risk_missing_evidence"));
});

test("deferred risks require bounded unexpired deferral details", () => {
  const result = evaluateKnownRiskLedger(ledger([
    baseRisk({
      status: "deferred",
      deferral: {
        deferred_until: "2026-05-01T00:00:00.000Z",
        deferral_count: 4,
        deferral_reason: "Too large",
        priority: "P2"
      }
    })
  ]), { now: NOW, requireClosed: true });

  assert.equal(result.status, "fail");
  assert.ok(issueCodes(result).includes("deferred_risk_expired"));
  assert.ok(issueCodes(result).includes("deferred_risk_too_many_deferrals"));
});

test("critical risks cannot be deferred by default", () => {
  const result = evaluateKnownRiskLedger(ledger([
    baseRisk({
      status: "deferred",
      severity: "critical",
      deferral: {
        deferred_until: "2026-07-01T00:00:00.000Z",
        deferral_count: 1,
        deferral_reason: "Needs policy authorization",
        priority: "P0"
      }
    })
  ]), { now: NOW, requireClosed: true });

  assert.equal(result.status, "fail");
  assert.ok(issueCodes(result).includes("critical_risk_deferred"));
});

test("blocked risks require blocker and recovery details", () => {
  const result = evaluateKnownRiskLedger(ledger([
    baseRisk({
      status: "blocked",
      blockage: { blocker_description: "", recovery_conditions: [] }
    })
  ]), { now: NOW, requireClosed: true });

  assert.equal(result.status, "fail");
  assert.ok(issueCodes(result).includes("blocked_risk_missing_description"));
  assert.ok(issueCodes(result).includes("blocked_risk_missing_recovery"));
  assert.ok(issueCodes(result).includes("blocked_risk_missing_last_check"));
});

test("risk dependency graph rejects unknown dependencies and cycles", () => {
  const result = evaluateKnownRiskLedger(ledger([
    baseRisk({ id: "risk-a", depends_on: ["risk-b"] }),
    baseRisk({ id: "risk-b", depends_on: ["risk-a"] }),
    baseRisk({ id: "risk-c", depends_on: ["risk-missing"] })
  ]), { now: NOW });

  assert.equal(result.status, "fail");
  assert.ok(issueCodes(result).includes("unknown_risk_dependency"));
  assert.ok(issueCodes(result).includes("cyclic_risk_dependency"));
});
