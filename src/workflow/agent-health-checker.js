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
