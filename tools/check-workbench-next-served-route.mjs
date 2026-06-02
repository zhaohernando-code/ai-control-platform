#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createWorkbenchServer } from "./workbench-server.mjs";

const VERSION = "workbench-next-served-route-check.v1";
export const WORKBENCH_MOUNT_PREFIX = "/projects/ai-control-platform";
const NEXT_READY_TIMEOUT_MS = 90000;
const ROUTE_TIMEOUT_MS = 30000;

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

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function requestText(url) {
  return new Promise((resolveRequest, reject) => {
    const req = httpRequest(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolveRequest({
        status: res.statusCode || 0,
        headers: res.headers,
        body
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function listenServer(server) {
  const listening = once(server, "listening");
  const errored = once(server, "error").then(([error]) => {
    throw error;
  });
  server.listen(0, "127.0.0.1");
  await Promise.race([listening, errored]);
  return server.address().port;
}

async function closeServer(server) {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

async function waitForNextRoute(baseUrl, child) {
  const deadline = Date.now() + NEXT_READY_TIMEOUT_MS;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Next.js process exited before serving route: ${child.exitCode}`);
    }
    try {
      const response = await requestText(`${baseUrl}${WORKBENCH_MOUNT_PREFIX}/`);
      if (response.status >= 200 && response.status < 400) return response;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await sleep(500);
  }
  throw new Error(`Next.js route was not ready within ${NEXT_READY_TIMEOUT_MS}ms: ${lastError}`);
}

async function startNextServer({ apiPort, nextPort }) {
  const nextDir = resolve("apps/workbench");
  const nextBin = resolve(nextDir, "node_modules/next/dist/bin/next");
  const env = {
    ...process.env,
    WORKBENCH_MOUNT_PREFIX,
    WORKBENCH_API_BASE: WORKBENCH_MOUNT_PREFIX,
    WORKBENCH_API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`
  };
  const child = spawn(process.execPath, [
    nextBin,
    "dev",
    "-H",
    "127.0.0.1",
    "-p",
    String(nextPort)
  ], {
    cwd: nextDir,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const baseUrl = `http://127.0.0.1:${nextPort}`;
  try {
    await waitForNextRoute(baseUrl, child);
  } catch (error) {
    child.kill("SIGTERM");
    throw new Error(`${error.message}\nstdout:\n${stdout.slice(-4000)}\nstderr:\n${stderr.slice(-4000)}`);
  }

  return {
    baseUrl,
    child,
    logs: () => ({ stdout, stderr })
  };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    sleep(5000).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    })
  ]);
}

export async function withRuntime(fn, options = {}) {
  mkdirSync("tmp", { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-next-served-route-"));
  const server = createWorkbenchServer({
    eventsPath: options.eventsPath || join(dir, "operator-events.json"),
    historyPath: options.historyPath || "docs/examples/projection-history.json",
    snapshotsRoot: options.snapshotsRoot || "docs/examples",
    projectStatusPath: Object.hasOwn(options, "projectStatusPath") ? options.projectStatusPath : "PROJECT_STATUS.json",
    stateDbPath: options.stateDbPath || join(dir, "workbench-state.sqlite"),
    realReviewerExecutor: options.realReviewerExecutor
  });
  const apiPort = await listenServer(server);
  const nextPort = Number(valueAfter("--port")) || 4191;
  let nextRuntime = null;
  try {
    nextRuntime = await startNextServer({ apiPort, nextPort });
    return await fn({ ...nextRuntime, apiPort, nextPort });
  } finally {
    if (nextRuntime) await stopChild(nextRuntime.child);
    await closeServer(server);
  }
}

function compactResponse(response) {
  return {
    url: response.url(),
    status: response.status(),
    content_type: response.headers()["content-type"] || null
  };
}

async function auditViewport(browser, baseUrl, viewportName, contextOptions = {}) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const httpErrors = [];
  const importantResponses = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText || "unknown";
    if (failure === "net::ERR_ABORTED" && request.url().includes("/api/workbench/projection")) {
      return;
    }
    failedRequests.push({
      url: request.url(),
      failure
    });
  });
  page.on("response", (response) => {
    const url = response.url();
    if (url.includes(WORKBENCH_MOUNT_PREFIX) || url.includes("/_next/static/")) {
      importantResponses.push(compactResponse(response));
    }
    if (response.status() >= 400) {
      httpErrors.push(compactResponse(response));
    }
  });

  const response = await page.goto(`${baseUrl}${WORKBENCH_MOUNT_PREFIX}/`, {
    waitUntil: "domcontentloaded",
    timeout: ROUTE_TIMEOUT_MS
  });
  await page.locator(".ant-layout").first().waitFor({ state: "visible", timeout: ROUTE_TIMEOUT_MS });
  await page.locator('[data-component="workbench-nav"]').first().waitFor({ state: "visible", timeout: ROUTE_TIMEOUT_MS });
  await page.waitForLoadState("networkidle", { timeout: ROUTE_TIMEOUT_MS }).catch(() => {});

  const root = await page.evaluate(() => ({
    title: document.title,
    final_url: location.href,
    body_text_sample: document.body.innerText.slice(0, 1200),
    ant_layout_count: document.querySelectorAll(".ant-layout").length,
    ant_menu_count: document.querySelectorAll(".ant-menu").length,
    mounted_next_script_count: document.querySelectorAll('script[src*="/projects/ai-control-platform/_next/static"]').length,
    root_next_script_count: document.querySelectorAll('script[src^="/_next/static"]').length,
    desktop_shell_count: document.querySelectorAll(".desktop-shell").length,
    mobile_shell_count: document.querySelectorAll(".mobile-shell").length,
    legacy_data_bind_count: document.querySelectorAll("[data-bind]").length,
    has_legacy_static_entry: document.documentElement.outerHTML.includes("apps/workbench/desktop.html") ||
      document.documentElement.outerHTML.includes("apps/workbench/mobile.html") ||
      document.documentElement.outerHTML.includes("workbench.js"),
    dimensions: {
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }
  }));

  const projectionResponse = importantResponses.find((entry) => entry.url.includes("/api/workbench/projection"));
  const projectionApiProbe = await page.evaluate(async () => {
    const response = await fetch("/projects/ai-control-platform/api/workbench/projection", { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    return {
      url: response.url,
      status: response.status,
      content_type: response.headers.get("content-type") || "",
      projection_status: body?.status || null,
      run_id: body?.run_id || null,
      cycle_id: body?.cycle_id || null
    };
  });
  const faviconResponse = await page.evaluate(async () => {
    const response = await fetch("/projects/ai-control-platform/favicon.svg", { cache: "no-store" });
    return {
      url: response.url,
      status: response.status,
      content_type: response.headers.get("content-type") || ""
    };
  });

  await context.close();

  return {
    viewport: viewportName,
    route_path: `${WORKBENCH_MOUNT_PREFIX}/`,
    http_status: response?.status() || 0,
    projection_response: projectionResponse || null,
    projection_api_probe: projectionApiProbe,
    favicon_response: faviconResponse,
    console_error_count: consoleErrors.length,
    page_error_count: pageErrors.length,
    failed_request_count: failedRequests.length,
    http_error_count: httpErrors.length,
    console_errors: consoleErrors.slice(0, 10),
    page_errors: pageErrors.slice(0, 10),
    failed_requests: failedRequests.slice(0, 10),
    http_errors: httpErrors.slice(0, 10),
    responses: importantResponses.slice(0, 80),
    ...root
  };
}

async function auditNavigation(browser, baseUrl) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${baseUrl}${WORKBENCH_MOUNT_PREFIX}/`, {
    waitUntil: "domcontentloaded",
    timeout: ROUTE_TIMEOUT_MS
  });
  await page.locator('[data-component="workbench-nav"]').first().waitFor({ state: "visible", timeout: ROUTE_TIMEOUT_MS });
  await page.getByText("新建任务", { exact: true }).click();
  await page.locator("form").first().waitFor({ state: "visible", timeout: ROUTE_TIMEOUT_MS });
  const requirementsUrl = page.url();
  const requirementText = await page.locator("body").innerText();
  await page.getByRole("button", { name: "查看任务流" }).click();
  await page.waitForURL(new RegExp(`${WORKBENCH_MOUNT_PREFIX}/flow/?$`), { timeout: ROUTE_TIMEOUT_MS });
  await page.locator("text=任务流").first().waitFor({ state: "visible", timeout: ROUTE_TIMEOUT_MS });
  const flowUrl = page.url();
  await page.close();
  return {
    status: "pass",
    requirements_url: requirementsUrl,
    flow_url: flowUrl,
    requirements_contains_form: requirementText.includes("任务标题") &&
      requirementText.includes("所属项目") &&
      requirementText.includes("需求描述")
  };
}

async function auditRouteSet(browser, baseUrl) {
  const routes = [
    { label: "overview", path: "/" },
    { label: "requirements", path: "/requirements" },
    { label: "projects", path: "/projects" },
    { label: "flow", path: "/flow" },
    { label: "agents", path: "/agents" },
    { label: "risks", path: "/risks" },
    { label: "governance", path: "/governance" },
    { label: "runs", path: "/runs" }
  ];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const results = [];
  try {
    for (const route of routes) {
      const response = await page.goto(`${baseUrl}${WORKBENCH_MOUNT_PREFIX}${route.path}`, {
        waitUntil: "domcontentloaded",
        timeout: ROUTE_TIMEOUT_MS
      });
      await page.locator(".ant-layout").first().waitFor({ state: "visible", timeout: ROUTE_TIMEOUT_MS });
      const dom = await page.evaluate(() => ({
        final_url: location.href,
        ant_layout_count: document.querySelectorAll(".ant-layout").length,
        ant_menu_count: document.querySelectorAll(".ant-menu").length,
        legacy_data_bind_count: document.querySelectorAll("[data-bind]").length,
        desktop_shell_count: document.querySelectorAll(".desktop-shell").length,
        mobile_shell_count: document.querySelectorAll(".mobile-shell").length,
        body_text_sample: document.body.innerText.slice(0, 360)
      }));
      results.push({
        ...route,
        route_path: `${WORKBENCH_MOUNT_PREFIX}${route.path}`,
        http_status: response?.status() || 0,
        ...dom
      });
    }
  } finally {
    await page.close();
  }
  return results;
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
