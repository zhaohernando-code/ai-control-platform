#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  runHeadlessCliMainOrchestrator,
  runHeadlessCliMainOrchestratorLoop
} from "../src/workflow/headless-cli-orchestrator.js";

function valueAfter(flag, args) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : "";
}

function hasFlag(flag, args) {
  return args.includes(flag);
}

function usage() {
  return [
    "Usage: node tools/run-headless-cli-orchestrator.mjs --project-status PROJECT_STATUS.json --workflow-state docs/examples/current-session-workbench-input.json --output tmp/headless-cli-orchestrator-output.json",
    "",
    "Runs one bounded headless Codex CLI main_orchestrator cycle from durable repository state.",
    "",
    "Optional governed agent execution:",
    "  --agent-profile <profile>           Agent invocation profile for bounded implementation",
    "  --agent-id <id>                     Optional configured channel id",
    "  --agent-model <model>               Optional model override inside the profile",
    "  --agent-candidate-index <n>         Candidate index inside the profile",
    "  --agent-timeout-ms <ms>             Governed invocation timeout",
    "  --agent-output-path <path>          Optional structured JSON output path template",
    "  --allow-mock-child-worker            Explicitly allow the built-in deterministic mock child worker",
    "  --agent-max-attempts <n>            Retry bound, capped at 3",
    "  --agent-split-retry                 Mark retries as split retries",
    "",
    "Optional persistence/loop:",
    "  --history-path <path>                Projection history path to update with headless snapshots",
    "  --snapshots-root <path>              Snapshot directory for headless workflow_state outputs",
    "  --snapshot-prefix <id>               Snapshot id prefix",
    "  --loop                               Run a bounded continuation loop",
    "  --max-iterations <n>                 Loop iteration bound, 1-5",
    "  --execution-strategy <strategy>      Use projected_next_action to call the workbench next-action API",
    "  --workbench-base-url <url>           Local workbench service URL for projected next actions",
    "  --workbench-projection-id <id>       Projection history id to execute through the workbench service",
    "  --projected-next-action <action>     Override the projected action readout for service trials",
    "  --projected-next-action-status <status>  Override projected action status, usually ready",
    "  --execution-profile <profile>        Reviewer/projected action execution profile",
    "  --context-work-package-execution-profile <profile>  Context package execution profile, defaults to service behavior",
    "  --reviewer-mock-status <status>      Mock reviewer status for approved mock projected shard runs",
    "  --reviewer-mock-findings-json <json> Mock reviewer findings JSON",
    "  --max-external-reviewer-calls <n>    Bounded real reviewer external-call budget",
    "  --provider-cost-mode <mode>          Bounded real reviewer provider cost mode",
    "  --timeout-seconds <n>                Bounded real reviewer timeout"
  ].join("\n");
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch (error) {
    throw new Error(`${label} read failed: ${error.message}`);
  }
}

const args = process.argv.slice(2);
if (hasFlag("--help", args) || hasFlag("-h", args)) {
  console.log(usage());
  process.exit(0);
}

const projectStatusPath = valueAfter("--project-status", args);
const workflowStatePath = valueAfter("--workflow-state", args);
const projectionHistoryPath = valueAfter("--projection-history", args);
const outputPath = valueAfter("--output", args);
const workflowOutputPath = valueAfter("--workflow-output", args);
const historyPath = valueAfter("--history-path", args);
const snapshotsRoot = valueAfter("--snapshots-root", args);
const snapshotPrefix = valueAfter("--snapshot-prefix", args);
const maxIterations = valueAfter("--max-iterations", args);
const executionStrategy = valueAfter("--execution-strategy", args);
const workbenchBaseUrl = valueAfter("--workbench-base-url", args);
const workbenchProjectionId = valueAfter("--workbench-projection-id", args);
const projectedNextAction = valueAfter("--projected-next-action", args);
const projectedNextActionStatus = valueAfter("--projected-next-action-status", args);
const reviewerMockStatus = valueAfter("--reviewer-mock-status", args);
const reviewerMockFindingsJson = valueAfter("--reviewer-mock-findings-json", args);
const agentProfile = valueAfter("--agent-profile", args);
const agentId = valueAfter("--agent-id", args);
const agentModel = valueAfter("--agent-model", args);
const agentCandidateIndex = valueAfter("--agent-candidate-index", args);
const agentTimeoutMs = valueAfter("--agent-timeout-ms", args);
const agentOutputPath = valueAfter("--agent-output-path", args);
const agentMaxAttempts = valueAfter("--agent-max-attempts", args);

if (!projectStatusPath || !workflowStatePath || !outputPath) {
  console.error(usage());
  process.exit(1);
}

const removedAgentCommandFlags = [
  "--child-worker-command",
  "--child-worker-arg",
  "--default-child-provider-command",
  "--default-child-provider-arg",
  "--child-worker-timeout-ms",
  "--child-worker-output-path",
  "--child-worker-max-attempts",
  "--child-worker-split-retry"
];
const removedFlag = removedAgentCommandFlags.find((flag) => hasFlag(flag, args));
if (removedFlag) {
  console.error(`Removed external command flag is not supported: ${removedFlag}. Use --agent-profile with config/agent-profiles.json.`);
  process.exit(1);
}

let result;
try {
  const projectStatus = readJson(projectStatusPath, "PROJECT_STATUS");
  const workflowState = readJson(workflowStatePath, "workflow_state");
  const projectionHistory = projectionHistoryPath
    ? readJson(projectionHistoryPath, "projection_history")
    : null;

  const runInput = {
    role: "main_orchestrator",
    project_status: projectStatus,
    workflow_state: workflowState,
    projection_history: projectionHistory
  };
  const runOptions = {
    cycle_id: valueAfter("--cycle-id", args),
    created_at: valueAfter("--created-at", args),
    max_package_count: valueAfter("--max-package-count", args) || 1,
    max_iterations: maxIterations || 1,
    execution_strategy: executionStrategy,
    workbench_base_url: workbenchBaseUrl,
    workbench_projection_id: workbenchProjectionId,
    execution_profile: valueAfter("--execution-profile", args),
    context_work_package_execution_profile: valueAfter("--context-work-package-execution-profile", args),
    reviewer_mock_status: reviewerMockStatus,
    reviewer_mock_findings_json: reviewerMockFindingsJson,
    max_external_reviewer_calls: valueAfter("--max-external-reviewer-calls", args),
    provider_cost_mode: valueAfter("--provider-cost-mode", args),
    budget_tier: valueAfter("--budget-tier", args),
    risk: valueAfter("--risk", args),
    timeout_seconds: valueAfter("--timeout-seconds", args),
    record_provider_health_on_timeout: hasFlag("--record-provider-health-on-timeout", args) ? true : undefined,
    provider_smoke_status: valueAfter("--provider-smoke-status", args),
    projected_next_action_readout: projectedNextAction || projectedNextActionStatus ? {
      status: projectedNextActionStatus || "ready",
      action: projectedNextAction
    } : undefined,
    projection_history_path: historyPath,
    snapshots_root: snapshotsRoot,
    snapshot_prefix: snapshotPrefix,
    agent_invocation_profile: agentProfile,
    agent_invocation_agent_id: agentId,
    agent_invocation_model: agentModel,
    agent_invocation_candidate_index: agentCandidateIndex,
    agent_invocation_max_attempts: agentMaxAttempts,
    agent_invocation_split_retry: hasFlag("--agent-split-retry", args),
    agent_invocation_retry_policy: {
      max_attempts: agentMaxAttempts || 1,
      split_retry: hasFlag("--agent-split-retry", args)
    },
    child_worker_timeout_ms: agentTimeoutMs,
    child_worker_output_path: agentOutputPath,
    allow_mock_child_worker: hasFlag("--allow-mock-child-worker", args),
    command_runner_kind: agentProfile ? "agent_invocation_child_process" : undefined
  };

  result = hasFlag("--loop", args)
    ? runHeadlessCliMainOrchestratorLoop(runInput, runOptions)
    : runHeadlessCliMainOrchestrator(runInput, runOptions);
} catch (error) {
  result = {
    status: "blocked",
    phase: "headless_cli_orchestrator_cli",
    role: "main_orchestrator",
    issues: [{ code: "headless_cli_orchestrator_cli_failed", message: error.message, path: "" }]
  };
}

const resolvedOutput = resolve(outputPath);
mkdirSync(dirname(resolvedOutput), { recursive: true });
writeFileSync(resolvedOutput, `${JSON.stringify(result, null, 2)}\n`);

const finalWorkflowState = result.workflow_state || result.last_result?.workflow_state || null;
if (workflowOutputPath && finalWorkflowState) {
  const resolvedWorkflowOutput = resolve(workflowOutputPath);
  mkdirSync(dirname(resolvedWorkflowOutput), { recursive: true });
  writeFileSync(resolvedWorkflowOutput, `${JSON.stringify(finalWorkflowState, null, 2)}\n`);
}

const summary = {
  status: result.status,
  phase: result.phase,
  role: result.role,
  output: resolvedOutput,
  workflow_output: workflowOutputPath && finalWorkflowState ? resolve(workflowOutputPath) : null,
  child_role: result.child_role || result.last_result?.child_role || null,
  context_pack_host: result.context_pack?.host || null,
  lifecycle_status: result.lifecycle_cleanup?.after?.status || result.last_result?.lifecycle_cleanup?.after?.status || null,
  next_action: result.projection?.next_action_readout?.action || result.last_result?.projection?.next_action_readout?.action || null,
  must_continue: result.must_continue ?? result.last_result?.must_continue ?? null,
  issue_count: Array.isArray(result.issues) ? result.issues.length : 0
};

if (result.status === "pass" || result.status === "complete") {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.error(JSON.stringify(summary, null, 2));
  process.exit(1);
}
