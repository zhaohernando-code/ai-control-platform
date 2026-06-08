import { execFileSync } from "node:child_process";

const DEFAULT_EDGE_AGENT_TOKEN_HELPER = "/Users/hernando_zhao/codex/scripts/edge-agent-auth-token.sh";
export const EDGE_AGENT_AUTH_HEADER = "X-HZ-Dev-Auth-Bypass-Token";

export function noteHeader(options, name) {
  if (!options.headerNames.includes(name)) options.headerNames.push(name);
}

export function addHeader(options, rawHeader) {
  const separator = rawHeader.indexOf(":");
  if (separator <= 0) throw new Error("invalid --header format; expected 'Name: value'");
  const name = rawHeader.slice(0, separator).trim();
  const value = rawHeader.slice(separator + 1).trim();
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(name) || !value) {
    throw new Error("invalid --header format; expected non-empty HTTP header name and value");
  }
  options.headers[name] = value;
  noteHeader(options, name);
}

function hasExplicitAuthHeader(headers = {}) {
  return Object.keys(headers).some((name) => {
    const normalized = name.toLowerCase();
    return normalized === "cookie" || normalized === "authorization" || normalized === EDGE_AGENT_AUTH_HEADER.toLowerCase();
  });
}

export function ensureTrailingSlash(value) {
  const url = new URL(value);
  if (!url.pathname.endsWith("/") && !url.pathname.split("/").at(-1)?.includes(".")) {
    url.pathname = `${url.pathname}/`;
  }
  return url.toString();
}

export function resolveRouteUrl(projectStatus, explicitUrl, expectedRouteUrls) {
  if (explicitUrl) return ensureTrailingSlash(explicitUrl);
  const expected = expectedRouteUrls || [];
  if (expected.length === 0) {
    throw new Error("missing --url and no expected public workbench route could be inferred from PROJECT_STATUS");
  }
  return expected[0];
}

export function isLocalHostname(hostname) {
  const normalized = String(hostname || "").toLowerCase();
  return normalized === "localhost" || normalized === "0.0.0.0" || normalized === "::1" || normalized.startsWith("127.");
}

export function isLocalRoute(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && isLocalHostname(url.hostname);
  } catch {
    return false;
  }
}

function isPublicHttpsRoute(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !isLocalHostname(url.hostname);
  } catch {
    return false;
  }
}

function isSharedEdgeRoute(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["hernando-zhao.cn", "www.hernando-zhao.cn"].includes(url.hostname);
  } catch {
    return false;
  }
}

function resolveEdgeAgentAuthToken(routeUrl, env = process.env) {
  if (!isSharedEdgeRoute(routeUrl) || env.WORKBENCH_LIVE_ROUTE_AUTO_EDGE_AUTH === "0") {
    return "";
  }

  const envToken = String(env.HZ_DEV_AUTH_BYPASS_TOKEN || "").trim();
  if (envToken) return envToken;

  const helperPath = String(env.EDGE_AGENT_AUTH_TOKEN_HELPER || DEFAULT_EDGE_AGENT_TOKEN_HELPER).trim();
  if (!helperPath) return "";

  try {
    return execFileSync(helperPath, [], {
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  } catch {
    return "";
  }
}

export function applyDefaultEdgeAgentAuth(options, routeUrl) {
  if (hasExplicitAuthHeader(options.headers)) return;
  const token = resolveEdgeAgentAuthToken(routeUrl, options.env || process.env);
  if (!token) return;
  options.headers[EDGE_AGENT_AUTH_HEADER] = token;
  noteHeader(options, EDGE_AGENT_AUTH_HEADER);
}

export function routeAllowed(value, allowInsecureLocalTest) {
  return isPublicHttpsRoute(value) || (allowInsecureLocalTest && isLocalRoute(value));
}

function projectMountPrefix(routeUrl, projectId) {
  const url = new URL(routeUrl);
  const marker = `/projects/${projectId}/`;
  const index = url.pathname.indexOf(marker);
  return index >= 0 ? url.pathname.slice(0, index + marker.length) : marker;
}

export function mountedUrl(routeUrl, projectId, suffix) {
  const url = new URL(routeUrl);
  url.pathname = `${projectMountPrefix(routeUrl, projectId)}${suffix}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function isProjectMount(value, projectId) {
  try {
    const url = new URL(value);
    const mountPath = `/projects/${projectId}`;
    return url.pathname === mountPath || url.pathname.startsWith(`${mountPath}/`);
  } catch {
    return false;
  }
}
