#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { writeDevelopmentFlowRealAcceptance } from "../src/workflow/development-flow-real.js";

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
    "Runs the dual real CLI development-flow acceptance gate:",
    "  - Codex CLI with gpt-5.3-codex-spark",
    "  - Claude CLI via DeepSeek with deepseek-v4-flash",
    "",
    "Optional overrides:",
    "  --codex-model MODEL",
    "  --claude-model MODEL",
    "  --timeout-ms N",
    "  --manual-agent-config PATH"
  ].join("\n");
}

export function runDevelopmentFlowRealCheck(argv = process.argv.slice(2)) {
  if (hasFlag("--help", argv) || hasFlag("-h", argv)) {
    console.log(usage());
    return 0;
  }

  const result = writeDevelopmentFlowRealAcceptance({
    output_path: valueAfter("--output", argv) || "tmp/development-flow-real/latest.json",
    codex_model: valueAfter("--codex-model", argv),
    claude_model: valueAfter("--claude-model", argv),
    timeout_ms: valueAfter("--timeout-ms", argv),
    manual_agent_config_path: valueAfter("--manual-agent-config", argv)
  });

  const summary = {
    status: result.status,
    output: result.output_path,
    codex_cli: result.artifact.runs.codex_cli.status,
    claude_cli: result.artifact.runs.claude_cli.status,
    issue_count: result.artifact.evaluation.issues.length,
    issues: result.artifact.evaluation.issues.slice(0, 8)
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
