import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { evaluateKnownRiskLedger } from "../tools/risk-ledger.mjs";

const NOW = new Date("2026-06-01T08:00:00.000Z");

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
  assert.equal(result.open_count, 7);
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
});

test("fixed risk with commit and test evidence passes closeout mode", () => {
  const result = evaluateKnownRiskLedger(ledger([
    baseRisk({
      status: "fixed",
      resolution: { fixed_by_commit: "abc123", test_added: true },
      evidence: [{ type: "test", summary: "targeted tests passed", command: "node --test test/example.test.js", exit_code: 0 }]
    })
  ]), { now: NOW, requireClosed: true });

  assert.equal(result.status, "pass");
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
