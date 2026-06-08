#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import {
  extractExpectedPublicRouteUrls,
  validateWorkbenchLiveRouteEvidenceArtifact,
  WORKBENCH_LIVE_ROUTE_EVIDENCE_VERSION
} from "../src/workflow/live-route-acceptance.js";
import {
  applyDefaultEdgeAgentAuth,
  addHeader,
  isLocalRoute,
  isProjectMount,
  mountedUrl,
  noteHeader,
  resolveRouteUrl,
  routeAllowed
} from "./workbench-live-route-url-auth.mjs";
import {
  assetPathMounted,
  extractReferencedAssetUrls,
  looksLikeWorkbenchHtml,
  parseJsonObject,
  safeRequest
} from "./workbench-live-route-http.mjs";

const DEFAULT_PROJECT_STATUS_PATH = "PROJECT_STATUS.json";
const DEFAULT_OUTPUT_PATH = "tmp/workbench-live-route-evidence.json";

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

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`failed to read ${label} JSON at ${path}: ${error.message}`);
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
  const routeUrl = resolveRouteUrl(projectStatus, options.url, expectedRouteUrls);
  applyDefaultEdgeAgentAuth(options, routeUrl);
  const shellUrl = mountedUrl(routeUrl, projectId, "flow");
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
  const referencedAssetUrls = extractReferencedAssetUrls(routeResponse.body, routeResponse.finalUrl);
  const unmountedAssetUrls = referencedAssetUrls.filter((assetUrl) => !assetPathMounted(assetUrl, projectId));
  const mountedAssetUrls = referencedAssetUrls.filter((assetUrl) => assetPathMounted(assetUrl, projectId));
  const assetResponses = [];
  for (const assetUrl of mountedAssetUrls.slice(0, 8)) {
    const assetResponse = await safeRequest("referenced_asset", assetUrl, options.headers, options);
    assetResponses.push({
      url: assetUrl,
      final_url: assetResponse.finalUrl,
      http_status: assetResponse.status || null,
      auth_redirect_detected: assetResponse.authRedirectDetected,
      error: assetResponse.error || null
    });
  }

  const authRedirectDetected = Boolean(
    routeResponse.authRedirectDetected ||
      shellResponse.authRedirectDetected ||
      apiResponse.authRedirectDetected ||
      assetResponses.some((response) => response.authRedirectDetected)
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
  const referencedAssetsMounted = referencedAssetUrls.length === 0 || unmountedAssetUrls.length === 0;
  const referencedAssetsReachable = assetResponses.every((response) => response.http_status >= 200 && response.http_status < 300);

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
    probeIssues.push(issue("mounted_workbench_route_not_verified", "mounted Next.js workbench route did not render successfully"));
  }
  if (!workbenchRendered) {
    probeIssues.push(issue("workbench_render_not_verified", "HTML did not contain expected workbench shell markers"));
  }
  if (!mountedApiVerified) {
    probeIssues.push(issue("mounted_api_not_verified", "mounted workbench API did not return a 2xx JSON response"));
  }
  if (!referencedAssetsMounted) {
    probeIssues.push(issue("referenced_assets_not_mounted", "served route HTML references root-level assets instead of project-mounted assets", {
      unmounted_asset_urls: unmountedAssetUrls.slice(0, 10)
    }));
  }
  if (!referencedAssetsReachable) {
    probeIssues.push(issue("referenced_assets_not_reachable", "served route referenced mounted assets that did not return 2xx", {
      asset_responses: assetResponses.filter((response) => !(response.http_status >= 200 && response.http_status < 300)).slice(0, 10)
    }));
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
      mounted_api_verified: mountedApiVerified,
      referenced_asset_count: referencedAssetUrls.length,
      referenced_assets_mounted: referencedAssetsMounted,
      referenced_assets_reachable: referencedAssetsReachable,
      referenced_asset_responses: assetResponses
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
