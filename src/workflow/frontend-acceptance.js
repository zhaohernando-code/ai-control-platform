import { recordArtifact } from "./artifact-ledger.js";
import { appendRunEvent } from "./run-manifest.js";

export const FRONTEND_ACCEPTANCE_RUN_VERSION = "frontend-acceptance-run.v1";
export const FRONTEND_ACCEPTANCE_DURABLE_EVIDENCE_VERSION = "frontend-acceptance-durable-evidence.v1";
export const FRONTEND_ACCEPTANCE_REPAIR_ACTION = "repair_frontend_acceptance";
export const FRONTEND_ACCEPTANCE_REPAIR_OWNED_FILES = [
  "apps/workbench",
  "test/workbench-shell.test.js"
];
export const FRONTEND_ACCEPTANCE_REPAIR_ACCEPTANCE_GATES = [
  "npm run check:workbench:frontend-acceptance",
  "npm run check:workbench:browser-events",
  "npm run check:closeout"
];

const BLOCKING_SEVERITIES = new Set(["p0", "p1", "critical", "blocker", "fatal"]);
const DESKTOP_DIAGNOSTIC_FIELD_WALL_THRESHOLD = 48;
const DESKTOP_DIAGNOSTIC_PLACEHOLDER_FIELD_THRESHOLD = 18;
const DESKTOP_BODY_PLACEHOLDER_WALL_THRESHOLD = 36;
const DESKTOP_SECTION_DATA_BIND_WALL_THRESHOLD = 10;
const DESKTOP_SECTION_PLACEHOLDER_WALL_THRESHOLD = 6;
const MAX_RELEASE_COMMAND_CONTROLS = 8;
const MAX_PRIMARY_COMMAND_CONTROLS = 3;
const MAX_RISKY_PRIMARY_COMMAND_CONTROLS = 1;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function issue(code, message, path) {
  return { code, message, path };
}

function countValue(value, fallback = 0) {
  const count = Number(value);
  return Number.isFinite(count) ? count : fallback;
}

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

function safeIdPart(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function severityOf(finding = {}) {
  return normalizeString(finding.severity || finding.level || "p1").toLowerCase();
}

function statusOf(finding = {}) {
  return normalizeString(finding.status || finding.result || "fail").toLowerCase();
}

export function isBlockingFrontendFinding(finding = {}) {
  return statusOf(finding) !== "pass" && BLOCKING_SEVERITIES.has(severityOf(finding));
}

function blockingFindingsFrom(frontendAcceptance = {}) {
  const blockingFindings = asArray(frontendAcceptance.blocking_findings || frontendAcceptance.blockingFindings);
  if (blockingFindings.length > 0) return blockingFindings;

  return asArray(frontendAcceptance.findings).filter(isBlockingFrontendFinding);
}

function findingCode(finding = {}) {
  return normalizeString(finding.code || finding.id || finding.finding_id || finding.findingId);
}

function numericCount(value, fallback = 0) {
  const count = Number(value);
  return Number.isFinite(count) ? count : fallback;
}

export function createFrontendAcceptanceRepairWorkPackage(frontendAcceptance = {}) {
  const status = normalizeString(frontendAcceptance.status).toLowerCase();
  const blockingFindings = blockingFindingsFrom(frontendAcceptance);
  const blockingCount = numericCount(
    frontendAcceptance.blocking_count ?? frontendAcceptance.blockingCount,
    blockingFindings.length
  );

  if (status !== "fail" || blockingCount <= 0) return null;

  const artifactId = normalizeString(frontendAcceptance.artifact_id || frontendAcceptance.artifactId || frontendAcceptance.id) || "latest";
  const latestFinding = normalizeString(frontendAcceptance.latest_finding || frontendAcceptance.latestFinding) ||
    normalizeString(blockingFindings[0]?.message || blockingFindings[0]?.code);
  const findingCodes = blockingFindings.map(findingCode).filter(Boolean);
  const summaryFindingCodes = asArray(frontendAcceptance.finding_codes || frontendAcceptance.findingCodes)
    .map(normalizeString)
    .filter(Boolean);

  return {
    id: `frontend-acceptance-repair-${safeIdPart(artifactId)}`,
    title: "Repair PC/mobile workbench frontend acceptance blockers",
    action: FRONTEND_ACCEPTANCE_REPAIR_ACTION,
    owned_files: [...FRONTEND_ACCEPTANCE_REPAIR_OWNED_FILES],
    acceptance_gates: [...FRONTEND_ACCEPTANCE_REPAIR_ACCEPTANCE_GATES],
    reason: latestFinding
      ? `${blockingCount} blocking frontend acceptance finding(s): ${latestFinding}`
      : `${blockingCount} blocking frontend acceptance finding(s) require UI repair`,
    frontend_acceptance: {
      artifact_id: artifactId,
      blocking_count: blockingCount,
      finding_count: numericCount(frontendAcceptance.finding_count ?? frontendAcceptance.findingCount, asArray(frontendAcceptance.findings).length || blockingFindings.length),
      latest_finding: latestFinding || null,
      finding_codes: findingCodes.length > 0 ? findingCodes : summaryFindingCodes,
      desktop_viewports: numericCount(frontendAcceptance.desktop_viewports ?? frontendAcceptance.desktopViewports, 0),
      mobile_viewports: numericCount(frontendAcceptance.mobile_viewports ?? frontendAcceptance.mobileViewports, 0)
    },
    source: {
      artifact_id: artifactId,
      role: "frontend_acceptance_child_worker",
      reason: "failed frontend-acceptance-run.v1 must become a durable bounded UI repair work package"
    }
  };
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

  for (const field of [
    "viewport_results",
    "navigation_results",
    "layout_results",
    "copy_results",
    "content_completion_results",
    "resource_results",
    "control_results",
    "mobile_results",
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
  const controlResultsByName = new Map(asArray(artifact.control_results).map((result) => [normalizeString(result.viewport), result]));
  const layoutResultsByName = new Map(asArray(artifact.layout_results).map((result) => [normalizeString(result.viewport), result]));
  for (const requiredViewport of ["desktop", "desktop_narrow", "mobile"]) {
    const viewportResult = viewportResultsByName.get(requiredViewport) || {};
    const resourceResult = resourceResultsByName.get(requiredViewport) || {};
    const contentResult = contentCompletionResultsByName.get(requiredViewport) || null;
    const controlResult = controlResultsByName.get(requiredViewport) || null;
    const layoutResult = layoutResultsByName.get(requiredViewport) || null;
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
  }

  const contentCompletionBlockerCodes = asArray(artifact.content_completion_results)
    .filter(contentCompletionHasBlocker)
    .flatMap(contentCompletionFindingCodes);
  const commandArchitectureBlockerCodes = asArray(artifact.control_results)
    .map(commandArchitectureOf)
    .filter(commandArchitectureHasBlocker)
    .flatMap(commandArchitectureFindingCodes);
  const findingCodes = new Set(findings.map(findingCode).filter(Boolean));
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

  if (options.requireDurableReleaseEvidence === true || options.require_durable_release_evidence === true) {
    issues.push(...validateFrontendAcceptanceDurableEvidence(artifact).issues);
  }

  return {
    status: issues.length ? "fail" : "pass",
    issues
  };
}

function workflowStateIdentityIssues(workflowState = {}) {
  const manifestRunId = normalizeString(workflowState?.manifest?.run_id);
  const manifestCycleId = normalizeString(workflowState?.manifest?.cycle_id);
  const ledger = workflowState?.artifact_ledger || workflowState?.artifactLedger || {};
  const ledgerRunId = normalizeString(ledger.run_id);
  const ledgerCycleId = normalizeString(ledger.cycle_id);
  const issues = [];

  if (!manifestRunId || !manifestCycleId) {
    issues.push(issue("missing_manifest_identity", "manifest run_id and cycle_id are required", "manifest"));
  }
  if (!ledgerRunId || !ledgerCycleId) {
    issues.push(issue("missing_artifact_ledger_identity", "artifact ledger run_id and cycle_id are required", "artifact_ledger"));
  }
  if (manifestRunId && ledgerRunId && manifestRunId !== ledgerRunId) {
    issues.push(issue("workflow_state_run_mismatch", "manifest run_id does not match artifact ledger run_id", "artifact_ledger.run_id"));
  }
  if (manifestCycleId && ledgerCycleId && manifestCycleId !== ledgerCycleId) {
    issues.push(issue("workflow_state_cycle_mismatch", "manifest cycle_id does not match artifact ledger cycle_id", "artifact_ledger.cycle_id"));
  }

  return issues;
}

function nextFactId(workflowState = {}, explicitId = "") {
  const runId = safeIdPart(workflowState?.manifest?.run_id);
  const cycleId = safeIdPart(workflowState?.manifest?.cycle_id);
  const prefix = explicitId || `frontend-acceptance-${runId}-${cycleId}`;
  const artifacts = workflowState?.artifact_ledger?.artifacts || workflowState?.artifactLedger?.artifacts || [];
  const events = workflowState?.manifest?.events || [];
  const usedIds = new Set([
    ...artifacts.map((item) => normalizeString(item?.id)).filter(Boolean),
    ...events.map((item) => normalizeString(item?.artifact_id)).filter(Boolean)
  ]);
  if (explicitId && !usedIds.has(explicitId)) return explicitId;

  let index = 1;
  let id = `${prefix}-${String(index).padStart(3, "0")}`;
  while (usedIds.has(id)) {
    index += 1;
    id = `${prefix}-${String(index).padStart(3, "0")}`;
  }
  return id;
}

export function recordFrontendAcceptanceRunArtifact(workflowState = {}, artifact = {}, options = {}) {
  if (!isObject(workflowState)) {
    return {
      status: "fail",
      issues: [issue("invalid_workflow_state", "workflow state must be an object", "workflow_state")]
    };
  }

  const validation = validateFrontendAcceptanceRunArtifact(artifact);
  const identityIssues = workflowStateIdentityIssues(workflowState);
  const issues = [...identityIssues, ...validation.issues];
  if (issues.length > 0) {
    return { status: "fail", issues };
  }

  const id = nextFactId(workflowState, normalizeString(options.artifact_id || options.artifactId || artifact.id));
  const createdAt = normalizeString(options.created_at || options.createdAt || artifact.created_at) || new Date().toISOString();
  const blockingFindings = asArray(artifact.findings).filter(isBlockingFrontendFinding);
  const fact = {
    ...artifact,
    id,
    type: "frontend_acceptance_run",
    created_at: createdAt,
    blocking_count: blockingFindings.length,
    blocking_findings: blockingFindings
  };
  const recordedArtifact = {
    id,
    type: "evaluation",
    status: fact.status,
    uri: `codex://frontend-acceptance/${encodeURIComponent(workflowState.manifest.run_id)}/${encodeURIComponent(workflowState.manifest.cycle_id)}/${encodeURIComponent(id)}`,
    producer: "frontend-acceptance-child-worker",
    created_at: createdAt,
    metadata: fact
  };
  const manifest = appendRunEvent(workflowState.manifest, {
    id: `event-${id}`,
    type: "frontend_acceptance_run",
    status: fact.status,
    artifact_id: id,
    message: `frontend acceptance ${fact.status}`,
    created_at: createdAt,
    metadata: fact
  });
  const manifestArtifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  const baseLedger = workflowState.artifact_ledger || workflowState.artifactLedger || {};
  const artifactLedger = recordArtifact({
    ...baseLedger,
    artifacts: Array.isArray(baseLedger.artifacts) ? baseLedger.artifacts : []
  }, recordedArtifact);

  return {
    status: "pass",
    fact,
    artifact: recordedArtifact,
    workflow_state: {
      ...workflowState,
      manifest: {
        ...manifest,
        artifacts: [...manifestArtifacts, recordedArtifact]
      },
      artifact_ledger: artifactLedger
    }
  };
}

function projectedFrontendAcceptanceOf(projection = {}) {
  return projection?.frontend_acceptance || projection?.frontendAcceptance || null;
}

function projectedRepairWorkPackageOf(projectedFrontendAcceptance = {}) {
  return projectedFrontendAcceptance?.repair_work_package || projectedFrontendAcceptance?.repairWorkPackage || null;
}

function hasRequiredRepairPackageShape(workPackage = {}) {
  const ownedFiles = asArray(workPackage.owned_files || workPackage.ownedFiles);
  const acceptanceGates = asArray(workPackage.acceptance_gates || workPackage.acceptanceGates);
  return workPackage.action === FRONTEND_ACCEPTANCE_REPAIR_ACTION &&
    FRONTEND_ACCEPTANCE_REPAIR_OWNED_FILES.every((ownedFile) => ownedFiles.includes(ownedFile)) &&
    FRONTEND_ACCEPTANCE_REPAIR_ACCEPTANCE_GATES.every((gate) => acceptanceGates.includes(gate));
}

function compareProjectedFrontendAcceptance(summary = {}, projected = {}, issues = []) {
  if (!isObject(projected)) {
    issues.push(issue("missing_frontend_acceptance_projection_summary", "workbench projection must expose frontend_acceptance summary", "durable_evidence.projection.frontend_acceptance"));
    return;
  }

  for (const field of ["status", "artifact_id", "blocking_count", "finding_count", "desktop_viewports", "mobile_viewports"]) {
    if (projected[field] !== summary[field]) {
      issues.push(issue("frontend_acceptance_projection_summary_mismatch", `projected frontend_acceptance.${field} must match recorded workflow summary`, `durable_evidence.projection.frontend_acceptance.${field}`));
    }
  }
  if (Boolean(projected.repair_required) !== Boolean(summary.repair_required)) {
    issues.push(issue("frontend_acceptance_projection_repair_mismatch", "projected repair_required must match recorded workflow summary", "durable_evidence.projection.frontend_acceptance.repair_required"));
  }
}

function validateFrontendRepairProjection(summary = {}, projection = {}, issues = []) {
  if (!summary.repair_required) return;

  const projectedFrontendAcceptance = projectedFrontendAcceptanceOf(projection) || {};
  const repairWorkPackage = projectedRepairWorkPackageOf(projectedFrontendAcceptance);
  if (!hasRequiredRepairPackageShape(repairWorkPackage)) {
    issues.push(issue("frontend_acceptance_repair_package_missing", "failed frontend acceptance must project a bounded repair_frontend_acceptance work package", "durable_evidence.projection.frontend_acceptance.repair_work_package"));
  }

  const nextActions = asArray(projection?.one_screen?.next_actions || projection?.oneScreen?.nextActions);
  if (!nextActions.some((action) => action?.action === FRONTEND_ACCEPTANCE_REPAIR_ACTION)) {
    issues.push(issue("frontend_acceptance_repair_next_action_missing", "failed frontend acceptance must expose repair_frontend_acceptance in projected next actions", "durable_evidence.projection.one_screen.next_actions"));
  }

  const readout = projection?.next_action_readout || projection?.nextActionReadout || {};
  if (readout.action !== FRONTEND_ACCEPTANCE_REPAIR_ACTION || readout.status !== "ready") {
    issues.push(issue("frontend_acceptance_repair_readout_missing", "failed frontend acceptance must make repair_frontend_acceptance the ready workbench readout action", "durable_evidence.projection.next_action_readout"));
  }
}

export function createFrontendAcceptanceDurableEvidence(recordedResult = {}, projection = {}) {
  if (recordedResult?.status !== "pass") {
    return {
      version: FRONTEND_ACCEPTANCE_DURABLE_EVIDENCE_VERSION,
      status: "fail",
      issues: asArray(recordedResult?.issues)
    };
  }

  const workflowState = recordedResult.workflow_state || recordedResult.workflowState || {};
  const summary = summarizeFrontendAcceptance(workflowState.manifest, workflowState.artifact_ledger || workflowState.artifactLedger);

  return {
    version: FRONTEND_ACCEPTANCE_DURABLE_EVIDENCE_VERSION,
    status: "pass",
    artifact_id: summary.artifact_id,
    event_id: summary.event_id,
    workflow_state: workflowState,
    artifact_ledger: workflowState.artifact_ledger || workflowState.artifactLedger || null,
    projection: {
      projection_version: projection.projection_version || null,
      frontend_acceptance: projection.frontend_acceptance || null,
      one_screen: projection.one_screen
        ? {
            counters: projection.one_screen.counters || {},
            next_actions: asArray(projection.one_screen.next_actions)
          }
        : null,
      next_action_readout: projection.next_action_readout || null
    },
    summary: {
      status: summary.status,
      artifact_id: summary.artifact_id,
      event_id: summary.event_id,
      blocking_count: summary.blocking_count,
      finding_count: summary.finding_count,
      desktop_viewports: summary.desktop_viewports,
      mobile_viewports: summary.mobile_viewports,
      repair_required: summary.repair_required,
      repair_work_package_id: summary.repair_work_package?.id || null
    }
  };
}

export function validateFrontendAcceptanceDurableEvidence(artifact = {}) {
  const issues = [];
  const evidence = artifact?.durable_evidence || artifact?.durableEvidence;
  if (!isObject(evidence)) {
    return {
      status: "fail",
      issues: [issue("missing_frontend_acceptance_durable_evidence", "frontend acceptance release evidence must include durable workflow/projection evidence", "durable_evidence")]
    };
  }
  if (evidence.version !== FRONTEND_ACCEPTANCE_DURABLE_EVIDENCE_VERSION) {
    issues.push(issue("invalid_frontend_acceptance_durable_evidence_version", `durable evidence version must be ${FRONTEND_ACCEPTANCE_DURABLE_EVIDENCE_VERSION}`, "durable_evidence.version"));
  }

  const workflowState = evidence.workflow_state || evidence.workflowState || {};
  const manifest = workflowState.manifest || {};
  const artifactLedger = workflowState.artifact_ledger || workflowState.artifactLedger || {};
  const identityIssues = workflowStateIdentityIssues(workflowState);
  issues.push(...identityIssues.map((item) => ({
    ...item,
    path: `durable_evidence.workflow_state.${item.path}`
  })));

  const artifactId = normalizeString(evidence.artifact_id || evidence.artifactId || evidence.summary?.artifact_id);
  const events = asArray(manifest.events).filter((event) => event?.type === "frontend_acceptance_run");
  const event = events.find((entry) => normalizeString(entry.artifact_id) === artifactId) || events.at(-1) || null;
  const ledgerArtifact = asArray(artifactLedger.artifacts).find((entry) => normalizeString(entry.id) === normalizeString(event?.artifact_id || artifactId)) || null;
  const manifestArtifact = asArray(manifest.artifacts).find((entry) => normalizeString(entry.id) === normalizeString(event?.artifact_id || artifactId)) || null;

  if (!event) {
    issues.push(issue("frontend_acceptance_manifest_event_missing", "workflow manifest must record a frontend_acceptance_run event", "durable_evidence.workflow_state.manifest.events"));
  }
  if (!ledgerArtifact) {
    issues.push(issue("frontend_acceptance_artifact_ledger_missing", "artifact ledger must record the frontend acceptance artifact", "durable_evidence.workflow_state.artifact_ledger.artifacts"));
  }
  if (!manifestArtifact) {
    issues.push(issue("frontend_acceptance_manifest_artifact_missing", "manifest artifacts must include the frontend acceptance artifact", "durable_evidence.workflow_state.manifest.artifacts"));
  }
  if (ledgerArtifact && ledgerArtifact.producer !== "frontend-acceptance-child-worker") {
    issues.push(issue("frontend_acceptance_artifact_producer_mismatch", "artifact ledger producer must be frontend-acceptance-child-worker", "durable_evidence.workflow_state.artifact_ledger.artifacts.producer"));
  }
  if (ledgerArtifact?.metadata?.version !== FRONTEND_ACCEPTANCE_RUN_VERSION) {
    issues.push(issue("frontend_acceptance_artifact_ledger_version_missing", "artifact ledger metadata must preserve frontend-acceptance-run.v1", "durable_evidence.workflow_state.artifact_ledger.artifacts.metadata.version"));
  }

  const summary = summarizeFrontendAcceptance(manifest, artifactLedger);
  const declaredBlockingCount = countValue(artifact.blocking_count, asArray(artifact.blocking_findings).length);
  if (summary.artifact_id !== normalizeString(event?.artifact_id || artifactId)) {
    issues.push(issue("frontend_acceptance_summary_artifact_mismatch", "recorded workflow summary must point at the recorded artifact id", "durable_evidence.summary.artifact_id"));
  }
  if (summary.status !== normalizeString(artifact.status)) {
    issues.push(issue("frontend_acceptance_summary_status_mismatch", "recorded workflow summary status must match the artifact status", "durable_evidence.summary.status"));
  }
  if (summary.blocking_count !== declaredBlockingCount) {
    issues.push(issue("frontend_acceptance_summary_blocking_mismatch", "recorded workflow summary blocking_count must match artifact blocking_count", "durable_evidence.summary.blocking_count"));
  }

  const projection = evidence.projection || {};
  if (projection.projection_version !== "workbench.v1") {
    issues.push(issue("frontend_acceptance_projection_version_missing", "durable evidence must include a workbench.v1 projection summary", "durable_evidence.projection.projection_version"));
  }
  const projectedFrontendAcceptance = projectedFrontendAcceptanceOf(projection);
  compareProjectedFrontendAcceptance(summary, projectedFrontendAcceptance, issues);
  if (projection?.one_screen?.counters?.frontend_acceptance_blockers !== summary.blocking_count) {
    issues.push(issue("frontend_acceptance_projection_counter_mismatch", "projection one_screen counters must expose frontend acceptance blocker count", "durable_evidence.projection.one_screen.counters.frontend_acceptance_blockers"));
  }
  validateFrontendRepairProjection(summary, projection, issues);

  return {
    status: issues.length ? "fail" : "pass",
    issues
  };
}

export function summarizeFrontendAcceptance(manifest = {}, artifactLedger = {}) {
  const events = asArray(manifest?.events).filter((event) => event?.type === "frontend_acceptance_run");
  const latestEvent = events.at(-1) || null;
  if (!latestEvent) {
    return {
      status: "not_configured",
      artifact_id: null,
      event_id: null,
      blocking_count: 0,
      finding_count: 0,
      latest_finding: null,
      desktop_viewports: 0,
      mobile_viewports: 0,
      repair_required: false,
      repair_work_package: null,
      created_at: null
    };
  }

  const artifacts = [
    ...asArray(artifactLedger?.artifacts),
    ...asArray(manifest?.artifacts)
  ];
  const artifact = artifacts.find((entry) => entry.id === latestEvent.artifact_id) || null;
  const metadata = artifact?.metadata || latestEvent.metadata || {};
  const findings = asArray(metadata.findings);
  const blockingFindings = asArray(metadata.blocking_findings).length > 0
    ? asArray(metadata.blocking_findings)
    : findings.filter(isBlockingFrontendFinding);
  const viewports = asArray(metadata.viewport_results);
  const findingCodes = blockingFindings.map(findingCode).filter(Boolean);

  const summary = {
    status: artifact?.status || latestEvent.status || metadata.status || "unknown",
    artifact_id: latestEvent.artifact_id || artifact?.id || null,
    event_id: latestEvent.id || null,
    blocking_count: Number(metadata.blocking_count ?? blockingFindings.length ?? 0),
    finding_count: findings.length,
    finding_codes: findingCodes,
    latest_finding: blockingFindings[0]?.message || findings[0]?.message || blockingFindings[0]?.code || findings[0]?.code || null,
    desktop_viewports: viewports.filter((result) => normalizeString(result.viewport).startsWith("desktop")).length,
    mobile_viewports: viewports.filter((result) => normalizeString(result.viewport) === "mobile").length,
    created_at: latestEvent.created_at || artifact?.created_at || metadata.created_at || null
  };
  const repairWorkPackage = createFrontendAcceptanceRepairWorkPackage({
    ...metadata,
    ...summary,
    blocking_findings: blockingFindings
  });

  return {
    ...summary,
    repair_required: Boolean(repairWorkPackage),
    repair_work_package: repairWorkPackage
  };
}
