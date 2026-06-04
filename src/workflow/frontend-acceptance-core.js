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

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function normalizeString(value) {
  return String(value || "").trim();
}

export function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function issue(code, message, path) {
  return { code, message, path };
}

export function countValue(value, fallback = 0) {
  const count = Number(value);
  return Number.isFinite(count) ? count : fallback;
}

export function safeIdPart(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

export function severityOf(finding = {}) {
  return normalizeString(finding.severity || finding.level || "p1").toLowerCase();
}

export function statusOf(finding = {}) {
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

export function findingCode(finding = {}) {
  return normalizeString(finding.code || finding.id || finding.finding_id || finding.findingId);
}

export function numericCount(value, fallback = 0) {
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

export function workflowStateIdentityIssues(workflowState = {}) {
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
