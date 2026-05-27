#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_URL = "https://hernando-zhao.cn/projects/ai-control-platform/";
const DEFAULT_OUTPUT = "tmp/public-live-route-browser-evidence.json";
const DEFAULT_EDGE_AGENT_TOKEN_HELPER = "/Users/hernando_zhao/codex/scripts/edge-agent-auth-token.sh";
const EDGE_AGENT_AUTH_HEADER = "X-HZ-Dev-Auth-Bypass-Token";

function parseArgs(argv) {
  const options = { url: DEFAULT_URL, output: DEFAULT_OUTPUT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--url") {
      options.url = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--output") {
      options.output = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function usage() {
  return [
    "usage: check-workbench-public-browser-route.mjs [--url URL] [--output evidence.json]",
    "",
    "Verifies the public mounted workbench route in Chromium, including dynamic Next.js chunks and client API calls."
  ].join("\n");
}

function resolveEdgeAgentAuthToken(env = process.env) {
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

function isMountedProjectUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname.startsWith("/projects/ai-control-platform/");
  } catch {
    return false;
  }
}

function issue(code, message, details = {}) {
  return { code, message, ...details };
}

async function runBrowserCheck(options) {
  const { chromium } = await import("playwright");
  const token = resolveEdgeAgentAuthToken();
  const headers = token ? { [EDGE_AGENT_AUTH_HEADER]: token } : {};
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ extraHTTPHeaders: headers });
  const page = await context.newPage();
  const consoleErrors = [];
  const failedRequests = [];
  const responses = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("requestfailed", (request) => {
    failedRequests.push({
      url: request.url(),
      failure: request.failure()?.errorText || "unknown"
    });
  });
  page.on("response", (response) => {
    const url = response.url();
    if (url.includes("/projects/ai-control-platform/") || url.includes("/_next/static/")) {
      responses.push({
        url,
        status: response.status(),
        content_type: response.headers()["content-type"] || null
      });
    }
  });

  let navigationError = null;
  let response = null;
  try {
    response = await page.goto(options.url, { waitUntil: "networkidle", timeout: 30000 });
  } catch (error) {
    navigationError = error.message;
  }

  const dom = await page.evaluate(() => ({
    title: document.title,
    final_url: location.href,
    body_text_sample: document.body.innerText.slice(0, 1000),
    ant_layout_count: document.querySelectorAll(".ant-layout").length,
    ant_menu_count: document.querySelectorAll(".ant-menu").length,
    mounted_next_script_count: document.querySelectorAll('script[src*="/projects/ai-control-platform/_next/static"]').length,
    root_next_script_count: document.querySelectorAll('script[src^="/_next/static"]').length,
    desktop_shell_count: document.querySelectorAll(".desktop-shell").length,
    has_desktop_shell_text: document.documentElement.outerHTML.includes("desktop-shell")
  })).catch(() => ({
    title: "",
    final_url: options.url,
    body_text_sample: "",
    ant_layout_count: 0,
    ant_menu_count: 0,
    mounted_next_script_count: 0,
    root_next_script_count: 0,
    desktop_shell_count: 0,
    has_desktop_shell_text: false
  }));
  await browser.close();

  const issues = [];
  const httpStatus = response?.status() || 0;
  if (!response || httpStatus < 200 || httpStatus >= 300) {
    issues.push(issue("browser_route_http_status_not_success", "browser route did not return a final 2xx response", { http_status: httpStatus || null }));
  }
  if (!isMountedProjectUrl(dom.final_url)) {
    issues.push(issue("browser_route_not_project_mount", "browser final URL is not the mounted project route", { final_url: dom.final_url }));
  }
  if (navigationError) {
    issues.push(issue("browser_navigation_failed", "browser navigation failed", { navigation_error: navigationError }));
  }
  if (dom.ant_layout_count < 1 || dom.ant_menu_count < 1) {
    issues.push(issue("browser_antd_dom_not_rendered", "browser DOM does not contain expected Ant Design layout/menu nodes"));
  }
  if (dom.root_next_script_count > 0) {
    issues.push(issue("browser_root_next_assets_detected", "browser DOM still references root-level Next.js scripts"));
  }
  if (dom.desktop_shell_count > 0 || dom.has_desktop_shell_text) {
    issues.push(issue("browser_desktop_shell_detected", "browser rendered the legacy desktop shell instead of the Next.js workbench"));
  }
  if (/无法加载工作台状态|Failed to fetch|Application error/iu.test(dom.body_text_sample)) {
    issues.push(issue("browser_client_runtime_error_visible", "browser visible text shows a client runtime or API loading failure"));
  }
  if (consoleErrors.length > 0) {
    issues.push(issue("browser_console_errors", "browser console reported errors", { console_errors: consoleErrors.slice(0, 20) }));
  }
  if (failedRequests.length > 0) {
    issues.push(issue("browser_failed_requests", "browser recorded failed resource or API requests", { failed_requests: failedRequests.slice(0, 20) }));
  }

  return {
    version: "workbench-public-browser-evidence.v1",
    status: issues.length === 0 ? "pass" : "fail",
    created_at: new Date().toISOString(),
    route_url: options.url,
    final_url: dom.final_url,
    http_status: httpStatus || null,
    title: dom.title,
    body_text_sample: dom.body_text_sample,
    workbench_rendered: dom.ant_layout_count > 0 && dom.ant_menu_count > 0,
    mounted_project_route: isMountedProjectUrl(dom.final_url),
    root_next_script_count: dom.root_next_script_count,
    mounted_next_script_count: dom.mounted_next_script_count,
    desktop_shell_count: dom.desktop_shell_count,
    console_error_count: consoleErrors.length,
    failed_request_count: failedRequests.length,
    navigation_error: navigationError,
    responses,
    request_header_names: Object.keys(headers).sort(),
    secret_policy: "Only header names and browser metadata are stored; no cookies, tokens, authorization headers, session values, or secret values are stored.",
    issues
  };
}

function writeArtifact(path, artifact) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
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
  const artifact = await runBrowserCheck(options);
  writeArtifact(options.output, artifact);
  console.log(JSON.stringify({
    status: artifact.status,
    version: artifact.version,
    route_url: artifact.route_url,
    final_url: artifact.final_url,
    http_status: artifact.http_status,
    workbench_rendered: artifact.workbench_rendered,
    root_next_script_count: artifact.root_next_script_count,
    console_error_count: artifact.console_error_count,
    failed_request_count: artifact.failed_request_count,
    output: options.output,
    request_header_names: artifact.request_header_names,
    issues: artifact.issues
  }, null, 2));
  process.exit(artifact.status === "pass" ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
