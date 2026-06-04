import {
  FRONTEND_ACCEPTANCE_DURABLE_EVIDENCE_VERSION,
  FRONTEND_ACCEPTANCE_REPAIR_ACCEPTANCE_GATES,
  FRONTEND_ACCEPTANCE_REPAIR_ACTION,
  FRONTEND_ACCEPTANCE_REPAIR_OWNED_FILES,
  FRONTEND_ACCEPTANCE_RUN_VERSION,
  asArray,
  countValue,
  isObject,
  issue,
  normalizeString,
  summarizeFrontendAcceptance,
  workflowStateIdentityIssues
} from "./frontend-acceptance-core.js";

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
