import { recordArtifact } from "./artifact-ledger.js";
import { recordAgentLifecycleFact } from "./agent-lifecycle-pool.js";
import {
  executeContextWorkPackagesWithAdapter,
  isProviderModelRoutedExecutionRequested
} from "./context-work-package-execution-adapter.js";
import { evaluateFixedDevelopmentModeGate } from "./fixed-development-mode-gate.js";
import { normalizeRequirementPlanWorkPackagesGranularity } from "./requirement-intake.js";
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
      fixed_development_mode_gate: options.fixed_development_mode_gate || options.fixedDevelopmentModeGate || null,
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

  const createdAt = normalizeString(options.created_at || options.createdAt) || new Date().toISOString();
  let executedNodes = selected;
  let executionOptions = {
    ...options,
    created_at: createdAt,
    fixed_development_mode_gate: fixedDevelopmentModeGate
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
      created_at: createdAt
    });

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
  let workflow_state = {
    ...workflowState,
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
