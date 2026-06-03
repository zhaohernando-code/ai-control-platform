import { spawnSync } from "node:child_process";

function normalizeString(value) {
  return String(value || "").trim();
}

export function localWorkbenchBaseUrl(value = "") {
  const text = normalizeString(value);
  if (!text) return null;
  const url = new URL(text);
  const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  if (url.protocol !== "http:" || !localHosts.has(url.hostname)) {
    const error = new Error("headless projected next-action workbench base url must be local http");
    error.code = "INVALID_WORKBENCH_BASE_URL";
    throw error;
  }
  return url;
}

function requestJsonSync(url, body = null, options = {}) {
  const timeoutMs = Number(options.timeout_ms || options.timeoutMs || 30000);
  const method = normalizeString(options.method).toUpperCase() || (body === null ? "GET" : "POST");
  const payload = body === null ? "" : JSON.stringify(body);
  const script = [
    "const http = await import('node:http');",
    "const https = await import('node:https');",
    "const url = process.argv[1];",
    "const method = process.argv[2] || 'GET';",
    "const body = process.argv[3] || '';",
    "const timeoutMs = Number(process.argv[4] || 30000);",
    "const target = new URL(url);",
    "const transport = target.protocol === 'https:' ? https : http;",
    "const result = await new Promise((resolveRequest, rejectRequest) => {",
    "  const headers = body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {};",
    "  const req = transport.request(target, { method, headers }, (res) => {",
    "    let text = '';",
    "    res.setEncoding('utf8');",
    "    res.on('data', (chunk) => { text += chunk; });",
    "    res.on('end', () => resolveRequest({ statusCode: res.statusCode || 0, text }));",
    "  });",
    "  req.setTimeout(timeoutMs, () => req.destroy(new Error('workbench request timed out')));",
    "  req.on('error', rejectRequest);",
    "  req.write(body);",
    "  req.end();",
    "});",
    "if (result.statusCode < 200 || result.statusCode >= 300) { console.error(result.text); process.exit(result.statusCode || 1); }",
    "process.stdout.write(result.text);"
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, url.toString(), method, payload, String(timeoutMs)], {
    encoding: "utf8",
    timeout: timeoutMs + 1000
  });
  if (result.status !== 0) {
    const error = new Error(normalizeString(result.stderr) || normalizeString(result.stdout) || `workbench request failed: ${result.status}`);
    error.status = result.status;
    throw error;
  }
  return JSON.parse(result.stdout || "{}");
}

function postJsonSync(url, body = {}, options = {}) {
  return requestJsonSync(url, body, { ...options, method: "POST" });
}

function getJsonSync(url, options = {}) {
  return requestJsonSync(url, null, { ...options, method: "GET" });
}

export function workbenchProjectionFrom(options = {}) {
  const loader = typeof options.workbench_projection_loader === "function"
    ? options.workbench_projection_loader
    : typeof options.workbenchProjectionLoader === "function"
      ? options.workbenchProjectionLoader
      : null;
  if (loader) {
    return loader(options);
  }
  const baseValue = normalizeString(options.workbench_base_url || options.workbenchBaseUrl);
  if (!baseValue) return null;
  const base = localWorkbenchBaseUrl(baseValue);
  const projectionId = normalizeString(
    options.current_workbench_projection_id ||
      options.currentWorkbenchProjectionId ||
      options.workbench_projection_id ||
      options.workbenchProjectionId
  );
  const url = new URL("/api/workbench/projection", base);
  if (projectionId) url.searchParams.set("id", projectionId);
  return getJsonSync(url, {
    timeout_ms: options.workbench_request_timeout_ms || options.workbenchRequestTimeoutMs
  });
}

export function workbenchNextActionRunnerFrom(options = {}) {
  const baseValue = normalizeString(options.workbench_base_url || options.workbenchBaseUrl);
  if (!baseValue) return null;
  const base = localWorkbenchBaseUrl(baseValue);
  return ({ action, iteration }) => {
    const url = new URL("/api/workbench/next-action", base);
    const projectionId = normalizeString(
      options.current_workbench_projection_id ||
        options.currentWorkbenchProjectionId ||
        options.workbench_projection_id ||
        options.workbenchProjectionId
    );
    if (projectionId) url.searchParams.set("id", projectionId);
    const body = {
      expected_action: action,
      max_iterations: 1,
      snapshot_prefix: normalizeString(options.snapshot_prefix || options.snapshotPrefix) || "headless-projected-action",
      created_at: normalizeString(options.created_at || options.createdAt),
      iteration
    };
    const reviewerOrSchedulerAction = new Set([
      "run_reviewer_scope_shard",
      "run_autonomous_scheduler_loop",
      "resume_autonomous_scheduler_loop",
      "enqueue_scheduler_next_cycle"
    ]).has(action);
    const contextExecutionProfile = options.context_work_package_execution_profile || options.contextWorkPackageExecutionProfile;
    for (const [target, source] of [
      ["execution_profile", action === "run_context_work_packages"
        ? contextExecutionProfile
        : reviewerOrSchedulerAction
          ? (options.execution_profile || options.executionProfile)
          : undefined],
      [
        "context_work_package_execution_profile",
        options.context_work_package_execution_profile || options.contextWorkPackageExecutionProfile
      ],
      ["reviewer_mock_status", options.reviewer_mock_status || options.reviewerMockStatus],
      ["reviewer_mock_findings_json", options.reviewer_mock_findings_json || options.reviewerMockFindingsJson],
      ["max_external_reviewer_calls", options.max_external_reviewer_calls ?? options.maxExternalReviewerCalls],
      ["provider_cost_mode", options.provider_cost_mode || options.providerCostMode],
      ["budget_tier", options.budget_tier || options.budgetTier],
      ["risk", options.risk || options.risk_level || options.riskLevel],
      ["timeout_seconds", options.timeout_seconds || options.timeoutSeconds],
      ["record_provider_health_on_timeout", options.record_provider_health_on_timeout ?? options.recordProviderHealthOnTimeout],
      ["provider_smoke_status", options.provider_smoke_status || options.providerSmokeStatus]
    ]) {
      if (source !== undefined && source !== null && source !== "") body[target] = source;
    }
    const result = postJsonSync(url, body, {
      timeout_ms: options.workbench_request_timeout_ms || options.workbenchRequestTimeoutMs
    });
    return {
      status: result.status || "executed",
      action: result.action || action,
      result,
      projection: result.projection || result.result?.projection || null,
      next_item: result.next_item || result.result?.next_item || null
    };
  };
}
