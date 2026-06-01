import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  createKnownRiskCloseoutRunArtifact,
  selectKnownRisksForCloseout
} from "../tools/run-known-risk-closeout.mjs";
import { tempDir } from "./helpers/temp-dir.js";

const NOW = new Date("2026-06-01T08:00:00.000Z");

function risk(id, severity, status = "open", overrides = {}) {
  return {
    id,
    title: id,
    source: "unit-test",
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    status,
    severity,
    scope: ["tools/example.mjs"],
    owned_files: ["tools/example.mjs"],
    acceptance_gates: ["node --test test/example.test.js"],
    attempted_count: 0,
    evidence: [{ type: "analysis", summary: "seeded" }],
    ...overrides
  };
}

function ledger() {
  return {
    version: "known-risk-ledger.v1",
    updated_at: NOW.toISOString(),
    risks: [
      risk("risk-low", "low"),
      risk("risk-high", "high"),
      risk("risk-medium", "medium"),
      risk("risk-fixed", "medium", "fixed", {
        resolution: { fixed_by_commit: "abc123" },
        review: { reviewers: [] }
      })
    ]
  };
}

function policy() {
  return {
    version: "ai-governed-risk-closeout-policy.v1",
    auto_merge: false,
    auto_publish: false,
    max_severity_auto_merge: "medium",
    require_two_model_review_for: ["critical", "high"],
    require_live_verification_for_user_visible_changes: true,
    max_files_changed: 12,
    max_lines_changed: 800,
    allowed_paths: ["tools/", "test/"],
    forbidden_paths: [".git/", "node_modules/"],
    rollback_on_live_failure: true,
    stop_on_new_high_risk_discovery: true
  };
}

test("risk selection is bounded and severity ordered", () => {
  const selected = selectKnownRisksForCloseout(ledger(), {
    maxRisks: 2,
    dryRun: true
  });

  assert.deepEqual(selected.map((item) => item.id), ["risk-high", "risk-medium"]);
  assert.equal(selected[0].action, "would_attempt_closeout");
});

test("explicit risk ids override severity ordering", () => {
  const selected = selectKnownRisksForCloseout(ledger(), {
    riskIds: ["risk-low"],
    maxRisks: 2,
    dryRun: true
  });

  assert.deepEqual(selected.map((item) => item.id), ["risk-low"]);
});

test("dry-run artifact records selected risks, gates, reviewers, release, and cleanup state", () => {
  const artifact = createKnownRiskCloseoutRunArtifact({
    ledger: ledger(),
    policy: policy(),
    maxRisks: 2,
    now: NOW,
    ledgerPath: "docs/governance/known-risk-ledger.json",
    policyPath: "docs/governance/ai-governed-risk-closeout-policy.example.json"
  });

  assert.equal(artifact.version, "known-risk-closeout-run.v1");
  assert.equal(artifact.status, "pass");
  assert.equal(artifact.mode, "dry_run");
  assert.deepEqual(artifact.selected_risks.map((item) => item.id), ["risk-high", "risk-medium"]);
  assert.equal(artifact.gates[0].name, "check-known-risk-closeout");
  assert.equal(Array.isArray(artifact.reviewers), true);
  assert.equal(artifact.release_decision.merge_allowed, false);
  assert.equal(artifact.cleanup.worktrees_cleaned, false);
});

test("dry-run CLI writes artifact without mutating the ledger", async (t) => {
  const dir = tempDir(t, "known-risk-closeout-runner-");
  const output = join(dir, "run.json");
  const before = readFileSync("docs/governance/known-risk-ledger.json", "utf8");

  const { execFileSync } = await import("node:child_process");
  execFileSync("node", [
    "tools/run-with-node18.mjs",
    "tools/run-known-risk-closeout.mjs",
    "--max-risks",
    "1",
    "--output",
    output,
    "--now",
    NOW.toISOString()
  ], { encoding: "utf8" });

  const after = readFileSync("docs/governance/known-risk-ledger.json", "utf8");
  const artifact = JSON.parse(readFileSync(output, "utf8"));

  assert.equal(before, after);
  assert.equal(existsSync(output), true);
  assert.equal(artifact.selected_risks.length, 1);
  assert.equal(artifact.mode, "dry_run");
});
