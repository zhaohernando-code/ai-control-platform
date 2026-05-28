import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { buildModelCollaborationPlan, MODEL_PROFILES } from "./model-router.js";

export const AGENT_INVOCATION_VERSION = "agent-invocation.v1";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_AGENT_CHANNELS_PATH = resolve(PROJECT_ROOT, "config/agent-channels.json");
export const DEFAULT_AGENT_PROFILES_PATH = resolve(PROJECT_ROOT, "config/agent-profiles.json");

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeToken(value) {
  return normalizeString(value).toLowerCase();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function secretRedactions(invocation = {}) {
  return [
    invocation?.key?.secret,
    invocation?.env?.ANTHROPIC_API_KEY,
    invocation?.env?.OPENAI_API_KEY
  ].map(normalizeString).filter(Boolean);
}

export function redactInvocationText(text = "", invocation = {}) {
  let output = normalizeString(text);
  for (const secret of secretRedactions(invocation)) {
    output = output.split(secret).join("[REDACTED]");
  }
  return output;
}

export function loadAgentInvocationConfig(options = {}) {
  const channelsPath = resolve(options.channels_path || options.channelsPath || DEFAULT_AGENT_CHANNELS_PATH);
  const profilesPath = resolve(options.profiles_path || options.profilesPath || DEFAULT_AGENT_PROFILES_PATH);
  return {
    version: AGENT_INVOCATION_VERSION,
    channels_path: channelsPath,
    profiles_path: profilesPath,
    channels: asArray(readJson(channelsPath).channels),
    profiles: readJson(profilesPath).profiles || {}
  };
}

function channelAuthType(channel = {}) {
  return normalizeString(channel.auth?.type || channel.auth_type || channel.authType);
}

function findChannel(config = {}, id = "") {
  return asArray(config.channels).find((channel) => normalizeString(channel.id) === normalizeString(id)) || null;
}

function profileFor(config = {}, profileId = "") {
  const id = normalizeString(profileId);
  return isObject(config.profiles?.[id]) ? { id, ...config.profiles[id] } : null;
}

function issue(code, message, path = "") {
  return { code, message, path };
}

function commandExists(command = "") {
  const value = normalizeString(command);
  if (!value) return false;
  if (value.includes("/")) return existsSync(value);
  const result = spawnSync("sh", ["-lc", `command -v ${JSON.stringify(value)}`], {
    encoding: "utf8",
    timeout: 5000
  });
  return result.status === 0;
}

function modelProfileFor(model = "") {
  const normalized = normalizeString(model);
  if (MODEL_PROFILES[normalized]) return MODEL_PROFILES[normalized];
  if (normalized.startsWith("claude-opus")) {
    return { model_id: normalized, family: "claude", cost_tier: "high", accuracy_tier: "very_high", latency_tier: "medium", strengths: ["architecture", "complex_planning", "implementation"] };
  }
  if (normalized.startsWith("claude-sonnet")) {
    return { model_id: normalized, family: "claude", cost_tier: "medium", accuracy_tier: "high", latency_tier: "medium", strengths: ["structured_planning", "implementation", "review"] };
  }
  if (normalized.startsWith("claude-haiku")) {
    return { model_id: normalized, family: "claude", cost_tier: "low", accuracy_tier: "medium", latency_tier: "low", strengths: ["fallback", "summarization", "routing"] };
  }
  if (normalized.startsWith("mimo")) {
    return { model_id: normalized, family: "mimo", cost_tier: "medium", accuracy_tier: "medium", latency_tier: "medium", strengths: ["anthropic_compatible", "fallback"] };
  }
  return { model_id: normalized || "unknown", family: "unknown", cost_tier: "medium", accuracy_tier: "medium", latency_tier: "medium", strengths: [] };
}

function selectCandidate({ config, profile, options = {} }) {
  const explicitAgentId = normalizeString(options.agent_id || options.agentId);
  const explicitModel = normalizeString(options.model);
  const candidateIndex = Number(options.candidate_index ?? options.candidateIndex ?? 0);
  const candidates = asArray(profile.candidates)
    .filter((candidate) => !explicitAgentId || normalizeString(candidate.agent_id || candidate.agentId) === explicitAgentId)
    .map((candidate) => ({
      ...candidate,
      model: explicitModel || normalizeString(candidate.model)
    }));
  const candidate = candidates[Math.max(0, candidateIndex)] || null;
  if (!candidate) return null;
  const channel = findChannel(config, candidate.agent_id || candidate.agentId);
  return channel ? { candidate, channel } : null;
}

function acquireKey(stateStore, profile = {}, channel = {}, input = {}) {
  if (!stateStore || typeof stateStore.acquireAgentKeyForRole !== "function") return { status: "not_configured", key: null };
  if (channelAuthType(channel) === "codex_account") return { status: "not_required", key: null };
  return stateStore.acquireAgentKeyForRole(profile.role, {
    agent_id: channel.id,
    lock_owner: normalizeString(input.lock_owner || input.lockOwner || input.invocation_id || input.invocationId) || `agent-invocation-${Date.now()}`,
    ttl_ms: input.lock_ttl_ms || input.lockTtlMs || profile.timeout_ms || profile.timeoutMs || 10 * 60 * 1000,
    now: input.created_at || input.createdAt
  });
}

function promptFromInput(input = {}) {
  const prompt = normalizeString(input.prompt);
  if (prompt) return prompt;
  const promptFile = normalizeString(input.prompt_file || input.promptFile);
  return promptFile ? readFileSync(promptFile, "utf8") : "";
}

function claudeInvocationCommand({ channel, profile, candidate, input, key }) {
  const prompt = promptFromInput(input);
  const command = normalizeString(input.command || channel.cli) || "claude";
  const model = normalizeString(input.model || candidate.model || channel.default_model || channel.defaultModel);
  const cwd = resolve(normalizeString(input.cwd) || process.cwd());
  const args = [];
  if (profile.bare !== false) args.push("--bare");
  args.push("--permission-mode", "bypassPermissions");
  if (profile.output_format) args.push("--output-format", profile.output_format);
  args.push("--no-session-persistence");
  if (profile.max_budget_usd || input.max_budget_usd || input.maxBudgetUsd) {
    args.push("--max-budget-usd", normalizeString(input.max_budget_usd || input.maxBudgetUsd || profile.max_budget_usd));
  }
  if (profile.effort || input.effort) args.push("--effort", normalizeString(input.effort || profile.effort));
  const tools = input.tools !== undefined ? normalizeString(input.tools) : normalizeString(profile.tools);
  const allowedTools = normalizeString(input.allowed_tools || input.allowedTools || tools);
  if (allowedTools) args.push("--allowedTools", allowedTools);
  const addDir = normalizeString(input.add_dir || input.addDir);
  if (addDir) args.push("--add-dir", addDir);
  if (input.json_schema || input.jsonSchema) args.push("--json-schema", typeof (input.json_schema || input.jsonSchema) === "string" ? input.json_schema || input.jsonSchema : JSON.stringify(input.json_schema || input.jsonSchema));
  args.push("--model", model, "-p", prompt);
  const env = {
    ...process.env,
    PATH: [
      process.env.PATH,
      "/Users/hernando_zhao/.local/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin"
    ].filter(Boolean).join(":"),
    ANTHROPIC_MODEL: model
  };
  if (channel.base_url || channel.baseUrl) env.ANTHROPIC_BASE_URL = normalizeString(channel.base_url || channel.baseUrl);
  if (key?.secret) env.ANTHROPIC_API_KEY = key.secret;
  return { command, args, cwd, env, model, runner: "claude" };
}

function codexInvocationCommand({ channel, profile, candidate, input, key }) {
  const prompt = promptFromInput(input);
  const command = normalizeString(input.command || channel.cli) || "codex";
  const model = normalizeString(input.model || candidate.model || channel.default_model || channel.defaultModel);
  const cwd = resolve(normalizeString(input.cwd) || process.cwd());
  const args = ["exec"];
  if (input.workspace_write !== false && input.sandbox !== "danger-full-access") args.push("-s", normalizeString(input.sandbox) || "workspace-write");
  const ephemeral = input.ephemeral ?? input.ephemeralMode ?? profile.ephemeral;
  if (ephemeral === true) args.push("--ephemeral");
  args.push("--color", "never");
  args.push("-C", cwd);
  if (input.output_schema || input.outputSchema) args.push("--output-schema", normalizeString(input.output_schema || input.outputSchema));
  if (input.output_path || input.outputPath) args.push("-o", normalizeString(input.output_path || input.outputPath));
  if (model) args.push("-m", model);
  args.push(prompt);
  const env = { ...process.env };
  if (channel.base_url || channel.baseUrl) env.OPENAI_BASE_URL = normalizeString(channel.base_url || channel.baseUrl);
  if (key?.secret) env.OPENAI_API_KEY = key.secret;
  return { command, args, cwd, env, model, runner: "codex" };
}

export function createAgentInvocationPlan(input = {}, options = {}) {
  const config = options.config || loadAgentInvocationConfig(options);
  const profile = profileFor(config, input.profile_id || input.profileId || input.flow || input.flowProfile);
  if (!profile) {
    return { status: "fail", issues: [issue("unknown_agent_invocation_profile", "agent invocation profile is not configured", "profile_id")] };
  }
  const selected = selectCandidate({ config, profile, options: input });
  if (!selected) {
    return { status: "blocked", issues: [issue("no_agent_candidate_for_profile", "no configured agent candidate is available for profile", "profile_id")] };
  }
  const keyResult = acquireKey(options.stateStore || options.state_store, profile, selected.channel, input);
  if (keyResult.status === "blocked" || keyResult.status === "fail") {
    return { status: "blocked", issues: keyResult.issues || [issue("agent_key_unavailable", "agent key unavailable", "agent_id")] };
  }
  const commandSpec = normalizeToken(selected.channel.runner) === "codex"
    ? codexInvocationCommand({ channel: selected.channel, profile, candidate: selected.candidate, input, key: keyResult.key })
    : claudeInvocationCommand({ channel: selected.channel, profile, candidate: selected.candidate, input, key: keyResult.key });
  const routing = buildModelCollaborationPlan({
    goal: input.goal || input.prompt || profile.id,
    stage: input.stage || profile.stage,
    risk: input.risk || profile.risk,
    budget_tier: input.budget_tier || input.budgetTier || profile.budget_tier,
    host: input.host || "platform_core",
    model_routing_strategy: input.model_routing_strategy || input.modelRoutingStrategy,
    tags: input.tags || profile.hooks || []
  });
  const invocation = {
    version: AGENT_INVOCATION_VERSION,
    id: normalizeString(input.invocation_id || input.invocationId) || `agent-invocation-${Date.now()}`,
    profile_id: profile.id,
    role: profile.role,
    stage: profile.stage,
    strength: profile.strength || null,
    hooks: asArray(profile.hooks),
    agent_id: selected.channel.id,
    agent_label: selected.channel.label || selected.channel.id,
    runner: commandSpec.runner,
    provider: normalizeToken(selected.channel.runner) === "codex" ? "codex" : "anthropic_compatible",
    model: commandSpec.model,
    model_profile: modelProfileFor(commandSpec.model),
    routing,
    command: commandSpec.command,
    args: commandSpec.args,
    cwd: commandSpec.cwd,
    env: commandSpec.env,
    key: keyResult.key || null,
    lock: keyResult.key?.lock || null,
    timeout_ms: Number(input.timeout_ms || input.timeoutMs || profile.timeout_ms || profile.timeoutMs || 180000)
  };
  return {
    status: "pass",
    invocation,
    issues: []
  };
}

function classifyFailure(result = {}, parsed = null) {
  const stderr = normalizeString(result.stderr);
  const stdout = normalizeString(result.stdout);
  const combined = `${stdout}\n${stderr}`;
  if (result.timed_out) return "timeout";
  if (/command not found|no such file|not executable/i.test(combined) || result.error?.code === "ENOENT") return "command_unavailable";
  if (/model.*not.*found|unknown model|invalid model|model_not_found/i.test(combined)) return "model_unavailable";
  if (/401|403|unauthorized|forbidden|auth/i.test(combined)) return "auth_failed";
  if (!parsed && normalizeString(stdout)) return "unstructured_output";
  return "command_failed";
}

export function runAgentInvocation(input = {}, options = {}) {
  const planned = createAgentInvocationPlan(input, options);
  if (planned.status !== "pass") return planned;
  const invocation = planned.invocation;
  const runner = options.commandRunner || ((command, args, runnerOptions) => spawnSync(command, args, runnerOptions));
  const startedAt = Date.now();
  const result = runner(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: invocation.env,
    encoding: "utf8",
    timeout: invocation.timeout_ms,
    maxBuffer: options.maxBuffer || 4 * 1024 * 1024
  });
  const latencyMs = Date.now() - startedAt;
  const exitCode = Number(result?.status ?? result?.exitCode ?? (result?.error ? 1 : 0));
  const timedOut = result?.error?.code === "ETIMEDOUT" || result?.signal === "SIGTERM" || exitCode === 124 || exitCode === 143;
  const stdout = redactInvocationText(result?.stdout || "", invocation);
  const stderr = redactInvocationText(result?.stderr || result?.error?.message || "", invocation);
  const outputText = normalizeString(stdout);
  const parsed = typeof options.parseOutput === "function" ? options.parseOutput(outputText) : null;
  if (invocation.key?.id && invocation.lock && typeof (options.stateStore || options.state_store)?.releaseAgentKeyLock === "function") {
    (options.stateStore || options.state_store).releaseAgentKeyLock(invocation.key.id, invocation.lock.lock_owner);
  }
  return {
    status: exitCode === 0 && !timedOut && !result?.error ? "pass" : "fail",
    stdout,
    stderr,
    parsed,
    invocation: {
      ...invocation,
      env: undefined,
      key: invocation.key ? { ...invocation.key, secret: undefined } : null,
      command_audit: {
        command: invocation.command,
        args: invocation.args.map((arg) => normalizeString(arg).length > 500 ? `${normalizeString(arg).slice(0, 500)}...<truncated>` : arg),
        timeout_ms: invocation.timeout_ms
      }
    },
    result: {
      exit_code: exitCode,
      signal: result?.signal || null,
      timed_out: timedOut,
      latency_ms: latencyMs,
      failure_classification: exitCode === 0 && !timedOut && !result?.error ? null : classifyFailure({ stdout, stderr, timed_out: timedOut, error: result?.error }, parsed)
    },
    issues: []
  };
}

export function writePromptTempFile(prompt = "", prefix = "agent-invocation-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const path = join(dir, "prompt.md");
  writeFileSync(path, prompt);
  return path;
}
