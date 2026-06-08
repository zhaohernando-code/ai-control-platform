#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  auditNavigation,
  auditRouteSet,
  auditViewport
} from "./workbench-next-served-route-browser-audit.mjs";
import {
  withRuntime,
  WORKBENCH_MOUNT_PREFIX
} from "./workbench-next-served-route-runtime.mjs";

const VERSION = "workbench-next-served-route-check.v1";
export { withRuntime, WORKBENCH_MOUNT_PREFIX };

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function valueAfter(flag, args = process.argv.slice(2)) {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : "";
}

function hasFlag(flag, args = process.argv.slice(2)) {
  return args.includes(flag);
}

function isMountedWorkbenchUrl(value) {
  try {
    const pathname = new URL(value).pathname;
    return pathname === WORKBENCH_MOUNT_PREFIX || pathname.startsWith(`${WORKBENCH_MOUNT_PREFIX}/`);
  } catch {
    return false;
  }
}

function findingsForArtifact(artifact) {
  const findings = [];
  const issue = (code, message, evidence = {}) => findings.push({
    code,
    severity: "blocking",
    status: "fail",
    message,
    evidence
  });

  for (const viewport of artifact.viewport_results) {
    if (viewport.http_status < 200 || viewport.http_status >= 300) {
      issue("next_route_http_status_not_success", `${viewport.viewport} Next route did not return 2xx`, {
        viewport: viewport.viewport,
        http_status: viewport.http_status
      });
    }
    if (!isMountedWorkbenchUrl(viewport.final_url)) {
      issue("next_route_not_mounted", `${viewport.viewport} final URL is not the mounted Workbench route`, {
        viewport: viewport.viewport,
        final_url: viewport.final_url
      });
    }
    if (viewport.ant_layout_count < 1 || viewport.ant_menu_count < 1) {
      issue("next_route_antd_shell_missing", `${viewport.viewport} did not render the Ant Design Workbench shell`, {
        viewport: viewport.viewport
      });
    }
    if (!viewport.projection_api_probe || viewport.projection_api_probe.status !== 200) {
      issue("next_route_projection_api_missing", `${viewport.viewport} did not load the mounted projection API through Next rewrites`, {
        viewport: viewport.viewport,
        projection_response: viewport.projection_response,
        projection_api_probe: viewport.projection_api_probe
      });
    }
    if (viewport.favicon_response.status !== 200 || !String(viewport.favicon_response.content_type).includes("image/svg+xml")) {
      issue("next_route_favicon_invalid", `${viewport.viewport} did not serve mounted SVG favicon`, {
        viewport: viewport.viewport,
        favicon_response: viewport.favicon_response
      });
    }
    if (viewport.root_next_script_count > 0) {
      issue("next_route_root_assets_detected", `${viewport.viewport} rendered root-level Next.js assets`, {
        viewport: viewport.viewport,
        root_next_script_count: viewport.root_next_script_count
      });
    }
    if (viewport.desktop_shell_count > 0 || viewport.mobile_shell_count > 0 || viewport.legacy_data_bind_count > 0 || viewport.has_legacy_static_entry) {
      issue("next_route_legacy_static_shell_detected", `${viewport.viewport} rendered or referenced the legacy static shell`, {
        viewport: viewport.viewport,
        desktop_shell_count: viewport.desktop_shell_count,
        mobile_shell_count: viewport.mobile_shell_count,
        legacy_data_bind_count: viewport.legacy_data_bind_count,
        has_legacy_static_entry: viewport.has_legacy_static_entry
      });
    }
    if (viewport.dimensions.scrollWidth > viewport.dimensions.width) {
      issue("next_route_horizontal_overflow", `${viewport.viewport} has horizontal overflow`, {
        viewport: viewport.viewport,
        dimensions: viewport.dimensions
      });
    }
    if (viewport.console_error_count || viewport.page_error_count || viewport.failed_request_count || viewport.http_error_count) {
      issue("next_route_browser_errors", `${viewport.viewport} recorded browser errors`, {
        viewport: viewport.viewport,
        console_errors: viewport.console_errors,
        page_errors: viewport.page_errors,
        failed_requests: viewport.failed_requests,
        http_errors: viewport.http_errors
      });
    }
    if (/无法加载工作台状态|Failed to fetch|Application error/iu.test(viewport.body_text_sample)) {
      issue("next_route_visible_runtime_error", `${viewport.viewport} visible text shows a runtime/API failure`, {
        viewport: viewport.viewport,
        body_text_sample: viewport.body_text_sample
      });
    }
  }

  if (artifact.navigation_result?.status !== "pass" || artifact.navigation_result?.requirements_contains_form !== true) {
    issue("next_route_navigation_failed", "Next served route did not preserve basic SPA navigation and task form rendering", {
      navigation_result: artifact.navigation_result
    });
  }

  for (const route of artifact.route_results || []) {
    if (route.http_status < 200 || route.http_status >= 300) {
      issue("next_route_set_http_status_not_success", `Next route ${route.path} did not return 2xx`, route);
    }
    if (!isMountedWorkbenchUrl(route.final_url)) {
      issue("next_route_set_not_mounted", `Next route ${route.path} did not stay under the mounted route`, route);
    }
    if (route.ant_layout_count < 1 || route.ant_menu_count < 1) {
      issue("next_route_set_antd_shell_missing", `Next route ${route.path} did not render the shared Workbench shell`, route);
    }
    if (route.legacy_data_bind_count > 0 || route.desktop_shell_count > 0 || route.mobile_shell_count > 0) {
      issue("next_route_set_legacy_static_shell_detected", `Next route ${route.path} rendered legacy static shell markers`, route);
    }
  }

  return findings;
}

function writeArtifact(outputPath, artifact) {
  if (!outputPath) return null;
  mkdirSync(dirname(resolve(outputPath)), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
  return outputPath;
}

export async function runNextServedRouteCheck(options = {}) {
  return withRuntime(async ({ baseUrl, apiPort, nextPort, logs }) => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    try {
      const viewportResults = [
        await auditViewport(browser, baseUrl, "desktop", { viewport: { width: 1440, height: 900 } }),
        await auditViewport(browser, baseUrl, "mobile", { viewport: { width: 390, height: 844 }, isMobile: true })
      ];
      const navigationResult = await auditNavigation(browser, baseUrl);
      const routeResults = await auditRouteSet(browser, baseUrl);
      const artifact = {
        version: VERSION,
        status: "pending",
        created_at: new Date().toISOString(),
        route_base_url: baseUrl,
        api_port: apiPort,
        next_port: nextPort,
        mount_prefix: WORKBENCH_MOUNT_PREFIX,
        route_family: "nextjs_app_router",
        legacy_static_shell_allowed: false,
        viewport_results: viewportResults,
        navigation_result: navigationResult,
        route_results: routeResults,
        secret_policy: "No cookies, tokens, authorization headers, or secret values are stored.",
        findings: [],
        blocking_count: 0,
        next_stdout_tail: logs().stdout.slice(-2000),
        next_stderr_tail: logs().stderr.slice(-2000)
      };
      const findings = findingsForArtifact(artifact);
      artifact.findings = findings;
      artifact.blocking_count = findings.length;
      artifact.status = findings.length === 0 ? "pass" : "fail";
      writeArtifact(options.outputPath, artifact);
      return artifact;
    } finally {
      await browser.close();
    }
  });
}

async function main() {
  const outputPath = valueAfter("--output") || "";
  const allowFail = hasFlag("--allow-fail");
  const artifact = await runNextServedRouteCheck({ outputPath });
  console.log(JSON.stringify({
    version: artifact.version,
    status: artifact.status,
    mount_prefix: artifact.mount_prefix,
    route_family: artifact.route_family,
    viewport_count: artifact.viewport_results.length,
    blocking_count: artifact.blocking_count,
    output: outputPath || null,
    findings: artifact.findings
  }, null, 2));
  if (!allowFail && artifact.status !== "pass") {
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
