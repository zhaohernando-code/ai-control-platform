import { evaluateFixedDevelopmentModeGate } from "./fixed-development-mode-gate.js";
import { appendRunEvent, validateRunManifest } from "./run-manifest.js";
import { evaluateWorkPackageExecutionGovernance } from "./work-package-execution-governance.js";
import {
  asArray,
  isObject,
  issue,
  normalizeString,
  normalizeWorkflowStateWorkPackageGranularity,
  patchSelectedWorkPackages,
  runnableNodes,
  safeIdPart,
  syncProjectStatusWorkPackages
} from "./context-work-package-runner-shared.js";

export function stageContextWorkPackageDispatch(workflowState = {}, options = {}) {
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

  const normalizedWorkflowState = normalizeWorkflowStateWorkPackageGranularity(workflowState);
  const { dag, dispatchable, selected } = runnableNodes(normalizedWorkflowState, options);
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
    manifest: normalizedWorkflowState.manifest,
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

  const executionGovernanceGate = evaluateWorkPackageExecutionGovernance({
    workflow_state: normalizedWorkflowState,
    selected_work_packages: selected
  });
  if (executionGovernanceGate.status !== "pass") {
    return {
      status: "blocked",
      phase: "work_package_execution_governance",
      gate_result: executionGovernanceGate,
      issues: executionGovernanceGate.issues,
      dispatchable_count: dispatchable.length,
      selected_work_package_ids: selected.map((node) => node.id),
      fixed_development_mode_gate: fixedDevelopmentModeGate,
      work_package_execution_governance: executionGovernanceGate
    };
  }

  const createdAt = normalizeString(options.created_at || options.createdAt) || new Date().toISOString();
  const dispatchRunId = normalizeString(options.dispatch_run_id || options.dispatchRunId) ||
    `context-work-package-dispatch-${safeIdPart(normalizedWorkflowState?.manifest?.run_id)}-${safeIdPart(normalizedWorkflowState?.manifest?.cycle_id)}-${Date.parse(createdAt) || Date.now()}`;
  const nextWorkPackages = patchSelectedWorkPackages(normalizedWorkflowState, selected, (workPackage) => ({
    ...workPackage,
    status: "running",
    result: "dispatch_started",
    dispatch_run_id: dispatchRunId,
    dispatch_started_at: createdAt,
    executor_kind: normalizeString(options.executor_kind || options.executorKind) || workPackage.executor_kind || null,
    execution_mode: normalizeString(options.execution_mode || options.executionMode) || workPackage.execution_mode || null,
    execution_profile: normalizeString(options.execution_profile || options.executionProfile) || workPackage.execution_profile || null
  }));
  const manifest = appendRunEvent({
    ...normalizedWorkflowState.manifest,
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
  }, {
    id: `event-${dispatchRunId}`,
    type: "context_work_packages_dispatch_started",
    status: "running",
    message: "context work packages dispatched to background provider runner",
    created_at: createdAt,
    metadata: {
      dispatch_run_id: dispatchRunId,
      selected_work_package_ids: selected.map((node) => node.id),
      executor_kind: normalizeString(options.executor_kind || options.executorKind) || null,
      execution_mode: normalizeString(options.execution_mode || options.executionMode) || null,
      execution_profile: normalizeString(options.execution_profile || options.executionProfile) || null
    }
  });

  const syncedWorkflowState = syncProjectStatusWorkPackages(workflowState, nextWorkPackages);

  return {
    status: "pass",
    phase: "context_work_packages_dispatch_started",
    dispatch_run_id: dispatchRunId,
    selected_work_package_ids: selected.map((node) => node.id),
    selected_work_packages: selected,
    dispatchable_count: dispatchable.length,
    workflow_state: {
      ...syncedWorkflowState,
      manifest,
      task_dag: nextWorkPackages
    },
    fixed_development_mode_gate: fixedDevelopmentModeGate,
    work_package_execution_governance: executionGovernanceGate,
    issues: []
  };
}

export function markContextWorkPackageDispatchFailed(workflowState = {}, options = {}) {
  const selectedIds = new Set(asArray(options.selected_work_package_ids || options.selectedWorkPackageIds).map(normalizeString).filter(Boolean));
  if (selectedIds.size === 0) {
    return {
      status: "fail",
      phase: "input",
      issues: [issue("missing_selected_work_package_ids", "selected work package ids are required", "selected_work_package_ids")]
    };
  }
  const createdAt = normalizeString(options.created_at || options.createdAt) || new Date().toISOString();
  const dispatchRunId = normalizeString(options.dispatch_run_id || options.dispatchRunId);
  const selected = asArray(workflowState?.manifest?.work_packages)
    .filter((workPackage) => selectedIds.has(normalizeString(workPackage?.id || workPackage?.work_package_id)))
    .map((workPackage) => ({ ...workPackage, id: normalizeString(workPackage.id || workPackage.work_package_id) }));
  const nextWorkPackages = patchSelectedWorkPackages(workflowState, selected, (workPackage) => ({
    ...workPackage,
    status: "failed",
    result: "dispatch_failed",
    dispatch_failed_at: createdAt,
    dispatch_run_id: dispatchRunId || workPackage.dispatch_run_id || null,
    failure_issues: asArray(options.issues).slice(0, 12),
    dispatch_artifact: options.dispatch_artifact || options.dispatchArtifact || workPackage.dispatch_artifact || null,
    dispatch_package_results: asArray(options.package_results || options.packageResults).slice(0, 12),
    dispatch_executor_provenance: options.executor_provenance || options.executorProvenance || null
  }));
  const manifest = appendRunEvent({
    ...workflowState.manifest,
    work_packages: nextWorkPackages
  }, {
    id: `event-${dispatchRunId || `context-work-package-dispatch-failed-${Date.parse(createdAt) || Date.now()}`}`,
    type: "context_work_packages_dispatch_failed",
    status: "failed",
    message: "context work package background provider runner failed",
    created_at: createdAt,
    metadata: {
      dispatch_run_id: dispatchRunId || null,
      selected_work_package_ids: [...selectedIds],
      issues: asArray(options.issues).slice(0, 12),
      dispatch_artifact: options.dispatch_artifact || options.dispatchArtifact || null,
      package_results: asArray(options.package_results || options.packageResults).slice(0, 12),
      executor_provenance: options.executor_provenance || options.executorProvenance || null
    }
  });

  const syncedWorkflowState = syncProjectStatusWorkPackages(workflowState, nextWorkPackages);

  return {
    status: "pass",
    phase: "context_work_packages_dispatch_failed",
    workflow_state: {
      ...syncedWorkflowState,
      manifest,
      task_dag: nextWorkPackages
    },
    issues: []
  };
}

