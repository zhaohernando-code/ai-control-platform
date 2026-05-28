import { spawn } from "node:child_process";
import { delimiter, dirname } from "node:path";

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeToken(value) {
  return normalizeString(value).toLowerCase();
}

function providerKind(key = {}) {
  const provider = normalizeToken(key.provider);
  const authType = normalizeToken(key.auth_type || key.authType);
  const baseUrl = normalizeToken(key.base_url || key.baseUrl);
  if (provider.includes("anthropic") || authType.includes("anthropic") || baseUrl.includes("anthropic")) return "anthropic";
  if (provider.includes("openai") || authType.includes("openai")) return "openai";
  if (provider.includes("claude")) return "anthropic";
  return provider || "openai";
}

function trimSlash(value = "") {
  return normalizeString(value).replace(/\/+$/g, "");
}

function urlFor(key = {}, path = "") {
  const baseUrl = trimSlash(key.base_url || key.baseUrl);
  const base = baseUrl || (providerKind(key) === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com");
  return `${base}${path}`;
}

function redact(text = "", secret = "") {
  const value = normalizeString(text);
  const token = normalizeString(secret);
  if (!token) return value.slice(0, 300);
  return value.split(token).join("[REDACTED]").slice(0, 300);
}

function truncateSummary(text = "") {
  return normalizeString(text).slice(0, 300);
}

function agentCommandPath() {
  return [
    process.env.PATH,
    dirname(process.execPath),
    "/Users/hernando_zhao/.local/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin"
  ].filter(Boolean).join(delimiter);
}

function healthStatusFromHttp(status) {
  if (status >= 200 && status < 300) return "success";
  if (status === 429 || status >= 500) return "warning";
  return "error";
}

async function responseSummary(response, secret) {
  try {
    const text = await response.text();
    return redact(text, secret);
  } catch {
    return "";
  }
}

function runCommand(command, args = [], options = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      env: options.env || process.env,
      cwd: options.cwd || process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const limit = Number(options.maxBuffer || 512 * 1024);
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-limit);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-limit);
    });
    const timeoutMs = Number(options.timeout_ms || options.timeoutMs || 15000);
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({
        exitCode: null,
        timedOut: true,
        stdout,
        stderr,
        latency_ms: Date.now() - startedAt
      });
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        error,
        stdout,
        stderr,
        latency_ms: Date.now() - startedAt
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        timedOut: false,
        stdout,
        stderr,
        latency_ms: Date.now() - startedAt
      });
    });
  });
}

function accountHealthCommand(agent = {}, options = {}) {
  const runner = normalizeToken(agent.runner);
  const cli = normalizeString(agent.cli) || (runner === "codex" ? "codex" : "");
  if (runner === "codex" && cli) {
    return {
      command: cli,
      args: ["doctor", "--json"],
      env: {
        ...process.env,
        PATH: agentCommandPath(),
        ...(agent.env && typeof agent.env === "object" ? agent.env : {}),
        ...(normalizeString(agent.codex_home || agent.codexHome) ? { CODEX_HOME: normalizeString(agent.codex_home || agent.codexHome) } : {})
      }
    };
  }
  const manualCli = normalizeString(options.manualAgentCliPath || options.manual_agent_cli_path) || "/Users/hernando_zhao/manual_agent_cli";
  return {
    command: manualCli,
    args: [normalizeString(agent.id), "--dry-run"],
    env: {
      ...process.env,
      PATH: agentCommandPath(),
      ...(agent.env && typeof agent.env === "object" ? agent.env : {})
    }
  };
}

function parseDoctorJson(stdout = "") {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function codexDoctorHealthFromResult(result = {}) {
  const report = parseDoctorJson(result.stdout || "");
  if (!report?.checks || typeof report.checks !== "object") return null;
  const auth = report.checks["auth.credentials"];
  const network = report.checks["network.provider_reachability"];
  if (auth && auth.status !== "ok") {
    return {
      status: "error",
      error_code: `auth_${auth.status || "failed"}`,
      error_summary: truncateSummary(auth.summary || "codex account authentication is not configured")
    };
  }
  if (network && network.status !== "ok") {
    return {
      status: "warning",
      error_code: `network_${network.status || "failed"}`,
      error_summary: truncateSummary(network.summary || "codex provider reachability is degraded")
    };
  }
  return {
    status: "success",
    error_code: "",
    error_summary: ""
  };
}

export async function checkAgentKeyHealth(key = {}, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return {
      status: "error",
      latency_ms: null,
      error_code: "fetch_unavailable",
      error_summary: "fetch is not available in this runtime"
    };
  }

  const startedAt = Date.now();
  const timeoutMs = Number(options.timeout_ms || options.timeoutMs || 15000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const secret = normalizeString(key.secret);

  try {
    let response;
    if (providerKind(key) === "anthropic") {
      response = await fetchImpl(urlFor(key, "/v1/messages"), {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": secret
        },
        body: JSON.stringify({
          model: normalizeString(key.default_model || key.defaultModel) || "claude-3-haiku-20240307",
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }]
        })
      });
    } else {
      response = await fetchImpl(urlFor(key, "/v1/models"), {
        method: "GET",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${secret}`,
          accept: "application/json"
        }
      });
    }

    const latencyMs = Date.now() - startedAt;
    return {
      status: healthStatusFromHttp(response.status),
      latency_ms: latencyMs,
      error_code: response.ok ? "" : `http_${response.status}`,
      error_summary: response.ok ? "" : await responseSummary(response, secret),
      raw: {
        http_status: response.status,
        provider: providerKind(key)
      }
    };
  } catch (error) {
    return {
      status: "error",
      latency_ms: Date.now() - startedAt,
      error_code: error?.name === "AbortError" ? "timeout" : "request_failed",
      error_summary: redact(error?.message || "agent key health check failed", secret),
      raw: {
        provider: providerKind(key),
        error_name: error?.name || "Error"
      }
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkAgentAccountHealth(agent = {}, options = {}) {
  if (typeof options.accountHealthCheckImpl === "function") {
    return options.accountHealthCheckImpl(agent, options);
  }
  const startedAt = Date.now();
  const runner = options.accountHealthRunner || runCommand;
  const commandSpec = typeof options.accountHealthCommand === "function"
    ? options.accountHealthCommand(agent, options)
    : accountHealthCommand(agent, options);
  if (!commandSpec?.command) {
    return {
      status: "error",
      latency_ms: Date.now() - startedAt,
      error_code: "account_health_command_unavailable",
      error_summary: "account health command is not configured",
      raw: { runner: normalizeToken(agent.runner), auth_type: normalizeToken(agent.auth_type || agent.authType) }
    };
  }
  const result = await runner(commandSpec.command, commandSpec.args || [], {
    env: commandSpec.env,
    cwd: commandSpec.cwd,
    timeout_ms: options.account_timeout_ms || options.accountTimeoutMs || options.timeout_ms || options.timeoutMs || 30000
  });
  const latencyMs = Number.isFinite(Number(result.latency_ms)) ? Number(result.latency_ms) : Date.now() - startedAt;
  if (result.timedOut) {
    return {
      status: "error",
      latency_ms: latencyMs,
      error_code: "timeout",
      error_summary: "account login health check timed out",
      raw: { runner: normalizeToken(agent.runner), command: commandSpec.command }
    };
  }
  if (result.error) {
    return {
      status: "error",
      latency_ms: latencyMs,
      error_code: "command_failed",
      error_summary: truncateSummary(result.error.message || "account login health check failed"),
      raw: { runner: normalizeToken(agent.runner), command: commandSpec.command }
    };
  }
  const doctorHealth = normalizeToken(agent.runner) === "codex" ? codexDoctorHealthFromResult(result) : null;
  if (doctorHealth) {
    return {
      status: doctorHealth.status,
      latency_ms: latencyMs,
      error_code: doctorHealth.error_code,
      error_summary: doctorHealth.error_summary,
      raw: {
        runner: normalizeToken(agent.runner),
        auth_type: normalizeToken(agent.auth_type || agent.authType),
        command: commandSpec.command,
        exit_code: result.exitCode,
        doctor_status: doctorHealth.status
      }
    };
  }
  const ok = result.exitCode === 0;
  return {
    status: ok ? "success" : "error",
    latency_ms: latencyMs,
    error_code: ok ? "" : `exit_${result.exitCode ?? "unknown"}`,
    error_summary: ok ? "" : truncateSummary(result.stderr || result.stdout || "account login health check failed"),
    raw: {
      runner: normalizeToken(agent.runner),
      auth_type: normalizeToken(agent.auth_type || agent.authType),
      command: commandSpec.command,
      exit_code: result.exitCode
    }
  };
}

export async function runAgentHealthCheck(store, input = {}, options = {}) {
  if (!store || typeof store.keysDueForHealthCheck !== "function") {
    return {
      status: "fail",
      checked: [],
      issues: [{ code: "agent_store_unavailable", message: "agent key store is not configured", path: "state_store" }]
    };
  }

  const checkedAt = normalizeString(input.checked_at || input.checkedAt || options.checked_at || options.checkedAt) ||
    new Date().toISOString();
  const keyId = normalizeString(input.key_id || input.keyId);
  const agentId = normalizeString(input.agent_id || input.agentId);
  const includeFresh = input.include_fresh !== false && input.includeFresh !== false;
  const keys = keyId
    ? [store.readAgentKeyForHealth(keyId)].filter(Boolean)
    : store.keysDueForHealthCheck({
        agent_id: agentId,
        include_fresh: includeFresh,
        ttl_ms: input.ttl_ms || input.ttlMs,
        now: checkedAt
      });
  const accounts = !keyId && typeof store.accountAgentsDueForHealthCheck === "function"
    ? store.accountAgentsDueForHealthCheck({
        agent_id: agentId,
        include_fresh: includeFresh,
        ttl_ms: input.ttl_ms || input.ttlMs,
        now: checkedAt
      })
    : [];

  if (keyId && keys.length === 0) {
    return {
      status: "fail",
      checked: [],
      issues: [{ code: "unknown_agent_key", message: "active agent key not found", path: "key_id" }]
    };
  }

  const checked = [];
  for (const key of keys) {
    const health = await checkAgentKeyHealth(key, options);
    const recorded = store.recordAgentKeyHealth({
      key_id: key.id,
      ...health
    }, checkedAt);
    checked.push({
      key_id: key.id,
      agent_id: key.agent_id,
      status: health.status,
      latency_ms: health.latency_ms,
      error_code: health.error_code || "",
      error_summary: health.error_summary || "",
      recorded_status: recorded.status
    });
  }
  for (const account of accounts) {
    const health = await checkAgentAccountHealth(account, options);
    const recorded = store.recordAgentAccountHealth({
      agent_id: account.id,
      ...health
    }, checkedAt);
    checked.push({
      kind: "account",
      agent_id: account.id,
      key_id: null,
      status: health.status,
      latency_ms: health.latency_ms,
      error_code: health.error_code || "",
      error_summary: health.error_summary || "",
      recorded_status: recorded.status
    });
  }

  if (!keyId && !agentId) {
    store.markFullHealthCheck(checkedAt);
  }

  return {
    status: checked.some((entry) => entry.status === "error") ? "completed_with_errors" : "completed",
    checked_at: checkedAt,
    checked,
    registry: typeof store.listAgents === "function" ? store.listAgents() : null,
    issues: []
  };
}
