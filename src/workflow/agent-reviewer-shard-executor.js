import { resolve } from "node:path";

import {
  createAgentInvocationPlan,
  runAgentInvocation
} from "./agent-invocation.js";

export const AGENT_REVIEWER_SHARD_EXECUTOR_VERSION = "agent-reviewer-shard-executor.v1";
export const DEFAULT_PROJECT_CWD = "/Users/hernando_zhao/codex/projects/ai-control-platform";
export const DEFAULT_MODEL = "deepseek-v4-pro[1m]";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function toolString(shard = {}) {
  return asArray(shard.allowed_tools).map(normalizeString).filter(Boolean).join(",");
}

function jsonCandidate(text) {
  const value = normalizeString(text);
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();

  const arrayStart = value.indexOf("[");
  const arrayEnd = value.lastIndexOf("]");
  if (arrayStart !== -1 && arrayEnd > arrayStart) return value.slice(arrayStart, arrayEnd + 1);

  const objectStart = value.indexOf("{");
  const objectEnd = value.lastIndexOf("}");
  if (objectStart !== -1 && objectEnd > objectStart) return value.slice(objectStart, objectEnd + 1);

  return "";
}

function normalizeFindingShape(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.findings)) return parsed.findings;
  if (parsed && typeof parsed === "object") return [parsed];
  return [];
}

export function parseAgentReviewerFindings(stdout = "") {
  const candidate = jsonCandidate(stdout);
  if (!candidate) return [];
  try {
    return normalizeFindingShape(JSON.parse(candidate));
  } catch {
    return [];
  }
}

export function createAgentReviewerShardCommand(input = {}) {
  const shard = input.shard || {};
  const cwd = resolve(normalizeString(input.cwd) || DEFAULT_PROJECT_CWD);
  const tools = input.tools !== undefined ? normalizeString(input.tools) : toolString(shard);
  const timeoutSeconds = Number(input.timeout_seconds || input.timeoutSeconds || shard.timeout_seconds || 180) || 180;
  const model = normalizeString(input.model || shard.model) || DEFAULT_MODEL;
  const planned = createAgentInvocationPlan({
    profile_id: "reviewer_shard",
    prompt: normalizeString(input.prompt),
    cwd,
    tools,
    model,
    add_dir: input.add_dir !== false && input.addDir !== false
      ? normalizeString(input.add_dir || input.addDir || cwd)
      : "",
    timeout_ms: timeoutSeconds * 1000,
    invocation_id: input.invocation_id || input.invocationId || normalizeString(shard.id),
    candidate_index: input.candidate_index ?? input.candidateIndex
  }, {
    channels_path: input.channels_path || input.channelsPath,
    profiles_path: input.profiles_path || input.profilesPath
  });
  const invocation = planned.invocation || {};
  return {
    status: planned.status,
    issues: planned.issues || [],
    command: invocation.command,
    args: invocation.args || [],
    cwd,
    timeout_seconds: timeoutSeconds,
    tools,
    model: invocation.model || model,
    profile_id: invocation.profile_id || "reviewer_shard",
    agent_id: invocation.agent_id || null,
    runner: invocation.runner || null,
    provider: invocation.provider || null
  };
}

export function createAgentReviewerShardExecutor(options = {}) {
  return async ({ shard, prompt }) => {
    const command = createAgentReviewerShardCommand({
      ...options,
      shard,
      prompt,
      invocation_id: `${normalizeString(shard?.id) || "reviewer-shard"}:${Date.now()}`
    });
    if (command.status && command.status !== "pass") {
      return {
        status: "fail",
        findings: [
          {
            id: `${normalizeString(shard?.id) || "reviewer-shard"}-agent-invocation-plan-failed`,
            status: "fail",
            severity: "high",
            category: "reviewer_executor",
            message: "Reviewer shard could not create a governed agent invocation plan.",
            evidence: { issues: command.issues || [] }
          }
        ],
        provenance: {
          executor_kind: "agent_invocation",
          provider: "agent_invocation",
          model: command.model,
          timeout_seconds: command.timeout_seconds,
          tools: command.tools,
          external_call_budget_used: 0
        },
        stdout: "",
        stderr: JSON.stringify(command.issues || [])
      };
    }

    const invocationResult = runAgentInvocation({
      profile_id: "reviewer_shard",
      prompt,
      cwd: command.cwd,
      model: command.model,
      tools: command.tools,
      add_dir: options.add_dir !== false && options.addDir !== false
        ? normalizeString(options.add_dir || options.addDir || command.cwd)
        : "",
      timeout_ms: command.timeout_seconds * 1000,
      invocation_id: `${normalizeString(shard?.id) || "reviewer-shard"}:${Date.now()}`
    }, {
      stateStore: options.stateStore || options.state_store,
      channels_path: options.channels_path || options.channelsPath,
      profiles_path: options.profiles_path || options.profilesPath,
      commandRunner: options.commandRunner,
      parseOutput: parseAgentReviewerFindings,
      maxBuffer: options.maxBuffer
    });

    const stdout = normalizeString(invocationResult.stdout);
    const stderr = normalizeString(invocationResult.stderr);
    const exitCode = Number(invocationResult.result?.exit_code ?? (invocationResult.status === "pass" ? 0 : 1));
    const timedOut = invocationResult.result?.timed_out === true;
    const findings = parseAgentReviewerFindings(stdout);
    const provenance = {
      executor_version: AGENT_REVIEWER_SHARD_EXECUTOR_VERSION,
      executor_kind: "agent_invocation",
      provider: invocationResult.invocation?.provider || command.provider || "agent_invocation",
      agent_id: invocationResult.invocation?.agent_id || command.agent_id,
      runner: invocationResult.invocation?.runner || command.runner,
      profile_id: "reviewer_shard",
      model: invocationResult.invocation?.model || command.model,
      timeout_seconds: command.timeout_seconds,
      tools: command.tools,
      external_call_budget_used: invocationResult.status === "pass" || exitCode !== 0 ? 1 : 0
    };

    if (exitCode === 0 && findings.length > 0) {
      return {
        status: findings.some((finding) => normalizeString(finding.status).toLowerCase() === "fail") ? "fail" : "pass",
        findings,
        provenance,
        stdout,
        stderr
      };
    }

    if (exitCode === 0) {
      return {
        status: "fail",
        findings: [
          {
            id: `${shard.id}-reviewer-unstructured-output`,
            status: "fail",
            severity: "medium",
            category: "evidence_gap",
            message: stdout
              ? "Reviewer shard returned unstructured text; structured findings are required before accepting the review."
              : "Reviewer shard returned no structured findings."
          }
        ],
        provenance,
        stdout,
        stderr
      };
    }

    return {
      status: "fail",
      findings: [
        {
          id: `${shard.id}-${timedOut ? "agent-timeout" : "agent-error"}`,
          status: "fail",
          severity: "medium",
          category: timedOut ? "reviewer_timeout" : "reviewer_executor",
          message: timedOut
            ? `Reviewer shard agent timed out after ${command.timeout_seconds}s`
            : `Reviewer shard agent failed with exit code ${exitCode}`,
          evidence: {
            stdout,
            stderr,
            model: provenance.model,
            agent_id: provenance.agent_id,
            tools: command.tools,
            timeout_seconds: command.timeout_seconds,
            failure_classification: invocationResult.result?.failure_classification || null
          }
        }
      ],
      provenance,
      stdout,
      stderr
    };
  };
}
