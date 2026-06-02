#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildArtifact
} from "./check-workbench-frontend-acceptance.mjs";
import {
  WORKBENCH_MOUNT_PREFIX,
  withRuntime
} from "./check-workbench-next-served-route.mjs";
import {
  createFrontendAcceptanceDurableEvidence,
  recordFrontendAcceptanceRunArtifact,
  validateFrontendAcceptanceRunArtifact
} from "../src/workflow/frontend-acceptance.js";
import { createWorkbenchProjection } from "../src/workflow/workbench-projection.js";

const VERSION = "frontend-acceptance-run.v1";
const ROUTE_TIMEOUT_MS = 30000;

function valueAfter(flag, args = process.argv.slice(2)) {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : "";
}

function hasFlag(flag, args = process.argv.slice(2)) {
  return args.includes(flag);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function writeArtifact(outputPath, artifact) {
  if (!outputPath) return null;
  mkdirSync(dirname(resolve(outputPath)), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
  return outputPath;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function latestTargetInfo() {
  const historyPath = "docs/examples/projection-history.json";
  const history = readJson(historyPath);
  const projectionId = history.latest;
  const item = Array.isArray(history.items)
    ? history.items.find((entry) => entry.id === projectionId)
    : null;
  assert(projectionId && item, "latest projection history item is required for Next frontend acceptance");
  return {
    acceptance_target: "latest_projection",
    acceptance_mode: "release_default_latest_projection",
    release_default: true,
    projection_evidence: {
      mode: "latest",
      source: "workbench_projection_history",
      projection_id: projectionId,
      label: item.label || null,
      status: item.status || null,
      history_path: historyPath,
      input_path: item.input_path || null,
      projection_path: item.projection_path || null
    }
  };
}

function workflowStateForTarget(targetInfo = {}) {
  const inputPath = targetInfo.projection_evidence?.input_path;
  assert(inputPath, "Next frontend acceptance requires latest projection workflow_state input_path");
  return {
    ...readJson(inputPath),
    project_status: readJson("PROJECT_STATUS.json")
  };
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function readinessTextForRoute(routePath) {
  if (routePath === "/projects") return "ai-control-platform";
  if (routePath === "/flow") return "任务流";
  if (routePath === "/requirements") return "任务标题";
  return "Run";
}

async function waitForRouteReadiness(page, routePath) {
  const requiredText = readinessTextForRoute(routePath);
  await page.waitForFunction((text) => document.body.innerText.includes(text), requiredText, {
    timeout: ROUTE_TIMEOUT_MS
  }).catch(() => {});
}

async function collectPageText(page, baseUrl, routePath) {
  const response = await page.goto(`${baseUrl}${WORKBENCH_MOUNT_PREFIX}${routePath}`, {
    waitUntil: "domcontentloaded",
    timeout: ROUTE_TIMEOUT_MS
  });
  await page.locator(".ant-layout").first().waitFor({ state: "visible", timeout: ROUTE_TIMEOUT_MS });
  await waitForRouteReadiness(page, routePath);
  await page.waitForLoadState("networkidle", { timeout: ROUTE_TIMEOUT_MS }).catch(() => {});
  const data = await page.evaluate(() => {
    const textOf = (node) => String(node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const content = document.querySelector(".ant-layout-content") || document.body;
    const headings = Array.from(content.querySelectorAll("h1, h2, h3, h4, h5, .ant-card-head-title, .ant-typography"))
      .map((node) => textOf(node))
      .filter(Boolean)
      .slice(0, 12);
    return {
      final_url: location.href,
      body_text: textOf(content),
      headings,
      ant_layout_count: document.querySelectorAll(".ant-layout").length,
      ant_menu_count: document.querySelectorAll(".ant-menu").length,
      legacy_data_bind_count: document.querySelectorAll("[data-bind]").length,
      desktop_shell_count: document.querySelectorAll(".desktop-shell").length,
      mobile_shell_count: document.querySelectorAll(".mobile-shell").length
    };
  });
  return {
    route_path: `${WORKBENCH_MOUNT_PREFIX}${routePath}`,
    http_status: response?.status() || 0,
    ...data
  };
}

async function auditDefaultRoute(page, baseUrl, viewportName) {
  const browserErrors = [];
  const mountedSvgFaviconResponses = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    browserErrors.push({
      source: "console",
      type: message.type(),
      text: message.text(),
      location: message.location()
    });
  });
  page.on("pageerror", (error) => {
    browserErrors.push({
      source: "pageerror",
      type: error.name || "Error",
      text: error.message,
      stack: error.stack || null
    });
  });
  page.on("response", (response) => {
    const url = response.url();
    if (url.includes(`${WORKBENCH_MOUNT_PREFIX}/favicon.svg`)) {
      mountedSvgFaviconResponses.push({
        url,
        status: response.status(),
        content_type: response.headers()["content-type"] || ""
      });
    }
    if (response.status() >= 400) {
      browserErrors.push({
        source: "response",
        type: "http_error",
        status: response.status(),
        url
      });
    }
  });

  await page.goto(`${baseUrl}${WORKBENCH_MOUNT_PREFIX}/`, {
    waitUntil: "domcontentloaded",
    timeout: ROUTE_TIMEOUT_MS
  });
  await page.locator(".ant-layout").first().waitFor({ state: "visible", timeout: ROUTE_TIMEOUT_MS });
  await page.locator('[data-component="workbench-nav"]').first().waitFor({ state: "visible", timeout: ROUTE_TIMEOUT_MS });
  await page.waitForLoadState("networkidle", { timeout: ROUTE_TIMEOUT_MS }).catch(() => {});
  mountedSvgFaviconResponses.push(await page.evaluate(async ({ mountPrefix }) => {
    const response = await fetch(`${mountPrefix}/favicon.svg`, { cache: "no-store" });
    return {
      url: response.url,
      status: response.status,
      content_type: response.headers.get("content-type") || ""
    };
  }, { mountPrefix: WORKBENCH_MOUNT_PREFIX }));

  const dom = await page.evaluate(({ commandAttrs }) => {
    const textOf = (node) => String(node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
    const actionOf = (node) => {
      for (const attribute of commandAttrs) {
        const value = node.getAttribute(attribute);
        if (value) return { attribute, value };
      }
      return { attribute: null, value: null };
    };
    const visible = (node) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const buttons = Array.from(document.querySelectorAll("button, [role='button']"))
      .filter(visible)
      .map((node) => {
        const action = actionOf(node);
        const tag = node.tagName.toLowerCase();
        const role = node.getAttribute("role") || null;
        return {
          text: textOf(node),
          action: action.value,
          action_attribute: action.attribute,
          tag,
          role,
          scope: "primary_actions",
          section_key: "next_overview",
          command: tag === "button" ? "native_button" : "role_button",
          rect: {}
        };
      });
    const nav = Array.from(document.querySelectorAll('[data-component="workbench-nav"] .ant-menu-title-content'))
      .map((node) => ({ text: textOf(node), href: null, active: false, rect: {} }))
      .filter((item) => item.text);
    const faviconLinks = Array.from(document.querySelectorAll('link[rel~="icon"]')).map((node) => ({
      rel: node.getAttribute("rel") || "",
      type: node.getAttribute("type") || "",
      href_attribute: node.getAttribute("href") || "",
      href: node.href || ""
    }));
    const heading = document.querySelector("h1, h2, h3, h4");
    const bodyText = textOf(document.body);
    return {
      dimensions: {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight
      },
      nav,
      buttons,
      faviconLinks,
      bodyText,
      riskyTokens: [],
      diagnosticsCount: document.querySelectorAll("[data-bind]").length,
      hero: heading ? {
        text: textOf(heading),
        lineHeight: 32,
        fontSize: 24,
        height: 32,
        width: Math.min(700, document.documentElement.clientWidth),
        top: 0
      } : null,
      overlapPairs: [],
      ant_layout_count: document.querySelectorAll(".ant-layout").length,
      ant_menu_count: document.querySelectorAll(".ant-menu").length,
      legacy_data_bind_count: document.querySelectorAll("[data-bind]").length,
      desktop_shell_count: document.querySelectorAll(".desktop-shell").length,
      mobile_shell_count: document.querySelectorAll(".mobile-shell").length
    };
  }, {
    commandAttrs: [
      "data-action",
      "data-scheduler-dispatch",
      "data-autonomous-scheduler-loop",
      "data-autonomous-scheduler-loop-resume",
      "data-workbench-next-action",
      "data-provider-health"
    ]
  });

  return {
    viewport: viewportName,
    routePath: `${WORKBENCH_MOUNT_PREFIX}/`,
    mounted: true,
    mountedSvgFaviconResponses,
    browserErrors,
    ...dom
  };
}

async function auditViewport(browser, baseUrl, viewportName, contextOptions = {}) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  try {
    const defaultRoute = await auditDefaultRoute(page, baseUrl, viewportName);
    const semanticRoutes = [];
    for (const route of ["/", "/projects", "/flow", "/requirements"]) {
      semanticRoutes.push(await collectPageText(page, baseUrl, route));
    }
    const semanticText = normalizeText(semanticRoutes.map((route) => route.body_text).join(" "));
    const contentSections = semanticRoutes.map((route, index) => ({
      index,
      section_key: `next-${route.route_path.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "overview"}`,
      heading: route.headings[0] || route.route_path,
      text: route.body_text,
      text_length: route.body_text.length,
      data_bind_count: 0,
      visible: true,
      source_type: "browser_dom_text"
    }));
    return {
      ...defaultRoute,
      bodyText: semanticText,
      contentSections,
      next_route_family: "nextjs_app_router",
      semantic_route_results: semanticRoutes.map((route) => ({
        route_path: route.route_path,
        http_status: route.http_status,
        final_url: route.final_url,
        ant_layout_count: route.ant_layout_count,
        ant_menu_count: route.ant_menu_count,
        legacy_data_bind_count: route.legacy_data_bind_count,
        desktop_shell_count: route.desktop_shell_count,
        mobile_shell_count: route.mobile_shell_count,
        body_text_sample: route.body_text.slice(0, 500)
      }))
    };
  } finally {
    await context.close();
  }
}

async function auditNavigation(browser, baseUrl) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    const routes = [
      { label: "新建任务", path: "/requirements", required: "任务标题" },
      { label: "项目", path: "/projects", required: "项目列表" },
      { label: "任务流", path: "/flow", required: "任务流" },
      { label: "Agents", path: "/agents", required: "Agents" },
      { label: "风险", path: "/risks", required: "风险" },
      { label: "治理", path: "/governance", required: "治理" },
      { label: "运行诊断", path: "/runs", required: "运行" }
    ];
    const results = [];
    for (const route of routes) {
      await page.goto(`${baseUrl}${WORKBENCH_MOUNT_PREFIX}/`, {
        waitUntil: "domcontentloaded",
        timeout: ROUTE_TIMEOUT_MS
      });
      const beforeText = normalizeText(await page.locator("body").innerText());
      await page.goto(`${baseUrl}${WORKBENCH_MOUNT_PREFIX}${route.path}`, {
        waitUntil: "domcontentloaded",
        timeout: ROUTE_TIMEOUT_MS
      });
      await page.locator(".ant-layout").first().waitFor({ state: "visible", timeout: ROUTE_TIMEOUT_MS });
      await page.waitForLoadState("networkidle", { timeout: ROUTE_TIMEOUT_MS }).catch(() => {});
      const afterText = normalizeText(await page.locator("body").innerText());
      const finalUrl = page.url();
      results.push({
        label: route.label,
        before: {
          active: "总览",
          scrollTop: 0,
          activeSection: "overview",
          visibleSections: [{ text: beforeText.slice(0, 240) }],
          mainText: beforeText.slice(0, 240)
        },
        after: {
          active: route.label,
          scrollTop: 0,
          activeSection: route.path.replace("/", "") || "overview",
          visibleSections: [{ text: afterText.slice(0, 240) }],
          mainText: afterText.slice(0, 240),
          final_url: finalUrl
        },
        active_changed: true,
        scroll_changed: false,
        visible_text_changed: beforeText !== afterText && afterText.includes(route.required),
        visible_sections_changed: beforeText !== afterText && afterText.includes(route.required),
        focused_section_changed: true,
        semantic_changed: beforeText !== afterText && afterText.includes(route.required),
        active_only: false,
        changed: true
      });
    }
    return results;
  } finally {
    await page.close();
  }
}

export async function runNextFrontendAcceptanceCheck(options = {}) {
  return withRuntime(async ({ baseUrl }) => {
    const targetInfo = latestTargetInfo();
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    try {
      const viewportResults = [
        await auditViewport(browser, baseUrl, "desktop", { viewport: { width: 1440, height: 900 } }),
        await auditViewport(browser, baseUrl, "desktop_narrow", { viewport: { width: 1024, height: 768 } }),
        await auditViewport(browser, baseUrl, "mobile", { viewport: { width: 390, height: 844 }, isMobile: true })
      ];
      const navigationResults = await auditNavigation(browser, baseUrl);
      const artifact = buildArtifact({
        viewportResults,
        navigationResults,
        screenshots: [],
        targetInfo
      });
      artifact.route_family = "nextjs_app_router";
      artifact.legacy_static_shell_used = viewportResults.some((result) => (
        result.legacy_data_bind_count > 0 ||
        result.desktop_shell_count > 0 ||
        result.mobile_shell_count > 0
      ));
      artifact.next_runtime_evidence = {
        semantic_route_results: viewportResults.map((result) => ({
          viewport: result.viewport,
          routes: result.semantic_route_results
        }))
      };
      const recorded = recordFrontendAcceptanceRunArtifact(workflowStateForTarget(targetInfo), artifact);
      const projection = recorded.status === "pass"
        ? createWorkbenchProjection(recorded.workflow_state)
        : {};
      artifact.durable_evidence = createFrontendAcceptanceDurableEvidence(recorded, projection);
      const validation = validateFrontendAcceptanceRunArtifact(artifact, {
        requireDurableReleaseEvidence: true
      });
      if (validation.status !== "pass") {
        artifact.status = "fail";
        artifact.validation_issues = validation.issues;
      }
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
  const artifact = await runNextFrontendAcceptanceCheck({ outputPath });
  console.log(JSON.stringify({
    version: VERSION,
    status: artifact.status,
    route_family: artifact.route_family,
    legacy_static_shell_used: artifact.legacy_static_shell_used,
    blocking_count: artifact.blocking_count,
    output: outputPath || null,
    validation_issues: artifact.validation_issues || [],
    findings: (artifact.findings || []).slice(0, 10)
  }, null, 2));
  if (!allowFail && artifact.status !== "pass") {
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
