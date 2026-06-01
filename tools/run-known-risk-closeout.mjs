#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { evaluateKnownRiskLedger, readKnownRiskLedger } from "./risk-ledger.mjs";
import { loadRiskCloseoutPolicy } from "./risk-closeout-policy.mjs";
import { inspectRiskCloseoutLock, staleInProgressRiskActions } from "./risk-closeout-recovery.mjs";

const SEVERITY_RANK = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3
};

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function nowDate(value) {
  return value instanceof Date ? value : new Date(value || Date.now());
}

function compareRiskPriority(left, right) {
  const severity = (SEVERITY_RANK[left.severity] ?? 99) - (SEVERITY_RANK[right.severity] ?? 99);
  if (severity !== 0) return severity;
  return String(left.created_at || "").localeCompare(String(right.created_at || ""));
}

export function selectKnownRisksForCloseout(ledger, options = {}) {
  const maxRisks = Number.isInteger(options.maxRisks) && options.maxRisks > 0 ? options.maxRisks : 1;
  const explicitIds = asArray(options.riskIds).filter(nonEmptyString);
  const risks = asArray(ledger?.risks);
  const selected = explicitIds.length > 0
    ? explicitIds.map((id) => risks.find((risk) => risk?.id === id)).filter(Boolean)
    : risks
        .filter((risk) => ["open", "in_progress"].includes(risk?.status))
        .sort(compareRiskPriority)
        .slice(0, maxRisks);
  return selected.map((risk) => ({
    id: risk.id,
    status: risk.status,
    severity: risk.severity,
    title: risk.title,
    action: options.dryRun === false ? "attempt_closeout" : "would_attempt_closeout"
  }));
}

export function createKnownRiskCloseoutRunArtifact(input = {}) {
  const now = nowDate(input.now);
  const ledger = input.ledger || { version: "known-risk-ledger.v1", risks: [] };
  const policy = input.policy || null;
  const dryRun = input.dryRun !== false;
  const selectedRisks = selectKnownRisksForCloseout(ledger, {
    maxRisks: input.maxRisks,
    riskIds: input.riskIds,
    dryRun
  });
  const ledgerGate = evaluateKnownRiskLedger(ledger, {
    policy,
    requireClosed: false,
    now
  });
  const staleActions = staleInProgressRiskActions(ledger, {
    now,
    staleAfterMs: input.staleAfterMs
  });
  const lock = input.lockPath
    ? inspectRiskCloseoutLock(input.lockPath, { now, staleAfterMs: input.lockStaleAfterMs })
    : { status: "not_configured", stale: false, lock: null };

  return {
    version: "known-risk-closeout-run.v1",
    run_id: input.runId || `known-risk-closeout-${now.toISOString()}`,
    mode: dryRun ? "dry_run" : "write_mode_not_implemented",
    status: dryRun ? "pass" : "fail",
    started_at: now.toISOString(),
    ledger_path: input.ledgerPath || null,
    policy_path: input.policyPath || null,
    selected_risks: selectedRisks,
    stale_in_progress: staleActions,
    gates: [{
      name: "check-known-risk-closeout",
      status: ledgerGate.status,
      issues: ledgerGate.issues
    }],
    reviewers: [],
    release_decision: {
      status: "not_evaluated_in_dry_run",
      merge_allowed: false,
      publish_allowed: false,
      owner_authorization_required: false
    },
    cleanup: {
      lock_status: lock.status,
      worktrees_cleaned: false,
      reason: dryRun ? "dry run does not mutate locks or worktrees" : "write mode not implemented"
    }
  };
}

function parseArgs(argv) {
  const options = {
    ledgerPath: "docs/governance/known-risk-ledger.json",
    policyPath: "docs/governance/ai-governed-risk-closeout-policy.example.json",
    outputPath: null,
    lockPath: null,
    maxRisks: 1,
    riskIds: [],
    dryRun: true,
    now: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--ledger") {
      options.ledgerPath = argv[index + 1];
      index += 1;
    } else if (arg === "--policy") {
      options.policyPath = argv[index + 1];
      index += 1;
    } else if (arg === "--output") {
      options.outputPath = argv[index + 1];
      index += 1;
    } else if (arg === "--lock") {
      options.lockPath = argv[index + 1];
      index += 1;
    } else if (arg === "--max-risks") {
      options.maxRisks = Number(argv[index + 1]);
      index += 1;
    } else if (arg === "--risk-id") {
      options.riskIds.push(argv[index + 1]);
      index += 1;
    } else if (arg === "--now") {
      options.now = argv[index + 1];
      index += 1;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--write") {
      options.dryRun = false;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return options;
}

function usage() {
  return [
    "usage: run-known-risk-closeout.mjs [--dry-run] [--max-risks n] [--risk-id id] [--output artifact.json]",
    "",
    "Creates a bounded known-risk closeout run artifact. Dry-run is the default and performs no ledger, lock, branch, or worktree mutation."
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exit(2);
  }

  if (options.help) {
    console.log(usage());
    process.exit(0);
  }

  const ledger = readKnownRiskLedger(options.ledgerPath);
  const policyResult = loadRiskCloseoutPolicy(options.policyPath);
  if (policyResult.status !== "pass") {
    const artifact = {
      version: "known-risk-closeout-run.v1",
      status: "fail",
      mode: "dry_run",
      run_id: `known-risk-closeout-${nowDate(options.now).toISOString()}`,
      started_at: nowDate(options.now).toISOString(),
      ledger_path: options.ledgerPath,
      policy_path: options.policyPath,
      selected_risks: [],
      gates: [{ name: "policy-load", status: "fail", issues: policyResult.issues }],
      reviewers: [],
      release_decision: { status: "not_evaluated", merge_allowed: false, publish_allowed: false, owner_authorization_required: true },
      cleanup: { lock_status: "not_acquired", worktrees_cleaned: false, reason: "policy failed closed" }
    };
    console.log(JSON.stringify(artifact, null, 2));
    process.exit(1);
  }

  const artifact = createKnownRiskCloseoutRunArtifact({
    ledger,
    policy: policyResult.policy,
    ledgerPath: options.ledgerPath,
    policyPath: options.policyPath,
    lockPath: options.lockPath,
    maxRisks: options.maxRisks,
    riskIds: options.riskIds,
    dryRun: options.dryRun,
    now: options.now
  });

  if (options.outputPath) {
    writeFileSync(options.outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
  }
  console.log(JSON.stringify(artifact, null, 2));

  if (artifact.status !== "pass") {
    process.exit(1);
  }
}
