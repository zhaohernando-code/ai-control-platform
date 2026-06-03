import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { decideContinuation } from "./autonomous-continuation.js";
import { cleanupAgentLifecyclePool, recordAgentLifecycleFact } from "./agent-lifecycle-pool.js";
import { materializeContextPackCycleFromWorkflowState } from "./context-pack-cycle.js";
import {
  prepareContinuationFromProjectStatus,
  recordProjectStatusContinuationPrepared
} from "./project-status-continuation.js";
import { runContextWorkPackages } from "./context-work-package-runner.js";
import { evaluateGlobalGoalCompletion } from "./global-goal-completion.js";
import { createWorkbenchProjection } from "./workbench-projection.js";
import { runAgentInvocation } from "./agent-invocation.js";
import { isParentOwnedAcceptanceGate, splitChildAcceptanceGates } from "./headless-acceptance-gates.js";
import {
  CHILD_WORKER_ROLE,
  HEADLESS_MAIN_ORCHESTRATOR_ROLE,
  createHeadlessWorkerSpawnFacts,
  selectHeadlessWorkPackages
} from "./headless-worker-planning.js";
import { headlessChildWorkerPrompt } from "./headless-child-worker-prompt.js";
import {
  defaultHeadlessChildWorkerOutput,
  evaluateHeadlessChildWorkerOutput,
  missingHeadlessChildWorkerOutput,
  parseHeadlessChildWorkerOutput
} from "./headless-child-acceptance.js";
import {
  recordHeadlessProcessHardening,
  rejectedPackageResults
} from "./headless-process-hardening.js";
import {
  publishHeadlessWorkflowSnapshot,
  snapshotPersistenceConfig
} from "./headless-snapshot-publisher.js";
import {
  MAX_HEADLESS_LOOP_ITERATIONS,
  boundedHeadlessLoopIterations,
  executeHeadlessProjectedNextAction,
  nextProjectedActionOptions,
  recordHeadlessProjectedActionProgress,
  serviceProjectedActionConfigured
} from "./headless-projected-next-action.js";

export const HEADLESS_CLI_ORCHESTRATOR_VERSION = "headless-cli-orchestrator.v1";
export { CHILD_WORKER_ROLE, HEADLESS_MAIN_ORCHESTRATOR_ROLE };
export {
  evaluateHeadlessChildWorkerOutput,
  headlessChildWorkerPrompt,
  parseHeadlessChildWorkerOutput
};
export const DEFAULT_CHILD_WORKER_TIMEOUT_MS = 10 * 60 * 1000;
export { MAX_HEADLESS_LOOP_ITERATIONS };

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeToken(value) {
  return normalizeString(value).toLowerCase();
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

function workflowStateIdentityIssues(workflowState = {}) {
  const manifestRunId = normalizeString(workflowState?.manifest?.run_id);
  const manifestCycleId = normalizeString(workflowState?.manifest?.cycle_id);
  const ledgerRunId = normalizeString(workflowState?.artifact_ledger?.run_id || workflowState?.artifactLedger?.run_id);
  const ledgerCycleId = normalizeString(workflowState?.artifact_ledger?.cycle_id || workflowState?.artifactLedger?.cycle_id);
  const issues = [];

  if (!manifestRunId || !manifestCycleId) {
    issues.push(issue("missing_workflow_manifest_identity", "workflow_state manifest run_id and cycle_id are required", "workflow_state.manifest"));
  }
  if (!ledgerRunId || !ledgerCycleId) {
    issues.push(issue("missing_workflow_ledger_identity", "workflow_state artifact_ledger run_id and cycle_id are required", "workflow_state.artifact_ledger"));
  }
  if (manifestRunId && ledgerRunId && manifestRunId !== ledgerRunId) {
    issues.push(issue("workflow_run_id_mismatch", "workflow_state manifest and artifact_ledger run_id must match", "workflow_state.artifact_ledger.run_id"));
  }
  if (manifestCycleId && ledgerCycleId && manifestCycleId !== ledgerCycleId) {
    issues.push(issue("workflow_cycle_id_mismatch", "workflow_state manifest and artifact_ledger cycle_id must match", "workflow_state.artifact_ledger.cycle_id"));
  }

  return issues;
}

function validateHeadlessInput(input = {}) {
  const issues = [];
  if (!isObject(input)) {
    return {
      status: "fail",
      issues: [issue("invalid_headless_orchestrator_input", "headless orchestrator input must be an object", "")]
    };
  }
  if (!isObject(input.project_status || input.projectStatus)) {
    issues.push(issue("missing_project_status", "PROJECT_STATUS durable input is required", "project_status"));
  }
  if ((input.project_status || input.projectStatus)?.project !== "ai-control-platform") {
    issues.push(issue("project_status_mismatch", "headless CLI main orchestrator must target ai-control-platform", "project_status.project"));
  }
  if (!isObject(input.workflow_state || input.workflowState)) {
    issues.push(issue("missing_workflow_state", "workflow_state durable input is required", "workflow_state"));
  } else {
    issues.push(...workflowStateIdentityIssues(input.workflow_state || input.workflowState));
  }
  if (input.role && normalizeToken(input.role) !== HEADLESS_MAIN_ORCHESTRATOR_ROLE) {
    issues.push(issue("invalid_orchestrator_role", "headless CLI adapter must declare role=main_orchestrator", "role"));
  }

  return {
    status: issues.length ? "fail" : "pass",
    issues
  };
}

function hasMaterializedContextCycle(workflowState = {}) {
  return asArray(workflowState?.manifest?.events).some((event) => [
    "context_pack_cycle_created",
    "context_pack_cycle_materialized"
  ].includes(event?.type));
}

function continuationRunEvaluationFromProjectStatus(projectStatus = {}) {
  const globalGoalCompletion = evaluateGlobalGoalCompletion({
    project_status: projectStatus,
    global_goals: projectStatus.global_goals
  });
  return {
    status: "pass",
    decision: "pass",
    source: "PROJECT_STATUS.json",
    next_work_packages: asArray(globalGoalCompletion.next_work_packages),
    global_goal_completion: globalGoalCompletion
  };
}

function recordLifecycleFacts(workflowState = {}, facts = []) {
  let nextState = workflowState;
  const recorded = [];

  for (const factInput of facts) {
    const result = recordAgentLifecycleFact(nextState, factInput);
    if (result.status !== "pass") {
      return {
        status: "fail",
        issues: result.issues || [],
        facts: recorded,
        workflow_state: nextState
      };
    }
    nextState = result.workflow_state;
    recorded.push(result.fact);
  }

  return {
    status: "pass",
    issues: [],
    facts: recorded,
    workflow_state: nextState
  };
}

function mockChildWorkerAllowed(options = {}) {
  return options.allow_mock_child_worker === true ||
    options.allowMockChildWorker === true ||
    normalizeToken(options.child_worker_mode || options.childWorkerMode) === "mock" ||
    normalizeToken(options.child_worker_execution_profile || options.childWorkerExecutionProfile) === "mock";
}

function childOutputsByPackage(options = {}) {
  const outputs = options.child_worker_outputs || options.childWorkerOutputs || [];
  const byId = new Map();
  for (const output of asArray(outputs)) {
    const id = normalizeString(output?.work_package_id || output?.workPackageId || output?.id);
    if (id) byId.set(id, output);
  }
  return byId;
}

function agentInvocationTemplateFrom(options = {}) {
  const provider = options.default_child_provider || options.defaultChildProvider || {};
  const profileId = normalizeString(
    options.agent_invocation_profile ||
      options.agentInvocationProfile ||
      options.child_worker_agent_profile ||
      options.childWorkerAgentProfile ||
      provider.profile_id ||
      provider.profileId
  );
  if (!profileId) return null;
  return {
    profile_id: profileId,
    provider: "agent_invocation",
    model: normalizeString(options.agent_invocation_model || options.agentInvocationModel || provider.model) || "",
    agent_id: normalizeString(options.agent_invocation_agent_id || options.agentInvocationAgentId || provider.agent_id || provider.agentId),
    candidate_index: options.agent_invocation_candidate_index ?? options.agentInvocationCandidateIndex ?? provider.candidate_index ?? provider.candidateIndex,
    retry_policy: agentInvocationRetryPolicy(options)
  };
}

function agentInvocationRetryPolicy(options = {}) {
  const provider = options.default_child_provider || options.defaultChildProvider || {};
  return options.agent_invocation_retry_policy ||
    options.agentInvocationRetryPolicy ||
    provider.retry_policy ||
    provider.retryPolicy ||
    {};
}

function childWorkerTimeoutMs(options = {}) {
  const value = Number(options.child_worker_timeout_ms ?? options.childWorkerTimeoutMs ?? options.timeout_ms ?? options.timeoutMs);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_CHILD_WORKER_TIMEOUT_MS;
}

function maxChildWorkerAttempts(options = {}) {
  const retryPolicy = agentInvocationRetryPolicy(options);
  const value = Number(
    options.agent_invocation_max_attempts ??
      options.agentInvocationMaxAttempts ??
      retryPolicy.max_attempts ??
      retryPolicy.maxAttempts ??
      1
  );
  return Number.isInteger(value) && value > 0 ? Math.min(value, 3) : 1;
}

function splitRetryEnabled(options = {}) {
  const retryPolicy = agentInvocationRetryPolicy(options);
  return options.agent_invocation_split_retry === true ||
    options.agentInvocationSplitRetry === true ||
    retryPolicy.split_retry === true ||
    retryPolicy.splitRetry === true;
}

function childWorkerRunnerFrom(options = {}) {
  if (typeof options.child_worker_runner === "function") return options.child_worker_runner;
  if (typeof options.childWorkerRunner === "function") return options.childWorkerRunner;
  const template = agentInvocationTemplateFrom(options);
  if (!template) return null;
  return ({ prompt_file: promptFile, work_package: workPackage, workflow_state: workflowState, timeout_ms: timeoutMs, output_path: outputPath }) => {
    const resolvedOutputPath = resolvedChildWorkerOutputPath(outputPath) ||
      resolvedChildWorkerOutputPath(childWorkerCommandOutputPath(workPackage, {
        ...options,
        run_id: workflowState?.manifest?.run_id,
        cycle_id: workflowState?.manifest?.cycle_id
      })) ||
      "";
    const commandRunner = typeof options.agent_invocation_command_runner === "function"
      ? options.agent_invocation_command_runner
      : typeof options.agentInvocationCommandRunner === "function"
        ? options.agentInvocationCommandRunner
        : null;
    const invocationResult = runAgentInvocation({
      profile_id: template.profile_id,
      agent_id: template.agent_id,
      candidate_index: template.candidate_index,
      model: template.model,
      prompt_file: promptFile,
      output_path: resolvedOutputPath,
      cwd: resolve(normalizeString(options.agent_invocation_cwd || options.agentInvocationCwd) || process.cwd()),
      timeout_ms: timeoutMs,
      lock_owner: `headless-${normalizeString(workflowState?.manifest?.run_id) || "run"}-${normalizeString(workPackage.id) || "work-package"}`,
      created_at: options.created_at || options.createdAt,
      stage: "implementation",
      risk: workPackage.risk || options.risk,
      budget_tier: workPackage.budget_tier || options.budget_tier,
      tags: ["headless_cli_orchestrator", "bounded_child_worker"]
    }, {
      stateStore: options.stateStore || options.state_store,
      channels_path: options.agent_channels_path || options.agentChannelsPath,
      profiles_path: options.agent_profiles_path || options.agentProfilesPath,
      commandRunner: commandRunner
        ? (command, args, runnerOptions) => commandRunner(command, args, {
            ...runnerOptions,
            env: childWorkerProcessEnv({ child_worker_env: runnerOptions.env })
          })
        : undefined
    });
    return {
      status: invocationResult.result?.exit_code ?? (invocationResult.status === "pass" ? 0 : 1),
      stdout: invocationResult.stdout || "",
      stderr: invocationResult.stderr || invocationResult.issues?.map((item) => item.message).join("\n") || "",
      error: invocationResult.status === "blocked" ? new Error("agent invocation blocked") : undefined,
      agent_invocation: invocationResult.invocation || null
    };
  };
}

function selectedModelFromResult(result = {}) {
  return normalizeString(result?.agent_invocation?.model);
}

function agentInvocationEvidenceFromResult(result = {}) {
  const invocation = result?.agent_invocation;
  if (!invocation) return null;
  return {
    version: invocation.version,
    profile_id: invocation.profile_id,
    role: invocation.role,
    stage: invocation.stage,
    agent_id: invocation.agent_id,
    runner: invocation.runner,
    provider: invocation.provider,
    model: invocation.model,
    model_profile: invocation.model_profile,
    command_audit: invocation.command_audit,
    result: result.result || null
  };
}

function childWorkerProcessEnv(options = {}) {
  const baseEnv = isObject(options.child_worker_env)
    ? options.child_worker_env
    : isObject(options.childWorkerEnv)
      ? options.childWorkerEnv
      : process.env;
  return Object.fromEntries(
    Object.entries(baseEnv).filter(([name]) => !name.startsWith("AI_CONTROL_WORKBENCH_CHILD_WORKER_"))
  );
}

function childWorkerCommandOutputPath(workPackage = {}, options = {}) {
  const explicit = normalizeString(options.child_worker_output_path || options.childWorkerOutputPath);
  if (!explicit) return null;
  return explicit
    .replaceAll("{work_package_id}", safeIdPart(workPackage.id))
    .replaceAll("{run_id}", safeIdPart(options.run_id || options.runId || "run"))
    .replaceAll("{cycle_id}", safeIdPart(options.cycle_id || options.cycleId || "cycle"));
}

function resolvedChildWorkerOutputPath(outputPath) {
  const normalized = normalizeString(outputPath);
  if (!normalized) return null;
  return isAbsolute(normalized) ? normalized : resolve(normalized);
}

function normalizeCommandRunnerResult(result = {}, workPackage = {}, promptFile = "", outputPath = null) {
  const stdout = normalizeString(result?.stdout);
  const stderr = normalizeString(result?.stderr);
  const exitCode = Number(result?.status ?? result?.exitCode ?? (result?.error ? 1 : 0));
  const timedOut = result?.error?.code === "ETIMEDOUT" ||
    exitCode === 124 ||
    /timed?\s*out|timeout/i.test(stderr);
  const fileOutput = outputPath && existsSync(outputPath)
    ? parseHeadlessChildWorkerOutput(readFileSync(outputPath, "utf8"))
    : null;
  const parsed = fileOutput || parseHeadlessChildWorkerOutput(stdout);

  if (parsed) {
    // Preserve worker-declared child_worker_integration evidence so no_diff=true
    // read-only work packages can prove the mainline already satisfies the task.
    const parsedCommandEvidence = (parsed.command_evidence && typeof parsed.command_evidence === "object" && !Array.isArray(parsed.command_evidence))
      ? parsed.command_evidence
      : {};
    return {
      ...parsed,
      command_evidence: {
        ...parsedCommandEvidence,
        exit_code: exitCode,
        timed_out: timedOut,
        stdout_present: Boolean(stdout),
        stderr_present: Boolean(stderr),
        prompt_file: promptFile,
        output_path: outputPath,
        agent_invocation: agentInvocationEvidenceFromResult(result)
      },
      selected_model: normalizeString(parsed.selected_model) || selectedModelFromResult(result) || parsed.selected_model
    };
  }

  return {
    status: "fail",
    role: CHILD_WORKER_ROLE,
    host: "platform_core",
    changed_files: [],
    test_results: [],
    durable_state_updated: false,
    process_hardening: { required: true, status: "pending" },
    continuation_readiness: { ready: false },
    self_evaluation: {
      aligned: false,
      drifted: false,
      evidence_sufficient: false
    },
    blocker: timedOut
      ? `child worker timed out before structured output for ${workPackage.id}`
      : `child worker returned no structured output for ${workPackage.id}`,
    read_files: [],
    next_minimal_patch_position: "child_worker.output",
    command_evidence: {
      exit_code: exitCode,
      timed_out: timedOut,
      stdout,
      stderr,
      prompt_file: promptFile,
      output_path: outputPath,
      agent_invocation: agentInvocationEvidenceFromResult(result)
    },
    selected_model: selectedModelFromResult(result) || null
  };
}

function createIsolatedWorktree(repoRoot, workPackageId) {
  const codexRoot = resolve(repoRoot, "..", "..");
  const projectId = repoRoot.split("/").pop();
  const workerBase = join(codexRoot, "worker-workspaces", projectId);
  mkdirSync(workerBase, { recursive: true });
  const slug = `child-worker-${workPackageId}-${Date.now()}`;
  const worktreeDir = join(workerBase, slug);
  const branchName = `worker/${workPackageId}-${Date.now()}`;
  const result = spawnSync("git", ["worktree", "add", "-b", branchName, worktreeDir], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30000
  });
  if (result.status !== 0) {
    try { rmSync(worktreeDir, { recursive: true, force: true }); } catch {}
    return { status: "fail", error: normalizeString(result.stderr) || "git worktree add failed" };
  }
  return { status: "pass", branch: branchName, path: worktreeDir };
}

function cleanupIsolatedWorktree(repoRoot, worktreePath, branchName) {
  try {
    spawnSync("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 15000
    });
  } catch {}
  try {
    spawnSync("git", ["branch", "-D", branchName], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10000
    });
  } catch {}
}

function executeRealChildWorker(workflowState = {}, workPackage = {}, options = {}) {
  const repoRoot = normalizeString(options.repo_root || options.repoRoot || process.cwd());
  const worktree = createIsolatedWorktree(repoRoot, workPackage.id);
  const useWorktree = worktree.status === "pass";
  const workerCwd = useWorktree ? worktree.path : resolve(normalizeString(options.agent_invocation_cwd || options.agentInvocationCwd) || process.cwd());

  const effectiveOptions = useWorktree
    ? { ...options, agent_invocation_cwd: workerCwd, agentInvocationCwd: workerCwd }
    : options;
  const runner = childWorkerRunnerFrom(effectiveOptions);
  if (!runner) {
    if (useWorktree) cleanupIsolatedWorktree(repoRoot, worktree.path, worktree.branch);
    return null;
  }

  const tempDir = mkdtempSync(join(tmpdir(), "headless-child-worker-"));
  const promptFile = join(tempDir, "bounded-implementation-task.md");
  const outputPath = resolvedChildWorkerOutputPath(childWorkerCommandOutputPath(workPackage, {
    ...effectiveOptions,
    run_id: workflowState?.manifest?.run_id,
    cycle_id: workflowState?.manifest?.cycle_id
  }));
  if (outputPath) mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(promptFile, headlessChildWorkerPrompt(workflowState, workPackage, {
    ...effectiveOptions,
    child_worker_output_path_resolved: outputPath
  }));

  const timeoutMs = childWorkerTimeoutMs(effectiveOptions);
  const attempts = [];
  let normalized = null;
  for (let attemptIndex = 0; attemptIndex < maxChildWorkerAttempts(effectiveOptions); attemptIndex += 1) {
    let result;
    try {
      result = runner({
        workflow_state: workflowState,
        work_package: workPackage,
        prompt_file: promptFile,
        output_path: outputPath,
        timeout_ms: timeoutMs,
        attempt: attemptIndex + 1,
        split_retry: attemptIndex > 0 && splitRetryEnabled(effectiveOptions),
        options: effectiveOptions
      });
    } catch (error) {
      result = {
        status: 1,
        stdout: "",
        stderr: error.message,
        error
      };
    }
    normalized = normalizeCommandRunnerResult(result, workPackage, promptFile, outputPath);
    const template = agentInvocationTemplateFrom(effectiveOptions);
    if ((template?.model || selectedModelFromResult(result)) && !normalizeString(normalized?.selected_model)) {
      normalized = {
        ...normalized,
        selected_model: template.model || selectedModelFromResult(result)
      };
    }
    attempts.push({
      attempt: attemptIndex + 1,
      status: normalized.status || "fail",
      exit_code: normalized.command_evidence?.exit_code ?? null,
      timed_out: normalized.command_evidence?.timed_out === true,
      split_retry: attemptIndex > 0 && splitRetryEnabled(effectiveOptions)
    });
    if (evaluateHeadlessChildWorkerOutput(workPackage, normalized).status === "pass") break;
  }

  if (useWorktree) {
    const evalResult = evaluateHeadlessChildWorkerOutput(workPackage, normalized);
    if (evalResult.status === "pass") {
      const mergeResult = spawnSync("git", ["-C", repoRoot, "merge", "--ff-only", worktree.branch], {
        encoding: "utf8",
        timeout: 15000
      });
      if (mergeResult.status !== 0) {
        normalized = {
          ...normalized,
          status: "fail",
          command_evidence: {
            ...(normalized?.command_evidence || {}),
            child_worker_integration: {
              required: true,
              status: "fail",
              error: normalizeString(mergeResult.stderr) || "merge failed"
            }
          }
        };
      } else {
        normalized = {
          ...normalized,
          command_evidence: {
            ...(normalized?.command_evidence || {}),
            child_worker_integration: {
              required: true,
              status: "pass",
              branch: worktree.branch
            }
          }
        };
      }
    }
    cleanupIsolatedWorktree(repoRoot, worktree.path, worktree.branch);
  }

  // The child-worker scratch dir (prompt file) is no longer needed once the run is
  // recorded; remove it so dispatches don't accumulate under the OS temp root (P2-9).
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort; a missing dir is fine
  }

  return {
    ...normalized,
    command_evidence: {
      ...(normalized?.command_evidence || {}),
      attempts,
      retry_policy: {
        max_attempts: maxChildWorkerAttempts(options),
        split_retry: splitRetryEnabled(options)
      }
    }
  };
}

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
        provider: agentInvocationTemplateFrom(options)?.provider || normalizeString(options.provider) || "agent_invocation",
        model: agentInvocationTemplateFrom(options)?.model || normalizeString(options.model) || "codex-cli",
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

function continuationInput(projectStatus = {}, workflowState = {}, projection = {}) {
  return {
    project_status: projectStatus,
    run_evaluation: {
      status: projection.status,
      decision: projection.decision,
      blockers: projection.blockers,
      projection
    },
    workflow_state: workflowState
  };
}

export function runHeadlessCliMainOrchestrator(input = {}, options = {}) {
  const validation = validateHeadlessInput(input);
  if (validation.status !== "pass") {
    return {
      status: "blocked",
      phase: "input_validation",
      role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
      issues: validation.issues,
      workflow_state: input?.workflow_state || input?.workflowState || null
    };
  }

  const projectStatus = input.project_status || input.projectStatus;
  const createdAt = normalizeString(options.created_at || options.createdAt) || new Date().toISOString();
  let workflowState = input.workflow_state || input.workflowState;
  const steps = [];

  const prepared = prepareContinuationFromProjectStatus(projectStatus, {
    workflow_state: workflowState,
    run_evaluation: continuationRunEvaluationFromProjectStatus(projectStatus)
  });
  const recordedPreparation = recordProjectStatusContinuationPrepared(workflowState, prepared, { created_at: createdAt });
  if (recordedPreparation.status !== "pass") {
    return {
      status: "blocked",
      phase: "project_status_continuation_record",
      role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
      issues: recordedPreparation.issues || [],
      workflow_state: recordedPreparation.workflow_state || workflowState
    };
  }
  workflowState = recordedPreparation.workflow_state;
  steps.push({ phase: "project_status_continuation", status: prepared.status });

  if (!prepared.should_continue) {
    const projection = createWorkbenchProjection({
      ...workflowState,
      project_status: projectStatus,
      global_goals: projectStatus.global_goals
    });
    return {
      status: prepared.status === "complete" ? "complete" : "blocked",
      phase: "project_status_continuation",
      role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
      steps,
      projection,
      continuation: prepared.decision,
      workflow_state: workflowState,
      issues: prepared.issues || []
    };
  }

  if (hasMaterializedContextCycle(workflowState) && selectHeadlessWorkPackages(workflowState, options).length > 0) {
    steps.push({
      phase: "context_pack_cycle",
      status: "existing",
      work_package_count: asArray(workflowState?.manifest?.work_packages).length
    });
  } else {
    const materialized = materializeContextPackCycleFromWorkflowState(workflowState, {
      cycle_id: normalizeString(options.cycle_id || options.cycleId),
      created_at: createdAt
    });
    if (materialized.status !== "ready") {
      return {
        status: "blocked",
        phase: "context_pack_cycle",
        role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
        steps,
        issues: materialized.issues || [],
        workflow_state: materialized.workflow_state || workflowState
      };
    }
    workflowState = materialized.workflow_state;
    steps.push({
      phase: "context_pack_cycle",
      status: "ready",
      work_package_count: asArray(materialized.work_packages).length
    });
  }

  const selected = selectHeadlessWorkPackages(workflowState, options);
  if (selected.length === 0) {
    return {
      status: "blocked",
      phase: "no_dispatchable_work_packages",
      role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
      steps,
      issues: [issue("no_dispatchable_work_packages", "headless orchestrator found no dispatchable child work packages", "workflow_state.manifest.work_packages")],
      workflow_state: workflowState
    };
  }

  const spawned = recordLifecycleFacts(workflowState, createHeadlessWorkerSpawnFacts(workflowState, selected, { ...options, created_at: createdAt }));
  if (spawned.status !== "pass") {
    return {
      status: "blocked",
      phase: "child_worker_lifecycle_spawn",
      role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
      steps,
      issues: spawned.issues,
      workflow_state: spawned.workflow_state
    };
  }
  workflowState = spawned.workflow_state;
  steps.push({
    phase: "child_worker_spawn",
    status: "pass",
    fact_count: spawned.facts.length
  });

  const runResult = runContextWorkPackages(workflowState, {
    ...options,
    created_at: createdAt,
    max_package_count: selected.length,
    execution_mode: "provider_model_routed",
    execution_profile: "verified_provider_multi_agent",
    provider_executor: createHeadlessProviderExecutor({
      ...options,
      created_at: createdAt,
      workflow_state: workflowState,
      acceptance_gates: workflowState.manifest.context_pack.acceptance_gates
    })
  });

  if (runResult.status !== "pass") {
    const hardening = recordHeadlessProcessHardening(workflowState, rejectedPackageResults(runResult), {
      ...options,
      created_at: createdAt
    });
    const closed = cleanupAgentLifecyclePool(hardening.workflow_state || workflowState, {
      created_at: createdAt,
      failure: "headless main orchestrator rejected child worker output"
    });
    return {
      status: "blocked",
      phase: "child_worker_acceptance",
      role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
      steps,
      issues: runResult.issues || [],
      hardening: {
        status: hardening.status,
        finding: hardening.finding,
        plan: hardening.plan
      },
      lifecycle_cleanup: {
        status: closed.status,
        facts: closed.facts || [],
        before: closed.before || null,
        after: closed.after || null
      },
      child_run: runResult,
      workflow_state: closed.workflow_state || hardening.workflow_state || workflowState
    };
  }

  workflowState = runResult.workflow_state;
  steps.push({
    phase: "context_work_packages_run",
    status: "pass",
    executed_count: runResult.executed_count
  });

  const closed = cleanupAgentLifecyclePool(workflowState, {
    created_at: createdAt,
    timeout_threshold_ms: options.timeout_threshold_ms ?? options.timeoutThresholdMs
  });
  if (!["pass", "cleanup_required"].includes(closed.status)) {
    return {
      status: "blocked",
      phase: "child_worker_lifecycle_close",
      role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
      steps,
      issues: closed.issues || [],
      workflow_state: closed.workflow_state || workflowState
    };
  }
  workflowState = closed.workflow_state;
  steps.push({
    phase: "child_worker_lifecycle_close",
    status: closed.status,
    fact_count: closed.facts.length
  });

  const projection = createWorkbenchProjection({
    ...workflowState,
    project_status: projectStatus,
    global_goals: projectStatus.global_goals
  });
  const continuation = decideContinuation(continuationInput(projectStatus, workflowState, projection));
  const snapshotPublish = publishHeadlessWorkflowSnapshot(workflowState, {
    ...options,
    created_at: createdAt
  });
  if (snapshotPublish.status === "fail") {
    return {
      status: "blocked",
      phase: "headless_snapshot_publish",
      role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
      steps,
      issues: snapshotPublish.issues || [],
      projection: snapshotPublish.projection || projection,
      continuation,
      snapshot_publish: snapshotPublish,
      workflow_state: workflowState
    };
  }
  workflowState = snapshotPublish.workflow_state || workflowState;
  const persistedProjection = snapshotPublish.projection || projection;
  if (snapshotPublish.status === "created") {
    steps.push({
      phase: "headless_snapshot_publish",
      status: "created",
      snapshot_id: snapshotPublish.item?.id || null
    });
  }

  return {
    status: "pass",
    phase: "headless_cli_orchestrator_cycle",
    version: HEADLESS_CLI_ORCHESTRATOR_VERSION,
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    child_role: CHILD_WORKER_ROLE,
    steps,
    context_pack: workflowState.manifest.context_pack,
    child_run: runResult,
    lifecycle_cleanup: {
      status: closed.status,
      facts: closed.facts,
      before: closed.before,
      after: closed.after
    },
    projection: persistedProjection,
    snapshot_publish: snapshotPublish,
    continuation,
    must_continue: continuation.should_continue === true ||
      Boolean(continuation.next_step) ||
      asArray(continuation.next_work_packages).length > 0 ||
      persistedProjection.next_action_readout?.action !== "wait_for_driver_event",
    workflow_state: workflowState,
    issues: []
  };
}

export function runHeadlessCliMainOrchestratorLoop(input = {}, options = {}) {
  const bounded = boundedHeadlessLoopIterations(options.max_iterations || options.maxIterations || 1);
  if (bounded.status !== "pass") {
    return {
      status: "blocked",
      phase: "input_validation",
      role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
      issues: bounded.issues,
      iterations: []
    };
  }

  const iterations = [];
  let currentInput = input;
  let loopOptions = { ...options };
  let lastResult = null;
  let currentWorkbenchProjectionId = normalizeString(options.workbench_projection_id || options.workbenchProjectionId);
  for (let index = 0; index < bounded.value; index += 1) {
    if (serviceProjectedActionConfigured(loopOptions)) {
      const iterationOptions = currentWorkbenchProjectionId
        ? { ...loopOptions, current_workbench_projection_id: currentWorkbenchProjectionId }
        : loopOptions;
      const serviceProjectedAction = executeHeadlessProjectedNextAction({
        status: "pass",
        phase: "service_projected_next_action",
        workflow_state: currentInput.workflow_state || currentInput.workflowState,
        projection: null,
        must_continue: true
      }, iterationOptions, index);
      if (serviceProjectedAction.status !== "not_configured") {
        const progress = recordHeadlessProjectedActionProgress(
          serviceProjectedAction.workflow_state || currentInput.workflow_state || currentInput.workflowState,
          serviceProjectedAction,
          loopOptions
        );
        if (progress.status === "pass") {
          serviceProjectedAction.workflow_state = progress.workflow_state;
        }
        if (serviceProjectedAction.next_projection_id) {
          currentWorkbenchProjectionId = serviceProjectedAction.next_projection_id;
          loopOptions = nextProjectedActionOptions(loopOptions, serviceProjectedAction);
        } else {
          loopOptions = nextProjectedActionOptions(loopOptions, serviceProjectedAction);
        }
        lastResult = {
          status: serviceProjectedAction.status === "blocked" ? "blocked" : "pass",
          phase: "headless_projected_next_action",
          role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
          projected_next_action: serviceProjectedAction,
          workflow_state: serviceProjectedAction.workflow_state || currentInput.workflow_state || currentInput.workflowState,
          projection: serviceProjectedAction.projection,
          must_continue: serviceProjectedAction.status !== "stopped",
          issues: serviceProjectedAction.issues || []
        };
        iterations.push({
          index: index + 1,
          status: lastResult.status,
          phase: lastResult.phase,
          run_id: lastResult.workflow_state?.manifest?.run_id || null,
          cycle_id: lastResult.workflow_state?.manifest?.cycle_id || null,
          snapshot_status: "not_configured",
          snapshot_id: null,
          next_action: serviceProjectedAction.projection?.next_action_readout?.action || null,
          projected_next_action_status: serviceProjectedAction.status,
          projected_next_action: serviceProjectedAction.action || null,
          projected_next_projection_id: serviceProjectedAction.next_projection_id || null,
          workbench_projection_id: currentWorkbenchProjectionId || null,
          must_continue: lastResult.must_continue === true,
          issue_count: asArray(lastResult.issues).length
        });
        if (serviceProjectedAction.status === "blocked") {
          return {
            status: "blocked",
            phase: "headless_projected_next_action",
            role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
            iterations,
            last_result: lastResult,
            projected_next_action: serviceProjectedAction,
            issues: serviceProjectedAction.issues || []
          };
        }
        currentInput = {
          ...currentInput,
          role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
          workflow_state: lastResult.workflow_state,
          project_status: input.project_status || input.projectStatus,
          projection_history: currentInput.projection_history || currentInput.projectionHistory
        };
        if (!lastResult.must_continue) {
          return {
            status: "complete",
            phase: "headless_loop_complete",
            role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
            iterations,
            last_result: lastResult,
            issues: []
          };
        }
        continue;
      }
    }

    const sourceCycleId = currentInput?.workflow_state?.manifest?.cycle_id || currentInput?.workflowState?.manifest?.cycle_id;
    const cycleSeed = normalizeString(options.cycle_id || options.cycleId) || `${safeIdPart(sourceCycleId)}-headless`;
    const run = runHeadlessCliMainOrchestrator(currentInput, {
      ...loopOptions,
      cycle_id: `${safeIdPart(cycleSeed)}-${String(index + 1).padStart(2, "0")}`,
      snapshot_id: normalizeString(loopOptions.snapshot_id || loopOptions.snapshotId)
        ? `${safeIdPart(loopOptions.snapshot_id || loopOptions.snapshotId)}-${String(index + 1).padStart(2, "0")}`
        : "",
      snapshot_prefix: normalizeString(loopOptions.snapshot_prefix || loopOptions.snapshotPrefix) || "headless-loop"
    });
    lastResult = run;
    const persisted = run.snapshot_publish?.status === "created";
    const iterationOptions = currentWorkbenchProjectionId
      ? { ...options, current_workbench_projection_id: currentWorkbenchProjectionId }
      : options;
    const projectedAction = executeHeadlessProjectedNextAction(run, iterationOptions, index);
    iterations.push({
      index: index + 1,
      status: run.status,
      phase: run.phase,
      run_id: run.workflow_state?.manifest?.run_id || null,
      cycle_id: run.workflow_state?.manifest?.cycle_id || null,
      snapshot_status: run.snapshot_publish?.status || "not_configured",
      snapshot_id: run.snapshot_publish?.item?.id || null,
      next_action: run.projection?.next_action_readout?.action || null,
      projected_next_action_status: projectedAction.status,
      projected_next_action: projectedAction.action || null,
      projected_next_projection_id: projectedAction.next_projection_id || null,
      workbench_projection_id: currentWorkbenchProjectionId || null,
      must_continue: run.must_continue === true,
      issue_count: asArray(run.issues).length
    });
    if (projectedAction.next_projection_id) {
      currentWorkbenchProjectionId = projectedAction.next_projection_id;
      loopOptions = nextProjectedActionOptions(loopOptions, projectedAction);
    }

    if (run.status !== "pass") {
      return {
        status: "blocked",
        phase: run.phase,
        role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
        iterations,
        last_result: run,
        issues: run.issues || []
      };
    }
    if (snapshotPersistenceConfig(options).status === "configured" && !persisted) {
      return {
        status: "blocked",
        phase: "headless_loop_snapshot_persistence",
        role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
        iterations,
        last_result: run,
        issues: [issue("headless_loop_snapshot_not_persisted", "configured headless loop must persist every iteration snapshot before continuing", "snapshot_publish.status")]
      };
    }
    if (projectedAction.status === "blocked") {
      return {
        status: "blocked",
        phase: "headless_projected_next_action",
        role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
        iterations,
        last_result: run,
        projected_next_action: projectedAction,
        issues: projectedAction.issues || []
      };
    }
    if (projectedAction.status !== "not_configured") {
      const progress = recordHeadlessProjectedActionProgress(
        projectedAction.workflow_state || run.workflow_state,
        projectedAction,
        loopOptions
      );
      if (progress.status === "pass") {
        projectedAction.workflow_state = progress.workflow_state;
      }
      lastResult = {
        ...run,
        projected_next_action: projectedAction,
        workflow_state: projectedAction.workflow_state || run.workflow_state,
        projection: projectedAction.projection || run.projection
      };
      loopOptions = nextProjectedActionOptions(loopOptions, projectedAction);
    }
    if (!run.must_continue) {
      return {
        status: "complete",
        phase: "headless_loop_complete",
        role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
        iterations,
        last_result: lastResult,
        issues: []
      };
    }

    currentInput = {
      ...currentInput,
      role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
      workflow_state: projectedAction.workflow_state || run.workflow_state,
      project_status: input.project_status || input.projectStatus,
      projection_history: run.snapshot_publish?.history || currentInput.projection_history || currentInput.projectionHistory
    };
  }

  return {
    status: "pass",
    phase: "headless_loop_iteration_limit_reached",
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    iterations,
    last_result: lastResult,
    issues: []
  };
}

export { publishHeadlessWorkflowSnapshot, validateHeadlessInput };
