import { recordArtifact } from "./artifact-ledger.js";
import { evaluateFixedDevelopmentModeGate } from "./fixed-development-mode-gate.js";
import { appendRunEvent, validateRunManifest } from "./run-manifest.js";
import { buildTaskDag, getDispatchableNodes } from "./task-dag.js";

export const CONTEXT_WORK_PACKAGES_RUN_VERSION = "context-work-packages-run.v1";

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

  const prefix = `context-work-packages-run-${safeIdPart(workflowState?.manifest?.run_id)}-${safeIdPart(workflowState?.manifest?.cycle_id)}`;
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

function runnableNodes(workflowState = {}, options = {}) {
  const taskDag = workflowState.task_dag || workflowState.taskDag || workflowState.manifest?.work_packages || [];
  const dag = buildTaskDag(taskDag);
  const dispatchable = getDispatchableNodes(dag);
  const maxPackageCount = Number(options.max_package_count || options.maxPackageCount || dispatchable.length || 1);
  return {
    dag,
    dispatchable,
    selected: dispatchable.slice(0, Math.max(1, maxPackageCount))
  };
}

function updateWorkPackages(workflowState = {}, selected = [], options = {}) {
  const selectedIds = new Set(selected.map((node) => node.id));
  const status = normalizeString(options.status) || "completed";

  return asArray(workflowState?.manifest?.work_packages).map((workPackage) => {
    const id = normalizeString(workPackage?.id || workPackage?.work_package_id);
    if (!selectedIds.has(id)) return { ...workPackage };
    return {
      ...workPackage,
      status,
      result: "pass",
      completed_at: normalizeString(options.created_at || options.createdAt) || new Date().toISOString()
    };
  });
}

function runArtifact(workflowState = {}, selected = [], options = {}) {
  const runId = normalizeString(workflowState?.manifest?.run_id);
  const cycleId = normalizeString(workflowState?.manifest?.cycle_id);
  const createdAt = normalizeString(options.created_at || options.createdAt) || new Date().toISOString();
  const id = nextArtifactId(workflowState, options);

  return {
    id,
    type: "evaluation",
    status: "pass",
    uri: `context-work-packages://run/${encodeURIComponent(runId)}/${encodeURIComponent(cycleId)}/${encodeURIComponent(id)}`,
    producer: "context-work-package-runner",
    created_at: createdAt,
    metadata: {
      version: CONTEXT_WORK_PACKAGES_RUN_VERSION,
      type: "context_work_packages_run",
      status: "pass",
      run_id: runId,
      cycle_id: cycleId,
      executor_kind: normalizeString(options.executor_kind || options.executorKind) || "local_bounded",
      fixed_development_mode_gate: options.fixed_development_mode_gate || options.fixedDevelopmentModeGate || null,
      executed_count: selected.length,
      executed_work_package_ids: selected.map((node) => node.id),
      executed_work_packages: selected.map((node) => ({
        id: node.id,
        title: node.title,
        owned_files: node.owned_files,
        action: node.action
      }))
    }
  };
}

export function runContextWorkPackages(workflowState = {}, options = {}) {
  if (!isObject(workflowState)) {
    return {
      status: "fail",
      phase: "input",
      issues: [issue("invalid_workflow_state", "workflow state must be an object", "workflow_state")]
    };
  }

  const manifestValidation = validateRunManifest(workflowState.manifest);
  if (manifestValidation.status !== "pass") {
    return {
      status: "fail",
      phase: "manifest_validation",
      issues: manifestValidation.issues
    };
  }

  const { dag, dispatchable, selected } = runnableNodes(workflowState, options);
  if (dag.status !== "pass") {
    return {
      status: "fail",
      phase: "task_dag_validation",
      issues: dag.issues || []
    };
  }

  if (selected.length === 0) {
    return {
      status: "blocked",
      phase: "no_dispatchable_work_packages",
      issues: [issue("no_dispatchable_work_packages", "no dispatchable context work packages are available", "task_dag")],
      dispatchable_count: dispatchable.length
    };
  }

  const fixedDevelopmentModeGate = evaluateFixedDevelopmentModeGate({
    manifest: workflowState.manifest,
    selected_work_packages: selected
  });
  if (fixedDevelopmentModeGate.status !== "pass") {
    return {
      status: "blocked",
      phase: "fixed_development_mode_gate",
      gate_result: fixedDevelopmentModeGate,
      issues: fixedDevelopmentModeGate.issues,
      dispatchable_count: dispatchable.length,
      selected_work_package_ids: selected.map((node) => node.id)
    };
  }

  const createdAt = normalizeString(options.created_at || options.createdAt) || new Date().toISOString();
  const artifact = runArtifact(workflowState, selected, {
    ...options,
    created_at: createdAt,
    fixed_development_mode_gate: fixedDevelopmentModeGate
  });
  const nextWorkPackages = updateWorkPackages(workflowState, selected, { ...options, created_at: createdAt });
  const manifestWithPackages = {
    ...workflowState.manifest,
    work_packages: nextWorkPackages,
    gate_results: [
      ...asArray(workflowState.manifest?.gate_results),
      {
        gate_id: fixedDevelopmentModeGate.gate_id,
        status: fixedDevelopmentModeGate.status,
        checked_work_package_count: fixedDevelopmentModeGate.checked_work_package_count,
        checked_work_package_ids: fixedDevelopmentModeGate.checked_work_package_ids,
        created_at: createdAt
      }
    ]
  };
  const manifest = appendRunEvent(manifestWithPackages, {
    id: `event-${artifact.id}`,
    type: "context_work_packages_run",
    status: "pass",
    artifact_id: artifact.id,
    message: "context work packages executed by bounded local runner",
    created_at: createdAt,
    metadata: artifact.metadata
  });
  const baseLedger = workflowState.artifact_ledger || workflowState.artifactLedger || {};
  const artifactLedger = recordArtifact({
    ...baseLedger,
    artifacts: Array.isArray(baseLedger.artifacts) ? baseLedger.artifacts : []
  }, artifact);
  const workflow_state = {
    ...workflowState,
    manifest: {
      ...manifest,
      artifacts: [...asArray(manifest.artifacts), artifact]
    },
    artifact_ledger: artifactLedger,
    task_dag: nextWorkPackages
  };

  return {
    status: "pass",
    phase: "context_work_packages_run",
    artifact,
    executed_work_packages: artifact.metadata.executed_work_packages,
    executed_count: selected.length,
    remaining_dispatchable_count: getDispatchableNodes(buildTaskDag(nextWorkPackages)).length,
    workflow_state,
    issues: []
  };
}
