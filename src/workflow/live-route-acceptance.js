export const WORKBENCH_LIVE_ROUTE_EVIDENCE_VERSION = "workbench-live-route-evidence.v1";

const RESOLVED_STATUSES = new Set([
  "pass",
  "passed",
  "ok",
  "success",
  "succeeded",
  "resolved",
  "closed",
  "complete",
  "completed"
]);

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

function normalizeRoutePath(pathname) {
  if (!pathname) return "/";
  return pathname.endsWith("/") ? pathname : `${pathname}/`;
}

function cleanUrlToken(value) {
  return normalizeString(value).replace(/[),.;\]]+$/u, "");
}

export function normalizePublicRouteUrl(value) {
  const cleaned = cleanUrlToken(value);
  if (!cleaned) return "";
  try {
    const url = new URL(cleaned);
    url.hash = "";
    url.search = "";
    url.pathname = normalizeRoutePath(url.pathname);
    return url.toString();
  } catch {
    return "";
  }
}

function isLocalHostname(hostname) {
  const normalized = normalizeToken(hostname);
  return (
    normalized === "localhost" ||
    normalized === "0.0.0.0" ||
    normalized === "::1" ||
    normalized.startsWith("127.") ||
    normalized.endsWith(".local")
  );
}

function isPublicHttpsRoute(value) {
  const cleaned = cleanUrlToken(value);
  if (!cleaned) return false;
  try {
    const url = new URL(cleaned);
    return url.protocol === "https:" && !isLocalHostname(url.hostname);
  } catch {
    return false;
  }
}

function isProjectRoute(value, projectId) {
  if (!isPublicHttpsRoute(value)) return false;
  if (!projectId) return true;
  try {
    const url = new URL(cleanUrlToken(value));
    return normalizeRoutePath(url.pathname).startsWith(`/projects/${projectId}/`);
  } catch {
    return false;
  }
}

function collectStrings(value, output = [], depth = 0) {
  if (depth > 5) return output;
  if (typeof value === "string") {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output, depth + 1);
    return output;
  }
  if (isObject(value)) {
    for (const item of Object.values(value)) collectStrings(item, output, depth + 1);
  }
  return output;
}

function blockerStatus(blocker) {
  return normalizeToken(blocker?.status || blocker?.state || blocker?.result || blocker?.outcome);
}

export function isUnresolvedWorkbenchLiveRouteBlocker(blocker = {}) {
  if (!isObject(blocker)) return false;
  if (RESOLVED_STATUSES.has(blockerStatus(blocker))) return false;
  const text = collectStrings({
    id: blocker.id,
    code: blocker.code,
    category: blocker.category,
    title: blocker.title,
    summary: blocker.summary,
    message: blocker.message,
    evidence: blocker.evidence
  }).join(" ").toLowerCase();
  const routeSignal = (
    text.includes("public-project-route-auth-gate") ||
    text.includes("canonical_route_unverified") ||
    /(?:public|canonical|live)[-_ ]?route/u.test(text) ||
    /route[-_ ]?auth|auth[-_ ]?route/u.test(text)
  );
  const workbenchSignal = (
    text.includes("workbench") ||
    text.includes("ai-control-platform") ||
    text.includes("/projects/") ||
    text.includes("project-route")
  );
  return routeSignal && workbenchSignal;
}

export function detectWorkbenchLiveRouteBlockers(projectStatus = {}) {
  return asArray(projectStatus.blockers).filter(isUnresolvedWorkbenchLiveRouteBlocker);
}

export function extractExpectedPublicRouteUrls(projectStatus = {}) {
  const projectId = normalizeString(projectStatus.project);
  const urls = new Set();
  const strings = collectStrings({
    blockers: projectStatus.blockers,
    next_step: projectStatus.next_step,
    latest_update: projectStatus.latest_update
  });
  for (const text of strings) {
    for (const match of text.matchAll(/https:\/\/[^\s"'<>]+/gu)) {
      const candidate = cleanUrlToken(match[0]);
      if (isProjectRoute(candidate, projectId)) {
        urls.add(normalizePublicRouteUrl(candidate));
      }
    }
  }
  return [...urls].filter(Boolean).sort();
}

function firstString(paths) {
  for (const value of paths) {
    const normalized = normalizeString(value);
    if (normalized) return normalized;
  }
  return "";
}

function firstNumber(paths) {
  for (const value of paths) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return NaN;
}

function firstBoolean(paths) {
  for (const value of paths) {
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function requireTrue(artifact, code, label, paths, issues) {
  if (firstBoolean(paths) !== true) {
    issues.push({
      code,
      path: label,
      message: `${label} must be true in verified workbench live-route evidence`
    });
  }
}

function normalizedExpectedUrls(options) {
  return asArray(options.expectedRouteUrls)
    .map(normalizePublicRouteUrl)
    .filter(Boolean);
}

export function validateWorkbenchLiveRouteEvidenceArtifact(artifact = {}, options = {}) {
  const issues = [];
  const expectedRouteUrls = normalizedExpectedUrls(options);
  const projectId = normalizeString(options.projectId);

  if (!isObject(artifact)) {
    return {
      status: "fail",
      issues: [{ code: "invalid_live_route_evidence_artifact", path: "artifact" }]
    };
  }

  const evidence = isObject(artifact.evidence) ? artifact.evidence : {};
  const workbench = isObject(artifact.workbench) ? artifact.workbench : {};
  const route = isObject(artifact.route) ? artifact.route : {};

  if (artifact.version !== WORKBENCH_LIVE_ROUTE_EVIDENCE_VERSION) {
    issues.push({ code: "invalid_live_route_evidence_version", path: "version" });
  }
  if (normalizeToken(artifact.status) !== "pass") {
    issues.push({ code: "live_route_evidence_not_passed", path: "status" });
  }
  if (!normalizeString(artifact.created_at || artifact.createdAt)) {
    issues.push({ code: "missing_live_route_evidence_timestamp", path: "created_at" });
  }

  const artifactProject = firstString([artifact.project, artifact.project_id, artifact.projectId]);
  if (projectId && artifactProject !== projectId) {
    issues.push({ code: "live_route_project_mismatch", path: "project" });
  }

  const routeUrl = firstString([
    artifact.route_url,
    artifact.routeUrl,
    artifact.url,
    route.url,
    evidence.route_url,
    evidence.routeUrl,
    evidence.url
  ]);
  const finalUrl = firstString([
    artifact.final_url,
    artifact.finalUrl,
    route.final_url,
    route.finalUrl,
    evidence.final_url,
    evidence.finalUrl,
    routeUrl
  ]);
  const normalizedRouteUrl = normalizePublicRouteUrl(routeUrl);
  const normalizedFinalUrl = normalizePublicRouteUrl(finalUrl);

  if (!routeUrl) {
    issues.push({ code: "missing_live_route_url", path: "route_url" });
  } else if (!isPublicHttpsRoute(routeUrl)) {
    issues.push({ code: "live_route_url_not_public_https", path: "route_url" });
  }
  if (!finalUrl) {
    issues.push({ code: "missing_live_route_final_url", path: "final_url" });
  } else if (!isPublicHttpsRoute(finalUrl)) {
    issues.push({ code: "live_route_final_url_not_public_https", path: "final_url" });
  }

  if (expectedRouteUrls.length > 0 && !expectedRouteUrls.includes(normalizedRouteUrl) && !expectedRouteUrls.includes(normalizedFinalUrl)) {
    issues.push({
      code: "live_route_url_mismatch",
      path: "route_url",
      expected_route_urls: expectedRouteUrls
    });
  }

  if (projectId && routeUrl && !isProjectRoute(routeUrl, projectId)) {
    issues.push({ code: "live_route_not_project_mount", path: "route_url" });
  }
  if (projectId && finalUrl && !isProjectRoute(finalUrl, projectId)) {
    issues.push({ code: "live_route_final_url_not_project_mount", path: "final_url" });
  }

  const httpStatus = firstNumber([
    artifact.http_status,
    artifact.httpStatus,
    artifact.status_code,
    route.http_status,
    route.httpStatus,
    evidence.http_status,
    evidence.httpStatus,
    evidence.status_code
  ]);
  if (!Number.isInteger(httpStatus) || httpStatus < 200 || httpStatus >= 300) {
    issues.push({ code: "live_route_http_status_not_success", path: "http_status" });
  }

  const authRedirectDetected = firstBoolean([
    artifact.auth_redirect_detected,
    artifact.authRedirectDetected,
    route.auth_redirect_detected,
    evidence.auth_redirect_detected,
    evidence.authRedirectDetected
  ]);
  if (authRedirectDetected === true || /\?next=/u.test(finalUrl)) {
    issues.push({ code: "live_route_auth_redirect_detected", path: "final_url" });
  }

  const localLoopback = firstBoolean([
    artifact.local_loopback,
    artifact.localLoopback,
    route.local_loopback,
    evidence.local_loopback,
    evidence.localLoopback
  ]);
  if (localLoopback === true) {
    issues.push({ code: "local_live_route_evidence_not_allowed", path: "local_loopback" });
  }

  requireTrue(artifact, "public_live_route_not_verified", "public_route_verified", [
    artifact.public_route_verified,
    artifact.publicRouteVerified,
    route.public_route_verified,
    route.verified,
    evidence.public_route_verified,
    evidence.publicRouteVerified
  ], issues);
  requireTrue(artifact, "mounted_workbench_route_not_verified", "mounted_workbench_route_verified", [
    artifact.mounted_workbench_route_verified,
    artifact.mountedWorkbenchRouteVerified,
    route.mounted_workbench_route_verified,
    workbench.mounted_route_verified,
    evidence.mounted_workbench_route_verified,
    evidence.mountedWorkbenchRouteVerified
  ], issues);
  requireTrue(artifact, "workbench_render_not_verified", "workbench_rendered", [
    artifact.workbench_rendered,
    artifact.workbenchRendered,
    workbench.rendered,
    workbench.workbench_rendered,
    evidence.workbench_rendered,
    evidence.workbenchRendered
  ], issues);
  requireTrue(artifact, "mounted_workbench_api_not_verified", "mounted_api_verified", [
    artifact.mounted_api_verified,
    artifact.mountedApiVerified,
    workbench.mounted_api_verified,
    evidence.mounted_api_verified,
    evidence.mountedApiVerified
  ], issues);

  return {
    status: issues.length > 0 ? "fail" : "pass",
    version: artifact.version,
    route_url: normalizedRouteUrl,
    final_url: normalizedFinalUrl,
    http_status: Number.isFinite(httpStatus) ? httpStatus : null,
    issues
  };
}

export function evaluateWorkbenchLiveRouteAcceptance(input = {}) {
  const projectStatus = isObject(input.projectStatus) ? input.projectStatus : {};
  const blockers = detectWorkbenchLiveRouteBlockers(projectStatus);
  const expectedRouteUrls = extractExpectedPublicRouteUrls(projectStatus);
  const projectId = normalizeString(projectStatus.project);
  const issues = [];
  let evidenceValidation = null;

  if (input.evidenceArtifact !== undefined && input.evidenceArtifact !== null) {
    evidenceValidation = validateWorkbenchLiveRouteEvidenceArtifact(input.evidenceArtifact, {
      expectedRouteUrls,
      projectId
    });
  }

  if (blockers.length > 0 && !evidenceValidation) {
    issues.push({
      code: "missing_verified_public_live_route_evidence",
      path: "evidence",
      message: "PROJECT_STATUS contains unresolved public/canonical live-route blockers for the workbench"
    });
  }
  if (evidenceValidation?.status === "fail") {
    issues.push(...evidenceValidation.issues);
  }

  return {
    gate_id: "workbench-live-route-acceptance",
    status: issues.length > 0 ? "fail" : "pass",
    blocker_count: blockers.length,
    blockers: blockers.map((blocker) => ({
      id: blocker.id || blocker.code || "",
      category: blocker.category || "",
      severity: blocker.severity || "",
      requires_human: Boolean(blocker.requires_human)
    })),
    expected_route_urls: expectedRouteUrls,
    evidence_status: evidenceValidation ? evidenceValidation.status : blockers.length > 0 ? "missing" : "not_required",
    evidence: evidenceValidation,
    issues
  };
}
