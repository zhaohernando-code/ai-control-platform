import { recordArtifact } from "./artifact-ledger.js";
import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { recordAgentLifecycleFact } from "./agent-lifecycle-pool.js";
import {
  executeContextWorkPackagesWithAdapter,
  isProviderModelRoutedExecutionRequested
} from "./context-work-package-execution-adapter.js";
import { evaluateFixedDevelopmentModeGate } from "./fixed-development-mode-gate.js";
import { normalizeRequirementPlanWorkPackagesGranularity } from "./requirement-intake.js";
import { appendRunEvent, validateRunManifest } from "./run-manifest.js";
import { buildTaskDag, getDispatchableNodes } from "./task-dag.js";
import { evaluateWorkPackageExecutionGovernance } from "./work-package-execution-governance.js";

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

function normalizePath(value) {
  const text = normalizeString(value);
  return text ? resolve(text) : "";
}

function isSameOrInsidePath(candidatePath, rootPath) {
  const candidate = normalizePath(candidatePath);
  const root = normalizePath(rootPath);
  if (!candidate || !root) return false;
  const pathToCandidate = relative(root, candidate);
  return pathToCandidate === "" || Boolean(pathToCandidate && !pathToCandidate.startsWith("..") && !isAbsolute(pathToCandidate));
}

function gitPorcelain(cwd = "", options = {}) {
  if (typeof options.gitStatusProvider === "function") {
    return normalizeString(options.gitStatusProvider({ cwd }));
  }
  if (typeof options.git_status_provider === "function") {
    return normalizeString(options.git_status_provider({ cwd }));
  }
  const root = normalizePath(cwd || process.cwd());
  const result = spawnSync("git", ["-C", root, "status", "--short", "--untracked-files=all"], {
    encoding: "utf8",
    timeout: 10000
  });
  if (result.status !== 0) return "";
  return normalizeString(result.stdout);
}

function workPackageRequiresCodeOutput(workPackage = {}) {
  const action = normalizeString(workPackage.action || workPackage.type).toLowerCase();
  const title = normalizeString(workPackage.title || workPackage.reason).toLowerCase();
  if (action === "execute_requirement_plan_step") return true;
  if (/implement|implementation|repair|fix|code|generate|write|modify|refactor/.test(action)) return true;
  if (/实施|修复|代码|生成|修改|重构|实现/.test(title)) return true;
  return false;
}

function isWorkerWorktree(cwd = "", options = {}) {
  const executionCwd = normalizePath(cwd);
  const primary = normalizePath(
    options.primary_worktree_path ||
    options.primaryWorktreePath ||
    process.env.AI_CONTROL_PLATFORM_PRIMARY_WORKTREE ||
    "/Users/hernando_zhao/codex/projects/ai-control-platform"
  );
  if (!executionCwd) return false;
  if (executionCwd.split(/[\\/]+/).includes("worker-workspaces")) return true;
  return primary && !isSameOrInsidePath(executionCwd, primary);
}

function executionCwdFromOptions(options = {}) {
  return normalizePath(options.execution_cwd || options.executionCwd || options.cwd || process.cwd());
}

function workspaceMutationBlocked(beforePorcelain, afterPorcelain) {
  return normalizeString(beforePorcelain) !== normalizeString(afterPorcelain);
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
  const rawWorkPackages = asArray(workflowState?.manifest?.work_packages);
  const dag = buildTaskDag(taskDag);
  const dispatchable = getDispatchableNodes(dag);
  const selectedIds = new Set(asArray(options.selected_work_package_ids || options.selectedWorkPackageIds).map(normalizeString).filter(Boolean));
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
      return ["done", "completed", "complete", "pass", "passed", "ok", "success", "succeeded"].includes(dependencyStatus);
    });
  });
  const runnable = recoverableFailed.length > 0 ? recoverableFailed : dispatchable;
  const maxPackageCount = Number(options.max_package_count || options.maxPackageCount || runnable.length || 1);
  return {
    dag,
    dispatchable,
    selected: runnable.slice(0, Math.max(1, maxPackageCount))
  };
}

function workPackageId(workPackage = {}) {
  return normalizeString(workPackage.id || workPackage.work_package_id || workPackage.workPackageId);
}

function sameWorkPackages(left = [], right = []) {
  if (left.length !== right.length) return false;
  return left.every((workPackage, index) => workPackageId(workPackage) === workPackageId(right[index]));
}

function normalizeWorkflowStateWorkPackageGranularity(workflowState = {}) {
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

function patchSelectedWorkPackages(workflowState = {}, selected = [], patcher) {
  const selectedIds = new Set(selected.map((node) => node.id));

  return asArray(workflowState?.manifest?.work_packages).map((workPackage) => {
    const id = normalizeString(workPackage?.id || workPackage?.work_package_id);
    if (!selectedIds.has(id)) return { ...workPackage };
    return patcher(workPackage, id);
  });
}

function updateWorkPackages(workflowState = {}, selected = [], options = {}) {
  const status = normalizeString(options.status) || "completed";
  const completedAt = normalizeString(options.created_at || options.createdAt) || new Date().toISOString();

  return patchSelectedWorkPackages(workflowState, selected, (workPackage) => ({
    ...workPackage,
    status,
    result: "pass",
    completed_at: completedAt
  }));
}

function syncProjectStatusWorkPackages(workflowState = {}, nextWorkPackages = []) {
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

function isLocalBoundedExecution(options = {}) {
  const executionMode = normalizeString(options.execution_mode || options.executionMode);
  const executionProfile = normalizeString(options.execution_profile || options.executionProfile);
  const executorKind = normalizeString(options.executor_kind || options.executorKind);
  return (!executionMode || executionMode === "local_bounded") &&
    (!executionProfile || executionProfile === "local_bounded") &&
    (!executorKind || executorKind === "local_bounded");
}

function localBoundedCompletionIssues(selected = [], options = {}) {
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

export function adapterResultAllowsWorkPackageCompletion(adapterResult = {}) {
  return adapterResult?.allows_work_package_completion === true ||
    adapterResult?.completion_authority?.allows_work_package_completion === true;
}

export function packageResultAllowsWorkPackageCompletion(packageResult = {}, adapterResult = {}) {
  if (!adapterResultAllowsWorkPackageCompletion(adapterResult)) return false;
  return normalizeString(packageResult?.status).toLowerCase() === "pass" &&
    (
      packageResult?.allows_work_package_completion === true ||
      packageResult?.completion_authority?.allows_work_package_completion === true
    );
}

export function completionAuthorizedExecutionNodes(selected = [], packageResults = [], adapterResult = {}) {
  const authorizedIds = new Set(
    asArray(packageResults)
      .filter((result) => packageResultAllowsWorkPackageCompletion(result, adapterResult))
      .map((result) => normalizeString(result?.work_package_id || result?.id))
      .filter(Boolean)
  );
  return selected.filter((node) => authorizedIds.has(node.id));
}

function alreadySatisfiedEvaluatorFrom(options = {}) {
  return [
    options.already_satisfied_evaluator,
    options.alreadySatisfiedEvaluator,
    options.mainline_already_satisfied_evaluator,
    options.mainlineAlreadySatisfiedEvaluator
  ].find((candidate) => typeof candidate === "function") || null;
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

function retryAgentWorkerId(node = {}) {
  return normalizeString(
    node.source?.retry_worker?.worker_id ||
      node.source?.retryWorker?.worker_id ||
      node.source?.worker_id ||
      node.source?.workerId ||
      node.id
  );
}

function retryAgentPoolId(node = {}) {
  return normalizeString(
    node.source?.retry_worker?.pool_id ||
      node.source?.retryWorker?.pool_id ||
      node.source?.pool_id ||
      node.source?.poolId
  ) || "default";
}

function contextWorkerId(node = {}, index = 0) {
  return `child-${safeIdPart(node.id || node.work_package_id || index + 1)}`;
}

function contextWorkerPoolId(workflowState = {}, options = {}) {
  return normalizeString(options.pool_id || options.poolId) ||
    `context-work-package-${safeIdPart(workflowState?.manifest?.run_id)}-${safeIdPart(workflowState?.manifest?.cycle_id)}`;
}

function nonRetryAgentFactsForNode(workflowState = {}, node = {}, index = 0, createdAt, options = {}) {
  if (normalizeString(node.action) === "retry_agent_worker") return [];
  const workerId = contextWorkerId(node, index);
  const poolId = contextWorkerPoolId(workflowState, options);
  const baseSource = {
    action: normalizeString(node.action) || "run_context_work_package",
    work_package_id: node.id,
    owned_files: asArray(node.owned_files),
    executor_kind: normalizeString(options.executor_kind || options.executorKind) || "local_bounded",
    execution_mode: normalizeString(options.execution_mode || options.executionMode) || "local_bounded",
    execution_profile: normalizeString(options.execution_profile || options.executionProfile) ||
      normalizeString(options.executor_kind || options.executorKind) ||
      "local_bounded"
  };

  return [
    {
      event_type: "WorkerSpawned",
      pool_id: poolId,
      worker_id: workerId,
      status: "pass",
      message: `${workerId} spawned for context work package ${node.id}`,
      created_at: createdAt,
      source: baseSource
    },
    {
      event_type: "WorkerHeartbeat",
      pool_id: poolId,
      worker_id: workerId,
      status: "pass",
      message: `${workerId} heartbeat recorded before bounded execution`,
      created_at: createdAt,
      source: baseSource
    },
    {
      event_type: "WorkerCompleted",
      pool_id: poolId,
      worker_id: workerId,
      status: "pass",
      message: `${workerId} completed context work package ${node.id}`,
      created_at: createdAt,
      source: baseSource
    },
    {
      event_type: "WorkerEvaluation",
      pool_id: poolId,
      worker_id: workerId,
      status: "pass",
      message: `${workerId} evaluation recorded as pass`,
      created_at: createdAt,
      source: baseSource
    },
    {
      event_type: "WorkerClosed",
      pool_id: poolId,
      worker_id: workerId,
      status: "pass",
      message: `${workerId} closed after evaluation`,
      created_at: createdAt,
      source: baseSource
    },
    {
      event_type: "PoolIterationClosed",
      pool_id: poolId,
      status: "pass",
      message: `agent lifecycle pool ${poolId} iteration closed after ${workerId}`,
      created_at: createdAt,
      source: baseSource
    }
  ];
}

function retryAgentFactsForNode(node = {}, createdAt) {
  if (normalizeString(node.action) !== "retry_agent_worker") return [];
  const workerId = retryAgentWorkerId(node);
  const poolId = retryAgentPoolId(node);
  if (!workerId) return [];
  const retryWorkerId = `${workerId}-retry`;
  const baseSource = {
    action: "retry_agent_worker",
    work_package_id: node.id,
    original_worker_id: workerId,
    retry_worker: node.source?.retry_worker || null,
    timed_out_workers: asArray(node.source?.timed_out_workers)
  };

  return [
    {
      event_type: "WorkerSpawned",
      pool_id: poolId,
      worker_id: retryWorkerId,
      status: "pass",
      message: `${retryWorkerId} spawned as retry for timed-out worker ${workerId}`,
      created_at: createdAt,
      source: baseSource
    },
    {
      event_type: "WorkerHeartbeat",
      pool_id: poolId,
      worker_id: retryWorkerId,
      status: "pass",
      message: `${retryWorkerId} retry heartbeat recorded by scheduler`,
      created_at: createdAt,
      source: baseSource
    },
    {
      event_type: "WorkerCompleted",
      pool_id: poolId,
      worker_id: retryWorkerId,
      status: "pass",
      message: `${retryWorkerId} retry completed after bounded execution`,
      created_at: createdAt,
      source: baseSource
    },
    {
      event_type: "WorkerEvaluation",
      pool_id: poolId,
      worker_id: retryWorkerId,
      status: "pass",
      message: `${retryWorkerId} retry evaluation recorded as pass`,
      created_at: createdAt,
      source: baseSource
    },
    {
      event_type: "WorkerClosed",
      pool_id: poolId,
      worker_id: retryWorkerId,
      status: "pass",
      message: `${retryWorkerId} retry closed after evaluation`,
      created_at: createdAt,
      source: baseSource
    },
    {
      event_type: "PoolIterationClosed",
      pool_id: poolId,
      status: "pass",
      message: `agent lifecycle pool ${poolId} iteration closed after ${retryWorkerId} retry`,
      created_at: createdAt,
      source: baseSource
    }
  ];
}

function recordExecutedWorkPackageLifecycleFacts(workflowState = {}, selected = [], createdAt, options = {}) {
  let nextState = workflowState;
  const facts = [];
  const retryAgentWorkerFacts = [];

  for (const [index, node] of selected.entries()) {
    const factInputs = normalizeString(node.action) === "retry_agent_worker"
      ? retryAgentFactsForNode(node, createdAt)
      : nonRetryAgentFactsForNode(workflowState, node, index, createdAt, options);
    for (const factInput of factInputs) {
      const result = recordAgentLifecycleFact(nextState, factInput);
      if (result.status !== "pass") {
        return {
          status: "fail",
          issues: result.issues || [],
          facts,
          retry_agent_worker_facts: retryAgentWorkerFacts,
          workflow_state: nextState
        };
      }
      nextState = result.workflow_state;
      facts.push(result.fact);
      if (normalizeString(node.action) === "retry_agent_worker") retryAgentWorkerFacts.push(result.fact);
    }
  }
  return {
    status: "pass",
    facts,
    retry_agent_worker_facts: retryAgentWorkerFacts,
    workflow_state: nextState
  };
}

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
    const fixedDevelopmentModeGate = evaluateFixedDevelopmentModeGate({
      manifest: workflowState.manifest,
      selected_work_packages: asArray(workflowState.manifest?.work_packages)
    });
    if (fixedDevelopmentModeGate.status !== "pass") {
      return {
        status: "blocked",
        phase: "fixed_development_mode_gate",
        gate_result: fixedDevelopmentModeGate,
        issues: [
          ...fixedDevelopmentModeGate.issues,
          ...manifestValidation.issues
        ],
        dispatchable_count: 0,
        selected_work_package_ids: asArray(workflowState.manifest?.work_packages)
          .map((node) => normalizeString(node?.id))
          .filter(Boolean)
      };
    }
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
      work_package_execution_governance: executionGovernanceGate,
      allows_work_package_completion: false,
      completion_authority: {
        allows_work_package_completion: false,
        authority: "work_package_execution_governance",
        evidence_kind: "pre_dispatch_gate",
        reason: "selected work packages must be concrete and verifiable before child/provider execution"
      }
    };
  }

  const executionCwd = executionCwdFromOptions(options);
  const requiresCodeOutput = selected.some(workPackageRequiresCodeOutput);
  if (requiresCodeOutput && !isWorkerWorktree(executionCwd, options)) {
    return {
      status: "blocked",
      phase: "execution_worktree_isolation",
      issues: [
        issue(
          "code_output_requires_isolated_worktree",
          "code-output context work packages must execute in an isolated worker worktree, not the primary platform worktree",
          "execution_cwd"
        )
      ],
      dispatchable_count: dispatchable.length,
      selected_work_package_ids: selected.map((node) => node.id),
      fixed_development_mode_gate: fixedDevelopmentModeGate,
      work_package_execution_governance: executionGovernanceGate,
      execution_cwd: executionCwd,
      allows_work_package_completion: false,
      completion_authority: {
        allows_work_package_completion: false,
        authority: "worktree_isolation",
        evidence_kind: "pre_dispatch_gate",
        reason: "implementation work packages require isolated worker worktree execution"
      }
    };
  }
  const workspacePorcelainBefore = requiresCodeOutput || options.skip_workspace_mutation_check === true
    ? null
    : gitPorcelain(executionCwd, options);

  const createdAt = normalizeString(options.created_at || options.createdAt) || new Date().toISOString();
  let executedNodes = selected;
  let executionOptions = {
    ...options,
    created_at: createdAt,
    fixed_development_mode_gate: fixedDevelopmentModeGate,
    work_package_execution_governance: executionGovernanceGate
  };
  let eventMessage = "context work packages executed by bounded local runner";
  const alreadySatisfiedEvaluator = alreadySatisfiedEvaluatorFrom(options);

  if (alreadySatisfiedEvaluator) {
    const alreadySatisfiedResult = alreadySatisfiedEvaluator({
      workflow_state: normalizedWorkflowState,
      selected_work_packages: selected,
      options: {
        ...options,
        created_at: createdAt
      }
    });
    if (alreadySatisfiedResult?.status === "fail" || alreadySatisfiedResult?.status === "blocked") {
      return {
        status: "blocked",
        phase: alreadySatisfiedResult.phase || "already_satisfied_preflight",
        issues: alreadySatisfiedResult.issues || [],
        dispatchable_count: dispatchable.length,
        selected_work_package_ids: selected.map((node) => node.id),
        fixed_development_mode_gate: fixedDevelopmentModeGate,
        package_results: alreadySatisfiedResult.package_results || [],
        executor_provenance: alreadySatisfiedResult.executor_provenance || null,
        allows_work_package_completion: false,
        completion_authority: alreadySatisfiedResult.completion_authority || null
      };
    }
    if (alreadySatisfiedResult?.status === "pass") {
      if (!adapterResultAllowsWorkPackageCompletion(alreadySatisfiedResult)) {
        return {
          status: "blocked",
          phase: alreadySatisfiedResult.phase || "already_satisfied_preflight",
          issues: asArray(alreadySatisfiedResult.issues).length > 0
            ? alreadySatisfiedResult.issues
            : [
              issue(
                "already_satisfied_preflight_lacks_completion_authority",
                "already-satisfied preflight cannot complete work packages without explicit completion authority",
                "completion_authority"
              )
            ],
          dispatchable_count: dispatchable.length,
          selected_work_package_ids: selected.map((node) => node.id),
          fixed_development_mode_gate: fixedDevelopmentModeGate,
          package_results: alreadySatisfiedResult.package_results || [],
          executor_provenance: alreadySatisfiedResult.executor_provenance || null,
          allows_work_package_completion: false,
          completion_authority: alreadySatisfiedResult.completion_authority || null
        };
      }
      executedNodes = completionAuthorizedExecutionNodes(selected, alreadySatisfiedResult.package_results, alreadySatisfiedResult);
      if (executedNodes.length === 0) {
        return {
          status: "blocked",
          phase: alreadySatisfiedResult.phase || "already_satisfied_preflight",
          issues: [
            issue(
              "already_satisfied_preflight_no_authorized_packages",
              "already-satisfied preflight returned no pass package results with completion authority",
              "package_results"
            )
          ],
          dispatchable_count: dispatchable.length,
          selected_work_package_ids: selected.map((node) => node.id),
          fixed_development_mode_gate: fixedDevelopmentModeGate,
          package_results: alreadySatisfiedResult.package_results || [],
          executor_provenance: alreadySatisfiedResult.executor_provenance || null,
          allows_work_package_completion: true,
          completion_authority: alreadySatisfiedResult.completion_authority || null
        };
      }
      executionOptions = {
        ...executionOptions,
        executor_kind: alreadySatisfiedResult.executor_provenance?.executor_kind,
        execution_mode: alreadySatisfiedResult.executor_provenance?.execution_mode,
        execution_profile: alreadySatisfiedResult.executor_provenance?.execution_profile,
        package_results: alreadySatisfiedResult.package_results,
        executor_provenance: alreadySatisfiedResult.executor_provenance,
        completion_authority: alreadySatisfiedResult.completion_authority,
        model_routing: alreadySatisfiedResult.execution_plan?.model_routing || null
      };
      eventMessage = "context work packages accepted as already satisfied by mainline evidence";
    }
  }

  if (executedNodes.length === selected.length && eventMessage === "context work packages accepted as already satisfied by mainline evidence") {
    // Skip provider/model execution: completion authority came from the deterministic mainline preflight.
  } else if (isProviderModelRoutedExecutionRequested(options)) {
    const adapterExecutor = typeof options.adapter_executor === "function"
      ? options.adapter_executor
      : typeof options.adapterExecutor === "function"
        ? options.adapterExecutor
        : executeContextWorkPackagesWithAdapter;
    const adapterResult = adapterExecutor(normalizedWorkflowState, selected, {
      ...options,
      created_at: createdAt,
      execution_cwd: executionCwd
    });
    const workspacePorcelainAfter = requiresCodeOutput || options.skip_workspace_mutation_check === true
      ? null
      : gitPorcelain(executionCwd, options);
    if (workspaceMutationBlocked(workspacePorcelainBefore, workspacePorcelainAfter)) {
      return {
        status: "blocked",
        phase: "workspace_mutation_guard",
        issues: [
          issue(
            "unexpected_workspace_mutation",
            "no-code context work package execution changed the git worktree",
            "git.status"
          )
        ],
        dispatchable_count: dispatchable.length,
        selected_work_package_ids: selected.map((node) => node.id),
        fixed_development_mode_gate: fixedDevelopmentModeGate,
        execution_plan: adapterResult.execution_plan,
        package_results: adapterResult.package_results,
        executor_provenance: adapterResult.executor_provenance || null,
        workspace_mutation: {
          before: workspacePorcelainBefore,
          after: workspacePorcelainAfter
        },
        allows_work_package_completion: false,
        completion_authority: {
          allows_work_package_completion: false,
          authority: "workspace_mutation_guard",
          evidence_kind: "unexpected_workspace_mutation",
          reason: "no-code execution cannot complete after mutating the worktree"
        }
      };
    }

    if (adapterResult.status === "fail" || adapterResult.status === "blocked") {
      return {
        status: "blocked",
        phase: "provider_model_routed_execution",
        issues: adapterResult.issues,
        dispatchable_count: dispatchable.length,
        selected_work_package_ids: selected.map((node) => node.id),
        fixed_development_mode_gate: fixedDevelopmentModeGate,
        execution_plan: adapterResult.execution_plan,
        package_results: adapterResult.package_results,
        executor_provenance: adapterResult.executor_provenance || null,
        allows_work_package_completion: false,
        completion_authority: adapterResult.completion_authority || null
      };
    }

    if (adapterResult.status !== "pass") {
      return {
        status: adapterResult.status || "blocked",
        phase: adapterResult.phase || "provider_model_routed_execution",
        issues: asArray(adapterResult.issues).length > 0
          ? adapterResult.issues
          : [
            issue(
              "adapter_result_not_completed",
              "adapter result must be status=pass before it can complete work packages",
              "status"
            )
          ],
        dispatchable_count: dispatchable.length,
        selected_work_package_ids: selected.map((node) => node.id),
        fixed_development_mode_gate: fixedDevelopmentModeGate,
        execution_plan: adapterResult.execution_plan,
        package_results: adapterResult.package_results,
        executor_provenance: adapterResult.executor_provenance || null,
        allows_work_package_completion: false,
        completion_authority: adapterResult.completion_authority || null
      };
    }

    if (!adapterResultAllowsWorkPackageCompletion(adapterResult)) {
      return {
        status: "blocked",
        phase: adapterResult.phase || "provider_model_routed_execution",
        issues: asArray(adapterResult.issues).length > 0
          ? adapterResult.issues
          : [
            issue(
              "adapter_lacks_completion_authority",
              "adapter result cannot complete work packages without completion authority",
              "completion_authority"
            )
          ],
        dispatchable_count: dispatchable.length,
        selected_work_package_ids: selected.map((node) => node.id),
        fixed_development_mode_gate: fixedDevelopmentModeGate,
        execution_plan: adapterResult.execution_plan,
        package_results: adapterResult.package_results,
        executor_provenance: adapterResult.executor_provenance || null,
        allows_work_package_completion: false,
        completion_authority: adapterResult.completion_authority || null
      };
    }

    executedNodes = completionAuthorizedExecutionNodes(selected, adapterResult.package_results, adapterResult);
    if (executedNodes.length === 0) {
      return {
        status: "blocked",
        phase: "provider_model_routed_execution",
        issues: [
          issue(
            "no_completion_authorized_package_results",
            "adapter did not return any pass package results with completion authority",
            "package_results"
          )
        ],
        dispatchable_count: dispatchable.length,
        selected_work_package_ids: selected.map((node) => node.id),
        fixed_development_mode_gate: fixedDevelopmentModeGate,
        execution_plan: adapterResult.execution_plan,
        package_results: adapterResult.package_results,
        executor_provenance: adapterResult.executor_provenance || null,
        allows_work_package_completion: true,
        completion_authority: adapterResult.completion_authority || null
      };
    }

    executionOptions = {
      ...executionOptions,
      executor_kind: adapterResult.executor_provenance?.executor_kind,
      execution_mode: adapterResult.executor_provenance?.execution_mode,
      execution_profile: adapterResult.executor_provenance?.execution_profile,
      package_results: adapterResult.package_results,
      executor_provenance: adapterResult.executor_provenance,
      completion_authority: adapterResult.completion_authority,
      model_routing: adapterResult.execution_plan?.model_routing
    };
    eventMessage = "context work packages executed by provider/model-routed adapter";
  } else {
    const localCompletionIssues = localBoundedCompletionIssues(selected, executionOptions);
    if (localCompletionIssues.length > 0) {
      return {
        status: "blocked",
        phase: "local_bounded_completion_authority",
        issues: localCompletionIssues,
        dispatchable_count: dispatchable.length,
        selected_work_package_ids: selected.map((node) => node.id),
        fixed_development_mode_gate: fixedDevelopmentModeGate,
        allows_work_package_completion: false,
        completion_authority: {
          allows_work_package_completion: false,
          authority: "local_bounded_runner",
          evidence_kind: "local_execution",
          reason: "implementation work packages require verified child-worker/provider completion authority"
        }
      };
    }
  }

  const artifact = runArtifact(normalizedWorkflowState, executedNodes, executionOptions);
  const nextWorkPackages = updateWorkPackages(normalizedWorkflowState, executedNodes, { ...options, created_at: createdAt });
  const manifestWithPackages = {
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
  };
  const manifest = appendRunEvent(manifestWithPackages, {
    id: `event-${artifact.id}`,
    type: "context_work_packages_run",
    status: "pass",
    artifact_id: artifact.id,
    message: eventMessage,
    created_at: createdAt,
    metadata: artifact.metadata
  });
  const baseLedger = workflowState.artifact_ledger || workflowState.artifactLedger || {};
  const artifactLedger = recordArtifact({
    ...baseLedger,
    artifacts: Array.isArray(baseLedger.artifacts) ? baseLedger.artifacts : []
  }, artifact);
  const syncedWorkflowState = syncProjectStatusWorkPackages(workflowState, nextWorkPackages);
  let workflow_state = {
    ...syncedWorkflowState,
    manifest: {
      ...manifest,
      artifacts: [...asArray(manifest.artifacts), artifact]
    },
    artifact_ledger: artifactLedger,
    task_dag: nextWorkPackages
  };
  const lifecycleFactResult = recordExecutedWorkPackageLifecycleFacts(workflow_state, executedNodes, createdAt, executionOptions);
  if (lifecycleFactResult.status !== "pass") {
    return {
      status: "blocked",
      phase: "agent_lifecycle_fact_recording",
      issues: lifecycleFactResult.issues,
      dispatchable_count: dispatchable.length,
      selected_work_package_ids: selected.map((node) => node.id),
      workflow_state: lifecycleFactResult.workflow_state
    };
  }
  workflow_state = lifecycleFactResult.workflow_state;

  return {
    status: "pass",
    phase: "context_work_packages_run",
    artifact,
    agent_lifecycle_facts: lifecycleFactResult.facts,
    retry_agent_worker_facts: lifecycleFactResult.retry_agent_worker_facts,
    executed_work_packages: artifact.metadata.executed_work_packages,
    executed_count: artifact.metadata.executed_count,
    remaining_dispatchable_count: getDispatchableNodes(buildTaskDag(nextWorkPackages)).length,
    workflow_state,
    issues: []
  };
}
