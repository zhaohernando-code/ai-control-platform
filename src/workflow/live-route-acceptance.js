export const WORKBENCH_LIVE_ROUTE_EVIDENCE_VERSION = "workbench-live-route-evidence.v1";
export const DEFAULT_WORKBENCH_LIVE_ROUTE_EVIDENCE_MAX_AGE_MS = 60 * 60 * 1000;
const DEFAULT_ALLOWED_EVIDENCE_FUTURE_SKEW_MS = 5 * 60 * 1000;

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

function isLocalLiveRouteUrl(value) {
  const cleaned = cleanUrlToken(value);
  if (!cleaned) return false;
  try {
    const url = new URL(cleaned);
    return ["http:", "https:"].includes(url.protocol) && isLocalHostname(url.hostname);
  } catch {
    return false;
  }
}

function isProjectMountPath(value, projectId) {
  if (!projectId) return true;
  try {
    const url = new URL(cleanUrlToken(value));
    return normalizeRoutePath(url.pathname).startsWith(`/projects/${projectId}/`);
  } catch {
    return false;
  }
}

function isProjectRoute(value, projectId) {
  if (!isPublicHttpsRoute(value)) return false;
  return isProjectMountPath(value, projectId);
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

function parseTimestampMs(value) {
  const normalized = normalizeString(value);
  if (!normalized) return NaN;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

function latestTimestamp(values) {
  let latest = NaN;
  for (const value of values) {
    const timestamp = parseTimestampMs(value);
    if (!Number.isFinite(timestamp)) continue;
    if (!Number.isFinite(latest) || timestamp > latest) latest = timestamp;
  }
  return latest;
}

function timestampInfo(values) {
  for (const value of values) {
    const raw = normalizeString(value);
    if (!raw) continue;
    const timestamp = parseTimestampMs(raw);
    return {
      raw,
      timestamp: Number.isFinite(timestamp) ? timestamp : NaN
    };
  }
  return {
    raw: "",
    timestamp: NaN
  };
}

function evidenceTimestampInfo(artifact = {}, evidenceMetadata = {}) {
  const evidence = isObject(artifact.evidence) ? artifact.evidence : {};
  const route = isObject(artifact.route) ? artifact.route : {};
  return timestampInfo([
    artifact.generated_at,
    artifact.generatedAt,
    artifact.created_at,
    artifact.createdAt,
    artifact.captured_at,
    artifact.capturedAt,
    evidence.generated_at,
    evidence.generatedAt,
    evidence.created_at,
    evidence.createdAt,
    evidence.captured_at,
    evidence.capturedAt,
    route.generated_at,
    route.generatedAt,
    route.created_at,
    route.createdAt,
    route.captured_at,
    route.capturedAt,
    evidenceMetadata.generated_at,
    evidenceMetadata.generatedAt,
    evidenceMetadata.created_at,
    evidenceMetadata.createdAt,
    evidenceMetadata.captured_at,
    evidenceMetadata.capturedAt
  ]);
}

function projectStatusFreshnessAnchor(projectStatus = {}, blockers = []) {
  return latestTimestamp([
    projectStatus.updated_at,
    projectStatus.updatedAt,
    projectStatus.status_updated_at,
    projectStatus.statusUpdatedAt,
    ...blockers.flatMap((blocker) => [
      blocker.updated_at,
      blocker.updatedAt,
      blocker.detected_at,
      blocker.detectedAt,
      blocker.created_at,
      blocker.createdAt,
      blocker.captured_at,
      blocker.capturedAt
    ])
  ]);
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
  const allowInsecureLocalTest = Boolean(options.allowInsecureLocalTest || options.allow_insecure_local_test);

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
  const generatedAt = evidenceTimestampInfo(artifact);
  if (!generatedAt.raw) {
    issues.push({ code: "missing_live_route_evidence_timestamp", path: "created_at" });
  } else if (!Number.isFinite(generatedAt.timestamp)) {
    issues.push({ code: "invalid_live_route_evidence_timestamp", path: "created_at" });
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
  const routeIsLocalTest = isLocalLiveRouteUrl(routeUrl);
  const finalIsLocalTest = isLocalLiveRouteUrl(finalUrl);
  const localLoopback = firstBoolean([
    artifact.local_loopback,
    artifact.localLoopback,
    route.local_loopback,
    evidence.local_loopback,
    evidence.localLoopback
  ]);

  if (!routeUrl) {
    issues.push({ code: "missing_live_route_url", path: "route_url" });
  } else if (!isPublicHttpsRoute(routeUrl) && !(allowInsecureLocalTest && routeIsLocalTest)) {
    issues.push({ code: "live_route_url_not_public_https", path: "route_url" });
  }
  if (!finalUrl) {
    issues.push({ code: "missing_live_route_final_url", path: "final_url" });
  } else if (!isPublicHttpsRoute(finalUrl) && !(allowInsecureLocalTest && finalIsLocalTest)) {
    issues.push({ code: "live_route_final_url_not_public_https", path: "final_url" });
  }

  const localTestRouteOverride = allowInsecureLocalTest && localLoopback === true && (routeIsLocalTest || finalIsLocalTest);
  if (
    expectedRouteUrls.length > 0 &&
    !localTestRouteOverride &&
    !expectedRouteUrls.includes(normalizedRouteUrl) &&
    !expectedRouteUrls.includes(normalizedFinalUrl)
  ) {
    issues.push({
      code: "live_route_url_mismatch",
      path: "route_url",
      expected_route_urls: expectedRouteUrls
    });
  }

  if (projectId && routeUrl && !isProjectMountPath(routeUrl, projectId)) {
    issues.push({ code: "live_route_not_project_mount", path: "route_url" });
  }
  if (projectId && finalUrl && !isProjectMountPath(finalUrl, projectId)) {
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

  if (allowInsecureLocalTest && (routeIsLocalTest || finalIsLocalTest) && localLoopback !== true) {
    issues.push({ code: "local_live_route_evidence_missing_test_marker", path: "local_loopback" });
  }
  if (!allowInsecureLocalTest && localLoopback === true) {
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
    generated_at: generatedAt.raw || "",
    route_url: normalizedRouteUrl,
    final_url: normalizedFinalUrl,
    http_status: Number.isFinite(httpStatus) ? httpStatus : null,
    issues
  };
}

export function validateWorkbenchLiveRouteEvidenceFreshness(input = {}) {
  const projectStatus = isObject(input.projectStatus) ? input.projectStatus : {};
  const blockers = asArray(input.blockers);
  const evidenceArtifact = isObject(input.evidenceArtifact) ? input.evidenceArtifact : {};
  const evidenceMetadata = isObject(input.evidenceMetadata) ? input.evidenceMetadata : {};
  const maxAgeMs = Number.isFinite(Number(input.maxEvidenceAgeMs))
    ? Number(input.maxEvidenceAgeMs)
    : DEFAULT_WORKBENCH_LIVE_ROUTE_EVIDENCE_MAX_AGE_MS;
  const allowedFutureSkewMs = Number.isFinite(Number(input.allowedFutureSkewMs))
    ? Number(input.allowedFutureSkewMs)
    : DEFAULT_ALLOWED_EVIDENCE_FUTURE_SKEW_MS;
  const nowMs = input.now ? parseTimestampMs(input.now) : Date.now();
  const generatedAt = evidenceTimestampInfo(evidenceArtifact, evidenceMetadata);
  const requiredAfterMs = projectStatusFreshnessAnchor(projectStatus, blockers);
  const issues = [];

  if (!generatedAt.raw) {
    issues.push({
      code: "missing_live_route_evidence_timestamp",
      path: "created_at",
      message: "public live-route evidence must include a generated_at, created_at, or captured_at timestamp"
    });
  } else if (!Number.isFinite(generatedAt.timestamp)) {
    issues.push({
      code: "invalid_live_route_evidence_timestamp",
      path: "created_at",
      generated_at: generatedAt.raw
    });
  }

  if (Number.isFinite(generatedAt.timestamp)) {
    if (Number.isFinite(requiredAfterMs) && generatedAt.timestamp <= requiredAfterMs) {
      issues.push({
        code: "stale_live_route_evidence",
        path: "created_at",
        reason: "older_than_project_status_update",
        generated_at: generatedAt.raw,
        required_after: new Date(requiredAfterMs).toISOString(),
        message: "public live-route evidence predates the current unresolved route blocker state"
      });
    }
    if (Number.isFinite(nowMs)) {
      const ageMs = nowMs - generatedAt.timestamp;
      if (ageMs > maxAgeMs) {
        issues.push({
          code: "stale_live_route_evidence",
          path: "created_at",
          reason: "exceeds_freshness_window",
          generated_at: generatedAt.raw,
          max_age_ms: maxAgeMs,
          age_ms: ageMs,
          message: "public live-route evidence is outside the freshness window for unresolved route blockers"
        });
      } else if (generatedAt.timestamp - nowMs > allowedFutureSkewMs) {
        issues.push({
          code: "future_live_route_evidence_timestamp",
          path: "created_at",
          generated_at: generatedAt.raw,
          now: new Date(nowMs).toISOString()
        });
      }
    }
  }

  return {
    status: issues.length > 0 ? "fail" : "pass",
    generated_at: generatedAt.raw || "",
    required_after: Number.isFinite(requiredAfterMs) ? new Date(requiredAfterMs).toISOString() : "",
    max_age_ms: maxAgeMs,
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
  let evidenceFreshness = null;

  if (input.evidenceArtifact !== undefined && input.evidenceArtifact !== null) {
    evidenceValidation = validateWorkbenchLiveRouteEvidenceArtifact(input.evidenceArtifact, {
      expectedRouteUrls,
      projectId
    });
    if (blockers.length > 0) {
      evidenceFreshness = validateWorkbenchLiveRouteEvidenceFreshness({
        projectStatus,
        blockers,
        evidenceArtifact: input.evidenceArtifact,
        evidenceMetadata: input.evidenceMetadata,
        now: input.now,
        maxEvidenceAgeMs: input.maxEvidenceAgeMs,
        allowedFutureSkewMs: input.allowedFutureSkewMs
      });
    }
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
  if (evidenceFreshness?.status === "fail") {
    issues.push(...evidenceFreshness.issues);
  }

  const evidenceAccepted = evidenceValidation?.status === "pass" &&
    (!evidenceFreshness || evidenceFreshness.status === "pass");

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
    evidence_status: evidenceValidation ? evidenceAccepted ? "pass" : "fail" : blockers.length > 0 ? "missing" : "not_required",
    evidence: evidenceValidation,
    evidence_freshness: evidenceFreshness,
    issues
  };
}
