import { normalizeRequirementPlanWorkPackagesGranularity } from "./requirement-intake.js";
import { COMPLETE_SYNONYMS } from "./status-vocabulary.js";
import { buildTaskDag, getDispatchableNodes } from "./task-dag.js";

export const CONTEXT_WORK_PACKAGES_RUN_VERSION = "context-work-packages-run.v1";

// Dependency-satisfied dispatch uses the shared "work item complete" verdict so a
// dependency reported as ok/success/succeeded/done is recognized consistently with the
// scheduler (was a hand-typed copy of COMPLETE_SYNONYMS).
const DEPENDENCY_COMPLETE_STATUSES = new Set(COMPLETE_SYNONYMS);

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

export function safeIdPart(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

export function nextArtifactId(workflowState = {}, options = {}) {
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

export function runnableNodes(workflowState = {}, options = {}) {
  const taskDag = workflowState.task_dag || workflowState.taskDag || workflowState.manifest?.work_packages || [];
  const rawWorkPackages = asArray(workflowState?.manifest?.work_packages);
  const dag = buildTaskDag(taskDag);
  const dispatchable = getDispatchableNodes(dag);
  const selectedIds = new Set(asArray(options.selected_work_package_ids || options.selectedWorkPackageIds).map(normalizeString).filter(Boolean));
  const requirementId = normalizeString(options.requirement_id || options.requirementId);
  if (selectedIds.size > 0) {
    const nodes = asArray(dag.nodes).filter((node) => selectedIds.has(normalizeString(node.id)));
    return {
      dag,
      dispatchable,
      selected: nodes
    };
  }
  const rawById = new Map(
    rawWorkPackages
      .map((workPackage) => [normalizeString(workPackage?.id || workPackage?.work_package_id), workPackage])
      .filter(([id]) => id)
  );
  const nodeById = new Map(asArray(dag.nodes).map((node) => [normalizeString(node.id), node]));
  const recoverableFailed = asArray(dag.nodes).filter((node) => {
    const raw = rawById.get(normalizeString(node.id));
    const rawStatus = normalizeString(raw?.status || raw?.state || raw?.result || raw?.outcome).toLowerCase();
    if (!["failed", "fail", "error", "errored", "timeout", "timed_out"].includes(rawStatus)) return false;
    if (asArray(node.blocked_reasons).length > 0) return false;
    return asArray(node.depends_on).every((dependencyId) => {
      const dependency = rawById.get(dependencyId) || nodeById.get(dependencyId);
      const dependencyStatus = normalizeString(dependency?.status || dependency?.state || dependency?.result || dependency?.outcome).toLowerCase();
      return DEPENDENCY_COMPLETE_STATUSES.has(dependencyStatus);
    });
  });
  const runnable = recoverableFailed.length > 0 ? recoverableFailed : dispatchable;
  const requirementScopedRunnable = requirementId
    ? runnable.filter((node) => {
      const raw = rawById.get(normalizeString(node.id));
      return workPackageRequirementId(raw || node) === requirementId;
    })
    : runnable;
  const maxPackageCount = Number(options.max_package_count || options.maxPackageCount || runnable.length || 1);
  return {
    dag,
    dispatchable,
    selected: requirementScopedRunnable.slice(0, Math.max(1, maxPackageCount))
  };
}

export function workPackageId(workPackage = {}) {
  return normalizeString(workPackage.id || workPackage.work_package_id || workPackage.workPackageId);
}

export function workPackageRequirementId(workPackage = {}) {
  return normalizeString(
    workPackage.requirement_id ||
    workPackage.requirementId ||
    workPackage.source?.requirement_id ||
    workPackage.source?.requirementId
  );
}

export function sameWorkPackages(left = [], right = []) {
  if (left.length !== right.length) return false;
  return left.every((workPackage, index) => workPackageId(workPackage) === workPackageId(right[index]));
}

export function normalizeWorkflowStateWorkPackageGranularity(workflowState = {}) {
  const sourcePackages = asArray(workflowState.manifest?.work_packages).length > 0
    ? workflowState.manifest.work_packages
    : asArray(workflowState.task_dag || workflowState.taskDag);
  const normalizedPackages = normalizeRequirementPlanWorkPackagesGranularity(sourcePackages);

  if (sameWorkPackages(sourcePackages, normalizedPackages)) return workflowState;

  return {
    ...workflowState,
    manifest: {
      ...workflowState.manifest,
      work_packages: normalizedPackages
    },
    task_dag: normalizedPackages
  };
}

export function patchSelectedWorkPackages(workflowState = {}, selected = [], patcher) {
  const selectedIds = new Set(selected.map((node) => node.id));

  return asArray(workflowState?.manifest?.work_packages).map((workPackage) => {
    const id = normalizeString(workPackage?.id || workPackage?.work_package_id);
    if (!selectedIds.has(id)) return { ...workPackage };
    return patcher(workPackage, id);
  });
}

export function updateWorkPackages(workflowState = {}, selected = [], options = {}) {
  const status = normalizeString(options.status) || "completed";
  const completedAt = normalizeString(options.created_at || options.createdAt) || new Date().toISOString();

  return patchSelectedWorkPackages(workflowState, selected, (workPackage) => ({
    ...workPackage,
    status,
    result: "pass",
    completed_at: completedAt
  }));
}

export function syncProjectStatusWorkPackages(workflowState = {}, nextWorkPackages = []) {
  const projectStatus = workflowState.project_status || workflowState.projectStatus;
  if (!isObject(projectStatus)) return workflowState;
  const byId = new Map(
    asArray(nextWorkPackages)
      .map((workPackage) => [normalizeString(workPackage?.id || workPackage?.work_package_id), workPackage])
      .filter(([id]) => id)
  );
  const syncList = (value) => asArray(value).map((workPackage) => {
    const id = normalizeString(workPackage?.id || workPackage?.work_package_id || workPackage?.workPackageId);
    return byId.has(id) ? { ...workPackage, ...byId.get(id) } : { ...workPackage };
  });
  const nextProjectStatus = {
    ...projectStatus
  };
  if (Array.isArray(projectStatus.next_work_packages)) {
    nextProjectStatus.next_work_packages = syncList(projectStatus.next_work_packages);
  }
  if (Array.isArray(projectStatus.nextWorkPackages)) {
    nextProjectStatus.nextWorkPackages = syncList(projectStatus.nextWorkPackages);
  }
  return {
    ...workflowState,
    project_status: nextProjectStatus
  };
}

export function isLocalBoundedExecution(options = {}) {
  const executionMode = normalizeString(options.execution_mode || options.executionMode);
  const executionProfile = normalizeString(options.execution_profile || options.executionProfile);
  const executorKind = normalizeString(options.executor_kind || options.executorKind);
  return (!executionMode || executionMode === "local_bounded") &&
    (!executionProfile || executionProfile === "local_bounded") &&
    (!executorKind || executorKind === "local_bounded");
}

export function localBoundedCompletionIssues(selected = [], options = {}) {
  if (!isLocalBoundedExecution(options)) return [];
  const issues = [];
  if (!(options.allow_local_bounded_global_goal_completion === true ||
    options.allowLocalBoundedGlobalGoalCompletion === true)) {
    issues.push(...selected
    .filter((node) => normalizeString(node.action) === "continue_global_goal" && normalizeString(node.id).startsWith("global-goal-"))
    .map((node) => issue(
      "local_bounded_global_goal_completion_requires_child_authority",
      `local_bounded runner cannot complete broad global-goal work package without verified child-worker/provider completion authority: ${node.id}`,
      `manifest.work_packages.${node.id}`
    )));
  }
  if (!(options.allow_local_bounded_requirement_intake_completion === true ||
    options.allowLocalBoundedRequirementIntakeCompletion === true)) {
    issues.push(...selected
      .filter((node) => normalizeString(node.action) === "continue_requirement_intake")
      .map((node) => issue(
        "local_bounded_requirement_intake_requires_child_authority",
        `local_bounded runner cannot complete requirement-intake implementation work package without verified child-worker/provider completion authority: ${node.id}`,
        `manifest.work_packages.${node.id}`
      )));
  }
  return issues;
}


export function alreadySatisfiedEvaluatorFrom(options = {}) {
  return [
    options.already_satisfied_evaluator,
    options.alreadySatisfiedEvaluator,
    options.mainline_already_satisfied_evaluator,
    options.mainlineAlreadySatisfiedEvaluator
  ].find((candidate) => typeof candidate === "function") || null;
}

export function runArtifact(workflowState = {}, selected = [], options = {}) {
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
      execution_mode: normalizeString(options.execution_mode || options.executionMode) || "local_bounded",
      execution_profile: normalizeString(options.execution_profile || options.executionProfile) ||
        normalizeString(options.executor_kind || options.executorKind) ||
        "local_bounded",
      execution_cwd: normalizeString(options.execution_cwd || options.executionCwd || options.cwd),
      primary_worktree_path: normalizeString(options.primary_worktree_path || options.primaryWorktreePath),
      fixed_development_mode_gate: options.fixed_development_mode_gate || options.fixedDevelopmentModeGate || null,
      work_package_execution_governance: options.work_package_execution_governance ||
        options.workPackageExecutionGovernance ||
        null,
      executed_count: selected.length,
      executed_work_package_ids: selected.map((node) => node.id),
      executed_work_packages: selected.map((node) => ({
        id: node.id,
        title: node.title,
        owned_files: node.owned_files,
        action: node.action
      })),
      package_results: asArray(options.package_results || options.packageResults),
      executor_provenance: options.executor_provenance || options.executorProvenance || {
        executor_kind: "local_bounded",
        execution_profile: "local_bounded",
        external_calls: 0
      },
      completion_authority: options.completion_authority || options.completionAuthority || {
        allows_work_package_completion: true,
        authority: "local_bounded_runner",
        evidence_kind: "local_execution",
        reason: "default local bounded runner owns completion writes after fixed-development-mode gate"
      },
      model_routing: options.model_routing || options.modelRouting || null
    }
  };
}

