import { recordArtifact } from "./artifact-ledger.js";
import { appendRunEvent } from "./run-manifest.js";

export const FRONTEND_ACCEPTANCE_RUN_VERSION = "frontend-acceptance-run.v1";
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

export function validateFrontendAcceptanceRunArtifact(artifact = {}) {
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
  for (const requiredViewport of ["desktop", "desktop_narrow", "mobile"]) {
    const viewportResult = viewportResultsByName.get(requiredViewport) || {};
    const resourceResult = resourceResultsByName.get(requiredViewport) || {};
    const contentResult = contentCompletionResultsByName.get(requiredViewport) || null;
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
  }

  const contentCompletionBlockerCodes = asArray(artifact.content_completion_results)
    .filter(contentCompletionHasBlocker)
    .flatMap(contentCompletionFindingCodes);
  const findingCodes = new Set(findings.map(findingCode).filter(Boolean));
  for (const code of contentCompletionBlockerCodes) {
    if (!findingCodes.has(code)) {
      issues.push(issue("frontend_content_completion_finding_mismatch", `content completion blocker ${code} must have a matching P0/P1 finding`, "findings"));
    }
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
