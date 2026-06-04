import { recordArtifact } from "./artifact-ledger.js";
import { appendRunEvent } from "./run-manifest.js";
import {
  WORKBENCH_REQUIREMENT_INTAKE_VERSION,
  asArray,
  isObject,
  issue,
  normalizeString,
  safeIdPart,
  uniqueStrings
} from "./requirement-intake-core.js";

function nextArtifactId(workflowState = {}, requirementId = "") {
  const prefix = `requirement-intake-${safeIdPart(workflowState?.manifest?.run_id)}-${safeIdPart(workflowState?.manifest?.cycle_id)}-${safeIdPart(requirementId)}`;
  const used = new Set([
    ...asArray(workflowState?.manifest?.events).map((event) => normalizeString(event?.artifact_id)).filter(Boolean),
    ...asArray(workflowState?.artifact_ledger?.artifacts || workflowState?.artifactLedger?.artifacts)
      .map((artifact) => normalizeString(artifact?.id))
      .filter(Boolean)
  ]);
  let index = 1;
  let id = `${prefix}-${String(index).padStart(3, "0")}`;
  while (used.has(id)) {
    index += 1;
    id = `${prefix}-${String(index).padStart(3, "0")}`;
  }
  return id;
}

export function recordRequirementIntakeSubmitted(workflowState = {}, submission = {}, options = {}) {
  if (!isObject(workflowState)) {
    return {
      status: "fail",
      issues: [issue("invalid_workflow_state", "workflow state must be an object", "workflow_state")]
    };
  }
  if (!isObject(submission?.project_status) || !isObject(submission?.requirement)) {
    return {
      status: "fail",
      issues: [issue("invalid_requirement_submission_result", "submission must include project_status and requirement", "submission")]
    };
  }

  const runId = normalizeString(workflowState?.manifest?.run_id);
  const cycleId = normalizeString(workflowState?.manifest?.cycle_id);
  if (!runId || !cycleId) {
    return {
      status: "fail",
      issues: [issue("missing_workflow_identity", "workflow state manifest run_id and cycle_id are required", "workflow_state.manifest")]
    };
  }

  const requirement = submission.requirement;
  const createdAt = normalizeString(options.created_at || options.createdAt || requirement.submitted_at) || new Date().toISOString();
  const artifactId = nextArtifactId(workflowState, requirement.id);
  const nextWorkPackages = asArray(submission.project_status.next_work_packages);
  const artifact = {
    id: artifactId,
    type: "evaluation",
    status: "pass",
    producer: "workbench-requirement-intake",
    uri: `requirement-intake://${encodeURIComponent(runId)}/${encodeURIComponent(cycleId)}/${encodeURIComponent(requirement.id)}`,
    created_at: createdAt,
    metadata: {
      version: WORKBENCH_REQUIREMENT_INTAKE_VERSION,
      type: "requirement_intake_submitted",
      status: "ready",
      run_id: runId,
      cycle_id: cycleId,
      requirement,
      next_step: submission.project_status.next_step || null,
      global_goal_id: requirement.id,
      next_work_package_count: nextWorkPackages.length,
      next_work_packages: nextWorkPackages.map((workPackage) => ({
        id: workPackage.id || null,
        title: workPackage.title || null,
        action: workPackage.action || null,
        global_goal_id: workPackage.global_goal_id || null,
        owned_files: uniqueStrings(workPackage.owned_files || workPackage.ownedFiles),
        acceptance_gates: uniqueStrings(workPackage.acceptance_gates || workPackage.acceptanceGates)
      }))
    }
  };
  const manifest = appendRunEvent(workflowState.manifest, {
    id: `event-${artifactId}`,
    type: "requirement_intake_submitted",
    status: "ready",
    artifact_id: artifactId,
    message: `workbench requirement submitted: ${requirement.title}`,
    created_at: createdAt,
    metadata: artifact.metadata
  });
  const baseLedger = workflowState.artifact_ledger || workflowState.artifactLedger || {};
  const artifactLedger = recordArtifact({
    ...baseLedger,
    artifacts: Array.isArray(baseLedger.artifacts) ? baseLedger.artifacts : []
  }, artifact);

  return {
    status: "pass",
    artifact,
    fact: artifact.metadata,
    workflow_state: {
      ...workflowState,
      project_status: submission.project_status,
      global_goals: asArray(submission.project_status.global_goals),
      manifest: {
        ...manifest,
        artifacts: [...asArray(manifest.artifacts), artifact]
      },
      artifact_ledger: artifactLedger
    }
  };
}
