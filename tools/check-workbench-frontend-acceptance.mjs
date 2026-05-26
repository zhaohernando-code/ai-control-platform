#!/usr/bin/env node
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createWorkbenchServer } from "./workbench-server.mjs";
import {
  createFrontendAcceptanceDurableEvidence,
  FRONTEND_ACCEPTANCE_RUN_VERSION,
  recordFrontendAcceptanceRunArtifact,
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

function countValue(value) {
  const count = Number(value);
  return Number.isFinite(count) ? count : 0;
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

function workflowStateForTarget(targetInfo = {}) {
  const evidence = targetInfo.projection_evidence || {};
  if (evidence.input_path) {
    return {
      ...readJson(evidence.input_path),
      project_status: readJson("PROJECT_STATUS.json")
    };
  }
  throw new Error("release frontend acceptance requires latest projection workflow_state input_path for durable evidence");
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
  const stateDbPath = join(dir, "workbench-state.sqlite");
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
    stateDbPath,
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
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-frontend-acceptance-latest-"));
  const server = createWorkbenchServer({
    stateDbPath: join(dir, "workbench-state.sqlite"),
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
const INTERNAL_VISIBLE_COPY_PATTERNS = [
  { label: "Work Packages", pattern: /\bWork Packages\b/i },
  { label: "Context Pack -> Run -> Review -> Continuation", pattern: /\bContext Pack\s*(?:->|→)\s*Run\s*(?:->|→)\s*Review\s*(?:->|→)\s*Continuation\b/i },
  { label: "Provider Health", pattern: /\bProvider Health\b/i },
  { label: "Smoke OK", pattern: /\bSmoke OK\b/i },
  { label: "Smoke Timeout", pattern: /\bSmoke Timeout\b/i },
  { label: "role(s)", pattern: /\brole\(s\)\b/i },
  { label: "Projection", pattern: /\bProjection\b/i },
  { label: "Closeout", pattern: /\bCloseout\b/i },
  { label: "Resume Health", pattern: /\bResume Health\b/i },
  { label: "Snapshot", pattern: /\bSnapshot\b/i },
  { label: "Evidence", pattern: /\bEvidence\b/i },
  { label: "Artifacts", pattern: /\bArtifacts\b/i },
  { label: "Reviewer Findings", pattern: /\bReviewer Findings\b/i },
  { label: "Dispatchable", pattern: /\bDispatchable\b/i },
  { label: "Scheduler Steps", pattern: /\bScheduler Steps\b/i },
  { label: "Global Pending", pattern: /\bGlobal Pending\b/i },
  { label: "Global Done", pattern: /\bGlobal Done\b/i },
  { label: "Scheduler Dispatch", pattern: /\bScheduler Dispatch\b/i },
  { label: "Dry run", pattern: /\bDry run\b/i },
  { label: "Projected Mock Loop", pattern: /\bProjected Mock Loop\b/i },
  { label: "Projected Real Loop", pattern: /\bProjected Real Loop\b/i },
  { label: "Provider smoke", pattern: /\bProvider smoke\b/i },
  { label: "Headless live context cycle", pattern: /\bHeadless live context cycle\b/i },
  { label: "Context pack cycle", pattern: /\bContext pack cycle\b/i },
  { label: "Current autonomous platform self-trial", pattern: /\bCurrent autonomous platform self-trial\b/i },
  { label: "Platform repository bootstrap", pattern: /\bPlatform repository bootstrap\b/i }
];
const LONG_ARTIFACT_IDENTIFIER_PATTERN = /\b(?:scheduler-dispatch-run-run|scheduler-dispatch-policy-run|context-work-packages-run-run|agent-lifecycle-[A-Za-z]+|project-status-continuation|context-pack-cycle|headless-live-context-cycle|frontend-acceptance|workbench-live-route-evidence|cycle-headless-live)[A-Za-z0-9._-]{16,}\b/g;
const CONTENT_PLACEHOLDER_PATTERN = /--|未配置|未就绪|未知|(?:^|[\s:：,，;；([（])0(?=$|[\s,，;；)\]）])/g;
const CONTENT_UNRESOLVED_PLACEHOLDER_PATTERN = /--|未配置|未就绪|未知/g;
const CONTENT_TELEMETRY_PATTERN = /\b(?:run_id|cycle_id|artifact_id|artifact|manifest|ledger|payload|metadata|projection|status|not_configured|no_next_action|frontend_acceptance|scheduler_dispatch|next_action_readout|work_package|context_pack|provider_health|resume_health|closeout|snapshot|diagnostics?|telemetry|null|undefined)\b|(?:状态码|遥测|诊断字段|原始状态|后端字段)/gi;
const CONTENT_ACTIONABLE_PATTERN = /下一步|待处理|优先|处理|执行|派发|修复|恢复|审查|验收|收口|阻塞|风险|决策|建议|证据|任务|工作包|原因|影响|需要|可执行|继续|重试|发布|入口|选择|确认|失败原因|动作|模型|预算|健康|完成|通过|异常|人工|操作/g;
const CONTENT_NEXT_STEP_PATTERN = /下一步|待处理|需要|建议|修复|处理|执行|派发|恢复|重试|继续|验收|收口|查看|确认|选择|阻塞原因|风险处理|可执行/g;
const DESKTOP_DIAGNOSTIC_FIELD_WALL_THRESHOLD = 48;
const DESKTOP_DIAGNOSTIC_PLACEHOLDER_FIELD_THRESHOLD = 18;
const DESKTOP_BODY_PLACEHOLDER_WALL_THRESHOLD = 36;
const DESKTOP_SECTION_DATA_BIND_WALL_THRESHOLD = 10;
const DESKTOP_SECTION_PLACEHOLDER_WALL_THRESHOLD = 6;
const MAX_RELEASE_COMMAND_CONTROLS = 8;
const MAX_PRIMARY_COMMAND_CONTROLS = 3;
const MAX_RISKY_PRIMARY_COMMAND_CONTROLS = 1;
const MAX_COMMANDS_PER_SECTION = 6;

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

function internalVisibleCopyMatches(bodyText = "") {
  const text = normalizeText(bodyText);
  const matches = [];
  for (const item of INTERNAL_VISIBLE_COPY_PATTERNS) {
    if (item.pattern.test(text)) {
      matches.push({ label: item.label });
    }
  }
  for (const match of text.match(LONG_ARTIFACT_IDENTIFIER_PATTERN) || []) {
    matches.push({
      label: "raw_artifact_identifier",
      text: match.slice(0, 160)
    });
  }
  return matches;
}

function countContentMatches(text = "", pattern) {
  return (normalizeText(text).match(pattern) || []).length;
}

function contentTextMetrics(text = "") {
  const normalized = normalizeText(text);
  return {
    text_length: normalized.length,
    placeholder_count: countContentMatches(normalized, CONTENT_PLACEHOLDER_PATTERN),
    unresolved_placeholder_count: countContentMatches(normalized, CONTENT_UNRESOLVED_PLACEHOLDER_PATTERN),
    telemetry_token_count: countContentMatches(normalized, CONTENT_TELEMETRY_PATTERN),
    actionable_label_count: countContentMatches(normalized, CONTENT_ACTIONABLE_PATTERN),
    next_step_context_count: countContentMatches(normalized, CONTENT_NEXT_STEP_PATTERN)
  };
}

function isDesktopContentViewport(viewport = "") {
  return viewport === "desktop" || viewport === "desktop_narrow";
}

function contentSectionsOf(result = {}) {
  const sections = Array.isArray(result.contentSections)
    ? result.contentSections
    : Array.isArray(result.content_sections)
      ? result.content_sections
      : [];
  if (sections.length > 0) return sections;
  return [
    {
      index: 0,
      section_key: "body",
      heading: "body",
      text: result.bodyText || "",
      text_length: normalizeText(result.bodyText).length,
      data_bind_count: countValue(result.diagnosticsCount ?? result.diagnostics_count),
      visible: true,
      source_type: "browser_dom_text"
    }
  ];
}

function contentCompletionResultForViewport(result = {}) {
  const bodyMetrics = contentTextMetrics(result.bodyText);
  const sections = contentSectionsOf(result).map((section, index) => {
    const text = normalizeText(section.text || section.text_sample || "");
    const metrics = contentTextMetrics(text);
    const operatorContextCount = metrics.actionable_label_count + metrics.next_step_context_count;
    const placeholderRatio = metrics.placeholder_count / Math.max(metrics.placeholder_count + operatorContextCount, 1);
    return {
      index: Number.isFinite(Number(section.index)) ? Number(section.index) : index,
      section_key: normalizeText(section.section_key || section.section || section.id) || `section-${index + 1}`,
      heading: normalizeText(section.heading || section.title).slice(0, 120),
      text_sample: text.slice(0, 360),
      text_length: Number(section.text_length ?? metrics.text_length),
      data_bind_count: countValue(section.data_bind_count ?? section.dataBindCount),
      placeholder_count: metrics.placeholder_count,
      unresolved_placeholder_count: metrics.unresolved_placeholder_count,
      telemetry_token_count: metrics.telemetry_token_count,
      actionable_label_count: metrics.actionable_label_count,
      next_step_context_count: metrics.next_step_context_count,
      placeholder_ratio: Number(placeholderRatio.toFixed(3)),
      source_type: "browser_dom_text"
    };
  });
  const diagnosticFieldCount = Math.max(
    countValue(result.diagnosticsCount ?? result.diagnostics_count),
    sections.reduce((total, section) => total + countValue(section.data_bind_count), 0)
  );
  const operatorContextCount = bodyMetrics.actionable_label_count + bodyMetrics.next_step_context_count;
  const placeholderDominatedSections = sections.filter((section) => {
    const sectionOperatorContext = section.actionable_label_count + section.next_step_context_count;
    return (
      section.text_length > 0 &&
      section.placeholder_count >= 3 &&
      sectionOperatorContext < 4 &&
      section.placeholder_ratio >= 0.45
    ) || (
      section.placeholder_count >= 5 &&
      sectionOperatorContext < 6
    );
  });
  const diagnosticWallSections = sections.filter((section) => {
    return isDesktopContentViewport(result.viewport) &&
      section.data_bind_count >= DESKTOP_SECTION_DATA_BIND_WALL_THRESHOLD &&
      section.unresolved_placeholder_count >= DESKTOP_SECTION_PLACEHOLDER_WALL_THRESHOLD;
  });
  const diagnosticDominated = isDesktopContentViewport(result.viewport) && (
    diagnosticFieldCount >= DESKTOP_DIAGNOSTIC_FIELD_WALL_THRESHOLD ||
    (
      diagnosticFieldCount >= DESKTOP_DIAGNOSTIC_PLACEHOLDER_FIELD_THRESHOLD &&
      bodyMetrics.unresolved_placeholder_count >= DESKTOP_BODY_PLACEHOLDER_WALL_THRESHOLD
    ) ||
    diagnosticWallSections.length > 0 ||
    (diagnosticFieldCount >= 18 && diagnosticFieldCount > Math.max(operatorContextCount * 2, 12)) ||
    (bodyMetrics.telemetry_token_count >= 18 && bodyMetrics.telemetry_token_count > Math.max(operatorContextCount * 2, 12))
  );
  const mobileTelemetryDump = result.viewport === "mobile" && (
    diagnosticFieldCount > 20 ||
    (bodyMetrics.text_length > 1400 && bodyMetrics.telemetry_token_count > Math.max(bodyMetrics.next_step_context_count * 2, 10)) ||
    (bodyMetrics.text_length > 2200 && operatorContextCount < 14)
  );
  const blockingFindingCodes = [
    diagnosticDominated ? "frontend_content_diagnostic_wall" : null,
    mobileTelemetryDump ? "frontend_content_mobile_telemetry_dump" : null,
    placeholderDominatedSections.length > 0 ? "frontend_content_placeholder_section" : null
  ].filter(Boolean);

  return {
    viewport: result.viewport,
    source_type: "browser_dom_text",
    status: blockingFindingCodes.length > 0 ? "fail" : "pass",
    body_text_length: bodyMetrics.text_length,
    body_text_sample: normalizeText(result.bodyText).slice(0, 360),
    section_count: sections.length,
    diagnostic_field_count: diagnosticFieldCount,
    placeholder_count: bodyMetrics.placeholder_count,
    unresolved_placeholder_count: bodyMetrics.unresolved_placeholder_count,
    telemetry_token_count: bodyMetrics.telemetry_token_count,
    actionable_label_count: bodyMetrics.actionable_label_count,
    next_step_context_count: bodyMetrics.next_step_context_count,
    diagnostic_dominated: diagnosticDominated,
    mobile_telemetry_dump: mobileTelemetryDump,
    diagnostic_wall_sections: diagnosticWallSections.map((section) => ({
      section_key: section.section_key,
      heading: section.heading,
      text_sample: section.text_sample,
      text_length: section.text_length,
      data_bind_count: section.data_bind_count,
      placeholder_count: section.placeholder_count,
      unresolved_placeholder_count: section.unresolved_placeholder_count,
      actionable_label_count: section.actionable_label_count,
      next_step_context_count: section.next_step_context_count
    })),
    placeholder_dominated_sections: placeholderDominatedSections.map((section) => ({
      section_key: section.section_key,
      heading: section.heading,
      text_sample: section.text_sample,
      text_length: section.text_length,
      placeholder_count: section.placeholder_count,
      actionable_label_count: section.actionable_label_count,
      next_step_context_count: section.next_step_context_count,
      placeholder_ratio: section.placeholder_ratio
    })),
    blocking_finding_codes: blockingFindingCodes,
    content_sections: sections
  };
}

function includesAllText(text = "", values = []) {
  const normalized = normalizeText(text);
  return values.every((value) => normalized.includes(value));
}

function projectManagementSemanticResultForViewport(result = {}) {
  const text = normalizeText(result.bodyText);
  const contentText = normalizeText(
    (Array.isArray(result.contentSections) ? result.contentSections : [])
      .map((section) => `${section.heading || ""} ${section.text || section.text_sample || ""}`)
      .join(" ")
  ) || text;
  const navLabels = new Set((result.nav || []).map((item) => normalizeText(item.text)));
  const requiredNav = result.viewport === "mobile"
    ? []
    : ["总览", "项目", "任务流", "Agents", "风险", "治理"];
  const requiredLifecycle = ["需求", "拆解", "子任务", "Review", "发布", "Live 验证", "验收"];
  const requiredProjectFields = ["项目列表", "AI Control Platform", "ai-control-platform", "阶段", "当前任务", "Agent", "进度", "更新"];
  const requiredIntakeFields = ["新建任务", "提交"];
  const hasRequiredNav = requiredNav.every((label) => navLabels.has(label));
  const hasProjectList = includesAllText(text, requiredProjectFields);
  const hasLifecycle = includesAllText(text, requiredLifecycle);
  const hasRequirementIntake = includesAllText(text, requiredIntakeFields);
  const diagnosticsPrimary = contentText.indexOf("运行诊断") >= 0 && contentText.indexOf("项目列表") > contentText.indexOf("运行诊断");
  const status = hasRequiredNav && hasProjectList && hasLifecycle && hasRequirementIntake && !diagnosticsPrimary ? "pass" : "fail";
  const blockingFindingCodes = [
    hasRequiredNav ? null : "frontend_project_management_nav_missing",
    hasProjectList ? null : "frontend_project_management_project_list_missing",
    hasLifecycle ? null : "frontend_project_management_task_flow_missing",
    hasRequirementIntake ? null : "frontend_requirement_intake_missing",
    diagnosticsPrimary ? "frontend_projection_diagnostics_primary" : null
  ].filter(Boolean);

  return {
    viewport: result.viewport,
    status,
    source_type: "browser_dom_product_semantics",
    has_required_nav: hasRequiredNav,
    has_project_list: hasProjectList,
    has_platform_project: text.includes("AI Control Platform") && text.includes("ai-control-platform"),
    has_project_fields: includesAllText(text, ["阶段", "当前任务", "Agent", "进度", "更新"]),
    has_task_lifecycle: hasLifecycle,
    has_requirement_intake: hasRequirementIntake,
    diagnostics_primary: diagnosticsPrimary,
    required_nav: requiredNav,
    required_lifecycle: requiredLifecycle,
    text_sample: contentText.slice(0, 1000),
    blocking_finding_codes: blockingFindingCodes
  };
}

function findingsForProjectManagementSemantics(results = []) {
  const findings = [];
  for (const result of results) {
    if (result.status === "pass") continue;
    for (const code of result.blocking_finding_codes || []) {
      const messages = {
        frontend_project_management_nav_missing: "desktop workbench navigation must expose project-management sections from the original design",
        frontend_project_management_project_list_missing: "workbench must show a project list with ai-control-platform and current project work fields",
        frontend_project_management_task_flow_missing: "workbench must show the project task lifecycle from requirement through acceptance",
        frontend_requirement_intake_missing: "workbench must let operators submit requirements into the autonomous development flow",
        frontend_projection_diagnostics_primary: "projection diagnostics must not appear before the project-management surface"
      };
      findings.push(finding(code, "p1", messages[code] || "project-management semantic requirement failed", {
        viewport: result.viewport,
        text_sample: result.text_sample,
        required_nav: result.required_nav,
        required_lifecycle: result.required_lifecycle
      }));
    }
  }
  return findings;
}

function commandControlScopeOf(button = {}) {
  return normalizeText(button.scope || button.control_scope || button.controlScope || "ungrouped") || "ungrouped";
}

function commandSectionOf(button = {}) {
  return normalizeText(button.section_key || button.section || button.sectionKey || "unknown") || "unknown";
}

function isPrimaryCommand(button = {}) {
  const scope = commandControlScopeOf(button);
  return scope === "primary_actions" || scope === "top_actions";
}

function isAdvancedCommand(button = {}) {
  const scope = commandControlScopeOf(button);
  return scope === "advanced_drawer" || scope === "diagnostic_drawer";
}

function isRiskyCommand(button = {}) {
  return RISKY_COMMAND_PATTERN.test([
    button.text,
    button.action,
    button.action_attribute,
    button.command
  ].filter(Boolean).join(" "));
}

function commandArchitectureResultForViewport(result = {}) {
  const buttons = Array.isArray(result.buttons) ? result.buttons : [];
  const riskyButtons = buttons.filter(isRiskyCommand);
  const primaryButtons = buttons.filter(isPrimaryCommand);
  const advancedButtons = buttons.filter(isAdvancedCommand);
  const ungroupedRiskyButtons = riskyButtons.filter((button) => {
    const scope = commandControlScopeOf(button);
    return scope === "ungrouped" || scope === "command_actions";
  });
  const primaryRiskyButtons = primaryButtons.filter(isRiskyCommand);
  const actionCounts = new Map();
  const sectionCounts = new Map();

  for (const button of buttons) {
    const actionKey = normalizeText(button.action || button.text);
    if (actionKey) actionCounts.set(actionKey, (actionCounts.get(actionKey) || 0) + 1);
    const sectionKey = commandSectionOf(button);
    sectionCounts.set(sectionKey, (sectionCounts.get(sectionKey) || 0) + 1);
  }

  const repeatedActions = [...actionCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([action, count]) => ({ action, count }));
  const overloadedSections = [...sectionCounts.entries()]
    .filter(([, count]) => count > MAX_COMMANDS_PER_SECTION)
    .map(([section_key, count]) => ({ section_key, count }));
  const blockingFindingCodes = [
    buttons.length > MAX_RELEASE_COMMAND_CONTROLS ? "frontend_command_control_overload" : null,
    primaryButtons.length > MAX_PRIMARY_COMMAND_CONTROLS ? "frontend_primary_action_overload" : null,
    primaryRiskyButtons.length > MAX_RISKY_PRIMARY_COMMAND_CONTROLS ? "frontend_primary_risky_action_overload" : null,
    ungroupedRiskyButtons.length > 0 ? "frontend_command_information_architecture" : null,
    repeatedActions.length > 0 ? "frontend_repeated_command_actions" : null,
    overloadedSections.length > 0 ? "frontend_action_cluster_overload" : null
  ].filter(Boolean);

  return {
    viewport: result.viewport,
    source_type: "browser_dom_controls",
    status: blockingFindingCodes.length > 0 ? "fail" : "pass",
    control_count: buttons.length,
    primary_control_count: primaryButtons.length,
    advanced_control_count: advancedButtons.length,
    risky_control_count: riskyButtons.length,
    risky_primary_control_count: primaryRiskyButtons.length,
    ungrouped_risky_control_count: ungroupedRiskyButtons.length,
    repeated_actions: repeatedActions,
    overloaded_sections: overloadedSections,
    blocking_finding_codes: blockingFindingCodes,
    controls: buttons.map((button) => ({
      text: button.text,
      action: button.action || null,
      action_attribute: button.action_attribute || null,
      tag: button.tag || null,
      role: button.role || null,
      command: button.command || null,
      scope: commandControlScopeOf(button),
      section_key: commandSectionOf(button)
    }))
  };
}

function layoutDensityResultForViewport(result = {}) {
  const dimensions = result.dimensions || {};
  const sectionCount = Math.max(contentSectionsOf(result).length, 1);
  const buttonCount = Array.isArray(result.buttons) ? result.buttons.length : 0;
  const commandDensity = Number((buttonCount / sectionCount).toFixed(2));
  return {
    viewport: result.viewport,
    dimensions,
    overlap_count: Array.isArray(result.overlapPairs) ? result.overlapPairs.length : 0,
    visible_section_count: sectionCount,
    visible_command_count: buttonCount,
    command_density: commandDensity,
    dense_command_layout: buttonCount > MAX_RELEASE_COMMAND_CONTROLS || commandDensity > MAX_COMMANDS_PER_SECTION,
    source_type: "browser_dom_layout"
  };
}

function findingsForContentCompletion(contentCompletionResults = []) {
  const findings = [];
  for (const result of contentCompletionResults) {
    if (result.diagnostic_dominated) {
      findings.push(finding("frontend_content_diagnostic_wall", "p1", `${result.viewport} default surface is dominated by diagnostic fields or telemetry instead of operator decisions`, {
        viewport: result.viewport,
        diagnostic_field_count: result.diagnostic_field_count,
        telemetry_token_count: result.telemetry_token_count,
        actionable_label_count: result.actionable_label_count,
        next_step_context_count: result.next_step_context_count,
        diagnostic_wall_sections: result.diagnostic_wall_sections,
        body_text_sample: result.body_text_sample
      }));
    }
    if (result.mobile_telemetry_dump) {
      findings.push(finding("frontend_content_mobile_telemetry_dump", "p1", "mobile workbench content is a long telemetry/status dump instead of prioritized operator tasks", {
        viewport: result.viewport,
        body_text_length: result.body_text_length,
        diagnostic_field_count: result.diagnostic_field_count,
        telemetry_token_count: result.telemetry_token_count,
        actionable_label_count: result.actionable_label_count,
        next_step_context_count: result.next_step_context_count,
        body_text_sample: result.body_text_sample
      }));
    }
    if (result.placeholder_dominated_sections.length > 0) {
      findings.push(finding("frontend_content_placeholder_section", "p1", `${result.viewport} contains visible sections whose content is mostly placeholders without actionable context`, {
        viewport: result.viewport,
        sections: result.placeholder_dominated_sections.slice(0, 8)
      }));
    }
  }
  return findings;
}

async function auditViewport(page, viewport, browserErrors = [], options = {}) {
  const data = await page.evaluate(({ commandControlSelector, commandActionAttributes }) => {
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const clippedRectOf = (node) => {
      const rect = node.getBoundingClientRect();
      let left = Math.max(rect.left, 0);
      let top = Math.max(rect.top, 0);
      let right = Math.min(rect.right, viewportWidth);
      let bottom = Math.min(rect.bottom, viewportHeight);
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (!/(auto|scroll|hidden|clip)/.test(`${style.overflow}${style.overflowX}${style.overflowY}`)) {
          continue;
        }
        const parentRect = parent.getBoundingClientRect();
        left = Math.max(left, parentRect.left);
        top = Math.max(top, parentRect.top);
        right = Math.min(right, parentRect.right);
        bottom = Math.min(bottom, parentRect.bottom);
      }
      return {
        x: left,
        y: top,
        left,
        top,
        right,
        bottom,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top)
      };
    };
    const visible = (node) => {
      const style = getComputedStyle(node);
      const rect = clippedRectOf(node);
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
      const section = node.closest("[data-section]");
      const scope = node.closest(".top-actions")
        ? "top_actions"
        : node.closest(".primary-actions")
          ? "primary_actions"
          : node.closest("details.control-drawer")
            ? "advanced_drawer"
            : node.closest("details.diagnostic-drawer")
              ? "diagnostic_drawer"
              : node.closest(".provider-actions")
                ? "provider_actions"
                : node.closest(".command-actions")
                  ? "command_actions"
                  : "ungrouped";
      return {
        text: textOf(node),
        action: action.value,
        action_attribute: action.attribute,
        tag,
        role,
        scope,
        section_key: section?.dataset.section || section?.id || null,
        command: tag === "button"
          ? "native_button"
          : role === "button"
            ? "role_button"
            : "data_command",
        rect: clippedRectOf(node)
      };
    });
    const nav = Array.from(document.querySelectorAll(".nav-list a")).filter(visible).map((node) => ({
      text: textOf(node),
      href: node.getAttribute("href"),
      active: node.classList.contains("active"),
      rect: clippedRectOf(node)
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
    const contentSectionNodes = Array.from(document.querySelectorAll(".content-grid [data-section], .mobile-hero, .mobile-metrics, .mobile-section")).filter(visible);
    const contentSections = contentSectionNodes.map((node, index) => {
      const headingNode = node.querySelector("h1, h2, h3, .section-title, .mobile-section-title, strong");
      return {
        index,
        section_key: node.dataset.section || node.id || node.getAttribute("aria-label") || node.className || `section-${index + 1}`,
        heading: textOf(headingNode || node).slice(0, 120),
        text: textOf(node),
        text_length: textOf(node).length,
        data_bind_count: Array.from(node.querySelectorAll("[data-bind]")).filter(visible).length,
        visible: true,
        source_type: "browser_dom_text"
      };
    });
    const bodyText = textOf(document.body);
    const riskyTextPattern = /\b(rerun|not_configured|no_next_action|inspect_context_work_packages|prepare_project_status_continuation|run_context_work_packages|projected_next_action|approved_mock_non_dry_run|scheduler_dispatch|frontend_acceptance|headless_projected_action_progress)\b/g;
    const riskyTokens = Array.from(new Set(bodyText.match(riskyTextPattern) || []));
    const overlapPairs = [];
    const sampled = elements
      .map((node) => ({
        node,
        text: textOf(node).slice(0, 40),
        rect: clippedRectOf(node)
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
      bodyText: bodyText.slice(0, 12000),
      contentSections,
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
  const internalCopyMatches = internalVisibleCopyMatches(result.bodyText);
  if (internalCopyMatches.length > 0) {
    findings.push(finding("frontend_internal_workbench_copy_visible", "p1", `${result.viewport} exposes internal workbench/backend copy to users`, {
      viewport: result.viewport,
      matches: internalCopyMatches.slice(0, 12)
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
    const architecture = commandArchitectureResultForViewport(result);
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
      findings.push(finding("frontend_command_control_overload", "p1", `${result.viewport} exposes more visible command controls than the release workbench can support`, {
        viewport: result.viewport,
        control_count: buttons.length,
        max_release_command_controls: MAX_RELEASE_COMMAND_CONTROLS
      }));
      findings.push(finding("frontend_button_pileup", "p1", `${result.viewport} exposes too many unrelated command controls`, {
        viewport: result.viewport,
        button_count: buttons.length,
        buttons: buttons.map((button) => button.text)
      }));
    }
    if (architecture.ungrouped_risky_control_count > 0) {
      findings.push(finding("frontend_command_information_architecture", "p1", `${result.viewport} exposes high-risk command controls outside a primary or advanced control group`, {
        viewport: result.viewport,
        controls: architecture.controls.filter((control) => {
          return architecture.blocking_finding_codes.includes("frontend_command_information_architecture") &&
            isRiskyCommand(control) &&
            ["ungrouped", "command_actions"].includes(control.scope);
        })
      }));
    }
    if (architecture.primary_control_count > MAX_PRIMARY_COMMAND_CONTROLS) {
      findings.push(finding("frontend_primary_action_overload", "p1", `${result.viewport} has too many primary command actions competing for operator attention`, {
        viewport: result.viewport,
        primary_control_count: architecture.primary_control_count,
        max_primary_command_controls: MAX_PRIMARY_COMMAND_CONTROLS
      }));
    }
    if (architecture.risky_primary_control_count > MAX_RISKY_PRIMARY_COMMAND_CONTROLS) {
      findings.push(finding("frontend_primary_risky_action_overload", "p1", `${result.viewport} puts too many high-risk commands in the primary action area`, {
        viewport: result.viewport,
        risky_primary_control_count: architecture.risky_primary_control_count,
        max_risky_primary_command_controls: MAX_RISKY_PRIMARY_COMMAND_CONTROLS
      }));
    }
    if (architecture.repeated_actions.length > 0) {
      findings.push(finding("frontend_repeated_command_actions", "p1", `${result.viewport} repeats the same command action in the visible workspace`, {
        viewport: result.viewport,
        repeated_actions: architecture.repeated_actions
      }));
    }
    if (architecture.overloaded_sections.length > 0) {
      findings.push(finding("frontend_action_cluster_overload", "p1", `${result.viewport} has a section with too many visible command controls`, {
        viewport: result.viewport,
        overloaded_sections: architecture.overloaded_sections
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
  const contentCompletionResults = viewportResults.map(contentCompletionResultForViewport);
  const projectManagementSemanticResults = viewportResults.map(projectManagementSemanticResultForViewport);
  const commandArchitectureResults = viewportResults.map(commandArchitectureResultForViewport);
  const layoutResults = viewportResults.map(layoutDensityResultForViewport);
  const copyResults = viewportResults.map((result) => ({
    viewport: result.viewport,
    risky_tokens: result.riskyTokens,
    internal_copy_matches: internalVisibleCopyMatches(result.bodyText),
    body_text_sample: normalizeText(result.bodyText).slice(0, 800),
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
      command: button.command || null,
      scope: commandControlScopeOf(button),
      section_key: commandSectionOf(button)
    })),
    command_architecture: commandArchitectureResults.find((architecture) => architecture.viewport === result.viewport) || null
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
      button_count: result.buttons.length,
      content_status: contentCompletionResults.find((contentResult) => contentResult.viewport === result.viewport)?.status || "unknown"
    }));
  const findings = [
    ...viewportResults.flatMap(findingsForViewport),
    ...findingsForContentCompletion(contentCompletionResults),
    ...findingsForProjectManagementSemantics(projectManagementSemanticResults),
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
    content_completion_results: contentCompletionResults,
    project_management_semantic_results: projectManagementSemanticResults,
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
  let durableTargetInfo = null;
  const artifact = await withWorkbenchServer(options.target, async ({ port, targetInfo, staticRouteFallback = false }) => {
    durableTargetInfo = targetInfo;
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

  if (options.target === TARGET_LATEST) {
    const recorded = recordFrontendAcceptanceRunArtifact(workflowStateForTarget(durableTargetInfo), artifact);
    const projection = recorded.status === "pass"
      ? createWorkbenchProjection(recorded.workflow_state)
      : {};
    artifact.durable_evidence = createFrontendAcceptanceDurableEvidence(recorded, projection);
  }

  const validation = validateFrontendAcceptanceRunArtifact(artifact, {
    requireDurableReleaseEvidence: options.target === TARGET_LATEST
  });
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
