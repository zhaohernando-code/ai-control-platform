const PLATFORM_TERMS = [
  "中台",
  "平台",
  "控制面",
  "工作台",
  "ops workbench",
  "多agent",
  "multi-agent",
  "任务编排",
  "任务调度",
  "recovery",
  "watchdog",
  "llm reviewer",
  "ci/cd",
  "门禁",
  "项目体检",
  "代码地图",
  "skill"
];

const MANAGED_PROJECT_IDS = new Set(["stock_dashboard", "lobechat", "ashare-dashboard"]);
const PLATFORM_PROJECT_IDS = new Set(["ai-control-platform"]);

function normalizeText(value) {
  return String(value || "").toLowerCase();
}

export function inferRequestedDomain(request) {
  const text = normalizeText(request);
  const matchedTerms = PLATFORM_TERMS.filter((term) => text.includes(term.toLowerCase()));
  if (matchedTerms.length > 0) {
    return { domain: "platform_core", matchedTerms };
  }
  return { domain: "managed_project", matchedTerms: [] };
}

export function classifyHost({ request, targetProjectId, explicitAdapter = false }) {
  const requested = inferRequestedDomain(request);
  const target = normalizeText(targetProjectId);

  if (explicitAdapter) {
    return {
      classification: "integration_adapter",
      requestedDomain: requested.domain,
      targetProjectId,
      allowed: true,
      reasons: ["explicit integration adapter work"]
    };
  }

  if (requested.domain === "platform_core" && MANAGED_PROJECT_IDS.has(target)) {
    return {
      classification: "platform_core",
      requestedDomain: requested.domain,
      targetProjectId,
      allowed: false,
      reasons: [
        "platform-core request is targeting a managed business project",
        `matched platform terms: ${requested.matchedTerms.join(", ")}`
      ],
      requiredHost: "ai-control-platform"
    };
  }

  if (requested.domain === "platform_core" && !PLATFORM_PROJECT_IDS.has(target)) {
    return {
      classification: "platform_core",
      requestedDomain: requested.domain,
      targetProjectId,
      allowed: false,
      reasons: ["platform-core request must target ai-control-platform"],
      requiredHost: "ai-control-platform"
    };
  }

  return {
    classification: requested.domain,
    requestedDomain: requested.domain,
    targetProjectId,
    allowed: true,
    reasons: ["host boundary accepted"]
  };
}

export function assertHostBoundary(input) {
  const result = classifyHost(input);
  if (!result.allowed) {
    const error = new Error(result.reasons.join("; "));
    error.code = "HOST_BOUNDARY_VIOLATION";
    error.result = result;
    throw error;
  }
  return result;
}

