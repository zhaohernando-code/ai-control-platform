#!/usr/bin/env node
import {
  evaluateKnownRiskLedger,
  readKnownRiskLedger,
  readRiskCloseoutPolicy
} from "./risk-ledger.mjs";

function parseArgs(argv) {
  const options = {
    ledgerPath: "docs/governance/known-risk-ledger.json",
    policyPath: null,
    requireClosed: false,
    now: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--require-closed") {
      options.requireClosed = true;
    } else if (arg === "--policy") {
      options.policyPath = argv[index + 1];
      index += 1;
    } else if (arg === "--now") {
      options.now = argv[index + 1];
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (!arg.startsWith("--")) {
      options.ledgerPath = arg;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return options;
}

function usage() {
  return [
    "usage: check-known-risk-closeout.mjs [ledger.json] [--policy policy.json] [--require-closed] [--now ISO_DATE]",
    "",
    "Default mode validates ledger structure and terminal-status evidence while allowing open risks.",
    "--require-closed mode is the closeout gate: open and in_progress risks fail."
  ].join("\n");
}

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
const policy = options.policyPath ? readRiskCloseoutPolicy(options.policyPath) : undefined;
const result = evaluateKnownRiskLedger(ledger, {
  policy,
  requireClosed: options.requireClosed,
  now: options.now || undefined
});

console.log(JSON.stringify(result, null, 2));

if (result.status !== "pass") {
  process.exit(1);
}
