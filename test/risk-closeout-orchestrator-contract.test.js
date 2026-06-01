import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateEvidenceAgentContract,
  evaluatePhaseDeepSeekGate,
  evaluateRepairAgentContract,
  evaluateReviewerHandoffContract,
  evaluateWriteModeOrchestratorReadiness,
  transitionKnownRiskStatus
} from "../tools/risk-closeout-orchestrator-contract.mjs";

const NOW = new Date("2026-06-01T08:00:00.000Z");

function risk(overrides = {}) {
  return {
    id: "risk-test-orchestrator",
    title: "Orchestrator contract risk",
    source: "unit-test",
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    status: "open",
    severity: "medium",
    scope: ["tools/example.mjs"],
    owned_files: ["tools/", "test/"],
    acceptance_gates: ["node --test test/example.test.js"],
    attempted_count: 0,
    evidence: [{ type: "analysis", summary: "seeded" }],
    ...overrides
  };
}

function evidence(overrides = {}) {
  return {
    type: "test",
    gate: "node --test test/example.test.js",
    command: "node --test test/example.test.js",
    exit_code: 0,
    summary: "targeted test passed",
    ...overrides
  };
}

function reviewerHandoff(overrides = {}) {
  return {
    risk_id: "risk-test-orchestrator",
    changed_files: ["tools/example.mjs"],
    evidence_refs: ["artifact://targeted-test"],
    diff_summary: "Implemented the risk closeout fix.",
    terminal_claim: "fixed",
    ...overrides
  };
}

function codes(result) {
  return result.issues.map((item) => item.code);
}

test("repair agent contract requires isolated worktree and owned file scope", () => {
  const result = evaluateRepairAgentContract({
    risk: risk(),
    run_id: "run-1",
    worktree_path: "/Users/example/codex/projects/ai-control-platform",
    changed_files: ["apps/workbench/app/page.tsx"]
  });

  assert.equal(result.status, "fail");
  assert.ok(codes(result).includes("repair_contract_not_isolated_worktree"));
  assert.ok(codes(result).includes("repair_contract_changed_file_outside_owned_scope"));
});

test("repair agent contract passes for isolated owned changes", () => {
  const result = evaluateRepairAgentContract({
    risk: risk(),
    run_id: "run-1",
    worktree_path: "/Users/example/codex/worker-workspaces/ai-control-platform/task",
    changed_files: ["tools/example.mjs", "test/example.test.js"]
  });

  assert.equal(result.status, "pass");
});

test("repair agent contract rejects worker-workspaces substring and traversal paths", () => {
  const substring = evaluateRepairAgentContract({
    risk: risk(),
    run_id: "run-1",
    worktree_path: "/Users/example/codex/worker-workspaces-not/ai-control-platform/task",
    changed_files: ["tools/example.mjs"]
  });
  const traversal = evaluateRepairAgentContract({
    risk: risk(),
    run_id: "run-1",
    worktree_path: "/Users/example/codex/worker-workspaces/../projects/ai-control-platform",
    changed_files: ["tools/example.mjs"]
  });

  assert.equal(substring.status, "fail");
  assert.equal(traversal.status, "fail");
  assert.ok(codes(substring).includes("repair_contract_not_isolated_worktree"));
  assert.ok(codes(traversal).includes("repair_contract_not_isolated_worktree"));
});

test("evidence contract requires every acceptance gate to have passing command evidence", () => {
  const result = evaluateEvidenceAgentContract({
    risk: risk(),
    evidence: [evidence({ exit_code: 1 })]
  });

  assert.equal(result.status, "fail");
  assert.ok(codes(result).includes("evidence_contract_gate_not_proven"));
  assert.ok(codes(result).includes("evidence_contract_nonzero_exit"));
});

test("reviewer handoff requires risk diff evidence and terminal claim", () => {
  const result = evaluateReviewerHandoffContract({
    risk: risk(),
    handoff: {
      risk_id: "risk-test-orchestrator",
      changed_files: [" "],
      evidence_refs: [""]
    }
  });

  assert.equal(result.status, "fail");
  assert.ok(codes(result).includes("reviewer_handoff_missing_diff_summary"));
  assert.ok(codes(result).includes("reviewer_handoff_missing_evidence_refs"));
  assert.ok(codes(result).includes("reviewer_handoff_missing_terminal_claim"));
});

test("transition to in_progress records run identity only after repair contract passes", () => {
  const result = transitionKnownRiskStatus(risk(), "in_progress", {
    now: NOW,
    repair: {
      run_id: "run-1",
      worktree_path: "/Users/example/codex/worker-workspaces/ai-control-platform/task",
      changed_files: ["tools/example.mjs"]
    }
  });

  assert.equal(result.status, "pass");
  assert.equal(result.risk.status, "in_progress");
  assert.equal(result.risk.attempted_count, 1);
  assert.equal(result.risk.last_agent_run_id, "run-1");
});

test("transition to in_progress composes and enforces the repair contract", () => {
  const result = transitionKnownRiskStatus(risk(), "in_progress", {
    now: NOW,
    repair: {
      run_id: "run-1",
      worktree_path: "/Users/example/codex/projects/ai-control-platform",
      changed_files: ["apps/workbench/app/page.tsx"]
    }
  });

  assert.equal(result.status, "fail");
  assert.ok(codes(result).includes("repair_contract_not_isolated_worktree"));
  assert.ok(codes(result).includes("repair_contract_changed_file_outside_owned_scope"));
});

test("transition to fixed requires in_progress evidence reviewer handoff and commit", () => {
  const result = transitionKnownRiskStatus(risk(), "fixed", {
    now: NOW,
    evidence: [evidence()],
    reviewer_handoff: reviewerHandoff(),
    fixed_by_commit: "abc123"
  });

  assert.equal(result.status, "fail");
  assert.ok(codes(result).includes("transition_fixed_requires_in_progress"));
});

test("transition to fixed passes only with evidence reviewer handoff and commit", () => {
  const result = transitionKnownRiskStatus(risk({ status: "in_progress" }), "fixed", {
    now: NOW,
    evidence: [evidence()],
    reviewer_handoff: reviewerHandoff(),
    fixed_by_commit: "abc123"
  });

  assert.equal(result.status, "pass");
  assert.equal(result.risk.status, "fixed");
  assert.equal(result.risk.resolution.fixed_by_commit, "abc123");
});

test("DeepSeek phase gate blocks missing or non-passing verdicts", () => {
  const failed = evaluatePhaseDeepSeekGate({
    verdict: {
      verdict: "pass",
      blocking_findings: ["unresolved issue"],
      artifact: "docs/examples/deepseek-review.json"
    }
  });
  const passed = evaluatePhaseDeepSeekGate({
    verdict: {
      verdict: "pass",
      blocking_findings: [],
      artifact: "docs/examples/deepseek-review.json"
    }
  });

  assert.equal(failed.status, "fail");
  assert.ok(codes(failed).includes("deepseek_gate_has_blocking_findings"));
  assert.equal(passed.status, "pass");
});

test("write-mode readiness fails closed until every orchestrator contract is wired", () => {
  const failed = evaluateWriteModeOrchestratorReadiness({
    write_mode_enabled: false,
    repair_agent_contract: true,
    evidence_agent_contract: true,
    reviewer_handoff_contract: true,
    ledger_transition_contract: true,
    deepseek_phase_gate: true
  });
  const passed = evaluateWriteModeOrchestratorReadiness({
    write_mode_enabled: true,
    repair_agent_contract: true,
    evidence_agent_contract: true,
    reviewer_handoff_contract: true,
    ledger_transition_contract: true,
    deepseek_phase_gate: true
  });

  assert.equal(failed.status, "fail");
  assert.ok(codes(failed).includes("write_mode_not_implemented"));
  assert.equal(passed.status, "pass");
});
