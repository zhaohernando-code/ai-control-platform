#!/usr/bin/env node
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createWorkbenchServer } from "./workbench-server.mjs";
import {
  FRONTEND_ACCEPTANCE_RUN_VERSION,
  validateFrontendAcceptanceRunArtifact
} from "../src/workflow/frontend-acceptance.js";
import { createWorkbenchProjection } from "../src/workflow/workbench-projection.js";

const TARGET_LATEST = "latest";
const TARGET_FIXTURE = "fixture";
const ACCEPTANCE_TARGET_LATEST = "latest_projection";
const ACCEPTANCE_TARGET_FIXTURE = "fixture_current_session";
const WORKBENCH_MOUNT_PREFIX = "/projects/ai-control-platform";
const WORKBENCH_FAVICON_PATH = "/apps/workbench/favicon.svg";
const STATIC_ROUTE_PORT = 9;
const STATIC_CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function valueAfter(flag, args = process.argv.slice(2)) {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

function hasFlag(flag, args = process.argv.slice(2)) {
  return args.includes(flag);
}

function normalizeTarget(value = "") {
  const target = String(value || "").trim().toLowerCase();
  if (!target || ["latest", "live", "live-latest", "default", "release"].includes(target)) {
    return TARGET_LATEST;
  }
  if (["fixture", "current-session", "current_session"].includes(target)) {
    return TARGET_FIXTURE;
  }
  throw new Error(`unsupported frontend acceptance target: ${value}`);
}

export function parseAcceptanceOptions(args = process.argv.slice(2)) {
  const explicitTarget = valueAfter("--target", args) || valueAfter("--mode", args);
  const target = normalizeTarget(
    hasFlag("--fixture", args) || hasFlag("--current-session", args)
      ? TARGET_FIXTURE
      : explicitTarget
  );

  return {
    target,
    outputPath: valueAfter("--output", args),
    screenshotDir: valueAfter("--screenshots", args),
    expectPass: !hasFlag("--allow-fail", args)
  };
}

function finding(code, severity, message, evidence = {}) {
  return {
    code,
    severity,
    status: "fail",
    message,
    evidence
  };
}

function normalizeText(value) {
  return String(value || "").trim();
}

function faviconLinksOf(result = {}) {
  return Array.isArray(result.faviconLinks)
    ? result.faviconLinks
    : Array.isArray(result.favicon_links)
      ? result.favicon_links
      : [];
}

function pathnameOfUrl(value) {
  try {
    return new URL(value).pathname;
  } catch {
    return normalizeText(value);
  }
}

function isWorkbenchFaviconLink(link = {}) {
  const hrefAttribute = normalizeText(link.href_attribute || link.hrefAttribute).replace(/^\.\//, "");
  const pathname = pathnameOfUrl(link.href);
  const type = normalizeText(link.type).toLowerCase();
  return (
    (hrefAttribute === "favicon.svg" || pathname.endsWith(WORKBENCH_FAVICON_PATH)) &&
    (!type || type === "image/svg+xml")
  );
}

function isRootFaviconLink(link = {}) {
  const hrefAttribute = normalizeText(link.href_attribute || link.hrefAttribute);
  const pathname = pathnameOfUrl(link.href);
  return hrefAttribute === "/favicon.ico" || pathname === "/favicon.ico";
}

function normalizeContentType(value) {
  return normalizeText(value).toLowerCase().split(";")[0].trim();
}

function contentTypeOf(response = {}) {
  return response.content_type || response.contentType || "";
}

function mountedSvgFaviconResponsesOf(result = {}) {
  const responses = Array.isArray(result.mountedSvgFaviconResponses)
    ? result.mountedSvgFaviconResponses
    : Array.isArray(result.mounted_svg_favicon_responses)
      ? result.mounted_svg_favicon_responses
      : [];
  return responses.filter((response) => pathnameOfUrl(response.url || response.href).endsWith(WORKBENCH_FAVICON_PATH));
}

function mountedSvgFaviconMimePasses(result = {}) {
  const successfulResponses = mountedSvgFaviconResponsesOf(result).filter((response) => {
    return response.status >= 200 && response.status < 300;
  });
  return successfulResponses.length > 0 &&
    successfulResponses.every((response) => normalizeContentType(contentTypeOf(response)) === "image/svg+xml");
}

function writeArtifact(outputPath, artifact) {
  if (!outputPath) return null;
  const resolved = resolve(outputPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(artifact, null, 2)}\n`);
  return resolved;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
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

function canUseStaticRouteFallback(error = {}) {
  return error.code === "EPERM" && error.syscall === "listen";
}

function projectionForTarget(targetInfo = {}) {
  const evidence = targetInfo.projection_evidence || {};
  if (evidence.input_path) {
    return createWorkbenchProjection({
      ...readJson(evidence.input_path),
      project_status: readJson("PROJECT_STATUS.json")
    });
  }
  if (evidence.projection_path) {
    return readJson(evidence.projection_path);
  }
  return createWorkbenchProjection({
    ...readJson("docs/examples/current-session-workbench-input.json"),
    project_status: readJson("PROJECT_STATUS.json")
  });
}

function historyForTarget(targetInfo = {}) {
  const historyPath = targetInfo.projection_evidence?.history_path || "docs/examples/projection-history.json";
  return readJson(historyPath);
}

function staticWorkbenchFile(pathname) {
  const routePathname = pathname.startsWith(`${WORKBENCH_MOUNT_PREFIX}/`)
    ? pathname.slice(WORKBENCH_MOUNT_PREFIX.length)
    : pathname;
  const normalized = routePathname === "/" ? "/apps/workbench/desktop.html" : routePathname;
  if (!normalized.startsWith("/apps/workbench/")) return null;
  const filePath = resolve(normalized.replace(/^\/+/, ""));
  const workbenchRoot = resolve("apps/workbench");
  if (filePath !== workbenchRoot && !filePath.startsWith(`${workbenchRoot}/`)) return null;
  return filePath;
}

async function routeStaticMountedWorkbench(page, targetInfo = {}) {
  await page.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    const routePathname = requestUrl.pathname.startsWith(`${WORKBENCH_MOUNT_PREFIX}/`)
      ? requestUrl.pathname.slice(WORKBENCH_MOUNT_PREFIX.length)
      : requestUrl.pathname;

    if (routePathname === "/api/workbench/projection") {
      await route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify(projectionForTarget(targetInfo))
      });
      return;
    }

    if (routePathname === "/api/workbench/projections") {
      await route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify(historyForTarget(targetInfo))
      });
      return;
    }

    const filePath = staticWorkbenchFile(requestUrl.pathname);
    if (filePath) {
      await route.fulfill({
        status: 200,
        contentType: STATIC_CONTENT_TYPES[extname(filePath)] || "application/octet-stream",
        body: readFileSync(filePath)
      });
      return;
    }

    await route.fulfill({
      status: 404,
      contentType: "text/plain; charset=utf-8",
      body: "not found"
    });
  });
}

function latestTargetInfo() {
  const historyPath = "docs/examples/projection-history.json";
  const history = readJson(historyPath);
  const projectionId = history.latest;
  const item = Array.isArray(history.items)
    ? history.items.find((entry) => entry.id === projectionId)
    : null;
  if (!projectionId || !item) {
    throw new Error("latest projection history item is required for release frontend acceptance");
  }

  return {
    target: TARGET_LATEST,
    acceptance_target: ACCEPTANCE_TARGET_LATEST,
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

function fixtureTargetInfo({ inputPath, historyPath }) {
  return {
    target: TARGET_FIXTURE,
    acceptance_target: ACCEPTANCE_TARGET_FIXTURE,
    acceptance_mode: "current_session_fixture",
    release_default: false,
    projection_evidence: {
      mode: "fixture",
      source: "temporary_current_session_fixture",
      projection_id: "current-session",
      label: "Current session fixture",
      status: "rerun",
      history_path: historyPath,
      input_path: inputPath,
      projection_path: null
    }
  };
}

async function withFixtureWorkbenchServer(fn) {
  mkdirSync("tmp", { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-frontend-acceptance-"));
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-frontend-acceptance-"));
  const eventsPath = join(dir, "operator-events.json");
  const inputPath = join(snapshotsRoot, "current-session-workbench-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  writeFileSync(eventsPath, JSON.stringify({ version: "operator-events.v1", events: [] }));
  const workflowState = readJson("docs/examples/current-session-workbench-input.json");
  writeFileSync(inputPath, `${JSON.stringify(workflowState, null, 2)}\n`);
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "current-session",
    items: [
      {
        id: "current-session",
        label: "Current session",
        status: "rerun",
        input_path: inputPath.replace(`${process.cwd()}/`, "")
      }
    ]
  }, null, 2));

  const server = createWorkbenchServer({
    eventsPath,
    historyPath,
    snapshotsRoot,
    projectStatusPath: "PROJECT_STATUS.json"
  });
  let port;
  try {
    port = await listenServer(server);
  } catch (error) {
    await closeServer(server);
    if (!canUseStaticRouteFallback(error)) throw error;
    return fn({
      port: STATIC_ROUTE_PORT,
      targetInfo: fixtureTargetInfo({
        inputPath: inputPath.replace(`${process.cwd()}/`, ""),
        historyPath: historyPath.replace(`${process.cwd()}/`, "")
      }),
      staticRouteFallback: true
    });
  }

  try {
    return await fn({
      port,
      targetInfo: fixtureTargetInfo({
        inputPath: inputPath.replace(`${process.cwd()}/`, ""),
        historyPath: historyPath.replace(`${process.cwd()}/`, "")
      }),
      staticRouteFallback: false
    });
  } finally {
    await closeServer(server);
  }
}

async function withLatestWorkbenchServer(fn) {
  const server = createWorkbenchServer({
    projectStatusPath: "PROJECT_STATUS.json"
  });
  const targetInfo = latestTargetInfo();
  let port;
  try {
    port = await listenServer(server);
  } catch (error) {
    await closeServer(server);
    if (!canUseStaticRouteFallback(error)) throw error;
    return fn({
      port: STATIC_ROUTE_PORT,
      targetInfo,
      staticRouteFallback: true
    });
  }

  try {
    return await fn({
      port,
      targetInfo,
      staticRouteFallback: false
    });
  } finally {
    await closeServer(server);
  }
}

async function withWorkbenchServer(target, fn) {
  if (target === TARGET_FIXTURE) {
    return withFixtureWorkbenchServer(fn);
  }
  return withLatestWorkbenchServer(fn);
}

const COMMAND_ACTION_ATTRIBUTES = [
  "data-action",
  "data-scheduler-dispatch",
  "data-autonomous-scheduler-loop",
  "data-autonomous-scheduler-loop-resume",
  "data-workbench-next-action",
  "data-provider-health"
];
const COMMAND_CONTROL_SELECTOR = [
  "button",
  '[role="button"]',
  ...COMMAND_ACTION_ATTRIBUTES.map((attribute) => `[${attribute}]`)
].join(",");
const RISKY_COMMAND_PATTERN = /\b(mock|real|loop|resume|rerun|approve|approved|run_context_work_packages|prepare_project_status_continuation|headless_projected_action_progress|projected_next_action)\b|scheduler[-_ ]?dispatch|恢复|批准/i;
const ALLOWED_BROWSER_ERROR_PATTERNS = [];

function browserErrorsOf(result = {}) {
  return Array.isArray(result.browserErrors)
    ? result.browserErrors
    : Array.isArray(result.browser_errors)
      ? result.browser_errors
      : [];
}

function isAllowedBrowserError(error = {}) {
  const text = [
    error.source,
    error.type,
    error.text,
    error.message,
    error.url,
    error.status
  ].filter(Boolean).join(" ");
  return ALLOWED_BROWSER_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

function compactBrowserError(error = {}) {
  return {
    source: error.source || "browser",
    type: error.type || null,
    text: error.text || error.message || null,
    url: error.url || null,
    status: error.status || null,
    location: error.location || null,
    allowed: isAllowedBrowserError(error)
  };
}

async function auditViewport(page, viewport, browserErrors = [], options = {}) {
  const data = await page.evaluate(({ commandControlSelector, commandActionAttributes }) => {
    const visible = (node) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const textOf = (node) => String(node.textContent || "").replace(/\s+/g, " ").trim();
    const actionOf = (node) => {
      for (const attribute of commandActionAttributes) {
        const value = node.getAttribute(attribute);
        if (value) return { attribute, value };
      }
      return { attribute: null, value: null };
    };
    const elements = Array.from(document.querySelectorAll("body *")).filter(visible);
    const buttons = Array.from(document.querySelectorAll(commandControlSelector)).filter(visible).map((node) => {
      const action = actionOf(node);
      const tag = node.tagName.toLowerCase();
      const role = node.getAttribute("role") || null;
      return {
        text: textOf(node),
        action: action.value,
        action_attribute: action.attribute,
        tag,
        role,
        command: tag === "button"
          ? "native_button"
          : role === "button"
            ? "role_button"
            : "data_command",
        rect: node.getBoundingClientRect().toJSON()
      };
    });
    const nav = Array.from(document.querySelectorAll(".nav-list a")).filter(visible).map((node) => ({
      text: textOf(node),
      href: node.getAttribute("href"),
      active: node.classList.contains("active"),
      rect: node.getBoundingClientRect().toJSON()
    }));
    const faviconLinks = Array.from(document.querySelectorAll('link[rel~="icon"]')).map((node) => ({
      rel: node.getAttribute("rel") || "",
      type: node.getAttribute("type") || "",
      href_attribute: node.getAttribute("href") || "",
      href: node.href || ""
    }));
    const hero = document.querySelector(".hero-panel h1, .phone-hero h1");
    const heroRect = hero?.getBoundingClientRect();
    const heroStyle = hero ? getComputedStyle(hero) : null;
    const diagnostics = Array.from(document.querySelectorAll(".scheduler-grid [data-bind], .provider-grid [data-bind], .closeout-grid [data-bind], .resume-grid [data-bind]")).filter(visible);
    const bodyText = textOf(document.body);
    const riskyTextPattern = /\b(rerun|not_configured|no_next_action|inspect_context_work_packages|prepare_project_status_continuation|run_context_work_packages|projected_next_action|approved_mock_non_dry_run|scheduler_dispatch|frontend_acceptance|headless_projected_action_progress)\b/g;
    const riskyTokens = Array.from(new Set(bodyText.match(riskyTextPattern) || []));
    const overlapPairs = [];
    const sampled = elements
      .map((node) => ({
        node,
        text: textOf(node).slice(0, 40),
        rect: node.getBoundingClientRect().toJSON()
      }))
      .filter((item) => item.rect.width > 16 && item.rect.height > 16)
      .slice(0, 180);
    for (let i = 0; i < sampled.length; i += 1) {
      for (let j = i + 1; j < sampled.length; j += 1) {
        if (sampled[i].node.contains(sampled[j].node) || sampled[j].node.contains(sampled[i].node)) {
          continue;
        }
        const a = sampled[i].rect;
        const b = sampled[j].rect;
        const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
        const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        const area = x * y;
        if (area > 900 && area < Math.min(a.width * a.height, b.width * b.height) * 0.8) {
          overlapPairs.push({ a: sampled[i].text, b: sampled[j].text, area });
        }
      }
    }
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
      riskyTokens,
      diagnosticsCount: diagnostics.length,
      hero: hero ? {
        text: textOf(hero),
        lineHeight: Number.parseFloat(heroStyle.lineHeight),
        fontSize: Number.parseFloat(heroStyle.fontSize),
        height: heroRect.height,
        width: heroRect.width,
        top: heroRect.top
      } : null,
      overlapPairs: overlapPairs.slice(0, 10)
    };
  }, {
    commandControlSelector: COMMAND_CONTROL_SELECTOR,
    commandActionAttributes: COMMAND_ACTION_ATTRIBUTES
  });

  return {
    viewport,
    ...data,
    routePath: options.routePath || null,
    mounted: options.mounted === true,
    mountedSvgFaviconResponses: Array.isArray(options.mountedSvgFaviconResponses)
      ? options.mountedSvgFaviconResponses
      : [],
    browserErrors: browserErrors.map(compactBrowserError)
  };
}

async function auditNavigation(page) {
  const results = [];
  const count = await page.locator(".nav-list a").count();
  for (let index = 0; index < count; index += 1) {
    const link = page.locator(".nav-list a").nth(index);
    const label = (await link.textContent()).trim();
    const before = await page.evaluate(() => {
      const textOf = (node) => String(node?.textContent || "").replace(/\s+/g, " ").trim();
      const visible = (node) => {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };
      const sectionSummary = (node) => ({
        id: node.id || null,
        section: node.dataset.section || null,
        heading: textOf(node.querySelector("h1, h2, strong") || node).slice(0, 80),
        text: textOf(node).slice(0, 240)
      });
      const grid = document.querySelector(".content-grid");
      const visibleSections = Array.from(document.querySelectorAll(".content-grid [data-section]"))
        .filter(visible)
        .map(sectionSummary);
      const focusedSection = document.activeElement?.closest?.(".content-grid [data-section]");
      return {
        active: document.querySelector(".nav-list a.active")?.textContent?.trim() || null,
        scrollTop: grid?.scrollTop || 0,
        activeSection: grid?.dataset.activeSection || null,
        focusedSection: focusedSection ? sectionSummary(focusedSection) : null,
        visibleSections,
        mainText: visibleSections.map((section) => section.text).join(" ").replace(/\s+/g, " ").trim().slice(0, 240)
      };
    });
    await link.click();
    await page.waitForTimeout(50);
    const after = await page.evaluate(() => {
      const textOf = (node) => String(node?.textContent || "").replace(/\s+/g, " ").trim();
      const visible = (node) => {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };
      const sectionSummary = (node) => ({
        id: node.id || null,
        section: node.dataset.section || null,
        heading: textOf(node.querySelector("h1, h2, strong") || node).slice(0, 80),
        text: textOf(node).slice(0, 240)
      });
      const grid = document.querySelector(".content-grid");
      const visibleSections = Array.from(document.querySelectorAll(".content-grid [data-section]"))
        .filter(visible)
        .map(sectionSummary);
      const focusedSection = document.activeElement?.closest?.(".content-grid [data-section]");
      return {
        active: document.querySelector(".nav-list a.active")?.textContent?.trim() || null,
        scrollTop: grid?.scrollTop || 0,
        activeSection: grid?.dataset.activeSection || null,
        focusedSection: focusedSection ? sectionSummary(focusedSection) : null,
        visibleSections,
        mainText: visibleSections.map((section) => section.text).join(" ").replace(/\s+/g, " ").trim().slice(0, 240)
      };
    });
    const activeChanged = before.active !== after.active;
    const scrollChanged = before.scrollTop !== after.scrollTop;
    const visibleTextChanged = before.mainText !== after.mainText;
    const visibleSectionsChanged = JSON.stringify(before.visibleSections) !== JSON.stringify(after.visibleSections);
    const focusedSectionChanged = JSON.stringify(before.focusedSection) !== JSON.stringify(after.focusedSection);
    const semanticChanged = scrollChanged || visibleTextChanged || visibleSectionsChanged || focusedSectionChanged;
    results.push({
      label,
      before,
      after,
      active_changed: activeChanged,
      scroll_changed: scrollChanged,
      visible_text_changed: visibleTextChanged,
      visible_sections_changed: visibleSectionsChanged,
      focused_section_changed: focusedSectionChanged,
      semantic_changed: semanticChanged,
      active_only: activeChanged && !semanticChanged,
      changed: activeChanged || semanticChanged
    });
  }
  return results;
}

function findingsForViewport(result) {
  const findings = [];
  if (result.dimensions.scrollWidth > result.dimensions.width) {
    findings.push(finding("frontend_horizontal_overflow", "p1", `${result.viewport} has horizontal overflow`, result.dimensions));
  }
  const heroLines = result.hero ? Math.ceil(result.hero.height / Math.max(result.hero.lineHeight || result.hero.fontSize || 1, 1)) : 0;
  if (result.hero && (result.hero.text.length > 96 || heroLines > 3)) {
    findings.push(finding("frontend_unbounded_dynamic_headline", "p1", `${result.viewport} headline is too long for an operator status summary`, {
      text: result.hero.text,
      length: result.hero.text.length,
      lines: heroLines
    }));
  }
  if (result.riskyTokens.length > 0) {
    findings.push(finding("frontend_raw_projection_copy", "p1", `${result.viewport} exposes raw backend/projection tokens in the default surface`, {
      tokens: result.riskyTokens
    }));
  }
  if (result.overlapPairs.length > 0) {
    findings.push(finding("frontend_layout_overlap", "p1", `${result.viewport} contains overlapping visible elements`, {
      examples: result.overlapPairs.slice(0, 3)
    }));
  }
  if (result.viewport === "mobile" && result.diagnosticsCount > 24) {
    findings.push(finding("frontend_mobile_telemetry_dump", "p1", "mobile workbench is dominated by backend telemetry fields", {
      diagnostics_count: result.diagnosticsCount
    }));
  }
  return findings;
}

function findingsForNavigation(results) {
  const semanticChanged = (result = {}) => {
    if (result.semantic_changed === true || result.semantically_changed === true) return true;
    if (
      result.scroll_changed === true ||
      result.visible_text_changed === true ||
      result.visible_sections_changed === true ||
      result.focused_section_changed === true
    ) {
      return true;
    }
    const before = result.before || {};
    const after = result.after || {};
    return Boolean(
      before.scrollTop !== after.scrollTop ||
        before.mainText !== after.mainText ||
        JSON.stringify(before.visibleSections || []) !== JSON.stringify(after.visibleSections || []) ||
        JSON.stringify(before.focusedSection || null) !== JSON.stringify(after.focusedSection || null)
    );
  };

  return results
    .filter((result) => result.label !== "总览" && !semanticChanged(result))
    .map((result) => finding("frontend_dead_navigation", "p1", `navigation tab ${result.label} does not reveal distinct visible content, scroll position, or view focus`, result));
}

function findingsForControls(viewportResults) {
  const findings = [];

  for (const result of viewportResults) {
    const buttons = result.buttons || [];
    const riskyButtons = buttons.filter((button) => RISKY_COMMAND_PATTERN.test([
      button.text,
      button.action,
      button.action_attribute,
      button.command
    ].filter(Boolean).join(" ")));
    if (riskyButtons.length > 0) {
      findings.push(finding("frontend_danger_controls_unscoped", "p1", `${result.viewport} exposes dangerous scheduler/mock/real loop controls as ordinary command controls`, {
        viewport: result.viewport,
        buttons: riskyButtons.map((button) => ({
          text: button.text,
          action: button.action || null,
          action_attribute: button.action_attribute || null,
          tag: button.tag || null,
          role: button.role || null
        }))
      }));
    }
    if (buttons.length > 8) {
      findings.push(finding("frontend_button_pileup", "p1", `${result.viewport} exposes too many unrelated command controls`, {
        viewport: result.viewport,
        button_count: buttons.length,
        buttons: buttons.map((button) => button.text)
      }));
    }
  }
  return findings;
}

function findingsForResources(viewportResults) {
  const findings = [];

  for (const result of viewportResults) {
    const faviconLinks = faviconLinksOf(result);
    const workbenchFaviconLinks = faviconLinks.filter(isWorkbenchFaviconLink);
    const rootFaviconLinks = faviconLinks.filter(isRootFaviconLink);
    const mountedSvgFaviconResponses = mountedSvgFaviconResponsesOf(result);
    if (result.mounted !== true) {
      findings.push(finding("frontend_non_mounted_workbench_route", "p1", `${result.viewport} did not exercise the live project-mounted workbench route`, {
        viewport: result.viewport,
        route_path: result.routePath || null
      }));
    }
    if (faviconLinks.length === 0) {
      findings.push(finding("frontend_missing_favicon_link", "p1", `${result.viewport} has no explicit favicon link and may fall back to /favicon.ico`, {
        viewport: result.viewport,
        route_path: result.routePath || null
      }));
      continue;
    }
    if (rootFaviconLinks.length > 0) {
      findings.push(finding("frontend_root_favicon_fallback", "p1", `${result.viewport} points favicon traffic at root /favicon.ico`, {
        viewport: result.viewport,
        links: rootFaviconLinks
      }));
    }
    if (workbenchFaviconLinks.length === 0) {
      findings.push(finding("frontend_favicon_not_mounted_safe", "p1", `${result.viewport} favicon is not mounted with the workbench static assets`, {
        viewport: result.viewport,
        links: faviconLinks
      }));
    }
    if (workbenchFaviconLinks.length > 0 && !mountedSvgFaviconMimePasses(result)) {
      findings.push(finding("frontend_mounted_svg_favicon_mime_drift", "p1", `${result.viewport} mounted SVG favicon must be served as image/svg+xml`, {
        viewport: result.viewport,
        route_path: result.routePath || null,
        responses: mountedSvgFaviconResponses
      }));
    }
  }

  return findings;
}

function findingsForBrowserErrors(viewportResults) {
  return viewportResults.flatMap((result) => {
    const errors = browserErrorsOf(result).map(compactBrowserError);
    const blockedErrors = errors.filter((error) => !error.allowed);
    if (blockedErrors.length === 0) return [];
    return [
      finding("frontend_browser_console_error", "p1", `${result.viewport} produced browser console/page errors`, {
        viewport: result.viewport,
        error_count: errors.length,
        blocked_error_count: blockedErrors.length,
        errors: blockedErrors.slice(0, 10)
      })
    ];
  });
}

export function buildArtifact({ viewportResults, navigationResults, screenshots, targetInfo = {} }) {
  const layoutResults = viewportResults.map((result) => ({
    viewport: result.viewport,
    dimensions: result.dimensions,
    overlap_count: result.overlapPairs.length
  }));
  const copyResults = viewportResults.map((result) => ({
    viewport: result.viewport,
    risky_tokens: result.riskyTokens,
    hero_text_length: result.hero?.text.length || 0
  }));
  const resourceResults = viewportResults.map((result) => {
    const faviconLinks = faviconLinksOf(result);
    const mountedSvgFaviconResponses = mountedSvgFaviconResponsesOf(result);
    const driftedFaviconResponse = mountedSvgFaviconResponses.find((response) => {
      return response.status >= 200 &&
        response.status < 300 &&
        normalizeContentType(contentTypeOf(response)) !== "image/svg+xml";
    });
    const firstFaviconResponse = driftedFaviconResponse || mountedSvgFaviconResponses[0];
    return {
      viewport: result.viewport,
      route_path: result.routePath || null,
      mounted_workbench_route: result.mounted === true,
      favicon_link_count: faviconLinks.length,
      mounted_safe_favicon_count: faviconLinks.filter(isWorkbenchFaviconLink).length,
      root_favicon_count: faviconLinks.filter(isRootFaviconLink).length,
      mounted_svg_favicon_mime: contentTypeOf(firstFaviconResponse) || null,
      mounted_svg_favicon_mime_ok: mountedSvgFaviconMimePasses(result),
      mounted_svg_favicon_responses: mountedSvgFaviconResponses,
      favicon_links: faviconLinks
    };
  });
  const controlResults = viewportResults.map((result) => ({
    viewport: result.viewport,
    button_count: result.buttons.length,
    control_count: result.buttons.length,
    native_button_count: result.buttons.filter((button) => button.command === "native_button").length,
    role_button_count: result.buttons.filter((button) => button.command === "role_button").length,
    data_command_count: result.buttons.filter((button) => button.command === "data_command").length,
    buttons: result.buttons.map((button) => button.text),
    controls: result.buttons.map((button) => ({
      text: button.text,
      action: button.action || null,
      action_attribute: button.action_attribute || null,
      tag: button.tag || null,
      role: button.role || null,
      command: button.command || null
    }))
  }));
  const browserErrorResults = viewportResults.map((result) => {
    const errors = browserErrorsOf(result).map(compactBrowserError);
    const blockedErrors = errors.filter((error) => !error.allowed);
    return {
      viewport: result.viewport,
      error_count: errors.length,
      blocked_error_count: blockedErrors.length,
      errors
    };
  });
  const mobileResults = viewportResults
    .filter((result) => result.viewport === "mobile")
    .map((result) => ({
      viewport: result.viewport,
      diagnostics_count: result.diagnosticsCount,
      button_count: result.buttons.length
    }));
  const findings = [
    ...viewportResults.flatMap(findingsForViewport),
    ...findingsForNavigation(navigationResults),
    ...findingsForControls(viewportResults),
    ...findingsForResources(viewportResults),
    ...findingsForBrowserErrors(viewportResults)
  ];
  const blockingFindings = findings.filter((item) => item.severity === "p0" || item.severity === "p1");

  return {
    version: FRONTEND_ACCEPTANCE_RUN_VERSION,
    status: blockingFindings.length > 0 ? "fail" : "pass",
    created_at: new Date().toISOString(),
    acceptance_target: targetInfo.acceptance_target || "unknown",
    acceptance_mode: targetInfo.acceptance_mode || "unknown",
    release_default: targetInfo.release_default === true,
    projection_evidence: targetInfo.projection_evidence || null,
    screenshots,
    viewport_results: viewportResults.map((result) => ({
      viewport: result.viewport,
      route_path: result.routePath || null,
      mounted_workbench_route: result.mounted === true,
      dimensions: result.dimensions,
      nav_count: result.nav.length,
      button_count: result.buttons.length,
      control_count: result.buttons.length,
      diagnostics_count: result.diagnosticsCount,
      favicon_link_count: faviconLinksOf(result).length,
      mounted_safe_favicon_count: faviconLinksOf(result).filter(isWorkbenchFaviconLink).length,
      browser_error_count: browserErrorsOf(result).length,
      blocked_browser_error_count: browserErrorsOf(result).filter((error) => !isAllowedBrowserError(error)).length
    })),
    navigation_results: navigationResults,
    layout_results: layoutResults,
    copy_results: copyResults,
    resource_results: resourceResults,
    control_results: controlResults,
    browser_error_results: browserErrorResults,
    mobile_results: mobileResults,
    findings,
    blocking_count: blockingFindings.length,
    blocking_findings: blockingFindings
  };
}

async function run() {
  const options = parseAcceptanceOptions();
  const outputPath = options.outputPath;
  const screenshotDir = options.screenshotDir || mkdtempSync(join(tmpdir(), "ai-control-platform-frontend-screenshots-"));
  const expectPass = options.expectPass;
  const { chromium } = await import("playwright");
  const artifact = await withWorkbenchServer(options.target, async ({ port, targetInfo, staticRouteFallback = false }) => {
    const browser = await chromium.launch();
    const viewportResults = [];
    const screenshots = [];
    try {
      const scenarios = [
        { name: "desktop", path: "desktop.html", viewport: { width: 1440, height: 900 } },
        { name: "desktop_narrow", path: "desktop.html", viewport: { width: 1024, height: 768 } },
        { name: "mobile", path: "mobile.html", viewport: { width: 390, height: 844 }, isMobile: true }
      ];
      let navigationResults = [];
      for (const scenario of scenarios) {
        const page = await browser.newPage({ viewport: scenario.viewport, isMobile: scenario.isMobile === true });
        if (staticRouteFallback) {
          await routeStaticMountedWorkbench(page, targetInfo);
        }
        const routePath = `${WORKBENCH_MOUNT_PREFIX}/apps/workbench/${scenario.path}`;
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
          const responsePathname = pathnameOfUrl(response.url());
          if (responsePathname.endsWith(WORKBENCH_FAVICON_PATH)) {
            mountedSvgFaviconResponses.push({
              url: response.url(),
              status: response.status(),
              content_type: response.headers()["content-type"] || ""
            });
          }
          if (response.status() < 400) return;
          browserErrors.push({
            source: "response",
            type: "http_error",
            status: response.status(),
            url: response.url()
          });
        });
        await page.goto(
          `http://127.0.0.1:${port}${routePath}`,
          { waitUntil: "networkidle" }
        );
        mountedSvgFaviconResponses.push(await page.evaluate(async () => {
          const response = await fetch(new URL("favicon.svg", window.location.href), { cache: "no-store" });
          return {
            url: response.url,
            status: response.status,
            content_type: response.headers.get("content-type") || ""
          };
        }));
        if (scenario.name === "desktop") {
          navigationResults = await auditNavigation(page);
        }
        const screenshotPath = join(screenshotDir, `${scenario.name}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        screenshots.push({ viewport: scenario.name, path: screenshotPath });
        viewportResults.push(await auditViewport(page, scenario.name, browserErrors, {
          routePath,
          mounted: true,
          mountedSvgFaviconResponses
        }));
        await page.close();
      }
      return buildArtifact({ viewportResults, navigationResults, screenshots, targetInfo });
    } finally {
      await browser.close();
    }
  });

  const validation = validateFrontendAcceptanceRunArtifact(artifact);
  if (validation.status !== "pass") {
    artifact.status = "fail";
    artifact.validation_issues = validation.issues;
  }
  const written = writeArtifact(outputPath, artifact);
  console.log(JSON.stringify({ ...artifact, output_path: written }, null, 2));
  if (expectPass && artifact.status !== "pass") {
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
