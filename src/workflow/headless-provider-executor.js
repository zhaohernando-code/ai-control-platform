import {
  defaultHeadlessChildWorkerOutput,
  evaluateHeadlessChildWorkerOutput,
  missingHeadlessChildWorkerOutput
} from "./headless-child-acceptance.js";
import { CHILD_WORKER_ROLE } from "./headless-worker-planning.js";
import {
  agentInvocationTemplateFrom,
  childOutputsByPackage,
  childWorkerRunnerFrom,
  executeRealChildWorker,
  maxChildWorkerAttempts,
  mockChildWorkerAllowed,
  splitRetryEnabled
} from "./headless-child-worker-runtime.js";
import { asArray, normalizeString } from "./headless-orchestrator-utils.js";

export function createHeadlessProviderExecutor(options = {}) {
  const outputsById = childOutputsByPackage(options);
  return ({ workflow_state: invocationWorkflowState, selected_work_packages: selectedWorkPackages, execution_plan: executionPlan }) => {
    const createdAt = normalizeString(options.created_at || options.createdAt) || new Date().toISOString();
    const workflowState = options.workflow_state || options.workflowState || invocationWorkflowState || {};
    const packageResults = asArray(selectedWorkPackages).map((workPackage) => {
      const explicitOutput = outputsById.get(normalizeString(workPackage.id));
      const realOutput = explicitOutput ? null : executeRealChildWorker(workflowState, workPackage, {
          ...options,
          acceptance_gates: executionPlan?.package_plans?.find((plan) => plan.work_package_id === workPackage.id)
            ?.routing_request?.context_pack?.acceptance_gates
        });
      const workerOutput = explicitOutput ||
        realOutput ||
        (mockChildWorkerAllowed(options)
          ? defaultHeadlessChildWorkerOutput(workPackage, {
              ...options,
              acceptance_gates: executionPlan?.package_plans?.find((plan) => plan.work_package_id === workPackage.id)
                ?.routing_request?.context_pack?.acceptance_gates
            })
          : missingHeadlessChildWorkerOutput(workPackage));
      const evaluation = evaluateHeadlessChildWorkerOutput(workPackage, workerOutput);

      return {
        work_package_id: workPackage.id,
        status: evaluation.status,
        result: evaluation.status === "pass" ? "headless_child_worker_accepted" : "headless_child_worker_rejected",
        completed_at: evaluation.status === "pass" ? createdAt : null,
        completion_evidence: {
          summary: evaluation.status === "pass"
            ? `headless CLI main orchestrator accepted bounded child worker ${workPackage.id}`
            : `headless CLI main orchestrator rejected bounded child worker ${workPackage.id}`,
          worker_role: CHILD_WORKER_ROLE,
          child_output: workerOutput,
          evaluation
        },
        selected_model: workerOutput.selected_model || "codex-cli",
        model_roles: [
          {
            role: CHILD_WORKER_ROLE,
            model_id: workerOutput.selected_model || "codex-cli",
            reason: "bounded owned-files implementation"
          }
        ]
      };
    });
    const failed = packageResults.filter((result) => result.status !== "pass");
    const template = agentInvocationTemplateFrom(options);

    return {
      status: failed.length > 0 ? "fail" : "pass",
      completion_evidence: {
        summary: failed.length > 0
          ? "headless child worker output failed main orchestrator acceptance"
          : "headless CLI main orchestrator validated bounded child worker outputs",
        package_count: packageResults.length
      },
      package_results: packageResults,
      executor_provenance: {
        executor_kind: normalizeString(options.executor_kind || options.executorKind) || "agent_cli_worker",
        command_runner_kind: normalizeString(options.command_runner_kind || options.commandRunnerKind) ||
          (childWorkerRunnerFrom(options) ? "agent_invocation_child_process" : "agent_invocation"),
        provider: template?.provider || normalizeString(options.provider) || "agent_invocation",
        model: template?.model || normalizeString(options.model) || "codex-cli",
        retry_policy: {
          max_attempts: maxChildWorkerAttempts(options),
          split_retry: splitRetryEnabled(options)
        },
        external_calls: Math.max(1, Number(options.external_calls || options.externalCalls || packageResults.length || 1)),
        deterministic: false,
        role: CHILD_WORKER_ROLE,
        created_at: createdAt
      }
    };
  };
}
