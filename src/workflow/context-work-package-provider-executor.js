import { resolve } from "node:path";

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
import {
  createAgentInvocationPlan,
  runAgentInvocation
} from "./agent-invocation.js";

export const CONTEXT_WORK_PACKAGE_PROVIDER_EXECUTOR_VERSION = "context-work-package-provider-executor.v1";
export const DEFAULT_MODEL = "deepseek-v4-pro[1m]";
export const DEFAULT_FALLBACK_MODEL = "deepseek-v4-flash";
export const DEFAULT_HARD_TIMEOUT_SECONDS = 7200;
export const DEFAULT_IDLE_TIMEOUT_SECONDS = 1800;

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
  const normalized = normalizeString(value);
  return normalized || undefined;
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

// Some provider CLIs wrap structured output as {"type":"result","result":"<json string>"}.
// We unwrap that recursively, but a malformed or self-referential payload (result that
// re-encodes the same wrapper) could otherwise recurse without bound and crash the worker.
// Cap the unwrap depth so parsing fails closed (returns null) instead of overflowing.
export const PROVIDER_OUTPUT_MAX_UNWRAP_DEPTH = 8;

function isResultWrapper(parsed) {
  return isObject(parsed) && normalizeString(parsed.type) === "result" && typeof parsed.result === "string";
}

export function parseProviderExecutorOutput(stdout = "", depth = 0) {
  if (depth > PROVIDER_OUTPUT_MAX_UNWRAP_DEPTH) return null;
  const direct = normalizeString(stdout);
  const lines = direct.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of [...lines].reverse()) {
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(line);
      if (isObject(parsed?.structured_output || parsed?.structuredOutput)) {
        return parsed.structured_output || parsed.structuredOutput;
      }
      if (isResultWrapper(parsed)) {
        return parseProviderExecutorOutput(parsed.result, depth + 1);
      }
      if (isObject(parsed) && normalizeString(parsed.status)) return parsed;
    } catch {
      // Continue scanning earlier stream-json records.
    }
  }
  if (direct.startsWith("{") && direct.endsWith("}")) {
    try {
      const parsed = JSON.parse(direct);
      if (isObject(parsed?.structured_output || parsed?.structuredOutput)) {
        return parsed.structured_output || parsed.structuredOutput;
      }
      if (isResultWrapper(parsed)) {
        return parseProviderExecutorOutput(parsed.result, depth + 1);
      }
      return isObject(parsed) ? parsed : null;
    } catch {
      // Fall through to fenced/object extraction for CLIs that wrap JSON in prose.
    }
  }
  const candidate = jsonCandidate(stdout);
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate);
    if (isObject(parsed?.structured_output || parsed?.structuredOutput)) {
      return parsed.structured_output || parsed.structuredOutput;
    }
    if (isResultWrapper(parsed)) {
      return parseProviderExecutorOutput(parsed.result, depth + 1);
    }
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
    prompt_file: null,
    timeout_seconds: command.timeout_seconds,
    idle_timeout_seconds: command.idle_timeout_seconds,
    model: command.model,
    tools: command.tools,
    no_tools: command.no_tools === true,
    effort: command.effort,
    max_budget_usd: command.max_budget_usd,
    add_dir: command.add_dir,
    profile_id: command.profile_id,
    agent_id: command.agent_id,
    runner: command.runner,
    command_runner_kind: command.command_runner_kind
  };
}

function providerProvenance(command = {}, overrides = {}) {
  return {
    adapter_id: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    executor_version: CONTEXT_WORK_PACKAGE_PROVIDER_EXECUTOR_VERSION,
    executor_kind: "agent_invocation_provider_executor",
    provider: command.provider || "agent_invocation",
    model: command.model,
    execution_mode: PROVIDER_MODEL_ROUTED_MODE,
    execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    external_calls: 1,
    deterministic: false,
    timeout_seconds: command.timeout_seconds,
    idle_timeout_seconds: command.idle_timeout_seconds,
    tools: command.tools,
    no_tools: command.no_tools === true,
    cwd: command.cwd,
    prompt_file: null,
    profile_id: command.profile_id,
    agent_id: command.agent_id,
    runner: command.runner,
    command_runner_kind: command.command_runner_kind,
    ...overrides
  };
}

function releasePreviewLock(stateStore, invocation = {}) {
  const keyId = normalizeString(invocation.key?.id);
  const lockOwner = normalizeString(invocation.lock?.lock_owner || invocation.lock?.lockOwner);
  if (keyId && lockOwner && typeof stateStore?.releaseAgentKeyLock === "function") {
    stateStore.releaseAgentKeyLock(keyId, lockOwner);
  }
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
  const timedOut = exitCode === 124 || result?.error?.code === "ETIMEDOUT";
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
    "- In package_results, use the exact work_package_id value shown in Selected tasks. Do not use task_ref as the package id.",
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

export function createAgentContextWorkPackageProviderCommand(input = {}) {
  const cwd = resolve(normalizeString(input.cwd) || process.cwd());
  const timeoutSeconds = numberValue(input.timeout_seconds || input.timeoutSeconds, DEFAULT_HARD_TIMEOUT_SECONDS);
  const idleTimeoutSeconds = numberValue(input.idle_timeout_seconds || input.idleTimeoutSeconds || input.idle_timeout || input.idleTimeout, DEFAULT_IDLE_TIMEOUT_SECONDS);
  const model = normalizeString(input.model) || DEFAULT_MODEL;
  const noTools = input.no_tools === true || input.noTools === true;
  const tools = toolsString(input.tools ?? input.allowed_tools ?? input.allowedTools, noTools);
  const addDir = normalizeString(input.add_dir || input.addDir) || cwd;
  const effort = normalizeToken(input.effort) || "high";
  const planned = createAgentInvocationPlan({
    profile_id: "context_work_package_provider",
    prompt: normalizeString(input.prompt),
    cwd,
    model,
    tools,
    no_tools: noTools,
    add_dir: addDir,
    effort,
    output_format: normalizeString(input.output_format || input.outputFormat) || "stream-json",
    include_partial_messages: input.include_partial_messages !== false && input.includePartialMessages !== false,
    timeout_ms: timeoutSeconds * 1000,
    idle_timeout_ms: idleTimeoutSeconds * 1000,
    invocation_id: input.invocation_id || input.invocationId,
    candidate_index: input.candidate_index ?? input.candidateIndex
  }, {
    stateStore: input.stateStore || input.state_store,
    channels_path: input.channels_path || input.channelsPath,
    profiles_path: input.profiles_path || input.profilesPath
  });
  releasePreviewLock(input.stateStore || input.state_store, planned.invocation);
  const invocation = planned.invocation || {};
  return {
    status: planned.status,
    issues: planned.issues || [],
    command: invocation.command,
    args: invocation.args || [],
    cwd,
    timeout_seconds: timeoutSeconds,
    idle_timeout_seconds: idleTimeoutSeconds,
    tools,
    no_tools: noTools,
    model: invocation.model || model,
    effort,
    add_dir: addDir,
    profile_id: invocation.profile_id || "context_work_package_provider",
    agent_id: invocation.agent_id || null,
    runner: invocation.runner || null,
    provider: invocation.provider || null,
    candidate_index: input.candidate_index ?? input.candidateIndex ?? null,
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

export function createAgentContextWorkPackageProviderExecutor(options = {}) {
  const commandRunnerKind = normalizeString(options.command_runner_kind || options.commandRunnerKind) ||
    (options.commandRunner ? "injected_command_runner" : "spawn_sync");

  return ({ workflow_state, selected_work_packages, execution_plan }) => {
    const prompt = promptForProviderExecution({
      workflow_state,
      selected_work_packages,
      execution_plan
    });
    const primaryCommand = createAgentContextWorkPackageProviderCommand({
      ...options,
      prompt,
      command_runner_kind: commandRunnerKind
    });
    const fallbackModel = fallbackModelFrom(options, primaryCommand.model);
    const commands = [
      primaryCommand,
      ...(fallbackModel ? [
        createAgentContextWorkPackageProviderCommand({
          ...options,
          model: fallbackModel,
          prompt,
          command_runner_kind: commandRunnerKind
        })
      ] : [])
    ];
    const attempts = [];
    let lastFailure = null;

    for (const [index, command] of commands.entries()) {
      if (command.status && command.status !== "pass") {
        const issueCode = "provider_executor_invocation_planning_failed";
        const result = { status: 1, stdout: "", stderr: JSON.stringify(command.issues || []) };
        attempts.push(providerAttemptEvidence({ command, result, status: "fail", issueCode }));
        lastFailure = failureResult({
          selectedWorkPackages: selected_work_packages,
          reason: "agent provider executor could not create a governed invocation plan",
          issueCode,
          command,
          stdout: "",
          stderr: result.stderr,
          exitCode: 1,
          timedOut: false
        });
        if (index < commands.length - 1) continue;
        return withAttempts(lastFailure, attempts);
      }

      const invocationResult = runAgentInvocation({
        profile_id: "context_work_package_provider",
        prompt,
        cwd: command.cwd,
        model: command.model,
        tools: command.tools,
        add_dir: command.add_dir,
        effort: command.effort,
        timeout_ms: command.timeout_seconds * 1000,
        idle_timeout_ms: command.idle_timeout_seconds * 1000,
        invocation_id: `${normalizeString(workflow_state?.run_id || workflow_state?.runId) || "context-work-package"}:${index}`,
        candidate_index: command.candidate_index ?? undefined
      }, {
        stateStore: options.stateStore || options.state_store,
        channels_path: options.channels_path || options.channelsPath,
        profiles_path: options.profiles_path || options.profilesPath,
        commandRunner: options.commandRunner,
        parseOutput: parseProviderExecutorOutput,
        maxBuffer: options.maxBuffer
      });
      const result = {
        status: invocationResult.status === "pass" ? 0 : 1,
        stdout: invocationResult.stdout,
        stderr: invocationResult.stderr,
        error: invocationResult.result?.timed_out ? { code: "ETIMEDOUT" } : undefined
      };
      const stdout = normalizeString(result?.stdout);
      const stderr = normalizeString(result?.stderr);
      const exitCode = Number(result?.status ?? result?.exitCode ?? (result?.error ? 1 : 0));
      const timedOut = invocationResult.result?.timed_out === true || exitCode === 124 || result?.error?.code === "ETIMEDOUT";

      if (exitCode !== 0 || result?.error) {
        const issueCode = timedOut ? "provider_executor_timeout" : "provider_executor_command_failed";
        attempts.push(providerAttemptEvidence({ command, result, status: "fail", issueCode }));
        lastFailure = failureResult({
          selectedWorkPackages: selected_work_packages,
          reason: timedOut
            ? `agent provider executor timed out after ${command.timeout_seconds}s`
            : `agent provider executor failed with exit code ${exitCode}`,
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
        attempts.push(providerAttemptEvidence({ command, result, status: "fail", issueCode }));
        lastFailure = failureResult({
          selectedWorkPackages: selected_work_packages,
          reason: "agent provider executor returned non-structured output; completion was not trusted",
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

      attempts.push(providerAttemptEvidence({ command, result, status: "pass", issueCode: null }));
      return withAttempts(normalizeProviderPass(parsed, command), attempts);
    }

    return withAttempts(lastFailure, attempts);
  };
}
