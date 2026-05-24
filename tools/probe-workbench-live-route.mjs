#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import {
  extractExpectedPublicRouteUrls,
  validateWorkbenchLiveRouteEvidenceArtifact,
  WORKBENCH_LIVE_ROUTE_EVIDENCE_VERSION
} from "../src/workflow/live-route-acceptance.js";

const DEFAULT_PROJECT_STATUS_PATH = "PROJECT_STATUS.json";
const DEFAULT_OUTPUT_PATH = "tmp/workbench-live-route-evidence.json";
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function usage() {
  return [
    "usage: probe-workbench-live-route.mjs [--project-status PROJECT_STATUS.json] [--url URL] [--output evidence.json]",
    "                                      [--cookie-header COOKIE] [--header 'Name: value'] [--allow-insecure-local-test]",
    "",
    "Generates workbench-live-route-evidence.v1 without printing authentication header values."
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    projectStatusPath: DEFAULT_PROJECT_STATUS_PATH,
    outputPath: DEFAULT_OUTPUT_PATH,
    headers: {},
    headerNames: [],
    allowInsecureLocalTest: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--project-status") {
      options.projectStatusPath = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === "--url") {
      options.url = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === "--output") {
      options.outputPath = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === "--cookie-header") {
      const value = requiredValue(argv, index, arg);
      options.headers.Cookie = options.headers.Cookie ? `${options.headers.Cookie}; ${value}` : value;
      noteHeader(options, "Cookie");
      index += 1;
    } else if (arg === "--header") {
      addHeader(options, requiredValue(argv, index, arg));
      index += 1;
    } else if (arg === "--allow-insecure-local-test") {
      options.allowInsecureLocalTest = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

function requiredValue(argv, index, arg) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`missing value for ${arg}`);
  }
  return value;
}

function noteHeader(options, name) {
  if (!options.headerNames.includes(name)) options.headerNames.push(name);
}

function addHeader(options, rawHeader) {
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

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`failed to read ${label} JSON at ${path}: ${error.message}`);
  }
}

function ensureTrailingSlash(value) {
  const url = new URL(value);
  if (!url.pathname.endsWith("/") && !url.pathname.split("/").at(-1)?.includes(".")) {
    url.pathname = `${url.pathname}/`;
  }
  return url.toString();
}

function resolveRouteUrl(projectStatus, explicitUrl) {
  if (explicitUrl) return ensureTrailingSlash(explicitUrl);
  const expected = extractExpectedPublicRouteUrls(projectStatus);
  if (expected.length === 0) {
    throw new Error("missing --url and no expected public workbench route could be inferred from PROJECT_STATUS");
  }
  return expected[0];
}

function isLocalHostname(hostname) {
  const normalized = String(hostname || "").toLowerCase();
  return normalized === "localhost" || normalized === "0.0.0.0" || normalized === "::1" || normalized.startsWith("127.");
}

function isLocalRoute(value) {
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

function routeAllowed(value, allowInsecureLocalTest) {
  return isPublicHttpsRoute(value) || (allowInsecureLocalTest && isLocalRoute(value));
}

function projectMountPrefix(routeUrl, projectId) {
  const url = new URL(routeUrl);
  const marker = `/projects/${projectId}/`;
  const index = url.pathname.indexOf(marker);
  return index >= 0 ? url.pathname.slice(0, index + marker.length) : marker;
}

function mountedUrl(routeUrl, projectId, suffix) {
  const url = new URL(routeUrl);
  url.pathname = `${projectMountPrefix(routeUrl, projectId)}${suffix}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function isProjectMount(value, projectId) {
  try {
    const url = new URL(value);
    return url.pathname.startsWith(`/projects/${projectId}/`);
  } catch {
    return false;
  }
}

function looksLikeWorkbenchHtml(body) {
  const text = String(body || "");
  return (
    /<title>\s*AI Control Platform Workbench\s*<\/title>/iu.test(text) ||
    /data-view=["']desktop["']/iu.test(text) ||
    /data-bind=["']headline["']/iu.test(text) ||
    (/Control Platform/iu.test(text) && /workbench/iu.test(text))
  );
}

function redirectLocation(response) {
  const location = response.headers.location;
  return Array.isArray(location) ? location[0] : location || "";
}

function setCookieValues(headers) {
  const value = headers["set-cookie"];
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function detectAuthRedirect(response, fromUrl) {
  const status = Number(response.status || 0);
  const location = redirectLocation(response);
  if (status === 401 || status === 403) return false;
  if (status < 300 || status >= 400 || !location) return false;
  const resolved = new URL(location, fromUrl);
  const path = `${resolved.pathname}?${resolved.searchParams.toString()}`.toLowerCase();
  const clearsSession = setCookieValues(response.headers)
    .some((cookie) => /hz_auth_session=;/iu.test(cookie) || /hz_auth_session=\s*(?:;|$)/iu.test(cookie));
  return (
    resolved.searchParams.has("next") ||
    /(?:^|\/)(login|auth|signin|oauth)(?:\/|$)/iu.test(resolved.pathname) ||
    path.includes("next=%2fprojects%2f") ||
    clearsSession
  );
}

async function requestText(url, headers, options = {}, redirects = []) {
  const parsed = new URL(url);
  const transport = parsed.protocol === "https:" ? httpsRequest : httpRequest;
  const response = await new Promise((resolve, reject) => {
    const requestOptions = {
      method: "GET",
      headers,
      timeout: 15000
    };
    if (parsed.protocol === "https:" && options.allowInsecureLocalTest && isLocalHostname(parsed.hostname)) {
      requestOptions.rejectUnauthorized = false;
    }
    const req = transport(parsed, requestOptions, (res) => {
      const chunks = [];
      let total = 0;
      res.on("data", (chunk) => {
        total += chunk.length;
        if (total <= MAX_BODY_BYTES) chunks.push(chunk);
      });
      res.on("end", () => {
        resolve({
          url,
          status: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8")
        });
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error("request timed out"));
    });
    req.on("error", reject);
    req.end();
  });

  const authRedirectDetected = detectAuthRedirect(response, url);
  const location = redirectLocation(response);
  const status = Number(response.status || 0);
  if (status >= 300 && status < 400 && location && redirects.length < MAX_REDIRECTS) {
    const nextUrl = new URL(location, url).toString();
    return requestText(nextUrl, headers, options, [
      ...redirects,
      {
        from_url: url,
        to_url: nextUrl,
        http_status: status,
        auth_redirect_detected: authRedirectDetected
      }
    ]);
  }

  return {
    ...response,
    finalUrl: url,
    redirects,
    authRedirectDetected: authRedirectDetected || redirects.some((redirect) => redirect.auth_redirect_detected)
  };
}

function safeRequest(label, url, headers, options) {
  const requestFn = options.requestText || requestText;
  return requestFn(url, headers, options).catch((error) => ({
    label,
    url,
    finalUrl: url,
    status: 0,
    headers: {},
    body: "",
    redirects: [],
    authRedirectDetected: false,
    error: error.message
  }));
}

function parseJsonObject(body) {
  try {
    const value = JSON.parse(body);
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  } catch {
    return false;
  }
}

function issue(code, message, details = {}) {
  return { code, message, ...details };
}

export async function probeWorkbenchLiveRoute(inputOptions = {}) {
  const options = {
    projectStatusPath: DEFAULT_PROJECT_STATUS_PATH,
    outputPath: DEFAULT_OUTPUT_PATH,
    headers: {},
    headerNames: [],
    allowInsecureLocalTest: false,
    ...inputOptions
  };
  const projectStatus = readJson(options.projectStatusPath, "project status");
  const projectId = String(projectStatus.project || "ai-control-platform").trim() || "ai-control-platform";
  const expectedRouteUrls = extractExpectedPublicRouteUrls(projectStatus);
  const routeUrl = resolveRouteUrl(projectStatus, options.url);
  const shellUrl = mountedUrl(routeUrl, projectId, "apps/workbench/desktop.html");
  const apiUrl = mountedUrl(routeUrl, projectId, "api/workbench/projection");
  const localLoopback = isLocalRoute(routeUrl);
  const probeIssues = [];

  if (localLoopback && !options.allowInsecureLocalTest) {
    probeIssues.push(issue("local_loopback_requires_allow_insecure_local_test", "localhost workbench routes require --allow-insecure-local-test"));
  }
  if (!routeAllowed(routeUrl, options.allowInsecureLocalTest)) {
    probeIssues.push(issue("route_target_not_public_https", "route target must be public HTTPS unless explicitly running a local loopback test"));
  }

  const routeResponse = await safeRequest("route", routeUrl, options.headers, options);
  const rootRendered = looksLikeWorkbenchHtml(routeResponse.body);
  const needsShellRequest = !rootRendered;
  const shellResponse = needsShellRequest
    ? await safeRequest("workbench_shell", shellUrl, options.headers, options)
    : routeResponse;
  const apiResponse = await safeRequest("mounted_api", apiUrl, options.headers, options);

  const authRedirectDetected = Boolean(
    routeResponse.authRedirectDetected ||
      shellResponse.authRedirectDetected ||
      apiResponse.authRedirectDetected
  );
  const routeHttpOk = routeResponse.status >= 200 && routeResponse.status < 300;
  const shellHttpOk = shellResponse.status >= 200 && shellResponse.status < 300;
  const apiHttpOk = apiResponse.status >= 200 && apiResponse.status < 300;
  const workbenchRendered = looksLikeWorkbenchHtml(shellResponse.body);
  const mountedApiVerified = apiHttpOk && parseJsonObject(apiResponse.body);
  const publicRouteVerified = routeAllowed(routeUrl, options.allowInsecureLocalTest) &&
    routeHttpOk &&
    !authRedirectDetected &&
    isProjectMount(routeResponse.finalUrl, projectId);
  const mountedWorkbenchRouteVerified = shellHttpOk &&
    workbenchRendered &&
    isProjectMount(shellResponse.finalUrl, projectId);

  if (routeResponse.error) {
    probeIssues.push(issue("route_request_failed", "public route request failed", { target: "route" }));
  }
  if (!routeHttpOk) {
    probeIssues.push(issue("route_http_status_not_success", "public route did not return a final 2xx response", { http_status: routeResponse.status }));
  }
  if (authRedirectDetected) {
    probeIssues.push(issue("route_auth_redirect_detected", "probe detected an authentication redirect or session reset"));
  }
  if (!publicRouteVerified) {
    probeIssues.push(issue("public_route_not_verified", "route did not verify as an authenticated mounted workbench route"));
  }
  if (!mountedWorkbenchRouteVerified) {
    probeIssues.push(issue("mounted_workbench_route_not_verified", "mounted desktop workbench shell did not render successfully"));
  }
  if (!workbenchRendered) {
    probeIssues.push(issue("workbench_render_not_verified", "HTML did not contain expected workbench shell markers"));
  }
  if (!mountedApiVerified) {
    probeIssues.push(issue("mounted_api_not_verified", "mounted workbench API did not return a 2xx JSON response"));
  }

  const prelimStatus = probeIssues.length === 0 ? "pass" : "fail";
  const artifact = {
    version: WORKBENCH_LIVE_ROUTE_EVIDENCE_VERSION,
    status: prelimStatus,
    created_at: new Date().toISOString(),
    project: projectId,
    route_url: routeUrl,
    final_url: routeResponse.finalUrl,
    http_status: routeResponse.status || null,
    public_route_verified: publicRouteVerified,
    mounted_workbench_route_verified: mountedWorkbenchRouteVerified,
    workbench_rendered: workbenchRendered,
    mounted_api_verified: mountedApiVerified,
    auth_redirect_detected: authRedirectDetected,
    local_loopback: localLoopback,
    verification_mode: localLoopback ? "local_loopback_test" : "public_https",
    request_header_names: [...options.headerNames].sort(),
    route: {
      url: routeUrl,
      final_url: routeResponse.finalUrl,
      http_status: routeResponse.status || null,
      redirect_count: routeResponse.redirects.length,
      auth_redirect_detected: routeResponse.authRedirectDetected,
      public_route_verified: publicRouteVerified
    },
    workbench: {
      shell_url: shellUrl,
      shell_final_url: shellResponse.finalUrl,
      shell_http_status: shellResponse.status || null,
      mounted_route_verified: mountedWorkbenchRouteVerified,
      rendered: workbenchRendered,
      api_url: apiUrl,
      api_http_status: apiResponse.status || null,
      mounted_api_verified: mountedApiVerified
    },
    redirects: routeResponse.redirects,
    issues: probeIssues
  };

  const validation = validateWorkbenchLiveRouteEvidenceArtifact(artifact, {
    projectId,
    expectedRouteUrls,
    allowInsecureLocalTest: options.allowInsecureLocalTest
  });
  const validationIssues = validation.status === "pass" ? [] : validation.issues;
  artifact.validation = validation;
  artifact.issues = [...probeIssues, ...validationIssues];
  artifact.status = artifact.issues.length === 0 ? "pass" : "fail";
  return artifact;
}

export function writeProbeArtifact(path, artifact) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
}

function cliSummary(artifact, outputPath) {
  return {
    status: artifact.status,
    version: artifact.version,
    project: artifact.project,
    route_url: artifact.route_url,
    final_url: artifact.final_url,
    http_status: artifact.http_status,
    auth_redirect_detected: artifact.auth_redirect_detected,
    public_route_verified: artifact.public_route_verified,
    mounted_workbench_route_verified: artifact.mounted_workbench_route_verified,
    workbench_rendered: artifact.workbench_rendered,
    mounted_api_verified: artifact.mounted_api_verified,
    local_loopback: artifact.local_loopback,
    output: outputPath,
    request_header_names: artifact.request_header_names,
    issues: artifact.issues
  };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exit(2);
  }

  if (options.help) {
    console.log(usage());
    process.exit(0);
  }

  try {
    const artifact = await probeWorkbenchLiveRoute(options);
    writeProbeArtifact(options.outputPath, artifact);
    console.log(JSON.stringify(cliSummary(artifact, options.outputPath), null, 2));
    process.exit(artifact.status === "pass" ? 0 : 1);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
