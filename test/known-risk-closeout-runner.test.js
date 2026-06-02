import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

test("risk selection processes open dependencies before dependent risks", () => {
  const selected = selectKnownRisksForCloseout({
    version: "known-risk-ledger.v1",
    updated_at: NOW.toISOString(),
    risks: [
      risk("risk-dependent", "high", "open", {
        depends_on: ["risk-dependency"],
        created_at: "2026-06-01T00:00:00.000Z"
      }),
      risk("risk-dependency", "medium", "open", {
        created_at: "2026-06-01T00:01:00.000Z"
      })
    ]
  }, {
    maxRisks: 2,
    dryRun: true
  });

  assert.deepEqual(selected.map((item) => item.id), ["risk-dependency", "risk-dependent"]);
});

test("explicit dependent risk selection still returns its open dependency first", () => {
  const selected = selectKnownRisksForCloseout({
    version: "known-risk-ledger.v1",
    updated_at: NOW.toISOString(),
    risks: [
      risk("risk-dependent", "medium", "open", { depends_on: ["risk-dependency"] }),
      risk("risk-dependency", "medium", "open")
    ]
  }, {
    riskIds: ["risk-dependent"],
    maxRisks: 1,
    dryRun: true
  });

  assert.deepEqual(selected.map((item) => item.id), ["risk-dependency"]);
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
  assert.equal(artifact.status, "preflight_pass");
  assert.equal(artifact.mode, "dry_run");
  assert.equal(artifact.preflight_only, true);
  assert.equal(artifact.closeout_completed, false);
  assert.deepEqual(artifact.selected_risks.map((item) => item.id), ["risk-high", "risk-medium"]);
  assert.equal(artifact.gates[0].name, "check-known-risk-closeout");
  assert.equal(Array.isArray(artifact.reviewers), true);
  assert.equal(artifact.release_decision.merge_allowed, false);
  assert.equal(artifact.cleanup.worktrees_cleaned, false);
});

test("dry-run CLI writes artifact without mutating the ledger", async (t) => {
  const dir = tempDir(t, "known-risk-closeout-runner-");
  const output = join(dir, "run.json");
  const ledgerPath = join(dir, "known-risk-ledger.json");
  writeFileSync(ledgerPath, `${JSON.stringify({
    version: "known-risk-ledger.v1",
    updated_at: NOW.toISOString(),
    risks: [risk("risk-cli-open", "medium")]
  }, null, 2)}\n`);
  const before = readFileSync(ledgerPath, "utf8");

  const { execFileSync } = await import("node:child_process");
  execFileSync("node", [
    "tools/run-with-node18.mjs",
    "tools/run-known-risk-closeout.mjs",
    "--ledger",
    ledgerPath,
    "--max-risks",
    "1",
    "--output",
    output,
    "--now",
    NOW.toISOString()
  ], { encoding: "utf8" });

  const after = readFileSync(ledgerPath, "utf8");
  const artifact = JSON.parse(readFileSync(output, "utf8"));

  assert.equal(before, after);
  assert.equal(existsSync(output), true);
  assert.equal(artifact.selected_risks.length, 1);
  assert.equal(artifact.selected_risks[0].id, "risk-cli-open");
  assert.equal(artifact.mode, "dry_run");
});

test("dry-run CLI accepts a zero-open-risk ledger without pretending closeout completed", async (t) => {
  const dir = tempDir(t, "known-risk-closeout-zero-open-");
  const output = join(dir, "run.json");
  const ledgerPath = join(dir, "known-risk-ledger.json");
  writeFileSync(ledgerPath, `${JSON.stringify({
    version: "known-risk-ledger.v1",
    updated_at: NOW.toISOString(),
    risks: []
  }, null, 2)}\n`);

  const { execFileSync } = await import("node:child_process");
  execFileSync("node", [
    "tools/run-with-node18.mjs",
    "tools/run-known-risk-closeout.mjs",
    "--ledger",
    ledgerPath,
    "--max-risks",
    "1",
    "--output",
    output,
    "--now",
    NOW.toISOString()
  ], { encoding: "utf8" });

  const artifact = JSON.parse(readFileSync(output, "utf8"));

  assert.deepEqual(artifact.selected_risks, []);
  assert.equal(artifact.mode, "dry_run");
  assert.equal(artifact.preflight_only, true);
  assert.equal(artifact.closeout_completed, false);
});

test("dry-run CLI selects one queued large-file risk from a bounded ledger without pretending closeout completed", async (t) => {
  const dir = tempDir(t, "known-risk-closeout-large-file-");
  const output = join(dir, "run.json");
  const ledgerPath = join(dir, "known-risk-ledger.json");
  writeFileSync(ledgerPath, `${JSON.stringify({
    version: "known-risk-ledger.v1",
    updated_at: NOW.toISOString(),
    risks: [
      risk("risk-20260602-workbench-server-test-shards", "medium", "open", {
        title: "Workbench server test suite remains a broad large-file regression surface",
        source: "large-file-governance-p2",
        scope: ["test/workbench-server.test.js"],
        owned_files: ["test/workbench-server.test.js"],
        acceptance_gates: ["npm run check:large-files", "DeepSeek read-only review confirms behavior preservation"]
      }),
      risk("risk-20260602-workbench-server-route-groups", "medium", "open", {
        title: "Workbench server entrypoint still owns too many route and runtime responsibilities",
        source: "large-file-governance-p2",
        scope: ["tools/workbench-server.mjs"],
        owned_files: ["tools/workbench-server.mjs"],
        acceptance_gates: ["npm run check:large-files", "DeepSeek read-only review confirms behavior preservation"],
        depends_on: ["risk-20260602-workbench-server-test-shards"]
      })
    ]
  }, null, 2)}\n`);

  const { execFileSync } = await import("node:child_process");
  execFileSync("node", [
    "tools/run-with-node18.mjs",
    "tools/run-known-risk-closeout.mjs",
    "--ledger",
    ledgerPath,
    "--max-risks",
    "1",
    "--output",
    output,
    "--now",
    NOW.toISOString()
  ], { encoding: "utf8" });

  const artifact = JSON.parse(readFileSync(output, "utf8"));

  assert.deepEqual(artifact.selected_risks.map((risk) => risk.id), [
    "risk-20260602-workbench-server-test-shards"
  ]);
  assert.equal(artifact.selected_risks[0].action, "would_attempt_closeout");
  assert.equal(artifact.mode, "dry_run");
  assert.equal(artifact.preflight_only, true);
  assert.equal(artifact.closeout_completed, false);
});

test("write mode is rejected before ledger or lock mutation", async (t) => {
  const dir = tempDir(t, "known-risk-closeout-write-");
  const lockPath = join(dir, "closeout.lock");
  const ledgerPath = join(dir, "known-risk-ledger.json");
  writeFileSync(ledgerPath, `${JSON.stringify({
    version: "known-risk-ledger.v1",
    updated_at: NOW.toISOString(),
    risks: [risk("risk-write-open", "medium")]
  }, null, 2)}\n`);
  const before = readFileSync(ledgerPath, "utf8");
  const { execFileSync } = await import("node:child_process");
  let output = "";
  assert.throws(() => {
    execFileSync("node", [
      "tools/run-with-node18.mjs",
      "tools/run-known-risk-closeout.mjs",
      "--ledger",
      ledgerPath,
      "--write",
      "--lock",
      lockPath,
      "--now",
      NOW.toISOString()
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  }, (error) => {
    output = error.stdout;
    return error.status === 2;
  });

  const after = readFileSync(ledgerPath, "utf8");
  const artifact = JSON.parse(output);

  assert.equal(before, after);
  assert.equal(existsSync(lockPath), false);
  assert.equal(artifact.mode, "write_mode_rejected");
  assert.equal(artifact.closeout_completed, false);
  assert.equal(artifact.cleanup.lock_status, "not_acquired");
  assert.equal(artifact.cleanup.worktrees_cleaned, false);
  assert.equal(artifact.gates[0].issues[0].code, "write_mode_not_implemented");
});
