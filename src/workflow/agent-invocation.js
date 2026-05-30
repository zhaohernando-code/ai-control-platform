import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { buildModelCollaborationPlan, MODEL_PROFILES } from "./model-router.js";
import { resolveMs, lockTtlMsFor } from "./timeout-config.js";

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

function channelModels(channel = {}) {
  return asArray(channel.models || channel.model_ids || channel.modelIds).map(normalizeString).filter(Boolean);
}

function channelSupportsModel(channel = {}, candidate = {}, model = "") {
  const value = normalizeString(model);
  if (!value) return true;
  const candidateModel = normalizeString(candidate.model);
  return candidateModel === value ||
    normalizeString(channel.default_model || channel.defaultModel) === value ||
    channelModels(channel).includes(value);
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

function agentCommandPath() {
  const home = normalizeString(process.env.HOME) || "/Users/hernando_zhao";
  return [
    process.env.PATH,
    dirname(process.execPath),
    `${home}/.nvm/versions/node/v22.16.0/bin`,
    `${home}/.local/bin`,
    "/Applications/Codex.app/Contents/Resources",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin"
  ].filter(Boolean).join(delimiter);
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
    .map((candidate) => ({
      candidate,
      channel: findChannel(config, candidate.agent_id || candidate.agentId)
    }))
    .filter(({ channel }) => channel)
    .filter(({ candidate }) => !explicitAgentId || normalizeString(candidate.agent_id || candidate.agentId) === explicitAgentId)
    .filter(({ candidate, channel }) => channelSupportsModel(channel, candidate, explicitModel))
    .map(({ candidate, channel }) => ({
      candidate: {
        ...candidate,
        model: explicitModel || normalizeString(candidate.model)
      },
      channel
    }));
  const candidate = candidates[Math.max(0, candidateIndex)] || null;
  return candidate || null;
}

function acquireKey(stateStore, profile = {}, channel = {}, input = {}) {
  const authType = channelAuthType(channel);
  if (authType === "codex_account") {
    if (!stateStore || typeof stateStore.listAgents !== "function") {
      return {
        status: "blocked",
        key: null,
        issues: [issue("agent_state_store_required", "account-login agents require a governed state store with latest account health", "state_store")]
      };
    }
    const agent = asArray(stateStore.listAgents()?.agents).find((entry) => normalizeString(entry.id) === normalizeString(channel.id));
    if (normalizeToken(agent?.account_health?.status || agent?.status) !== "success") {
      return {
        status: "blocked",
        key: null,
        issues: [issue("account_agent_not_healthy", `account-login agent is not healthy: ${channel.id}`, "agent_id")]
      };
    }
    return { status: "not_required", key: null };
  }
  if (!stateStore || typeof stateStore.acquireAgentKeyForRole !== "function") {
    return {
      status: "blocked",
      key: null,
      issues: [issue("agent_state_store_required", "API-key agents require a governed state store for credential acquisition", "state_store")]
    };
  }
  // Lock TTL must outlive the invocation it guards. Previously this fell back to
  // profile.timeout_ms (2-5 min in config), so a lock could expire while a long invocation
  // was still running near its own timeout. Derive it from the invocation hard timeout with
  // grace, floored at 10 min — never shorter than the run.
  const invocationTimeoutMs = resolveMs(input, profile, "timeout", 180000);
  const lockTtlMs = firstFiniteTtl(input.lock_ttl_ms, input.lockTtlMs) ?? lockTtlMsFor(invocationTimeoutMs);
  return stateStore.acquireAgentKeyForRole(profile.role, {
    agent_id: channel.id,
    lock_owner: normalizeString(input.lock_owner || input.lockOwner || input.invocation_id || input.invocationId) || `agent-invocation-${Date.now()}`,
    ttl_ms: lockTtlMs,
    now: input.created_at || input.createdAt
  });
}

function firstFiniteTtl(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
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
  const outputFormat = normalizeString(input.output_format || input.outputFormat || profile.output_format);
  if (outputFormat) args.push("--output-format", outputFormat);
  if (input.include_partial_messages === true || input.includePartialMessages === true) {
    args.push("--include-partial-messages");
  }
  args.push("--no-session-persistence");
  if (profile.max_budget_usd || input.max_budget_usd || input.maxBudgetUsd) {
    args.push("--max-budget-usd", normalizeString(input.max_budget_usd || input.maxBudgetUsd || profile.max_budget_usd));
  }
  if (profile.effort || input.effort) args.push("--effort", normalizeString(input.effort || profile.effort));
  const tools = input.tools !== undefined ? normalizeString(input.tools) : normalizeString(profile.tools);
  const allowedTools = normalizeString(input.allowed_tools || input.allowedTools || tools);
  const noTools = input.no_tools === true || input.noTools === true;
  if (noTools) {
    args.push("--tools", "");
  } else if (allowedTools) {
    args.push("--allowedTools", allowedTools);
  }
  const addDir = normalizeString(input.add_dir || input.addDir);
  if (addDir) args.push("--add-dir", addDir);
  if (input.json_schema || input.jsonSchema) args.push("--json-schema", typeof (input.json_schema || input.jsonSchema) === "string" ? input.json_schema || input.jsonSchema : JSON.stringify(input.json_schema || input.jsonSchema));
  args.push("--model", model, "-p", prompt);
  const env = {
    ...process.env,
    PATH: agentCommandPath(),
    ANTHROPIC_MODEL: model
  };
  if (channel.base_url || channel.baseUrl) env.ANTHROPIC_BASE_URL = normalizeString(channel.base_url || channel.baseUrl);
  if (key?.secret) env.ANTHROPIC_API_KEY = key.secret;
  return { command, args, cwd, env, model, runner: "claude", no_tools: noTools };
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
  const env = {
    ...process.env,
    PATH: agentCommandPath()
  };
  // Do not leak unrelated provider credentials into the codex invocation env.
  // For codex_account auth, no API key is injected, so ambient keys must be stripped.
  if (!key?.secret) {
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENAI_API_KEY;
  }
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
    timeout_ms: resolveMs(input, profile, "timeout", 180000),
    // idle defaults to the HARD timeout when not given. Precedence preserved exactly from
    // the original chain: input idle -> input hard -> profile idle -> profile hard -> default
    // (input hard intentionally beats profile idle, so a caller-set hard cap bounds idle too).
    idle_timeout_ms: Number(
      input.idle_timeout_ms || input.idleTimeoutMs ||
      input.timeout_ms || input.timeoutMs ||
      profile.idle_timeout_ms || profile.idleTimeoutMs ||
      profile.timeout_ms || profile.timeoutMs || 180000
    )
  };
  return {
    status: "pass",
    invocation,
    issues: []
  };
}

export function runCommandWithIdleTimeout(command, args = [], runnerOptions = {}) {
  const timeoutMs = Number(runnerOptions.timeout || runnerOptions.timeout_ms || runnerOptions.timeoutMs || 0);
  const idleTimeoutMs = Number(runnerOptions.idle_timeout || runnerOptions.idle_timeout_ms || runnerOptions.idleTimeoutMs || timeoutMs || 0);
  const maxBuffer = Number(runnerOptions.maxBuffer || runnerOptions.max_buffer || 4 * 1024 * 1024);
  const monitorScript = `
    const { spawn } = require("node:child_process");
    const spec = JSON.parse(process.argv[1]);
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let truncated = false;
    let killTimer = null;
    // SIGTERM alone is not enough: the child's open stdio pipes keep this monitor
    // process alive until the child actually exits, so a child that ignores SIGTERM
    // would hang the monitor (forever when only an idle timeout is set, since the
    // outer spawnSync then has no wall-clock cap). Escalate to SIGKILL after a grace
    // window so the child is force-reaped and the monitor can exit promptly.
    function killChild() {
      try { child.kill("SIGTERM"); } catch {}
      if (killTimer) return;
      killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
      }, spec.killGraceMs || 2000);
      if (killTimer.unref) killTimer.unref();
    }
    function append(kind, chunk) {
      if (settled) return;
      const text = String(chunk || "");
      if (kind === "stdout") stdout += text;
      else stderr += text;
      if (stdout.length + stderr.length > spec.maxBuffer) {
        truncated = true;
        stderr += "\\nagent invocation output exceeded maxBuffer";
        finish(1, null, "MAXBUFFER");
        killChild();
        return;
      }
      resetIdleTimer();
    }
    let idleTimer = null;
    let hardTimer = null;
    function resetIdleTimer() {
      if (!spec.idleTimeoutMs) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        finish(1, null, "ETIMEDOUT");
        killChild();
      }, spec.idleTimeoutMs);
      if (idleTimer.unref) idleTimer.unref();
    }
    function finish(status, signal, errorCode) {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(hardTimer);
      process.stdout.write(JSON.stringify({
        status: Number.isFinite(status) ? status : (errorCode ? 1 : 0),
        signal,
        stdout,
        stderr,
        error: errorCode ? { code: errorCode, message: errorCode } : undefined,
        timed_out: timedOut,
        truncated
      }));
    }
    if (spec.timeoutMs) {
      hardTimer = setTimeout(() => {
        timedOut = true;
        finish(1, null, "ETIMEDOUT");
        killChild();
      }, spec.timeoutMs);
      if (hardTimer.unref) hardTimer.unref();
    }
    resetIdleTimer();
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    child.on("error", (error) => finish(1, null, error && error.code ? error.code : "COMMAND_ERROR"));
    child.on("close", (status, signal) => { clearTimeout(killTimer); finish(status, signal, null); });
  `;
  const killGraceMs = Number(runnerOptions.kill_grace_ms || runnerOptions.killGraceMs || 2000);
  const monitor = spawnSync(process.execPath, [
    "-e",
    monitorScript,
    JSON.stringify({
      command,
      args,
      cwd: runnerOptions.cwd,
      env: runnerOptions.env,
      timeoutMs,
      idleTimeoutMs,
      maxBuffer,
      killGraceMs
    })
  ], {
    encoding: "utf8",
    // Outer safety net: the monitor settles after timeoutMs/idleTimeoutMs and force-kills
    // the child after killGraceMs, so cap spawnSync just beyond the larger inner deadline
    // (plus the kill grace) instead of leaving it uncapped when only an idle timeout is set.
    timeout: (Math.max(timeoutMs, idleTimeoutMs) || 0)
      ? Math.max(timeoutMs, idleTimeoutMs) + killGraceMs + 5000
      : undefined,
    maxBuffer: maxBuffer + 1024 * 1024
  });
  if (monitor.status !== 0 && !normalizeString(monitor.stdout)) {
    return {
      status: Number(monitor.status ?? 1),
      stdout: "",
      stderr: normalizeString(monitor.stderr || monitor.error?.message),
      error: monitor.error,
      signal: monitor.signal
    };
  }
  try {
    return JSON.parse(monitor.stdout || "{}");
  } catch {
    return {
      status: 1,
      stdout: monitor.stdout || "",
      stderr: monitor.stderr || "agent invocation monitor returned invalid output",
      error: { code: "MONITOR_OUTPUT_INVALID" }
    };
  }
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
  const runner = options.commandRunner || runCommandWithIdleTimeout;
  const stateStore = options.stateStore || options.state_store;
  const startedAt = Date.now();
  // The key lock acquired during planning must always be released, even if the runner
  // throws before completing. Without this, a thrown runner leaks the lock and the next
  // caller can acquire the same API key concurrently (rate limits, auth conflicts).
  let released = false;
  const releaseLock = () => {
    if (released) return;
    if (invocation.key?.id && invocation.lock && typeof stateStore?.releaseAgentKeyLock === "function") {
      released = true;
      try {
        stateStore.releaseAgentKeyLock(invocation.key.id, invocation.lock.lock_owner);
      } catch {
        // A release failure must not mask the invocation result or crash the caller.
      }
    }
  };
  try {
    const result = runner(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      encoding: "utf8",
      timeout: invocation.timeout_ms,
      idle_timeout_ms: invocation.idle_timeout_ms,
      maxBuffer: options.maxBuffer || 4 * 1024 * 1024
    });
    const latencyMs = Date.now() - startedAt;
    const exitCode = Number(result?.status ?? result?.exitCode ?? (result?.error ? 1 : 0));
    const timedOut = result?.error?.code === "ETIMEDOUT" || result?.signal === "SIGTERM" || exitCode === 124 || exitCode === 143;
    const stdout = redactInvocationText(result?.stdout || "", invocation);
    const stderr = redactInvocationText(result?.stderr || result?.error?.message || "", invocation);
    const outputText = normalizeString(stdout);
    const parsed = typeof options.parseOutput === "function" ? options.parseOutput(outputText) : null;
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
  } finally {
    releaseLock();
  }
}

export function writePromptTempFile(prompt = "", prefix = "agent-invocation-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const path = join(dir, "prompt.md");
  writeFileSync(path, prompt);
  return path;
}
