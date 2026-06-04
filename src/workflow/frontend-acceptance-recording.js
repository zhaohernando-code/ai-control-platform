import { recordArtifact } from "./artifact-ledger.js";
import { appendRunEvent } from "./run-manifest.js";
import {
  asArray,
  isBlockingFrontendFinding,
  isObject,
  issue,
  normalizeString,
  safeIdPart,
  workflowStateIdentityIssues
} from "./frontend-acceptance-core.js";
import { validateFrontendAcceptanceRunArtifact } from "./frontend-acceptance-validation.js";

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
