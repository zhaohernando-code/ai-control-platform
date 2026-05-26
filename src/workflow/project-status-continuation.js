import { decideContinuation } from "./autonomous-continuation.js";
import { recordArtifact } from "./artifact-ledger.js";
import { appendRunEvent } from "./run-manifest.js";

export const PROJECT_STATUS_CONTINUATION_VERSION = "project-status-continuation.v1";

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

function safeIdPart(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function nextArtifactId(workflowState = {}, options = {}) {
  const explicit = normalizeString(options.artifact_id || options.artifactId);
  if (explicit) return explicit;

  const prefix = `project-status-continuation-${safeIdPart(workflowState?.manifest?.run_id)}-${safeIdPart(workflowState?.manifest?.cycle_id)}`;
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

function normalizeProjectStatus(projectStatus = {}) {
  return {
    project: normalizeString(projectStatus.project),
    status: normalizeString(projectStatus.status),
    current_phase: projectStatus.current_phase || null,
    current_milestone: projectStatus.current_milestone || null,
    updated_at: normalizeString(projectStatus.updated_at),
    blockers: asArray(projectStatus.blockers),
    next_step: normalizeString(projectStatus.next_step),
    next_work_packages: asArray(projectStatus.next_work_packages || projectStatus.nextWorkPackages),
    global_goals: asArray(projectStatus.global_goals),
    requirement_intake: isObject(projectStatus.requirement_intake) ? projectStatus.requirement_intake : null,
    plan_reviews: isObject(projectStatus.plan_reviews) ? projectStatus.plan_reviews : {},
    linked_docs: asArray(projectStatus.linked_docs)
  };
}

function validateProjectStatus(projectStatus = {}) {
  const issues = [];
  if (!isObject(projectStatus)) {
    return {
      status: "fail",
      issues: [issue("invalid_project_status", "project status must be an object", "project_status")]
    };
  }
  if (projectStatus.project !== "ai-control-platform") {
    issues.push(issue("project_status_mismatch", "PROJECT_STATUS must target ai-control-platform", "project"));
  }
  if (!normalizeString(projectStatus.next_step) && asArray(projectStatus.global_goals).length === 0) {
    issues.push(issue("missing_continuation_source", "PROJECT_STATUS must contain next_step or global_goals", "next_step"));
  }
  return {
    status: issues.length ? "fail" : "pass",
    issues
  };
}

export function createContinuationInputFromProjectStatus(projectStatus = {}, options = {}) {
  const normalizedStatus = normalizeProjectStatus(projectStatus);
  const runEvaluation = options.run_evaluation || options.runEvaluation || {
    status: "pass",
    decision: "pass",
    source: "PROJECT_STATUS.json",
    next_work_packages: []
  };

  return {
    project_status: normalizedStatus,
    run_evaluation: runEvaluation,
    workflow_state: options.workflow_state || options.workflowState || null
  };
}

export function prepareContinuationFromProjectStatus(projectStatus = {}, options = {}) {
  const validation = validateProjectStatus(projectStatus);
  if (validation.status !== "pass") {
    return {
      status: "blocked",
      phase: "project_status_continuation",
      should_continue: false,
      issues: validation.issues,
      continuation_input: null,
      decision: null
    };
  }

  const continuationInput = createContinuationInputFromProjectStatus(projectStatus, options);
  const decision = decideContinuation(continuationInput);

  return {
    status: decision.action === "complete" ? "complete" : (decision.should_continue ? "ready" : "blocked"),
    phase: "project_status_continuation",
    should_continue: decision.should_continue,
    issues: decision.validation?.issues || [],
    continuation_input: continuationInput,
    decision,
    global_goal_completion: decision.global_goal_completion
  };
}

export function recordProjectStatusContinuationPrepared(workflowState = {}, prepared = {}, options = {}) {
  if (!isObject(workflowState)) {
    return {
      status: "fail",
      issues: [issue("invalid_workflow_state", "workflow state must be an object", "workflow_state")]
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

  const id = nextArtifactId(workflowState, options);
  const createdAt = normalizeString(options.created_at || options.createdAt) || new Date().toISOString();
  const decision = prepared?.decision || null;
  const nextWorkPackages = asArray(decision?.next_work_packages);
  const issues = asArray(prepared?.issues);
  const ready = prepared?.status === "ready";
  const artifact = {
    id,
    type: "evaluation",
    status: ready ? "pass" : "fail",
    uri: `project-status://continuation/${encodeURIComponent(runId)}/${encodeURIComponent(cycleId)}/${encodeURIComponent(id)}`,
    producer: "project-status-continuation",
    created_at: createdAt,
    metadata: {
      version: PROJECT_STATUS_CONTINUATION_VERSION,
      type: "project_status_continuation",
      status: prepared?.status || "blocked",
      phase: prepared?.phase || "project_status_continuation",
      run_id: runId,
      cycle_id: cycleId,
      project: prepared?.continuation_input?.project_status?.project || null,
      project_status_updated_at: prepared?.continuation_input?.project_status?.updated_at || null,
      next_step: prepared?.continuation_input?.project_status?.next_step || null,
      should_continue: prepared?.should_continue ?? null,
      global_goal_completion: prepared?.global_goal_completion || null,
      next_goal: prepared?.global_goal_completion?.next_goal || null,
      next_work_package_count: nextWorkPackages.length,
      next_work_packages: nextWorkPackages.map((workPackage) => ({
        id: workPackage.id || null,
        title: workPackage.title || null,
        action: workPackage.action || null,
        global_goal_id: workPackage.global_goal_id || null
      })),
      context_pack_seed: decision?.context_pack_seed || null,
      issues
    }
  };
  const eventStatus = ready ? "ready" : (prepared?.status || "blocked");
  const manifest = appendRunEvent(workflowState.manifest, {
    id: `event-${id}`,
    type: "project_status_continuation",
    status: eventStatus,
    artifact_id: id,
    message: ready
      ? "project status continuation prepared from repository global goals"
      : "project status continuation blocked",
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
      manifest: {
        ...manifest,
        artifacts: [...asArray(manifest.artifacts), artifact]
      },
      artifact_ledger: artifactLedger
    }
  };
}
