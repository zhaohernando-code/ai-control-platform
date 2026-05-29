import { createArtifactLedger, recordArtifact } from "./artifact-ledger.js";
import { assertContextPackReady } from "./context-pack.js";
import { appendRunEvent, createRunManifest, validateRunManifest } from "./run-manifest.js";
import { WORK_ITEM_COMPLETE_SYNONYMS } from "./status-vocabulary.js";

export const CONTEXT_PACK_CYCLE_VERSION = "context-pack-cycle.v1";

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

function latestProjectStatusContinuation(workflowState = {}) {
  const events = asArray(workflowState?.manifest?.events);
  const event = events.filter((entry) => entry?.type === "project_status_continuation").at(-1) || null;
  if (!event) return null;

  const artifacts = [
    ...asArray(workflowState?.manifest?.artifacts),
    ...asArray(workflowState?.artifact_ledger?.artifacts || workflowState?.artifactLedger?.artifacts)
  ];
  const artifact = artifacts.find((entry) => entry?.id === event.artifact_id) || null;
  return {
    event,
    artifact,
    metadata: artifact?.metadata || event.metadata || {}
  };
}

function nextCycleId(workflowState = {}, options = {}) {
  return normalizeString(options.cycle_id || options.cycleId) ||
    `${safeIdPart(workflowState?.manifest?.cycle_id)}-context-pack-${Date.now()}`;
}

function artifactId(runId, cycleId, options = {}) {
  return normalizeString(options.artifact_id || options.artifactId) ||
    `context-pack-cycle-${safeIdPart(runId)}-${safeIdPart(cycleId)}-001`;
}

function contextPackArtifact(runId, cycleId, contextPack, options = {}) {
  const id = artifactId(runId, cycleId, options);
  const createdAt = normalizeString(options.created_at || options.createdAt) || new Date().toISOString();
  return {
    id,
    type: "context_pack",
    status: "pass",
    uri: `context-pack://cycle/${encodeURIComponent(runId)}/${encodeURIComponent(cycleId)}/${encodeURIComponent(id)}`,
    producer: "context-pack-cycle",
    created_at: createdAt,
    metadata: {
      version: CONTEXT_PACK_CYCLE_VERSION,
      type: "context_pack_cycle",
      status: "ready",
      run_id: runId,
      cycle_id: cycleId,
      source_event_id: normalizeString(options.source_event_id || options.sourceEventId) || null,
      source_artifact_id: normalizeString(options.source_artifact_id || options.sourceArtifactId) || null,
      context_pack: contextPack,
      work_package_count: asArray(contextPack?.subtasks).length
    }
  };
}

function completedGlobalGoalIdsFrom(workflowState = {}) {
  return new Set([
    ...asArray(workflowState?.manifest?.work_packages),
    ...asArray(workflowState?.task_dag || workflowState?.taskDag)
  ]
    .filter((workPackage) => WORK_ITEM_COMPLETE_SYNONYMS.includes(normalizeString(workPackage?.status || workPackage?.result).toLowerCase()))
    .map((workPackage) => normalizeString(workPackage?.global_goal_id || workPackage?.globalGoalId))
    .filter(Boolean));
}

function openRequirementGoalIdsFromProjectStatus(projectStatus = {}) {
  const planReviews = isObject(projectStatus?.plan_reviews) ? projectStatus.plan_reviews : {};
  // Requirement-item terminality: work-item-complete plus "shipped". Derived from the
  // shared set so the pass/done core stays in sync (was a hand-typed list).
  const completeStatuses = new Set([...WORK_ITEM_COMPLETE_SYNONYMS, "shipped"]);
  return new Set(asArray(projectStatus?.requirement_intake?.items)
    .filter((item) => {
      const id = normalizeString(item?.id);
      if (!id) return false;
      const itemStatus = normalizeString(item?.status || "submitted").toLowerCase();
      const reviewPhase = normalizeString(planReviews[id]?.phase || planReviews[id]?.status).toLowerCase();
      return !completeStatuses.has(itemStatus) && !completeStatuses.has(reviewPhase);
    })
    .map((item) => normalizeString(item.id)));
}

function projectStatusWithCompletedGlobalGoals(sourceWorkflowState = {}) {
  const projectStatus = sourceWorkflowState.project_status || sourceWorkflowState.projectStatus || null;
  if (!isObject(projectStatus)) return null;

  const completedIds = completedGlobalGoalIdsFrom(sourceWorkflowState);
  if (completedIds.size === 0) return projectStatus;

  return {
    ...projectStatus,
    global_goals: asArray(projectStatus.global_goals || projectStatus.globalGoals).map((goal) => {
      const id = normalizeString(goal?.id || goal?.goal_id || goal?.key);
      if (openRequirementGoalIdsFromProjectStatus(projectStatus).has(id)) return goal;
      if (!completedIds.has(id)) return goal;
      return {
        ...goal,
        status: "completed",
        completed: true
      };
    })
  };
}

function buildNextWorkflowState(sourceWorkflowState = {}, contextPack, options = {}) {
  const runId = normalizeString(options.run_id || options.runId || sourceWorkflowState?.manifest?.run_id);
  const cycleId = nextCycleId(sourceWorkflowState, options);
  const artifact = contextPackArtifact(runId, cycleId, contextPack, options);
  const projectStatus = projectStatusWithCompletedGlobalGoals(sourceWorkflowState);
  const sourceGlobalGoals = asArray(sourceWorkflowState.global_goals || sourceWorkflowState.globalGoals);
  const manifest = createRunManifest({
    run_id: runId,
    cycle_id: cycleId,
    goal: contextPack.requirement_summary,
    context_pack: contextPack,
    events: [
      {
        id: `event-${artifact.id}`,
        type: "context_pack_cycle_created",
        status: "ready",
        artifact_id: artifact.id,
        created_at: artifact.created_at,
        metadata: artifact.metadata
      }
    ],
    artifacts: [artifact],
    gate_results: [],
    review_findings: [],
    recovery_attempts: [],
    created_at: artifact.created_at
  });
  const ledger = createArtifactLedger({
    run_id: runId,
    cycle_id: cycleId,
    artifacts: [artifact],
    created_at: artifact.created_at
  });
  const projectStatusGoals = asArray(projectStatus?.global_goals || projectStatus?.globalGoals);

  return {
    ...sourceWorkflowState,
    project_status: projectStatus,
    global_goals: projectStatusGoals.length > 0 ? projectStatusGoals : sourceGlobalGoals,
    manifest,
    artifact_ledger: ledger,
    task_dag: manifest.work_packages,
    operator_event_ledger: {
      version: "operator-events.v1",
      events: [
        {
          id: `operator-context-pack-cycle-${safeIdPart(runId)}-${safeIdPart(cycleId)}`,
          action: "context_pack_cycle_created",
          run_id: runId,
          cycle_id: cycleId,
          created_at: artifact.created_at,
          metadata: {
            projection_id: cycleId,
            source_event_id: normalizeString(options.source_event_id || options.sourceEventId) || null,
            artifact_type: "context_pack"
          }
        }
      ]
    }
  };
}

function recordSourceMaterialization(sourceWorkflowState = {}, materialized = {}, options = {}) {
  const runId = normalizeString(sourceWorkflowState?.manifest?.run_id);
  const cycleId = normalizeString(sourceWorkflowState?.manifest?.cycle_id);
  const createdAt = normalizeString(options.created_at || options.createdAt) || new Date().toISOString();
  const id = normalizeString(options.source_artifact_id || options.sourceArtifactId) ||
    `context-pack-cycle-materialized-${safeIdPart(runId)}-${safeIdPart(cycleId)}-001`;
  const artifact = {
    id,
    type: "evaluation",
    status: "pass",
    uri: `context-pack://materialized/${encodeURIComponent(runId)}/${encodeURIComponent(cycleId)}/${encodeURIComponent(id)}`,
    producer: "context-pack-cycle",
    created_at: createdAt,
    metadata: {
      version: CONTEXT_PACK_CYCLE_VERSION,
      type: "context_pack_cycle_materialized",
      status: "ready",
      run_id: runId,
      cycle_id: cycleId,
      next_run_id: materialized.workflow_state?.manifest?.run_id || null,
      next_cycle_id: materialized.workflow_state?.manifest?.cycle_id || null,
      next_work_package_count: asArray(materialized.workflow_state?.manifest?.work_packages).length,
      source_event_id: materialized.source?.event?.id || null,
      source_artifact_id: materialized.source?.event?.artifact_id || null
    }
  };
  const manifest = appendRunEvent(sourceWorkflowState.manifest, {
    id: `event-${id}`,
    type: "context_pack_cycle_materialized",
    status: "ready",
    artifact_id: id,
    message: "context pack seed materialized into the next workflow cycle",
    created_at: createdAt,
    metadata: artifact.metadata
  });
  const baseLedger = sourceWorkflowState.artifact_ledger || sourceWorkflowState.artifactLedger || {};
  const artifactLedger = recordArtifact({
    ...baseLedger,
    artifacts: Array.isArray(baseLedger.artifacts) ? baseLedger.artifacts : []
  }, artifact);

  return {
    status: "pass",
    artifact,
    workflow_state: {
      ...sourceWorkflowState,
      manifest: {
        ...manifest,
        artifacts: [...asArray(manifest.artifacts), artifact]
      },
      artifact_ledger: artifactLedger
    }
  };
}

export function materializeContextPackCycleFromWorkflowState(workflowState = {}, options = {}) {
  if (!isObject(workflowState)) {
    return {
      status: "blocked",
      issues: [issue("invalid_workflow_state", "workflow state must be an object", "workflow_state")]
    };
  }

  const source = latestProjectStatusContinuation(workflowState);
  if (!source) {
    return {
      status: "blocked",
      issues: [issue("missing_project_status_continuation", "project_status_continuation fact is required", "manifest.events")]
    };
  }

  const contextPack = source.metadata?.context_pack_seed;
  if (!isObject(contextPack)) {
    return {
      status: "blocked",
      source,
      issues: [issue("missing_context_pack_seed", "project_status_continuation must contain context_pack_seed", "project_status_continuation.context_pack_seed")]
    };
  }

  let ready;
  try {
    ready = assertContextPackReady(contextPack);
  } catch (error) {
    return {
      status: "blocked",
      source,
      issues: [
        ...asArray(error.validation?.issues),
        ...asArray(error.work_packages)
          .filter((workPackage) => !workPackage.dispatch_allowed)
          .map((workPackage) => issue("context_work_package_blocked", `${workPackage.id} is not dispatchable`, `work_packages.${workPackage.id}`))
      ]
    };
  }

  const nextWorkflowState = buildNextWorkflowState(workflowState, contextPack, {
    ...options,
    source_event_id: source.event.id,
    source_artifact_id: source.event.artifact_id
  });
  const manifestValidation = validateRunManifest(nextWorkflowState.manifest);
  if (manifestValidation.status !== "pass") {
    return {
      status: "blocked",
      source,
      context_pack: contextPack,
      issues: manifestValidation.issues
    };
  }

  const materialized = {
    status: "ready",
    phase: "context_pack_cycle",
    source,
    context_pack: contextPack,
    work_packages: ready.work_packages,
    workflow_state: nextWorkflowState,
    issues: []
  };
  const sourceRecord = recordSourceMaterialization(workflowState, materialized, options);

  return {
    ...materialized,
    source_record: sourceRecord
  };
}
