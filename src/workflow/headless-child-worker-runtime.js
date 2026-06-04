import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { runAgentInvocation } from "./agent-invocation.js";
import { CHILD_WORKER_ROLE } from "./headless-worker-planning.js";
import { headlessChildWorkerPrompt } from "./headless-child-worker-prompt.js";
import {
  evaluateHeadlessChildWorkerOutput,
  parseHeadlessChildWorkerOutput
} from "./headless-child-acceptance.js";
import {
  DEFAULT_CHILD_WORKER_TIMEOUT_MS,
  isObject,
  normalizeString,
  normalizeToken,
  safeIdPart
} from "./headless-orchestrator-utils.js";

export function mockChildWorkerAllowed(options = {}) {
  return options.allow_mock_child_worker === true ||
    options.allowMockChildWorker === true ||
    normalizeToken(options.child_worker_mode || options.childWorkerMode) === "mock" ||
    normalizeToken(options.child_worker_execution_profile || options.childWorkerExecutionProfile) === "mock";
}

export function childOutputsByPackage(options = {}) {
  const outputs = options.child_worker_outputs || options.childWorkerOutputs || [];
  const byId = new Map();
  for (const output of Array.isArray(outputs) ? outputs : []) {
    const id = normalizeString(output?.work_package_id || output?.workPackageId || output?.id);
    if (id) byId.set(id, output);
  }
  return byId;
}

export function agentInvocationRetryPolicy(options = {}) {
  const provider = options.default_child_provider || options.defaultChildProvider || {};
  return options.agent_invocation_retry_policy ||
    options.agentInvocationRetryPolicy ||
    provider.retry_policy ||
    provider.retryPolicy ||
    {};
}

export function agentInvocationTemplateFrom(options = {}) {
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

function childWorkerTimeoutMs(options = {}) {
  const value = Number(options.child_worker_timeout_ms ?? options.childWorkerTimeoutMs ?? options.timeout_ms ?? options.timeoutMs);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_CHILD_WORKER_TIMEOUT_MS;
}

export function maxChildWorkerAttempts(options = {}) {
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

export function splitRetryEnabled(options = {}) {
  const retryPolicy = agentInvocationRetryPolicy(options);
  return options.agent_invocation_split_retry === true ||
    options.agentInvocationSplitRetry === true ||
    retryPolicy.split_retry === true ||
    retryPolicy.splitRetry === true;
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

export function childWorkerRunnerFrom(options = {}) {
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
    const parsedCommandEvidence = isObject(parsed.command_evidence) ? parsed.command_evidence : {};
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

export function executeRealChildWorker(workflowState = {}, workPackage = {}, options = {}) {
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
      result = { status: 1, stdout: "", stderr: error.message, error };
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
      normalized = {
        ...normalized,
        status: mergeResult.status !== 0 ? "fail" : normalized.status,
        command_evidence: {
          ...(normalized?.command_evidence || {}),
          child_worker_integration: mergeResult.status !== 0
            ? { required: true, status: "fail", error: normalizeString(mergeResult.stderr) || "merge failed" }
            : { required: true, status: "pass", branch: worktree.branch }
        }
      };
    }
    cleanupIsolatedWorktree(repoRoot, worktree.path, worktree.branch);
  }

  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {}

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
