import { FRONTEND_ACCEPTANCE_RUN_VERSION } from "../src/workflow/frontend-acceptance.js";
import {
  contentCompletionResultForViewport,
  contentSectionsOf,
  findingsForContentCompletion,
  findingsForProjectManagementSemantics,
  internalVisibleCopyMatches,
  normalizeText,
  projectManagementSemanticResultForViewport
} from "./workbench-frontend-acceptance-content.mjs";
import {
  faviconLinksOf,
  findingsForResources,
  mountedSafeFaviconCount,
  resourceResultForViewport
} from "./workbench-frontend-acceptance-resources.mjs";
const TARGET_LATEST = "latest";
const TARGET_FIXTURE = "fixture";
const RISKY_COMMAND_PATTERN = /\b(mock|real|loop|resume|rerun|approve|approved|run_context_work_packages|prepare_project_status_continuation|headless_projected_action_progress|projected_next_action)\b|scheduler[-_ ]?dispatch|恢复|批准/i;
const MAX_RELEASE_COMMAND_CONTROLS = 8;
const MAX_PRIMARY_COMMAND_CONTROLS = 3;
const MAX_RISKY_PRIMARY_COMMAND_CONTROLS = 1;
const MAX_COMMANDS_PER_SECTION = 6;
function valueAfter(flag, args) {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}
function hasFlag(flag, args) {
  return args.includes(flag);
}
function normalizeTarget(value = "") {
  const target = String(value || "").trim().toLowerCase();
  if (!target || ["latest", "live", "live-latest", "default", "release"].includes(target)) return TARGET_LATEST;
  if (["fixture", "current-session", "current_session"].includes(target)) return TARGET_FIXTURE;
  throw new Error(`unsupported frontend acceptance target: ${value}`);
}
export function parseAcceptanceOptions(args = process.argv.slice(2)) {
  const explicitTarget = valueAfter("--target", args) || valueAfter("--mode", args);
  return {
    target: normalizeTarget(hasFlag("--fixture", args) || hasFlag("--current-session", args) ? TARGET_FIXTURE : explicitTarget),
    outputPath: valueAfter("--output", args),
    screenshotDir: valueAfter("--screenshots", args),
    expectPass: !hasFlag("--allow-fail", args)
  };
}
function finding(code, severity, message, evidence = {}) {
  return { code, severity, status: "fail", message, evidence };
}
function countValue(value) {
  const count = Number(value);
  return Number.isFinite(count) ? count : 0;
}
function browserErrorsOf(result = {}) {
  return Array.isArray(result.browserErrors) ? result.browserErrors : Array.isArray(result.browser_errors) ? result.browser_errors : [];
}
function compactBrowserError(error = {}) {
  return {
    source: error.source || "browser",
    type: error.type || null,
    text: error.text || error.message || null,
    url: error.url || null,
    status: error.status || null,
    location: error.location || null,
    allowed: false
  };
}
function commandControlScopeOf(button = {}) {
  return normalizeText(button.scope || button.control_scope || button.controlScope || "ungrouped") || "ungrouped";
}
function commandSectionOf(button = {}) {
  return normalizeText(button.section_key || button.section || button.sectionKey || "unknown") || "unknown";
}
function isRiskyCommand(button = {}) {
  return RISKY_COMMAND_PATTERN.test([button.text, button.action, button.action_attribute, button.command].filter(Boolean).join(" "));
}
function commandArchitectureResultForViewport(result = {}) {
  const buttons = Array.isArray(result.buttons) ? result.buttons : [];
  const riskyButtons = buttons.filter(isRiskyCommand);
  const primaryButtons = buttons.filter((button) => ["primary_actions", "top_actions"].includes(commandControlScopeOf(button)));
  const advancedButtons = buttons.filter((button) => ["advanced_drawer", "diagnostic_drawer"].includes(commandControlScopeOf(button)));
  const primaryRiskyButtons = primaryButtons.filter(isRiskyCommand);
  const ungroupedRiskyButtons = riskyButtons.filter((button) => ["ungrouped", "command_actions"].includes(commandControlScopeOf(button)));
  const actionCounts = new Map();
  const sectionCounts = new Map();
  for (const button of buttons) {
    const actionKey = normalizeText(button.action || button.text);
    if (actionKey) actionCounts.set(actionKey, (actionCounts.get(actionKey) || 0) + 1);
    const sectionKey = commandSectionOf(button);
    sectionCounts.set(sectionKey, (sectionCounts.get(sectionKey) || 0) + 1);
  }
  const repeatedActions = [...actionCounts.entries()].filter(([, count]) => count > 1).map(([action, count]) => ({ action, count }));
  const overloadedSections = [...sectionCounts.entries()].filter(([, count]) => count > MAX_COMMANDS_PER_SECTION).map(([section_key, count]) => ({ section_key, count }));
  const codes = [
    buttons.length > MAX_RELEASE_COMMAND_CONTROLS ? "frontend_command_control_overload" : null,
    primaryButtons.length > MAX_PRIMARY_COMMAND_CONTROLS ? "frontend_primary_action_overload" : null,
    primaryRiskyButtons.length > MAX_RISKY_PRIMARY_COMMAND_CONTROLS ? "frontend_primary_risky_action_overload" : null,
    ungroupedRiskyButtons.length > 0 ? "frontend_command_information_architecture" : null,
    repeatedActions.length > 0 ? "frontend_repeated_command_actions" : null,
    overloadedSections.length > 0 ? "frontend_action_cluster_overload" : null
  ].filter(Boolean);
  const controls = buttons.map((button) => ({
    text: button.text,
    action: button.action || null,
    action_attribute: button.action_attribute || null,
    tag: button.tag || null,
    role: button.role || null,
    command: button.command || null,
    scope: commandControlScopeOf(button),
    section_key: commandSectionOf(button)
  }));
  return {
    viewport: result.viewport,
    source_type: "browser_dom_controls",
    status: codes.length > 0 ? "fail" : "pass",
    control_count: buttons.length,
    primary_control_count: primaryButtons.length,
    advanced_control_count: advancedButtons.length,
    risky_control_count: riskyButtons.length,
    risky_primary_control_count: primaryRiskyButtons.length,
    ungrouped_risky_control_count: ungroupedRiskyButtons.length,
    repeated_actions: repeatedActions,
    overloaded_sections: overloadedSections,
    blocking_finding_codes: codes,
    controls
  };
}
function layoutDensityResultForViewport(result = {}) {
  const sectionCount = Math.max(contentSectionsOf(result).length, 1);
  const buttonCount = Array.isArray(result.buttons) ? result.buttons.length : 0;
  const commandDensity = Number((buttonCount / sectionCount).toFixed(2));
  return {
    viewport: result.viewport,
    dimensions: result.dimensions || {},
    overlap_count: Array.isArray(result.overlapPairs) ? result.overlapPairs.length : 0,
    visible_section_count: sectionCount,
    visible_command_count: buttonCount,
    command_density: commandDensity,
    dense_command_layout: buttonCount > MAX_RELEASE_COMMAND_CONTROLS || commandDensity > MAX_COMMANDS_PER_SECTION,
    source_type: "browser_dom_layout"
  };
}
function findingsForViewport(result = {}) {
  const findings = [];
  const dimensions = result.dimensions || {};
  if (dimensions.scrollWidth > dimensions.width) findings.push(finding("frontend_horizontal_overflow", "p1", `${result.viewport} has horizontal overflow`, dimensions));
  const heroLines = result.hero ? Math.ceil(result.hero.height / Math.max(result.hero.lineHeight || result.hero.fontSize || 1, 1)) : 0;
  if (result.hero && (result.hero.text.length > 96 || heroLines > 3)) {
    findings.push(finding("frontend_unbounded_dynamic_headline", "p1", `${result.viewport} headline is too long for an operator status summary`, {
      text: result.hero.text,
      length: result.hero.text.length,
      lines: heroLines
    }));
  }
  if ((result.riskyTokens || []).length > 0) findings.push(finding("frontend_raw_projection_copy", "p1", `${result.viewport} exposes raw backend/projection tokens in the default surface`, { tokens: result.riskyTokens }));
  const internalCopyMatches = internalVisibleCopyMatches(result.bodyText);
  if (internalCopyMatches.length > 0) findings.push(finding("frontend_internal_workbench_copy_visible", "p1", `${result.viewport} exposes internal workbench/backend copy to users`, { viewport: result.viewport, matches: internalCopyMatches.slice(0, 12) }));
  if ((result.overlapPairs || []).length > 0) findings.push(finding("frontend_layout_overlap", "p1", `${result.viewport} contains overlapping visible elements`, { examples: result.overlapPairs.slice(0, 3) }));
  if (result.viewport === "mobile" && countValue(result.diagnosticsCount) > 24) findings.push(finding("frontend_mobile_telemetry_dump", "p1", "mobile workbench is dominated by backend telemetry fields", { diagnostics_count: result.diagnosticsCount }));
  return findings;
}
function findingsForNavigation(results = []) {
  const semanticChanged = (result = {}) => {
    if (result.semantic_changed === true || result.semantically_changed === true) return true;
    if (result.scroll_changed || result.visible_text_changed || result.visible_sections_changed || result.focused_section_changed) return true;
    return Boolean(
      (result.before || {}).scrollTop !== (result.after || {}).scrollTop ||
      (result.before || {}).mainText !== (result.after || {}).mainText ||
      JSON.stringify((result.before || {}).visibleSections || []) !== JSON.stringify((result.after || {}).visibleSections || []) ||
      JSON.stringify((result.before || {}).focusedSection || null) !== JSON.stringify((result.after || {}).focusedSection || null)
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
    const riskyButtons = buttons.filter(isRiskyCommand);
    if (riskyButtons.length > 0) findings.push(finding("frontend_danger_controls_unscoped", "p1", `${result.viewport} exposes dangerous scheduler/mock/real loop controls as ordinary command controls`, {
      viewport: result.viewport,
      buttons: riskyButtons.map((button) => ({ text: button.text, action: button.action || null, action_attribute: button.action_attribute || null, tag: button.tag || null, role: button.role || null }))
    }));
    if (buttons.length > 8) {
      findings.push(finding("frontend_command_control_overload", "p1", `${result.viewport} exposes more visible command controls than the release workbench can support`, { viewport: result.viewport, control_count: buttons.length, max_release_command_controls: MAX_RELEASE_COMMAND_CONTROLS }));
      findings.push(finding("frontend_button_pileup", "p1", `${result.viewport} exposes too many unrelated command controls`, { viewport: result.viewport, button_count: buttons.length, buttons: buttons.map((button) => button.text) }));
    }
    if (architecture.ungrouped_risky_control_count > 0) findings.push(finding("frontend_command_information_architecture", "p1", `${result.viewport} exposes high-risk command controls outside a primary or advanced control group`, { viewport: result.viewport, controls: architecture.controls.filter((control) => isRiskyCommand(control) && ["ungrouped", "command_actions"].includes(control.scope)) }));
    if (architecture.primary_control_count > MAX_PRIMARY_COMMAND_CONTROLS) findings.push(finding("frontend_primary_action_overload", "p1", `${result.viewport} has too many primary command actions competing for operator attention`, { viewport: result.viewport, primary_control_count: architecture.primary_control_count, max_primary_command_controls: MAX_PRIMARY_COMMAND_CONTROLS }));
    if (architecture.risky_primary_control_count > MAX_RISKY_PRIMARY_COMMAND_CONTROLS) findings.push(finding("frontend_primary_risky_action_overload", "p1", `${result.viewport} puts too many high-risk commands in the primary action area`, { viewport: result.viewport, risky_primary_control_count: architecture.risky_primary_control_count, max_risky_primary_command_controls: MAX_RISKY_PRIMARY_COMMAND_CONTROLS }));
    if (architecture.repeated_actions.length > 0) findings.push(finding("frontend_repeated_command_actions", "p1", `${result.viewport} repeats the same command action in the visible workspace`, { viewport: result.viewport, repeated_actions: architecture.repeated_actions }));
    if (architecture.overloaded_sections.length > 0) findings.push(finding("frontend_action_cluster_overload", "p1", `${result.viewport} has a section with too many visible command controls`, { viewport: result.viewport, overloaded_sections: architecture.overloaded_sections }));
  }
  return findings;
}
function findingsForBrowserErrors(viewportResults) {
  return viewportResults.flatMap((result) => {
    const errors = browserErrorsOf(result).map(compactBrowserError);
    return errors.length === 0 ? [] : [finding("frontend_browser_console_error", "p1", `${result.viewport} produced browser console/page errors`, {
      viewport: result.viewport,
      error_count: errors.length,
      blocked_error_count: errors.length,
      errors: errors.slice(0, 10)
    })];
  });
}
export function buildArtifact({ viewportResults, navigationResults, screenshots, targetInfo = {} }) {
  const contentCompletionResults = viewportResults.map(contentCompletionResultForViewport);
  const projectManagementSemanticResults = viewportResults.map(projectManagementSemanticResultForViewport);
  const commandArchitectureResults = viewportResults.map(commandArchitectureResultForViewport);
  const layoutResults = viewportResults.map(layoutDensityResultForViewport);
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
      nav_count: (result.nav || []).length,
      button_count: (result.buttons || []).length,
      control_count: (result.buttons || []).length,
      diagnostics_count: result.diagnosticsCount,
      favicon_link_count: faviconLinksOf(result).length,
      mounted_safe_favicon_count: mountedSafeFaviconCount(result),
      browser_error_count: browserErrorsOf(result).length,
      blocked_browser_error_count: browserErrorsOf(result).length
    })),
    navigation_results: navigationResults,
    layout_results: layoutResults,
    copy_results: viewportResults.map((result) => ({
      viewport: result.viewport,
      risky_tokens: result.riskyTokens,
      internal_copy_matches: internalVisibleCopyMatches(result.bodyText),
      body_text_sample: normalizeText(result.bodyText).slice(0, 800),
      hero_text_length: result.hero?.text.length || 0
    })),
    content_completion_results: contentCompletionResults,
    project_management_semantic_results: projectManagementSemanticResults,
    resource_results: viewportResults.map(resourceResultForViewport),
    control_results: viewportResults.map((result) => ({
      viewport: result.viewport,
      button_count: (result.buttons || []).length,
      control_count: (result.buttons || []).length,
      native_button_count: (result.buttons || []).filter((button) => button.command === "native_button").length,
      role_button_count: (result.buttons || []).filter((button) => button.command === "role_button").length,
      data_command_count: (result.buttons || []).filter((button) => button.command === "data_command").length,
      buttons: (result.buttons || []).map((button) => button.text),
      controls: commandArchitectureResults.find((item) => item.viewport === result.viewport)?.controls || [],
      command_architecture: commandArchitectureResults.find((item) => item.viewport === result.viewport) || null
    })),
    browser_error_results: viewportResults.map((result) => {
      const errors = browserErrorsOf(result).map(compactBrowserError);
      return { viewport: result.viewport, error_count: errors.length, blocked_error_count: errors.length, errors };
    }),
    mobile_results: viewportResults.filter((result) => result.viewport === "mobile").map((result) => ({
      viewport: result.viewport,
      diagnostics_count: result.diagnosticsCount,
      button_count: (result.buttons || []).length,
      content_status: contentCompletionResults.find((item) => item.viewport === result.viewport)?.status || "unknown"
    })),
    findings,
    blocking_count: blockingFindings.length,
    blocking_findings: blockingFindings
  };
}
