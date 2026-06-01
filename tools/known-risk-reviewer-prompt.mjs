#!/usr/bin/env node
import { fileURLToPath } from "node:url";

import { readKnownRiskLedger } from "./risk-ledger.mjs";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function formatList(items) {
  const values = asArray(items).filter((item) => typeof item === "string" && item.trim().length > 0);
  if (values.length === 0) return "- none";
  return values.map((item) => `- ${item}`).join("\n");
}

function findRisk(ledger, riskId) {
  return asArray(ledger?.risks).find((risk) => risk?.id === riskId);
}

export function reviewerPromptForRisk(ledger, riskId, options = {}) {
  const risk = findRisk(ledger, riskId);
  if (!risk) {
    throw new Error(`risk not found: ${riskId}`);
  }
  const changedFiles = asArray(options.changedFiles);
  const diffSummary = typeof options.diffSummary === "string" ? options.diffSummary : "";

  return [
    "You are an independent read-only reviewer for an AI-governed known-risk closeout.",
    "",
    "Rules:",
    "- Do not edit files, run destructive commands, merge, publish, or clean worktrees.",
    "- Review whether the claimed fix actually closes the risk without weakening gates or hiding failures.",
    "- Treat missing evidence as inconclusive, not pass.",
    "- Return a JSON object that conforms to docs/governance/ai-reviewer-verdict.schema.json.",
    "",
    "Risk:",
    `- id: ${risk.id}`,
    `- title: ${risk.title}`,
    `- status: ${risk.status}`,
    `- severity: ${risk.severity}`,
    `- source: ${risk.source}`,
    "",
    "Scope:",
    formatList(risk.scope),
    "",
    "Owned files:",
    formatList(risk.owned_files),
    "",
    "Acceptance gates:",
    formatList(risk.acceptance_gates),
    "",
    "Current evidence summaries:",
    formatList(asArray(risk.evidence).map((entry) => entry?.summary).filter(Boolean)),
    "",
    "Changed files to inspect:",
    formatList(changedFiles),
    "",
    "Diff summary:",
    diffSummary || "- none supplied",
    "",
    "Verdict requirements:",
    "- Use verdict pass only when the fix is supported by code and verification evidence.",
    "- Put every must-fix issue in blocking_findings.",
    "- Put follow-up-only observations in non_blocking_findings.",
    "- If you cannot verify the claim from available evidence, use verdict inconclusive."
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    ledgerPath: "docs/governance/known-risk-ledger.json",
    riskId: null,
    changedFiles: [],
    diffSummary: ""
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--ledger") {
      options.ledgerPath = argv[index + 1];
      index += 1;
    } else if (arg === "--risk-id") {
      options.riskId = argv[index + 1];
      index += 1;
    } else if (arg === "--changed-file") {
      options.changedFiles.push(argv[index + 1]);
      index += 1;
    } else if (arg === "--diff-summary") {
      options.diffSummary = argv[index + 1];
      index += 1;
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
    "usage: known-risk-reviewer-prompt.mjs --risk-id risk-id [--ledger ledger.json] [--changed-file path] [--diff-summary text]",
    "",
    "Produces a read-only reviewer prompt for a single known-risk ledger entry."
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      process.exit(0);
    }
    if (!options.riskId) {
      throw new Error("--risk-id is required");
    }
    const ledger = readKnownRiskLedger(options.ledgerPath);
    console.log(reviewerPromptForRisk(ledger, options.riskId, options));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exit(2);
  }
}
