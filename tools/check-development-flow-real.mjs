#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import {
  writeDevelopmentFlowC2CGovernance,
  writeDevelopmentFlowRealAcceptance
} from "../src/workflow/development-flow-real.js";
import { createSqliteWorkbenchStateStore } from "../src/workflow/workbench-state-store.js";
import { DEFAULT_LIVE_WORKBENCH_STATE_DB } from "../src/workflow/workbench-live-state-cleanliness.js";

function valueAfter(flag, args) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : "";
}

function hasFlag(flag, args) {
  return args.includes(flag);
}

function usage() {
  return [
    "Usage: node tools/check-development-flow-real.mjs [--output tmp/development-flow-real/latest.json]",
    "",
    "Default mode runs the low-cost C2C governance gate:",
    "  - Context work package provider C2C command governance through the real dispatch chain",
    "  - No Codex 5.5 or Claude code-landing model call is made unless --full-dual-cli is set",
    "",
    "Full mode additionally runs the real dual CLI development-flow acceptance gate:",
    "  - Codex CLI through project-owned agent invocation profiles",
    "  - Claude CLI through project-owned agent invocation profiles",
    "",
    "Optional overrides:",
    "  --full-dual-cli",
    "  --codex-model MODEL",
    "  --claude-model MODEL",
    "  --timeout-ms N",
    "  --state-db PATH",
    "  --manual-agent-config PATH"
  ].join("\n");
}

export function runDevelopmentFlowRealCheck(argv = process.argv.slice(2)) {
  if (hasFlag("--help", argv) || hasFlag("-h", argv)) {
    console.log(usage());
    return 0;
  }

  const runFullDualCli = hasFlag("--full-dual-cli", argv) || process.env.DEV_FLOW_FULL_DUAL_CLI === "1";
  const stateDbPath = valueAfter("--state-db", argv) ||
    process.env.AI_CONTROL_WORKBENCH_STATE_DB ||
    DEFAULT_LIVE_WORKBENCH_STATE_DB;
  const options = {
    output_path: valueAfter("--output", argv) || "tmp/development-flow-real/latest.json",
    codex_model: valueAfter("--codex-model", argv),
    claude_model: valueAfter("--claude-model", argv),
    timeout_ms: valueAfter("--timeout-ms", argv),
    manual_agent_config_path: valueAfter("--manual-agent-config", argv),
    stateStore: createSqliteWorkbenchStateStore({
      dbPath: stateDbPath,
      manualAgentConfigPath: valueAfter("--manual-agent-config", argv)
    })
  };
  const result = runFullDualCli
    ? writeDevelopmentFlowRealAcceptance(options)
    : writeDevelopmentFlowC2CGovernance(options);

  const summary = runFullDualCli
    ? {
      mode: "full_dual_cli",
      status: result.status,
      output: result.output_path,
      codex_cli: result.artifact.runs.codex_cli.status,
      claude_cli: result.artifact.runs.claude_cli.status,
      c2c_governance: result.artifact.c2c_governance.status,
      issue_count: result.artifact.evaluation.issues.length,
      issues: result.artifact.evaluation.issues.slice(0, 8)
    }
    : {
      mode: "provider_c2c_governance",
      status: result.status,
      output: result.output_path,
      codex_cli: "not_run_low_cost_default",
      claude_cli: "not_run_low_cost_default",
      c2c_governance: result.artifact.status,
      checks: result.artifact.checks,
      issue_count: result.artifact.issues.length,
      issues: result.artifact.issues.slice(0, 8)
    };

  const text = JSON.stringify(summary, null, 2);
  if (result.status === "pass") {
    console.log(text);
    return 0;
  }
  console.error(text);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runDevelopmentFlowRealCheck());
}
