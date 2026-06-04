import {
  FRONTEND_ACCEPTANCE_RUN_VERSION,
  asArray,
  countValue,
  findingCode,
  isBlockingFrontendFinding,
  isObject,
  issue,
  normalizeString
} from "./frontend-acceptance-core.js";
import { validateFrontendAcceptanceDurableEvidence } from "./frontend-acceptance-durable-evidence.js";

const DESKTOP_DIAGNOSTIC_FIELD_WALL_THRESHOLD = 48;
const DESKTOP_DIAGNOSTIC_PLACEHOLDER_FIELD_THRESHOLD = 18;
const DESKTOP_BODY_PLACEHOLDER_WALL_THRESHOLD = 36;
const DESKTOP_SECTION_DATA_BIND_WALL_THRESHOLD = 10;
const DESKTOP_SECTION_PLACEHOLDER_WALL_THRESHOLD = 6;
const MAX_RELEASE_COMMAND_CONTROLS = 8;
const MAX_PRIMARY_COMMAND_CONTROLS = 3;
const MAX_RISKY_PRIMARY_COMMAND_CONTROLS = 1;

function contentTypeValue(value) {
  return normalizeString(value).toLowerCase().split(";")[0].trim();
}

function contentCompletionFindingCodes(result = {}) {
  return asArray(result.blocking_finding_codes || result.blockingFindingCodes)
    .map(normalizeString)
    .filter(Boolean);
}

function isDesktopContentViewport(viewport = "") {
  const normalized = normalizeString(viewport);
  return normalized === "desktop" || normalized === "desktop_narrow";
}

function contentCompletionHasDiagnosticWall(result = {}) {
  if (result.diagnostic_dominated === true || result.diagnosticDominated === true) return true;
  if (!isDesktopContentViewport(result.viewport)) return false;

  const diagnosticFieldCount = countValue(result.diagnostic_field_count ?? result.diagnosticFieldCount);
  const placeholderCount = countValue(result.placeholder_count ?? result.placeholderCount);
  const unresolvedPlaceholderCount = countValue(
    result.unresolved_placeholder_count ?? result.unresolvedPlaceholderCount,
    placeholderCount
  );
  if (diagnosticFieldCount >= DESKTOP_DIAGNOSTIC_FIELD_WALL_THRESHOLD) return true;
  if (
    diagnosticFieldCount >= DESKTOP_DIAGNOSTIC_PLACEHOLDER_FIELD_THRESHOLD &&
    unresolvedPlaceholderCount >= DESKTOP_BODY_PLACEHOLDER_WALL_THRESHOLD
  ) {
    return true;
  }

  const diagnosticWallSections = asArray(result.diagnostic_wall_sections || result.diagnosticWallSections);
  if (diagnosticWallSections.length > 0) return true;

  return asArray(result.content_sections || result.contentSections).some((section) => {
    const sectionPlaceholderCount = countValue(section.placeholder_count ?? section.placeholderCount);
    const sectionUnresolvedPlaceholderCount = countValue(
      section.unresolved_placeholder_count ?? section.unresolvedPlaceholderCount,
      sectionPlaceholderCount
    );
    return countValue(section.data_bind_count ?? section.dataBindCount) >= DESKTOP_SECTION_DATA_BIND_WALL_THRESHOLD &&
      sectionUnresolvedPlaceholderCount >= DESKTOP_SECTION_PLACEHOLDER_WALL_THRESHOLD;
  });
}

function contentCompletionHasBlocker(result = {}) {
  if (contentCompletionFindingCodes(result).length > 0) return true;
  if (contentCompletionHasDiagnosticWall(result)) return true;
  if (result.mobile_telemetry_dump === true || result.mobileTelemetryDump === true) return true;
  return asArray(result.placeholder_dominated_sections || result.placeholderDominatedSections).length > 0;
}

function commandArchitectureOf(controlResult = {}) {
  return controlResult.command_architecture || controlResult.commandArchitecture || {};
}

function commandArchitectureFindingCodes(result = {}) {
  return asArray(result.blocking_finding_codes || result.blockingFindingCodes)
    .map(normalizeString)
    .filter(Boolean);
}

function commandArchitectureHasBlocker(result = {}) {
  if (normalizeString(result.status).toLowerCase() === "fail") return true;
  if (commandArchitectureFindingCodes(result).length > 0) return true;
  if (countValue(result.primary_control_count ?? result.primaryControlCount) > MAX_PRIMARY_COMMAND_CONTROLS) return true;
  if (countValue(result.risky_primary_control_count ?? result.riskyPrimaryControlCount) > MAX_RISKY_PRIMARY_COMMAND_CONTROLS) return true;
  if (countValue(result.ungrouped_risky_control_count ?? result.ungroupedRiskyControlCount) > 0) return true;
  if (asArray(result.repeated_actions || result.repeatedActions).length > 0) return true;
  if (asArray(result.overloaded_sections || result.overloadedSections).length > 0) return true;
  return false;
}

function navigationLabel(result = {}) {
  return normalizeString(result.label || result.text || result.name);
}

function navigationActiveChanged(result = {}) {
  if (result.active_changed === true || result.activeChanged === true) return true;
  const before = result.before || {};
  const after = result.after || {};
  return normalizeString(before.active) !== normalizeString(after.active);
}

function navigationSemanticChanged(result = {}) {
  if (result.semantic_changed === true || result.semantically_changed === true || result.semanticChanged === true) return true;
  if (
    result.scroll_changed === true ||
    result.scrollChanged === true ||
    result.visible_text_changed === true ||
    result.visibleTextChanged === true ||
    result.visible_sections_changed === true ||
    result.visibleSectionsChanged === true ||
    result.focused_section_changed === true ||
    result.focusedSectionChanged === true
  ) {
    return true;
  }

  const before = result.before || {};
  const after = result.after || {};
  const beforeScroll = Number(before.scrollTop);
  const afterScroll = Number(after.scrollTop);
  return Boolean(
    (Number.isFinite(beforeScroll) && Number.isFinite(afterScroll) && beforeScroll !== afterScroll) ||
      normalizeString(before.mainText) !== normalizeString(after.mainText) ||
      JSON.stringify(before.visibleSections || []) !== JSON.stringify(after.visibleSections || []) ||
      JSON.stringify(before.focusedSection || null) !== JSON.stringify(after.focusedSection || null)
  );
}

export function validateFrontendAcceptanceRunArtifact(artifact = {}, options = {}) {
  const issues = [];
  if (!isObject(artifact)) {
    return {
      status: "fail",
      issues: [issue("invalid_frontend_acceptance_artifact", "frontend acceptance artifact must be an object", "artifact")]
    };
  }

  if (artifact.version !== FRONTEND_ACCEPTANCE_RUN_VERSION) {
    issues.push(issue("invalid_frontend_acceptance_version", `version must be ${FRONTEND_ACCEPTANCE_RUN_VERSION}`, "version"));
  }
  if (!["pass", "fail"].includes(normalizeString(artifact.status))) {
    issues.push(issue("invalid_frontend_acceptance_status", "status must be pass or fail", "status"));
  }
  if (!normalizeString(artifact.created_at)) {
    issues.push(issue("missing_frontend_acceptance_created_at", "created_at is required", "created_at"));
  }
  if (normalizeString(artifact.route_family) === "nextjs_app_router" && artifact.legacy_static_shell_used !== false) {
    issues.push(issue("next_frontend_acceptance_legacy_shell_not_allowed", "Next.js frontend acceptance must prove legacy static shell was not used", "legacy_static_shell_used"));
  }

  for (const field of [
    "viewport_results",
    "navigation_results",
    "layout_results",
    "copy_results",
    "content_completion_results",
    "project_management_semantic_results",
    "resource_results",
    "control_results",
    "mobile_results",
    "browser_error_results",
    "findings"
  ]) {
    if (!Array.isArray(artifact[field])) {
      issues.push(issue("missing_frontend_acceptance_array", `${field} must be an array`, field));
    }
  }

  const findings = asArray(artifact.findings);
  const blockingFindings = findings.filter(isBlockingFrontendFinding);
  const declaredBlockingCount = Number(artifact.blocking_count ?? asArray(artifact.blocking_findings).length ?? 0);
  if (declaredBlockingCount !== blockingFindings.length) {
    issues.push(issue("frontend_acceptance_blocking_count_mismatch", "blocking_count must match P0/P1 failed findings", "blocking_count"));
  }
  if (normalizeString(artifact.status) === "pass" && blockingFindings.length > 0) {
    issues.push(issue("frontend_acceptance_false_pass", "frontend acceptance cannot pass with P0/P1 findings", "status"));
  }
  if (normalizeString(artifact.status) === "fail" && blockingFindings.length === 0) {
    issues.push(issue("frontend_acceptance_fail_without_blocker", "failed frontend acceptance must include a blocking finding", "findings"));
  }

  for (const [index, result] of asArray(artifact.navigation_results).entries()) {
    const label = navigationLabel(result);
    if (!label || label === "总览") continue;
    if (!navigationSemanticChanged(result)) {
      issues.push(issue("frontend_navigation_semantic_change_required", "non-overview navigation must reveal distinct visible content, scroll position, or view focus", `navigation_results.${index}`));
    }
    if (navigationActiveChanged(result) && !navigationSemanticChanged(result)) {
      issues.push(issue("frontend_navigation_active_only_not_allowed", "active-class-only navigation changes are not sufficient for frontend acceptance", `navigation_results.${index}`));
    }
  }

  const viewportNames = new Set(asArray(artifact.viewport_results).map((result) => normalizeString(result.viewport)));
  for (const requiredViewport of ["desktop", "desktop_narrow", "mobile"]) {
    if (!viewportNames.has(requiredViewport)) {
      issues.push(issue("missing_frontend_acceptance_viewport", `${requiredViewport} viewport result is required`, "viewport_results"));
    }
  }
  const viewportResultsByName = new Map(asArray(artifact.viewport_results).map((result) => [normalizeString(result.viewport), result]));
  const resourceResultsByName = new Map(asArray(artifact.resource_results).map((result) => [normalizeString(result.viewport), result]));
  const contentCompletionResultsByName = new Map(asArray(artifact.content_completion_results).map((result) => [normalizeString(result.viewport), result]));
  const productSemanticResultsByName = new Map(asArray(artifact.project_management_semantic_results).map((result) => [normalizeString(result.viewport), result]));
  const controlResultsByName = new Map(asArray(artifact.control_results).map((result) => [normalizeString(result.viewport), result]));
  const layoutResultsByName = new Map(asArray(artifact.layout_results).map((result) => [normalizeString(result.viewport), result]));
  const browserErrorResultsByName = new Map(asArray(artifact.browser_error_results).map((result) => [normalizeString(result.viewport), result]));
  const findingCodes = new Set(findings.map(findingCode).filter(Boolean));
  for (const requiredViewport of ["desktop", "desktop_narrow", "mobile"]) {
    const viewportResult = viewportResultsByName.get(requiredViewport) || {};
    const resourceResult = resourceResultsByName.get(requiredViewport) || {};
    const contentResult = contentCompletionResultsByName.get(requiredViewport) || null;
    const semanticResult = productSemanticResultsByName.get(requiredViewport) || null;
    const controlResult = controlResultsByName.get(requiredViewport) || null;
    const layoutResult = layoutResultsByName.get(requiredViewport) || null;
    const browserErrorResult = browserErrorResultsByName.get(requiredViewport) || null;
    if (viewportResult.mounted_workbench_route !== true && resourceResult.mounted_workbench_route !== true) {
      issues.push(issue("missing_mounted_workbench_route", `${requiredViewport} must exercise the project-mounted workbench route`, "viewport_results"));
    }
    if (countValue(resourceResult.mounted_safe_favicon_count ?? viewportResult.mounted_safe_favicon_count) <= 0) {
      issues.push(issue("missing_frontend_favicon_readiness", `${requiredViewport} must include a mounted-safe workbench favicon link`, "resource_results"));
    }
    if (countValue(resourceResult.root_favicon_count) > 0) {
      issues.push(issue("root_favicon_fallback_not_allowed", `${requiredViewport} must not point favicon traffic at root /favicon.ico`, "resource_results"));
    }
    if (resourceResult.mounted_svg_favicon_mime_ok !== true) {
      issues.push(issue("mounted_svg_favicon_mime_required", `${requiredViewport} mounted SVG favicon must be served as image/svg+xml`, "resource_results"));
    }
    if (
      normalizeString(resourceResult.mounted_svg_favicon_mime) &&
      contentTypeValue(resourceResult.mounted_svg_favicon_mime) !== "image/svg+xml"
    ) {
      issues.push(issue("mounted_svg_favicon_mime_drift", `${requiredViewport} mounted SVG favicon content-type drifted`, "resource_results"));
    }
    if (!contentResult) {
      issues.push(issue("missing_frontend_content_completion_evidence", `${requiredViewport} must include DOM text content completion evidence`, "content_completion_results"));
    } else {
      if (normalizeString(contentResult.source_type || contentResult.sourceType) !== "browser_dom_text") {
        issues.push(issue("frontend_content_completion_requires_dom_text", `${requiredViewport} content completion evidence must come from real browser DOM text`, "content_completion_results"));
      }
      if (countValue(contentResult.section_count ?? contentResult.sectionCount) <= 0) {
        issues.push(issue("frontend_content_completion_missing_sections", `${requiredViewport} content completion evidence must include visible sections`, "content_completion_results"));
      }
      if (countValue(contentResult.body_text_length ?? contentResult.bodyTextLength) <= 0) {
        issues.push(issue("frontend_content_completion_missing_text", `${requiredViewport} content completion evidence must include body text length`, "content_completion_results"));
      }
      const contentResultStatus = normalizeString(contentResult.status).toLowerCase();
      const contentHasBlocker = contentCompletionHasBlocker(contentResult);
      const contentBlockerCodes = contentCompletionFindingCodes(contentResult);
      if (contentResultStatus === "pass" && contentHasBlocker) {
        issues.push(issue("frontend_content_completion_false_pass", `${requiredViewport} content completion cannot pass with blocker flags`, "content_completion_results"));
      }
      if (contentResultStatus === "fail" && !contentHasBlocker) {
        issues.push(issue("frontend_content_completion_fail_without_blocker", `${requiredViewport} content completion failure must include a blocker flag`, "content_completion_results"));
      }
      if (contentHasBlocker && contentBlockerCodes.length === 0) {
        issues.push(issue("frontend_content_completion_missing_finding_codes", `${requiredViewport} content completion blockers must declare matching finding codes`, "content_completion_results"));
      }
      for (const [sectionIndex, section] of asArray(contentResult.content_sections || contentResult.contentSections).entries()) {
        if (normalizeString(section.source_type || section.sourceType) !== "browser_dom_text") {
          issues.push(issue("frontend_content_section_requires_dom_text", `${requiredViewport} section evidence must come from browser DOM text`, `content_completion_results.${requiredViewport}.content_sections.${sectionIndex}`));
        }
      }
    }
    if (!semanticResult) {
      issues.push(issue("missing_project_management_semantic_evidence", `${requiredViewport} must include project-management semantic evidence`, "project_management_semantic_results"));
    } else {
      if (normalizeString(semanticResult.source_type || semanticResult.sourceType) !== "browser_dom_product_semantics") {
        issues.push(issue("project_management_semantics_requires_dom", `${requiredViewport} project-management semantic evidence must come from browser DOM`, "project_management_semantic_results"));
      }
      if (artifact.status === "pass") {
        if (semanticResult.status !== "pass") {
          issues.push(issue("project_management_semantics_failed", `${requiredViewport} must satisfy project-management semantics`, "project_management_semantic_results"));
        }
        if (semanticResult.has_platform_project !== true) {
          issues.push(issue("project_management_platform_project_missing", `${requiredViewport} must show ai-control-platform as a managed project`, "project_management_semantic_results"));
        }
        if (semanticResult.has_task_lifecycle !== true) {
          issues.push(issue("project_management_task_lifecycle_missing", `${requiredViewport} must show the project lifecycle`, "project_management_semantic_results"));
        }
        if (semanticResult.has_requirement_intake !== true && semanticResult.hasRequirementIntake !== true) {
          issues.push(issue("project_management_requirement_intake_missing", `${requiredViewport} must expose requirement intake into the autonomous flow`, "project_management_semantic_results"));
        }
        if (requiredViewport !== "mobile" && semanticResult.has_required_nav !== true) {
          issues.push(issue("project_management_nav_missing", `${requiredViewport} must expose project-management navigation`, "project_management_semantic_results"));
        }
        if (semanticResult.diagnostics_primary === true) {
          issues.push(issue("projection_diagnostics_primary_not_allowed", `${requiredViewport} diagnostics cannot be the primary workbench surface`, "project_management_semantic_results"));
        }
      }
    }
    if (!controlResult) {
      issues.push(issue("missing_frontend_control_architecture_evidence", `${requiredViewport} must include command control architecture evidence`, "control_results"));
    } else {
      const controlCount = countValue(controlResult.control_count ?? controlResult.controlCount ?? controlResult.button_count ?? controlResult.buttonCount);
      const architecture = commandArchitectureOf(controlResult);
      const architectureStatus = normalizeString(architecture.status).toLowerCase();
      const architectureHasBlocker = commandArchitectureHasBlocker(architecture);
      const architectureCodes = commandArchitectureFindingCodes(architecture);
      if (controlCount > MAX_RELEASE_COMMAND_CONTROLS && !architectureCodes.includes("frontend_command_control_overload")) {
        issues.push(issue("frontend_control_overload_missing_architecture_finding", `${requiredViewport} command control overload must be declared in command architecture findings`, "control_results"));
      }
      if (normalizeString(architecture.source_type || architecture.sourceType) !== "browser_dom_controls") {
        issues.push(issue("frontend_control_architecture_requires_dom_controls", `${requiredViewport} command architecture evidence must come from browser DOM controls`, "control_results"));
      }
      if (architectureStatus === "pass" && architectureHasBlocker) {
        issues.push(issue("frontend_control_architecture_false_pass", `${requiredViewport} command architecture cannot pass with blocker flags`, "control_results"));
      }
      if (architectureStatus === "fail" && !architectureHasBlocker) {
        issues.push(issue("frontend_control_architecture_fail_without_blocker", `${requiredViewport} command architecture failure must include blocker evidence`, "control_results"));
      }
      if (architectureHasBlocker && architectureCodes.length === 0) {
        issues.push(issue("frontend_control_architecture_missing_finding_codes", `${requiredViewport} command architecture blockers must declare matching finding codes`, "control_results"));
      }
    }
    if (!layoutResult) {
      issues.push(issue("missing_frontend_layout_density_evidence", `${requiredViewport} must include layout density evidence`, "layout_results"));
    } else {
      if (normalizeString(layoutResult.source_type || layoutResult.sourceType) !== "browser_dom_layout") {
        issues.push(issue("frontend_layout_density_requires_dom_layout", `${requiredViewport} layout density evidence must come from browser DOM layout`, "layout_results"));
      }
      if (
        (layoutResult.dense_command_layout === true || layoutResult.denseCommandLayout === true) &&
        !findings.some((finding) => ["frontend_button_pileup", "frontend_action_cluster_overload", "frontend_command_control_overload"].includes(findingCode(finding)))
      ) {
        issues.push(issue("frontend_dense_command_layout_missing_finding", `${requiredViewport} dense command layouts must have a matching P0/P1 finding`, "layout_results"));
      }
    }
    if (!browserErrorResult) {
      issues.push(issue("missing_frontend_browser_error_evidence", `${requiredViewport} must include browser error evidence`, "browser_error_results"));
    } else {
      const blockedBrowserErrorCount = countValue(browserErrorResult.blocked_error_count ?? browserErrorResult.blockedBrowserErrorCount ?? browserErrorResult.blocked_browser_error_count);
      if (artifact.status === "pass" && blockedBrowserErrorCount > 0) {
        issues.push(issue("frontend_browser_error_false_pass", `${requiredViewport} browser error evidence cannot pass with blocked errors`, "browser_error_results"));
      }
      if (blockedBrowserErrorCount > 0 && !findingCodes.has("frontend_browser_console_error")) {
        issues.push(issue("frontend_browser_error_finding_mismatch", `${requiredViewport} blocked browser errors must have a matching P0/P1 finding`, "findings"));
      }
    }
  }

  const contentCompletionBlockerCodes = asArray(artifact.content_completion_results)
    .filter(contentCompletionHasBlocker)
    .flatMap(contentCompletionFindingCodes);
  const commandArchitectureBlockerCodes = asArray(artifact.control_results)
    .map(commandArchitectureOf)
    .filter(commandArchitectureHasBlocker)
    .flatMap(commandArchitectureFindingCodes);
  const projectManagementBlockerCodes = asArray(artifact.project_management_semantic_results)
    .flatMap((result) => asArray(result.blocking_finding_codes || result.blockingFindingCodes));
  for (const code of contentCompletionBlockerCodes) {
    if (!findingCodes.has(code)) {
      issues.push(issue("frontend_content_completion_finding_mismatch", `content completion blocker ${code} must have a matching P0/P1 finding`, "findings"));
    }
  }
  for (const code of commandArchitectureBlockerCodes) {
    if (!findingCodes.has(code)) {
      issues.push(issue("frontend_control_architecture_finding_mismatch", `command architecture blocker ${code} must have a matching P0/P1 finding`, "findings"));
    }
  }
  for (const code of projectManagementBlockerCodes) {
    if (!findingCodes.has(code)) {
      issues.push(issue("project_management_semantic_finding_mismatch", `project-management blocker ${code} must have a matching P0/P1 finding`, "findings"));
    }
  }

  if (options.requireDurableReleaseEvidence === true || options.require_durable_release_evidence === true) {
    issues.push(...validateFrontendAcceptanceDurableEvidence(artifact).issues);
  }

  return {
    status: issues.length ? "fail" : "pass",
    issues
  };
}
