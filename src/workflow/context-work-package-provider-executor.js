import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import {
  PROVIDER_MODEL_ROUTED_MODE,
  VERIFIED_PROVIDER_MULTI_AGENT_PROFILE
} from "./context-work-package-execution-adapter.js";
import {
  promptSafeContextPack,
  promptSafeWorkflowIdentity,
  promptSafeWorkPackages,
  promptSafetyPreamble
} from "./external-prompt-safety.js";

export const CONTEXT_WORK_PACKAGE_PROVIDER_EXECUTOR_VERSION = "context-work-package-provider-executor.v1";
export const DEFAULT_DEEPSEEK_REVIEW_SCRIPT = "/Users/hernando_zhao/.codex/skills/claude-deepseek-review/scripts/run_claude_deepseek_review.py";
export const DEFAULT_MODEL = "deepseek-v4-pro[1m]";
export const DEFAULT_FALLBACK_MODEL = "deepseek-v4-flash";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeToken(value) {
  return normalizeString(value).toLowerCase();
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function numberValue(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function toolsString(value, noTools = false) {
  if (noTools === true) return "";
  if (Array.isArray(value)) return value.map(normalizeString).filter(Boolean).join(",");
  return normalizeString(value);
}

function jsonCandidate(text) {
  const value = normalizeString(text);
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();

  const objectStart = value.indexOf("{");
  const objectEnd = value.lastIndexOf("}");
  if (objectStart !== -1 && objectEnd > objectStart) return value.slice(objectStart, objectEnd + 1);

  return "";
}

export function parseProviderExecutorOutput(stdout = "") {
  const candidate = jsonCandidate(stdout);
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function commandAuditFor(command = {}) {
  return {
    command: command.command,
    args: command.args,
    cwd: command.cwd,
    prompt_file: command.prompt_file,
    timeout_seconds: command.timeout_seconds,
    model: command.model,
    tools: command.tools,
    no_tools: command.tools === "",
    effort: command.effort,
    max_budget_usd: command.max_budget_usd,
    script_path: command.script_path,
    add_dir: command.add_dir,
    command_runner_kind: command.command_runner_kind
  };
}

function providerProvenance(command = {}, overrides = {}) {
  return {
    adapter_id: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    executor_version: CONTEXT_WORK_PACKAGE_PROVIDER_EXECUTOR_VERSION,
    executor_kind: "claude_deepseek_provider_executor",
    provider: "deepseek",
    model: command.model,
    execution_mode: PROVIDER_MODEL_ROUTED_MODE,
    execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    external_calls: 1,
    deterministic: false,
    timeout_seconds: command.timeout_seconds,
    tools: command.tools,
    no_tools: command.tools === "",
    cwd: command.cwd,
    prompt_file: command.prompt_file,
    command_runner_kind: command.command_runner_kind,
    ...overrides
  };
}

function packageFailureResults(selectedWorkPackages = [], reason, evidence = {}) {
  return selectedWorkPackages.map((workPackage) => ({
    work_package_id: workPackage.id,
    status: "fail",
    result: "fail",
    completion_evidence: {
      kind: "provider_execution_failure",
      reason,
      evidence
    }
  }));
}

function failureResult({ selectedWorkPackages = [], reason, issueCode, command, stdout = "", stderr = "", exitCode = null, timedOut = false }) {
  const evidence = {
    issue_code: issueCode,
    stdout,
    stderr,
    exit_code: exitCode,
    timed_out: timedOut,
    command: commandAuditFor(command)
  };

  return {
    status: "fail",
    completion_evidence: {
      kind: "provider_execution_failure",
      reason,
      evidence
    },
    package_results: packageFailureResults(selectedWorkPackages, reason, evidence),
    executor_provenance: providerProvenance(command, {
      exit_code: exitCode,
      timed_out: timedOut,
      external_calls: command ? 1 : 0
    }),
    findings: [
      {
        id: issueCode,
        status: "fail",
        severity: timedOut ? "medium" : "high",
        category: "provider_executor",
        message: reason,
        evidence
      }
    ]
  };
}

function fallbackModelFrom(options = {}, primaryModel) {
  const explicit = normalizeString(options.fallback_model ?? options.fallbackModel);
  const fallback = explicit || DEFAULT_FALLBACK_MODEL;
  return fallback && fallback !== primaryModel ? fallback : "";
}

function promptSafeExecutionPlan(executionPlan = {}) {
  const packagePlans = asArray(executionPlan.package_plans || executionPlan.packagePlans);
  return {
    status: normalizeString(executionPlan.status) || null,
    executor_kind: normalizeString(executionPlan.executor_kind || executionPlan.executorKind) || null,
    selected_model: normalizeString(executionPlan.selected_model || executionPlan.selectedModel) || null,
    package_plan_count: packagePlans.length,
    acceptance_gates: [
      ...new Set(packagePlans.flatMap((plan) => asArray(plan?.routing_request?.context_pack?.acceptance_gates)))
    ].map(normalizeString).filter(Boolean),
    notes: "Detailed routing metadata is omitted from this provider prompt to keep the request compact."
  };
}

function providerAttemptEvidence({ command, result, status, issueCode, workflowOutputWritten = false }) {
  const stdout = normalizeString(result?.stdout);
  const stderr = normalizeString(result?.stderr);
  const exitCode = Number(result?.status ?? result?.exitCode ?? (result?.error ? 1 : 0));
  const timedOut = exitCode === 124 || result?.error?.code === "ETIMEDOUT" || /CLAUDE_DEEPSEEK_TIMEOUT/.test(stderr);
  return {
    model: command.model,
    timeout_seconds: command.timeout_seconds,
    command_runner_kind: command.command_runner_kind,
    status,
    issue: issueCode || null,
    external_calls: 1,
    timed_out: timedOut,
    workflow_output_written: workflowOutputWritten,
    exit_code: exitCode,
    command: commandAuditFor(command)
  };
}

function withAttempts(result = {}, attempts = []) {
  const totalExternalCalls = attempts.reduce((count, attempt) => count + Number(attempt.external_calls || 0), 0);
  return {
    ...result,
    provider_attempts: attempts,
    executor_provenance: {
      ...(result.executor_provenance || {}),
      external_calls: totalExternalCalls,
      provider_attempts: attempts
    }
  };
}

export function promptForProviderExecution(input = {}) {
  const workflowState = input.workflow_state || {};
  const selectedWorkPackages = asArray(input.selected_work_packages);
  const executionPlan = input.execution_plan || {};

  return [
    "# Verified Provider Context Work Package Execution",
    "",
    "You are a bounded external provider executor for AI Control Platform context tasks.",
    "Return only one JSON object. Do not wrap it in prose.",
    "",
    promptSafetyPreamble(),
    "",
    "Completion rules:",
    "- Use status=pass only if the selected tasks were actually completed by this provider run.",
    "- Do not claim pass for local, mock, simulation, dry-run, planning-only, or unverified output.",
    "- If execution cannot complete, return status=fail with durable findings and evidence.",
    "- Every selected package must have a package_results entry with status and completion_evidence.",
    "",
    "Required JSON shape:",
    JSON.stringify({
      status: "pass|fail",
      completion_evidence: {
        kind: "provider_execution",
        summary: "what was completed or why completion failed"
      },
      package_results: [
        {
          work_package_id: "selected package id",
          status: "pass|fail",
          result: "pass|fail",
          completion_evidence: {
            kind: "package_completion",
            summary: "evidence for this package"
          }
        }
      ],
      findings: []
    }, null, 2),
    "",
    "Workflow identity:",
    JSON.stringify({
      ...promptSafeWorkflowIdentity(workflowState),
      context_pack: promptSafeContextPack(workflowState?.manifest?.context_pack || {})
    }, null, 2),
    "",
    "Selected tasks:",
    JSON.stringify(promptSafeWorkPackages(selectedWorkPackages), null, 2),
    "",
    "Provider/model routing execution plan:",
    JSON.stringify(promptSafeExecutionPlan(executionPlan), null, 2)
  ].join("\n");
}

export function createClaudeDeepSeekProviderCommand(input = {}) {
  const cwd = resolve(normalizeString(input.cwd) || process.cwd());
  const scriptPath = normalizeString(input.script_path || input.scriptPath) || DEFAULT_DEEPSEEK_REVIEW_SCRIPT;
  const timeoutSeconds = numberValue(input.timeout_seconds || input.timeoutSeconds, 120);
  const model = normalizeString(input.model) || DEFAULT_MODEL;
  const tools = toolsString(input.tools ?? input.allowed_tools ?? input.allowedTools, input.no_tools === true || input.noTools === true);
  const promptFile = normalizeString(input.prompt_file || input.promptFile);
  const addDir = normalizeString(input.add_dir || input.addDir) || cwd;
  const effort = normalizeToken(input.effort) || "high";
  const maxBudgetUsd = normalizeString(input.max_budget_usd || input.maxBudgetUsd) || "1";
  const args = [
    scriptPath,
    "--cwd",
    cwd,
    "--prompt-file",
    promptFile,
    "--timeout-seconds",
    String(timeoutSeconds),
    "--tools",
    tools,
    "--model",
    model,
    "--max-budget-usd",
    maxBudgetUsd,
    "--effort",
    effort,
    "--add-dir",
    addDir
  ];

  return {
    command: normalizeString(input.python || input.python_bin || input.pythonBin) || "python3",
    args,
    cwd,
    prompt_file: promptFile,
    timeout_seconds: timeoutSeconds,
    tools,
    model,
    effort,
    max_budget_usd: maxBudgetUsd,
    script_path: scriptPath,
    add_dir: addDir,
    command_runner_kind: normalizeString(input.command_runner_kind || input.commandRunnerKind) || "spawn_sync"
  };
}

function normalizeProviderPass(parsed = {}, command = {}) {
  return {
    ...parsed,
    executor_provenance: providerProvenance(command, parsed.executor_provenance || parsed.executorProvenance || parsed.provenance || {}),
    command_audit: commandAuditFor(command)
  };
}

export function createClaudeDeepSeekContextWorkPackageProviderExecutor(options = {}) {
  const commandRunner = options.commandRunner || ((command, args, runnerOptions) => spawnSync(command, args, runnerOptions));
  const commandRunnerKind = normalizeString(options.command_runner_kind || options.commandRunnerKind) ||
    (options.commandRunner ? "injected_command_runner" : "spawn_sync");

  return ({ workflow_state, selected_work_packages, execution_plan }) => {
    const tempDir = mkdtempSync(join(tmpdir(), "context-work-package-provider-"));
    const promptFile = join(tempDir, "provider-execution-prompt.md");
    writeFileSync(promptFile, promptForProviderExecution({
      workflow_state,
      selected_work_packages,
      execution_plan
    }));

    const primaryCommand = createClaudeDeepSeekProviderCommand({
      ...options,
      prompt_file: promptFile,
      command_runner_kind: commandRunnerKind
    });
    const fallbackModel = fallbackModelFrom(options, primaryCommand.model);
    const commands = [
      primaryCommand,
      ...(fallbackModel ? [
        createClaudeDeepSeekProviderCommand({
          ...options,
          model: fallbackModel,
          prompt_file: promptFile,
          command_runner_kind: commandRunnerKind
        })
      ] : [])
    ];
    const attempts = [];
    let lastFailure = null;

    for (const [index, command] of commands.entries()) {
      const result = commandRunner(command.command, command.args, {
        cwd: command.cwd,
        encoding: "utf8",
        timeout: (command.timeout_seconds + 5) * 1000
      });
      const stdout = normalizeString(result?.stdout);
      const stderr = normalizeString(result?.stderr);
      const exitCode = Number(result?.status ?? result?.exitCode ?? (result?.error ? 1 : 0));
      const timedOut = exitCode === 124 || result?.error?.code === "ETIMEDOUT" || /CLAUDE_DEEPSEEK_TIMEOUT/.test(stderr);

      if (exitCode !== 0 || result?.error) {
        const issueCode = timedOut ? "provider_executor_timeout" : "provider_executor_command_failed";
        attempts.push(providerAttemptEvidence({
          command,
          result,
          status: "fail",
          issueCode
        }));
        lastFailure = failureResult({
          selectedWorkPackages: selected_work_packages,
          reason: timedOut
            ? `Claude+DeepSeek provider executor timed out after ${command.timeout_seconds}s`
            : `Claude+DeepSeek provider executor failed with exit code ${exitCode}`,
          issueCode,
          command,
          stdout,
          stderr,
          exitCode,
          timedOut
        });
        if (timedOut && index < commands.length - 1) continue;
        return withAttempts(lastFailure, attempts);
      }

      const parsed = parseProviderExecutorOutput(stdout);
      if (!parsed) {
        const issueCode = "provider_executor_unstructured_output";
        attempts.push(providerAttemptEvidence({
          command,
          result,
          status: "fail",
          issueCode
        }));
        lastFailure = failureResult({
          selectedWorkPackages: selected_work_packages,
          reason: "Claude+DeepSeek provider executor returned non-structured output; completion was not trusted",
          issueCode,
          command,
          stdout,
          stderr,
          exitCode,
          timedOut: false
        });
        if (index < commands.length - 1) continue;
        return withAttempts(lastFailure, attempts);
      }

      attempts.push(providerAttemptEvidence({
        command,
        result,
        status: "pass",
        issueCode: null
      }));
      return withAttempts(normalizeProviderPass(parsed, command), attempts);
    }

    return withAttempts(lastFailure, attempts);
  };
}
