import { recordArtifact } from "./artifact-ledger.js";
import {
  executeContextWorkPackagesWithAdapter,
  isProviderModelRoutedExecutionRequested
} from "./context-work-package-execution-adapter.js";
import {
  evaluateContextExecutionScope,
  evaluateContextWorkspaceMutation
} from "./context-work-package-execution-scope.js";
import { evaluateFixedDevelopmentModeGate } from "./fixed-development-mode-gate.js";
import { appendRunEvent, validateRunManifest } from "./run-manifest.js";
import { buildTaskDag, getDispatchableNodes } from "./task-dag.js";
import { evaluateWorkPackageExecutionGovernance } from "./work-package-execution-governance.js";
import {
  adapterResultAllowsWorkPackageCompletion,
  completionAuthorizedExecutionNodes
} from "./context-work-package-runner-completion.js";
import { recordExecutedWorkPackageLifecycleFacts } from "./context-work-package-runner-lifecycle.js";
import {
  alreadySatisfiedEvaluatorFrom,
  asArray,
  isObject,
  issue,
  localBoundedCompletionIssues,
  normalizeString,
  normalizeWorkflowStateWorkPackageGranularity,
  runArtifact,
  runnableNodes,
  syncProjectStatusWorkPackages,
  updateWorkPackages
} from "./context-work-package-runner-shared.js";

export {
  CONTEXT_WORK_PACKAGES_RUN_VERSION
} from "./context-work-package-runner-shared.js";

export {
  adapterResultAllowsWorkPackageCompletion,
  completionAuthorizedExecutionNodes,
  packageResultAllowsWorkPackageCompletion
} from "./context-work-package-runner-completion.js";

export {
  markContextWorkPackageDispatchFailed,
  stageContextWorkPackageDispatch
} from "./context-work-package-runner-dispatch.js";

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

  const executionScope = evaluateContextExecutionScope(selected, options);
  const executionCwd = executionScope.execution_cwd;
  if (executionScope.status !== "pass") {
    return {
      status: "blocked",
      phase: executionScope.phase,
      issues: executionScope.issues,
      dispatchable_count: dispatchable.length,
      selected_work_package_ids: selected.map((node) => node.id),
      fixed_development_mode_gate: fixedDevelopmentModeGate,
      work_package_execution_governance: executionGovernanceGate,
      execution_cwd: executionCwd,
      allows_work_package_completion: executionScope.allows_work_package_completion,
      completion_authority: executionScope.completion_authority
    };
  }

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
    const workspaceMutationGate = evaluateContextWorkspaceMutation({
      ...options,
      execution_cwd: executionCwd,
      requires_code_output: executionScope.requires_code_output,
      workspace_porcelain_before: executionScope.workspace_porcelain_before
    });
    if (workspaceMutationGate.status !== "pass") {
      return {
        status: "blocked",
        phase: workspaceMutationGate.phase,
        issues: workspaceMutationGate.issues,
        dispatchable_count: dispatchable.length,
        selected_work_package_ids: selected.map((node) => node.id),
        fixed_development_mode_gate: fixedDevelopmentModeGate,
        execution_plan: adapterResult.execution_plan,
        package_results: adapterResult.package_results,
        executor_provenance: adapterResult.executor_provenance || null,
        workspace_mutation: workspaceMutationGate.workspace_mutation,
        allows_work_package_completion: workspaceMutationGate.allows_work_package_completion,
        completion_authority: workspaceMutationGate.completion_authority
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
