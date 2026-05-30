// Provider-failure-text analysis, extracted from workbench-projection.js (P2-8 god-file
// split). Pure helpers that turn raw provider failure payloads (issues, attempts, package
// results) into a single human-facing reason string. No projection state; depends only on
// string/object normalization. Kept as one module because the four functions form one
// cohesive concern (classify why an external model call failed).

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : value === null || value === undefined ? "" : String(value).trim();
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Recursively gather all human-readable failure text from an arbitrarily-shaped payload.
export function collectFailureText(value, output = []) {
  if (value === null || value === undefined) return output;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const text = normalizeString(value);
    if (text) output.push(text);
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectFailureText(entry, output));
    return output;
  }
  if (isObject(value)) {
    for (const key of [
      "message",
      "reason",
      "error",
      "stderr",
      "stdout",
      "issue",
      "issue_code",
      "issueCode",
      "code",
      "result",
      "args"
    ]) {
      if (key in value) collectFailureText(value[key], output);
    }
    collectFailureText(value.completion_evidence || value.completionEvidence, output);
    collectFailureText(value.evidence, output);
    collectFailureText(value.command, output);
  }
  return output;
}

export function budgetLimitFromText(text = "") {
  const source = normalizeString(text);
  if (!/budget|预算|spend|cost|--max-budget-usd/i.test(source)) return "";
  const patterns = [
    /--max-budget-usd\s+([0-9]+(?:\.[0-9]+)?)/i,
    /(?:max(?:imum)?\s+)?budget\s+(?:limit|cap|of|reached|exceeded|上限)[^\d$]{0,40}\$?\s*([0-9]+(?:\.[0-9]+)?)/i,
    /(?:limit|cap|上限)[^\d$]{0,40}\$?\s*([0-9]+(?:\.[0-9]+)?)/i,
    /\$\s*([0-9]+(?:\.[0-9]+)?)[^\n;。]{0,80}(?:budget|limit|cap|预算|上限)/i
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.[1]) {
      const amount = Number(match[1]);
      return Number.isFinite(amount) ? `$${Number.isInteger(amount) ? amount : amount.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}` : `$${match[1]}`;
    }
  }
  return "";
}

export function hasInternalProviderValidationOnly(text = "") {
  const normalized = normalizeString(text);
  if (!normalized) return false;
  return /provider executor (?:top-level status|package result|result has not been validated|did not return pass status)/i.test(normalized) ||
    /provider_executor_(?:result_not_pass|validation_failed)|package_result_not_pass/i.test(normalized);
}

export function userFacingProviderFailureReason({
  failureIssues = [],
  dispatchPackageResults = [],
  providerAttempts = [],
  latestAttempt = null,
  explicitReason = ""
} = {}) {
  const texts = [
    explicitReason,
    ...collectFailureText(failureIssues),
    ...collectFailureText(dispatchPackageResults),
    ...collectFailureText(providerAttempts),
    ...collectFailureText(latestAttempt)
  ].map(normalizeString).filter(Boolean);
  const budget = budgetLimitFromText(texts.join("\n"));
  if (budget) return `外部模型调用到达 ${budget} 预算上限，任务未完成。`;

  const issueCodes = new Set([
    ...failureIssues.map((entry) => normalizeString(entry?.code || entry?.id)),
    ...providerAttempts.map((entry) => normalizeString(entry?.issue)),
    normalizeString(latestAttempt?.issue)
  ].filter(Boolean));
  const latestExitCode = Number(latestAttempt?.exit_code || latestAttempt?.exitCode);
  if (
    latestAttempt?.timed_out === true ||
    latestAttempt?.timedOut === true ||
    issueCodes.has("provider_executor_timeout") ||
    texts.some((text) => /timed?\s*out|timeout|超时/i.test(text))
  ) {
    const timeoutSeconds = Number(latestAttempt?.command?.idle_timeout_seconds || latestAttempt?.command?.timeout_seconds || latestAttempt?.timeout_seconds);
    return Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
      ? `外部模型执行超时（${timeoutSeconds} 秒内未返回可验证结果），任务未完成。`
      : "外部模型执行超时，任务未完成。";
  }
  if (issueCodes.has("provider_executor_unstructured_output") || texts.some((text) => /non-structured|unstructured|structured output|结构化/i.test(text))) {
    return "外部模型没有返回可验证的结构化结果，任务未完成。";
  }
  if (issueCodes.has("missing_completion_evidence") || texts.some((text) => /completion_evidence|completion evidence|验收证据/i.test(text))) {
    return "外部模型返回结果缺少可验收证据，任务未完成。";
  }
  if (issueCodes.has("provider_executor_command_failed") || (Number.isFinite(latestExitCode) && latestExitCode !== 0)) {
    return Number.isFinite(latestExitCode)
      ? `外部模型执行失败（退出码 ${latestExitCode}），任务未完成。`
      : "外部模型执行失败，任务未完成。";
  }

  const firstReadable = texts.find((text) => !hasInternalProviderValidationOnly(text));
  if (firstReadable) return firstReadable;
  if (issueCodes.has("provider_executor_result_not_pass") || issueCodes.has("package_result_not_pass")) {
    return "外部模型执行未通过验收，任务未完成。";
  }
  return "";
}
