#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { VERIFIED_PROVIDER_MULTI_AGENT_PROFILE } from "../src/workflow/context-work-package-execution-adapter.js";
import { createClaudeDeepSeekContextWorkPackageProviderExecutor } from "../src/workflow/context-work-package-provider-executor.js";
import {
  withProviderAttemptsInRunArtifact,
  withProviderAttemptsInWorkflowState
} from "../src/workflow/context-work-package-provider-trial-artifact.js";
import { runContextWorkPackages } from "../src/workflow/context-work-package-runner.js";

const TRIAL_ARTIFACT_VERSION = "context-work-package-provider-trial.v1";

function usage() {
  return [
    "Usage: node tools/run-context-work-package-provider-trial.mjs --input <workflow-state.json> --output <trial-artifact.json>",
    "",
    "Options:",
    "  --workflow-output <path>      Write resulting workflow_state when the run passes",
    "  --in-place                    Write resulting workflow_state back to --input when the run passes",
    "  --max-package-count <n>       Dispatch at most this many pending packages",
    "  --cwd <path>                  Provider command cwd; defaults to current working directory",
    "  --timeout-seconds <seconds>   Bounded provider command timeout",
    "  --model <model>               Provider model; defaults to deepseek-v4-pro[1m]",
    "  --fallback-model <model>      Provider timeout fallback model; defaults to deepseek-v4-flash",
    "  --tools <tool-list>           Claude Code tools list, for example Read,Edit",
    "  --no-tools                    Pass an empty tools list to the provider command",
    "  --created-at <iso>            Stable timestamp for runner artifacts",
    "  --script-path <path>          Claude+DeepSeek wrapper script override",
    "  --python <path>               Python executable override",
    "  --effort <high|max>           Provider effort setting",
    "  --max-budget-usd <amount>     Provider budget cap passed to wrapper"
  ].join("\n");
}

function valueAfter(flag, args) {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  return args[index + 1] || null;
}

function hasFlag(flag, args) {
  return args.includes(flag);
}

function writeJson(path, value) {
  const destination = resolve(path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`);
  return destination;
}

function fakeCommandRunnerFromEnv() {
  const stdoutJson = process.env.AI_CONTROL_PLATFORM_PROVIDER_TRIAL_FAKE_STDOUT_JSON;
  if (!stdoutJson) return null;
  if (process.env.NODE_ENV !== "test" && process.env.AI_CONTROL_PLATFORM_ALLOW_FAKE_PROVIDER_TRIAL !== "1") {
    throw new Error("fake provider trial command runner is only allowed under NODE_ENV=test or explicit opt-in");
  }
  return () => ({
    status: 0,
    stdout: stdoutJson,
    stderr: "AI_CONTROL_PLATFORM_PROVIDER_TRIAL_FAKE_STDOUT_JSON used; not a real provider call"
  });
}

const args = process.argv.slice(2);
if (hasFlag("--help", args) || hasFlag("-h", args)) {
  console.log(usage());
  process.exit(0);
}

const inputPath = valueAfter("--input", args);
const outputPath = valueAfter("--output", args);
const workflowOutputPath = valueAfter("--workflow-output", args);
const inPlace = hasFlag("--in-place", args);

if (!inputPath || !outputPath) {
  console.error(usage());
  process.exit(1);
}

let workflowState;
let fakeRunner;
try {
  workflowState = JSON.parse(readFileSync(resolve(inputPath), "utf8"));
  fakeRunner = fakeCommandRunnerFromEnv();
} catch (error) {
  const artifact = {
    version: TRIAL_ARTIFACT_VERSION,
    status: "fail",
    phase: "input",
    issues: [{ code: "provider_trial_input_failed", message: error.message, path: "input" }],
    input_path: resolve(inputPath)
  };
  writeJson(outputPath, artifact);
  console.error(JSON.stringify(artifact, null, 2));
  process.exit(1);
}

const executor = createClaudeDeepSeekContextWorkPackageProviderExecutor({
  cwd: valueAfter("--cwd", args) || process.cwd(),
  timeout_seconds: valueAfter("--timeout-seconds", args),
  model: valueAfter("--model", args),
  fallback_model: valueAfter("--fallback-model", args),
  tools: valueAfter("--tools", args),
  no_tools: hasFlag("--no-tools", args),
  script_path: valueAfter("--script-path", args),
  python: valueAfter("--python", args),
  effort: valueAfter("--effort", args),
  max_budget_usd: valueAfter("--max-budget-usd", args),
  commandRunner: fakeRunner || undefined,
  command_runner_kind: fakeRunner ? "fake_test_command_runner" : undefined
});

const runnerOptions = {
  max_package_count: valueAfter("--max-package-count", args) || 1,
  execution_mode: "provider_model_routed",
  execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
  created_at: valueAfter("--created-at", args),
  provider_executor: executor
};
const result = runContextWorkPackages(workflowState, runnerOptions);
const rawProviderAttempts = result.executor_provenance?.provider_attempts ||
  result.artifact?.metadata?.executor_provenance?.provider_attempts ||
  [];
const shouldWriteWorkflowOutput = result.status === "pass" && result.workflow_state && (workflowOutputPath || inPlace);
const providerAttempts = rawProviderAttempts.map((attempt) => ({
  ...attempt,
  workflow_output_written: attempt.status === "pass" && Boolean(shouldWriteWorkflowOutput)
}));
const finalWorkflowState = shouldWriteWorkflowOutput
  ? withProviderAttemptsInWorkflowState(result.workflow_state, providerAttempts)
  : result.workflow_state || null;
const finalRunArtifact = withProviderAttemptsInRunArtifact(result.artifact, providerAttempts);
const rawExecutorProvenance = result.executor_provenance ||
  finalRunArtifact?.metadata?.executor_provenance ||
  null;
const finalExecutorProvenance = rawExecutorProvenance
  ? {
      ...rawExecutorProvenance,
      provider_attempts: providerAttempts
    }
  : null;
const artifact = {
  version: TRIAL_ARTIFACT_VERSION,
  status: result.status,
  phase: result.phase,
  input_path: resolve(inputPath),
  workflow_output_path: null,
  runner_options: {
    max_package_count: runnerOptions.max_package_count,
    execution_mode: runnerOptions.execution_mode,
    execution_profile: runnerOptions.execution_profile,
    provider_executor_injection: "runner_options",
    command_runner_kind: fakeRunner ? "fake_test_command_runner" : "spawn_sync",
    model: valueAfter("--model", args) || "deepseek-v4-pro[1m]",
    fallback_model: valueAfter("--fallback-model", args) || "deepseek-v4-flash"
  },
  result: {
    status: result.status,
    phase: result.phase,
    executed_count: result.executed_count || 0,
    executed_work_packages: result.executed_work_packages || [],
    selected_work_package_ids: result.selected_work_package_ids || [],
    issues: result.issues || [],
    artifact: finalRunArtifact || null,
    fixed_development_mode_gate: result.fixed_development_mode_gate || result.gate_result || null,
    execution_plan: result.execution_plan || null,
    model_routing: finalRunArtifact?.metadata?.model_routing || null,
    package_results: result.package_results || finalRunArtifact?.metadata?.package_results || [],
    executor_provenance: finalExecutorProvenance,
    provider_attempts: providerAttempts,
    completion_authority: result.completion_authority || result.artifact?.metadata?.completion_authority || null
  },
  workflow_state: finalWorkflowState
};

if (shouldWriteWorkflowOutput) {
  artifact.workflow_output_path = writeJson(inPlace ? inputPath : workflowOutputPath, finalWorkflowState);
}

const artifactPath = writeJson(outputPath, artifact);
console.log(JSON.stringify({
  status: artifact.status,
  phase: artifact.phase,
  output: artifactPath,
  workflow_output: artifact.workflow_output_path,
  executed_count: artifact.result.executed_count,
  executor_kind: artifact.result.executor_provenance?.executor_kind || null,
  external_calls: artifact.result.executor_provenance?.external_calls || null,
  command_runner_kind: artifact.runner_options.command_runner_kind
}, null, 2));

if (result.status !== "pass") {
  process.exit(1);
}
