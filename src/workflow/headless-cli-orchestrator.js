import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { decideContinuation } from "./autonomous-continuation.js";
import { recordArtifact } from "./artifact-ledger.js";
import { cleanupAgentLifecyclePool, recordAgentLifecycleFact } from "./agent-lifecycle-pool.js";
import { materializeContextPackCycleFromWorkflowState } from "./context-pack-cycle.js";
import {
  prepareContinuationFromProjectStatus,
  recordProjectStatusContinuationPrepared
} from "./project-status-continuation.js";
import { createProcessHardeningPlan } from "./process-hardening.js";
import { appendRunEvent } from "./run-manifest.js";
import { runContextWorkPackages } from "./context-work-package-runner.js";
import { evaluateGlobalGoalCompletion } from "./global-goal-completion.js";
import { createWorkbenchProjection } from "./workbench-projection.js";
import { publishWorkbenchSnapshot } from "./workbench-snapshots.js";
import {
  promptSafeContextPack,
  promptSafeWorkflowIdentity,
  promptSafeWorkPackage,
  promptSafetyPreamble
} from "./external-prompt-safety.js";

export const HEADLESS_CLI_ORCHESTRATOR_VERSION = "headless-cli-orchestrator.v1";
export const HEADLESS_MAIN_ORCHESTRATOR_ROLE = "main_orchestrator";
export const CHILD_WORKER_ROLE = "child_worker";
export const DEFAULT_CHILD_WORKER_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_HEADLESS_LOOP_ITERATIONS = 5;
const HEADLESS_PROJECTED_NEXT_ACTIONS = new Set([
  "enqueue_scheduler_next_cycle",
  "prepare_project_status_continuation",
  "continue_after_reviewer_aggregate",
  "create_context_pack_from_seed",
  "run_context_work_packages",
  "run_reviewer_scope_shard",
  "cleanup_agent_lifecycle_pool",
  "resume_autonomous_scheduler_loop",
  "run_autonomous_scheduler_loop"
]);

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

function compactStrings(value) {
  return asArray(value).map(normalizeString).filter(Boolean);
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

function lifecyclePoolId(workflowState = {}, options = {}) {
  return normalizeString(options.pool_id || options.poolId) ||
    `headless-cli-${safeIdPart(workflowState?.manifest?.run_id)}-${safeIdPart(workflowState?.manifest?.cycle_id)}`;
}

function childWorkerId(workPackage = {}, index = 0, options = {}) {
  return normalizeString(options.worker_id || options.workerId) ||
    `child-${safeIdPart(workPackage.id || workPackage.work_package_id || index + 1)}`;
}

function selectedWorkPackages(workflowState = {}, options = {}) {
  const maxPackageCount = Math.max(1, Number(options.max_package_count || options.maxPackageCount || 1));
  return asArray(workflowState?.manifest?.work_packages)
    .filter((workPackage) => normalizeToken(workPackage?.status || "pending") !== "completed")
    .filter((workPackage) => workPackage?.dispatch_allowed !== false)
    .slice(0, maxPackageCount);
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

function spawnFactsFor(workflowState = {}, workPackages = [], options = {}) {
  const poolId = lifecyclePoolId(workflowState, options);
  const createdAt = normalizeString(options.created_at || options.createdAt) || new Date().toISOString();
  return workPackages.flatMap((workPackage, index) => {
    const workerId = childWorkerId(workPackage, index, options);
    const baseSource = {
      orchestrator_role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
      worker_role: CHILD_WORKER_ROLE,
      work_package_id: workPackage.id || workPackage.work_package_id,
      owned_files: compactStrings(workPackage.owned_files),
      executor: normalizeString(options.executor_kind || options.executorKind) || "codex_proxy_or_cli_worker"
    };
    return [
      {
        event_type: "WorkerSpawned",
        pool_id: poolId,
        worker_id: workerId,
        status: "pass",
        message: `${workerId} spawned by headless CLI main orchestrator`,
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
      }
    ];
  });
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

function testResultsPass(testResults = []) {
  return asArray(testResults).length > 0 && asArray(testResults).every((testResult) => {
    const status = normalizeToken(testResult?.status || testResult?.result);
    return ["pass", "passed", "ok", "success"].includes(status);
  });
}

function durableStatePass(output = {}) {
  return output.durable_state_updated === true ||
    output.workflow_state_updated === true ||
    isObject(output.durable_state) ||
    isObject(output.workflow_state);
}

function pathMatchesOwnedFile(changedFile = "", ownedFile = "") {
  const changed = normalizeString(changedFile).replace(/\\/g, "/").replace(/^\.\/+/, "");
  const owned = normalizeString(ownedFile).replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  if ((owned === "." || owned === "") && changed && !changed.startsWith("../") && !changed.startsWith("/")) {
    return true;
  }
  return Boolean(changed && owned && (changed === owned || changed.startsWith(`${owned}/`)));
}

function changedFileAllowedByOwnedFiles(changedFile = "", ownedFiles = []) {
  return compactStrings(ownedFiles).some((ownedFile) => pathMatchesOwnedFile(changedFile, ownedFile));
}

export function evaluateHeadlessChildWorkerOutput(workPackage = {}, output = {}) {
  const issues = [];
  const ownedFiles = compactStrings(workPackage.owned_files);
  const changedFiles = compactStrings([
    ...asArray(output.changed_files || output.changedFiles || output.diff_files || output.diffFiles),
    ...asArray(output.touched_files || output.touchedFiles)
  ]);
  const testResults = asArray(output.test_results || output.testResults);
  const selfEvaluation = output.self_evaluation || output.selfEvaluation || {};
  const processHardening = output.process_hardening || output.processHardening || {};
  const continuationReadiness = output.continuation_readiness || output.continuationReadiness || {};

  if (!isObject(output)) {
    return {
      status: "fail",
      issues: [issue("invalid_child_worker_output", "child worker output must be an object", "child_output")]
    };
  }
  if (normalizeString(output.host || output.host_classification) !== "platform_core") {
    issues.push(issue("child_worker_host_boundary_missing", "child worker output must declare host=platform_core", "child_output.host"));
  }
  if (changedFiles.length === 0) {
    issues.push(issue("child_worker_no_diff", "child worker produced no changed files", "child_output.changed_files"));
  }
  for (const changedFile of changedFiles) {
    if (!changedFileAllowedByOwnedFiles(changedFile, ownedFiles)) {
      issues.push(issue("child_worker_owned_file_violation", `${changedFile} is outside work package owned_files`, "child_output.changed_files"));
    }
  }
  if (!testResultsPass(testResults)) {
    issues.push(issue("child_worker_tests_missing_or_failed", "child worker must provide passing focused test evidence", "child_output.test_results"));
  }
  if (!durableStatePass(output)) {
    issues.push(issue("child_worker_durable_state_missing", "child worker must update or return durable state evidence", "child_output.durable_state_updated"));
  }
  if (processHardening.required === true && processHardening.status !== "completed") {
    issues.push(issue("child_worker_process_hardening_incomplete", "required process hardening must be completed before acceptance", "child_output.process_hardening"));
  }
  if (continuationReadiness.ready !== true) {
    issues.push(issue("child_worker_continuation_not_ready", "child worker must declare continuation readiness", "child_output.continuation_readiness.ready"));
  }
  if (selfEvaluation.aligned !== true || selfEvaluation.drifted === true) {
    issues.push(issue("child_worker_self_evaluation_failed", "child worker self evaluation must confirm alignment and no drift", "child_output.self_evaluation"));
  }

  return {
    status: issues.length ? "fail" : "pass",
    issues,
    checked: {
      host_boundary: "platform_core",
      owned_files: changedFiles,
      test_count: testResults.length,
      durable_state: durableStatePass(output),
      process_hardening: processHardening.required === true ? processHardening.status : "not_required",
      continuation_ready: continuationReadiness.ready === true
    }
  };
}

function defaultChildWorkerOutput(workPackage = {}, options = {}) {
  const ownedFiles = compactStrings(workPackage.owned_files);
  return {
    status: "pass",
    role: CHILD_WORKER_ROLE,
    host: "platform_core",
    changed_files: ownedFiles.slice(0, Math.max(1, Number(options.changed_file_count || options.changedFileCount || 1))),
    test_results: compactStrings(options.acceptance_gates || ["node --test test/headless-cli-orchestrator.test.js"]).map((command) => ({
      command,
      status: "pass"
    })),
    durable_state_updated: true,
    process_hardening: { required: false, status: "not_required" },
    continuation_readiness: { ready: true },
    self_evaluation: {
      aligned: true,
      drifted: false,
      evidence_sufficient: true
    },
    completion_evidence: {
      summary: `bounded child worker completed ${workPackage.id || "work package"}`,
      owned_files: ownedFiles
    }
  };
}

function mockChildWorkerAllowed(options = {}) {
  return options.allow_mock_child_worker === true ||
    options.allowMockChildWorker === true ||
    normalizeToken(options.child_worker_mode || options.childWorkerMode) === "mock" ||
    normalizeToken(options.child_worker_execution_profile || options.childWorkerExecutionProfile) === "mock";
}

function missingChildWorkerOutput(workPackage = {}) {
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
    blocker: `child worker execution evidence is required for ${workPackage.id || "work package"}`,
    read_files: [],
    next_minimal_patch_position: "headless_cli.child_worker_execution",
    command_evidence: {
      executor_configured: false,
      mock_allowed: false,
      reason: "headless main orchestrator must not use implicit mock child output"
    }
  };
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

function parseJsonCandidate(text = "") {
  const value = normalizeString(text);
  if (!value) return null;
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced
    ? fenced[1].trim()
    : (() => {
        const objectStart = value.indexOf("{");
        const objectEnd = value.lastIndexOf("}");
        return objectStart >= 0 && objectEnd > objectStart ? value.slice(objectStart, objectEnd + 1) : value;
      })();
  try {
    const parsed = JSON.parse(candidate);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseHeadlessChildWorkerOutput(raw = {}) {
  if (isObject(raw)) return raw;
  return parseJsonCandidate(raw) || null;
}

export function headlessChildWorkerPrompt(workflowState = {}, workPackage = {}, options = {}) {
  const contextPack = workflowState?.manifest?.context_pack || {};
  const outputPath = normalizeString(options.child_worker_output_path_resolved || options.childWorkerOutputPathResolved) ||
    childWorkerCommandOutputPath(workPackage, {
      ...options,
      run_id: workflowState?.manifest?.run_id,
      cycle_id: workflowState?.manifest?.cycle_id
    });
  const outputPathInstructions = outputPath
    ? [
        "",
        "Final response protocol:",
        `- Write exactly one JSON object to child_worker_output_path: ${outputPath}`,
        "- Also print exactly the same JSON object as the final stdout content.",
        "- The JSON object must match the Required JSON shape above."
      ]
    : [];
  return [
    "# AI Control Platform Bounded Implementation Task",
    "",
    "role=bounded_implementation_worker",
    "host=platform_core",
    "Return exactly one JSON object. Do not wrap it in prose.",
    "",
    promptSafetyPreamble(),
    "",
    "You are not the coordinator. Only implement the bounded task.",
    "",
    "Required rules:",
    "- Read AGENTS.md, PROCESS.md, PROJECT_STATUS.json, PROJECT_RULES.md, docs/contracts/CODEX_PROXY_HANDOFF_CN.md, and this task context.",
    "- Do not read more than five extra files outside the task context unless you first report why.",
    "- First produce the minimum runnable diff, then explain design.",
    "- If no patch is possible within the time box, return status=fail with no_diff=true, blocker, read_files, and next_minimal_patch_position.",
    "- Do not modify managed projects, legacy directories, or files outside owned_files.",
    "- Do not create, switch to, or delegate into another worktree; the current working directory is the only execution root for this bounded child task.",
    "- Do not create .claude/worktrees or run claude --worktree; return status=fail if the current execution root is unsuitable.",
    "",
    "Required JSON shape:",
    JSON.stringify({
      status: "pass|fail",
      role: CHILD_WORKER_ROLE,
      host: "platform_core",
      changed_files: ["owned file path"],
      test_results: [{ command: "focused test command", status: "pass|fail" }],
      durable_state_updated: true,
      process_hardening: { required: false, status: "not_required|completed" },
      continuation_readiness: { ready: true },
      self_evaluation: { aligned: true, drifted: false, evidence_sufficient: true },
      blocker: null,
      read_files: [],
      next_minimal_patch_position: null
    }, null, 2),
    "",
    "Workflow identity:",
    JSON.stringify(promptSafeWorkflowIdentity(workflowState), null, 2),
    "",
    "Task context:",
    JSON.stringify(promptSafeContextPack(contextPack), null, 2),
    "",
    "Selected task:",
    JSON.stringify(promptSafeWorkPackage(workPackage), null, 2),
    "",
    "Acceptance gates:",
    JSON.stringify(compactStrings(options.acceptance_gates || contextPack.acceptance_gates), null, 2),
    ...outputPathInstructions
  ].join("\n");
}

function commandTemplateFrom(options = {}) {
  const provider = options.default_child_provider || options.defaultChildProvider || {};
  const command = normalizeString(
    options.child_worker_command ||
      options.childWorkerCommand ||
      provider.command ||
      options.default_child_worker_command ||
      options.defaultChildWorkerCommand
  );
  if (!command) return null;
  return {
    command,
    args: asArray(
      options.child_worker_args ||
        options.childWorkerArgs ||
        provider.args ||
        options.default_child_worker_args ||
        options.defaultChildWorkerArgs
    ).map(String),
    provider: normalizeString(provider.provider || options.default_child_provider_name || options.defaultChildProviderName) || "codex_proxy",
    model: normalizeString(provider.model || options.default_child_provider_model || options.defaultChildProviderModel) || "codex-cli",
    retry_policy: provider.retry_policy || provider.retryPolicy || options.child_worker_retry_policy || options.childWorkerRetryPolicy || {}
  };
}

function childWorkerTimeoutMs(options = {}) {
  const value = Number(options.child_worker_timeout_ms ?? options.childWorkerTimeoutMs ?? options.timeout_ms ?? options.timeoutMs);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_CHILD_WORKER_TIMEOUT_MS;
}

function maxChildWorkerAttempts(options = {}) {
  const template = commandTemplateFrom(options);
  const retryPolicy = template?.retry_policy || {};
  const value = Number(
    options.child_worker_max_attempts ??
      options.childWorkerMaxAttempts ??
      retryPolicy.max_attempts ??
      retryPolicy.maxAttempts ??
      1
  );
  return Number.isInteger(value) && value > 0 ? Math.min(value, 3) : 1;
}

function splitRetryEnabled(options = {}) {
  const template = commandTemplateFrom(options);
  const retryPolicy = template?.retry_policy || {};
  return options.child_worker_split_retry === true ||
    options.childWorkerSplitRetry === true ||
    retryPolicy.split_retry === true ||
    retryPolicy.splitRetry === true;
}

function childWorkerRunnerFrom(options = {}) {
  if (typeof options.child_worker_runner === "function") return options.child_worker_runner;
  if (typeof options.childWorkerRunner === "function") return options.childWorkerRunner;
  const template = commandTemplateFrom(options);
  if (!template) return null;
  return ({ prompt_file: promptFile, work_package: workPackage, workflow_state: workflowState, timeout_ms: timeoutMs, output_path: outputPath }) => {
    const resolvedOutputPath = resolvedChildWorkerOutputPath(outputPath) ||
      resolvedChildWorkerOutputPath(childWorkerCommandOutputPath(workPackage, {
        ...options,
        run_id: workflowState?.manifest?.run_id,
        cycle_id: workflowState?.manifest?.cycle_id
      })) ||
      "";
    const args = template.args.map((arg) => arg
      .replaceAll("{prompt_file}", promptFile)
      .replaceAll("{output_path}", resolvedOutputPath)
      .replaceAll("{work_package_id}", normalizeString(workPackage.id))
      .replaceAll("{run_id}", normalizeString(workflowState?.manifest?.run_id))
      .replaceAll("{cycle_id}", normalizeString(workflowState?.manifest?.cycle_id)));
    return spawnSync(template.command, args, {
      cwd: resolve(normalizeString(options.child_worker_cwd || options.childWorkerCwd) || process.cwd()),
      encoding: "utf8",
      timeout: timeoutMs,
      env: childWorkerProcessEnv(options)
    });
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
    return {
      ...parsed,
      command_evidence: {
        exit_code: exitCode,
        timed_out: timedOut,
        stdout_present: Boolean(stdout),
        stderr_present: Boolean(stderr),
        prompt_file: promptFile,
        output_path: outputPath
      }
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
      output_path: outputPath
    }
  };
}

function executeRealChildWorker(workflowState = {}, workPackage = {}, options = {}) {
  const runner = childWorkerRunnerFrom(options);
  if (!runner) return null;

  const tempDir = mkdtempSync(join(tmpdir(), "headless-child-worker-"));
  const promptFile = join(tempDir, "bounded-implementation-task.md");
  const outputPath = resolvedChildWorkerOutputPath(childWorkerCommandOutputPath(workPackage, {
    ...options,
    run_id: workflowState?.manifest?.run_id,
    cycle_id: workflowState?.manifest?.cycle_id
  }));
  if (outputPath) mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(promptFile, headlessChildWorkerPrompt(workflowState, workPackage, {
    ...options,
    child_worker_output_path_resolved: outputPath
  }));

  const timeoutMs = childWorkerTimeoutMs(options);
  const attempts = [];
  let normalized = null;
  for (let attemptIndex = 0; attemptIndex < maxChildWorkerAttempts(options); attemptIndex += 1) {
    let result;
    try {
      result = runner({
        workflow_state: workflowState,
        work_package: workPackage,
        prompt_file: promptFile,
        output_path: outputPath,
        timeout_ms: timeoutMs,
        attempt: attemptIndex + 1,
        split_retry: attemptIndex > 0 && splitRetryEnabled(options),
        options
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
    const template = commandTemplateFrom(options);
    if (template?.model && !normalizeString(normalized?.selected_model)) {
      normalized = {
        ...normalized,
        selected_model: template.model
      };
    }
    attempts.push({
      attempt: attemptIndex + 1,
      status: normalized.status || "fail",
      exit_code: normalized.command_evidence?.exit_code ?? null,
      timed_out: normalized.command_evidence?.timed_out === true,
      split_retry: attemptIndex > 0 && splitRetryEnabled(options)
    });
    if (evaluateHeadlessChildWorkerOutput(workPackage, normalized).status === "pass") break;
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
          ? defaultChildWorkerOutput(workPackage, {
              ...options,
              acceptance_gates: executionPlan?.package_plans?.find((plan) => plan.work_package_id === workPackage.id)
                ?.routing_request?.context_pack?.acceptance_gates
            })
          : missingChildWorkerOutput(workPackage));
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
        executor_kind: normalizeString(options.executor_kind || options.executorKind) || "codex_proxy_cli_worker",
        command_runner_kind: normalizeString(options.command_runner_kind || options.commandRunnerKind) ||
          (childWorkerRunnerFrom(options) ? "codex_proxy_child_process" : "codex_proxy"),
        provider: commandTemplateFrom(options)?.provider || normalizeString(options.provider) || "codex_proxy",
        model: commandTemplateFrom(options)?.model || normalizeString(options.model) || "codex-cli",
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

function processHardeningFindingFor(rejectedResults = []) {
  return {
    id: "headless-child-worker-acceptance-failed",
    status: "fail",
    category: "process_gap",
    severity: "p1",
    message: "Headless main orchestrator rejected child worker output; retry must first preserve the failure as a gate or regression.",
    enforcement_target: "src/workflow/headless-cli-orchestrator.js; test/headless-cli-orchestrator.test.js; docs/examples/process-hardening-current.json",
    regression_test: "headless CLI orchestrator hardens no-diff child worker output before retry",
    verification: "node --test test/headless-cli-orchestrator.test.js; npm run check:process-hardening; npm run check:closeout",
    hardening_status: "completed",
    rejected_results: rejectedResults
  };
}

function recordHeadlessProcessHardening(workflowState = {}, rejectedResults = [], options = {}) {
  const createdAt = normalizeString(options.created_at || options.createdAt) || new Date().toISOString();
  const finding = processHardeningFindingFor(rejectedResults);
  const plan = createProcessHardeningPlan({
    run_id: workflowState?.manifest?.run_id,
    cycle_id: workflowState?.manifest?.cycle_id,
    findings: [finding]
  });
  const id = normalizeString(options.process_hardening_artifact_id || options.processHardeningArtifactId) ||
    `headless-process-hardening-${safeIdPart(workflowState?.manifest?.run_id)}-${safeIdPart(workflowState?.manifest?.cycle_id)}-001`;
  const artifact = {
    id,
    type: "evaluation",
    status: "pass",
    uri: `headless-cli://process-hardening/${encodeURIComponent(workflowState?.manifest?.run_id || "unknown")}/${encodeURIComponent(workflowState?.manifest?.cycle_id || "unknown")}`,
    producer: "headless-cli-orchestrator",
    created_at: createdAt,
    metadata: {
      version: HEADLESS_CLI_ORCHESTRATOR_VERSION,
      type: "headless_cli_process_hardening",
      status: "completed",
      finding,
      plan
    }
  };
  const manifest = appendRunEvent(workflowState.manifest, {
    id: `event-${id}`,
    type: "headless_cli_process_hardening",
    status: "completed",
    artifact_id: id,
    message: "headless child worker failure was converted into process-hardening evidence before retry",
    created_at: createdAt,
    metadata: artifact.metadata
  });
  const baseLedger = workflowState.artifact_ledger || workflowState.artifactLedger || {};
  const artifactLedger = recordArtifact({
    ...baseLedger,
    artifacts: Array.isArray(baseLedger.artifacts) ? baseLedger.artifacts : []
  }, artifact);

  return {
    status: "pass",
    finding,
    plan,
    workflow_state: {
      ...workflowState,
      manifest: {
        ...manifest,
        review_findings: [...asArray(manifest.review_findings), finding],
        artifacts: [...asArray(manifest.artifacts), artifact]
      },
      artifact_ledger: artifactLedger
    }
  };
}

function rejectedPackageResults(runResult = {}) {
  return asArray(runResult.package_results)
    .filter((result) => normalizeToken(result?.status) !== "pass");
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

function snapshotPersistenceConfig(options = {}) {
  const historyPath = normalizeString(options.projection_history_path || options.projectionHistoryPath || options.history_path || options.historyPath);
  const snapshotsRoot = normalizeString(options.snapshots_root || options.snapshotsRoot);
  if (!historyPath && !snapshotsRoot) {
    return {
      status: "not_configured",
      issues: []
    };
  }
  const issues = [];
  if (!historyPath) {
    issues.push(issue("missing_projection_history_path", "projection history path is required when headless snapshot persistence is configured", "projection_history_path"));
  }
  if (!snapshotsRoot) {
    issues.push(issue("missing_snapshots_root", "snapshots root is required when headless snapshot persistence is configured", "snapshots_root"));
  }
  return {
    status: issues.length ? "fail" : "configured",
    issues,
    root: normalizeString(options.root) || process.cwd(),
    history_path: historyPath,
    snapshots_root: snapshotsRoot
  };
}

function headlessSnapshotId(workflowState = {}, options = {}) {
  const explicit = normalizeString(options.snapshot_id || options.snapshotId);
  if (explicit) return safeIdPart(explicit).slice(0, 80);
  const prefix = normalizeString(options.snapshot_prefix || options.snapshotPrefix) || "headless-cli";
  return `${safeIdPart(prefix)}-${safeIdPart(workflowState?.manifest?.cycle_id)}`.slice(0, 80);
}

function headlessSnapshotArtifact(snapshotId, result = {}, options = {}) {
  const createdAt = normalizeString(options.created_at || options.createdAt) || new Date().toISOString();
  const status = result.status === "created" ? "pass" : "fail";
  return {
    id: `headless-cli-snapshot-${snapshotId}`,
    type: "evaluation",
    status,
    path: result.item?.input_path || undefined,
    uri: result.item?.input_path ? undefined : `workbench://snapshot/${snapshotId}`,
    producer: "headless-cli-orchestrator",
    created_at: createdAt,
    metadata: {
      version: HEADLESS_CLI_ORCHESTRATOR_VERSION,
      type: "headless_cli_snapshot_publish",
      snapshot_id: snapshotId,
      publish_status: result.status,
      projection_status: result.projection?.status || null,
      history_latest: result.history?.latest || null,
      issues: result.issues || []
    }
  };
}

function recordHeadlessSnapshotEvidence(workflowState = {}, snapshotId, result = {}, options = {}) {
  const artifact = headlessSnapshotArtifact(snapshotId, result, options);
  const manifest = appendRunEvent(workflowState.manifest, {
    id: `event-${artifact.id}`,
    type: "headless_cli_snapshot_publish",
    status: result.status === "created" ? "created" : "fail",
    artifact_id: artifact.id,
    snapshot_id: snapshotId,
    message: result.status === "created"
      ? "headless CLI workflow snapshot published"
      : "headless CLI workflow snapshot publish failed",
    created_at: artifact.created_at,
    metadata: artifact.metadata
  });
  const baseLedger = workflowState.artifact_ledger || workflowState.artifactLedger || {};
  const artifactLedger = recordArtifact({
    ...baseLedger,
    artifacts: Array.isArray(baseLedger.artifacts)
      ? baseLedger.artifacts.filter((item) => item.id !== artifact.id)
      : []
  }, artifact);

  return {
    ...workflowState,
    manifest: {
      ...manifest,
      artifacts: [...asArray(manifest.artifacts).filter((item) => item.id !== artifact.id), artifact]
    },
    artifact_ledger: artifactLedger
  };
}

function publishHeadlessWorkflowSnapshot(workflowState = {}, options = {}) {
  const config = snapshotPersistenceConfig(options);
  if (config.status !== "configured") {
    return {
      status: config.status,
      issues: config.issues,
      workflow_state: workflowState
    };
  }

  const snapshotId = headlessSnapshotId(workflowState, options);
  const basePlan = {
    id: snapshotId,
    label: normalizeString(options.snapshot_label || options.snapshotLabel) || "Headless CLI orchestrator cycle",
    input: workflowState,
    created_at: normalizeString(options.created_at || options.createdAt) || new Date().toISOString()
  };
  const initial = publishWorkbenchSnapshot(basePlan, {
    root: config.root,
    historyPath: config.history_path,
    snapshotsRoot: config.snapshots_root
  });
  if (initial.status !== "created") {
    return {
      status: "fail",
      issues: initial.issues || [],
      item: initial.item,
      projection: initial.projection,
      workflow_state: workflowState,
      initial_publish: initial
    };
  }

  const evidencedWorkflowState = recordHeadlessSnapshotEvidence(workflowState, snapshotId, initial, options);
  const evidence = publishWorkbenchSnapshot({
    ...basePlan,
    input: evidencedWorkflowState
  }, {
    root: config.root,
    historyPath: config.history_path,
    snapshotsRoot: config.snapshots_root
  });
  if (evidence.status !== "created") {
    return {
      status: "fail",
      issues: evidence.issues || [],
      item: evidence.item,
      projection: evidence.projection,
      workflow_state: evidencedWorkflowState,
      initial_publish: initial,
      evidence_snapshot_publish: evidence
    };
  }

  return {
    status: "created",
    issues: [],
    item: evidence.item,
    projection: evidence.projection,
    workflow_state: evidencedWorkflowState,
    snapshot_path: evidence.snapshot_path,
    history: evidence.history,
    initial_publish: initial,
    evidence_snapshot_publish: evidence
  };
}

function boundedHeadlessLoopIterations(value) {
  const parsed = Number(value || 1);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_HEADLESS_LOOP_ITERATIONS) {
    return {
      status: "fail",
      value: null,
      issues: [issue(
        "invalid_headless_loop_iterations",
        `max_iterations must be an integer between 1 and ${MAX_HEADLESS_LOOP_ITERATIONS}`,
        "max_iterations"
      )]
    };
  }
  return { status: "pass", value: parsed, issues: [] };
}

function projectedNextActionRunnerFrom(options = {}) {
  if (typeof options.projected_next_action_runner === "function") return options.projected_next_action_runner;
  if (typeof options.projectedNextActionRunner === "function") return options.projectedNextActionRunner;
  return workbenchNextActionRunnerFrom(options);
}

function projectedNextActionMode(options = {}) {
  return normalizeString(options.execution_strategy || options.executionStrategy) === "projected_next_action" ||
    normalizeString(options.headless_loop_strategy || options.headlessLoopStrategy) === "projected_next_action";
}

function isTerminalProjectedAction(action = "") {
  return !action ||
    action === "wait_for_driver_event" ||
    action === "inspect_scheduler_loop" ||
    action === "inspect_resume_target" ||
    action === "inspect_latest_driver";
}

function projectedActionProgressEvidence(result = {}) {
  return Boolean(
    result?.workflow_state ||
      result?.workflowState ||
      result?.projection ||
      result?.result?.projection ||
      result?.result?.current_projection ||
      result?.result?.next_item?.id ||
      result?.next_item?.id
  );
}

function localWorkbenchBaseUrl(value = "") {
  const text = normalizeString(value);
  if (!text) return null;
  const url = new URL(text);
  const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  if (url.protocol !== "http:" || !localHosts.has(url.hostname)) {
    const error = new Error("headless projected next-action workbench base url must be local http");
    error.code = "INVALID_WORKBENCH_BASE_URL";
    throw error;
  }
  return url;
}

function requestJsonSync(url, body = null, options = {}) {
  const timeoutMs = Number(options.timeout_ms || options.timeoutMs || 30000);
  const method = normalizeString(options.method).toUpperCase() || (body === null ? "GET" : "POST");
  const payload = body === null ? "" : JSON.stringify(body);
  const script = [
    "const http = await import('node:http');",
    "const https = await import('node:https');",
    "const url = process.argv[1];",
    "const method = process.argv[2] || 'GET';",
    "const body = process.argv[3] || '';",
    "const timeoutMs = Number(process.argv[4] || 30000);",
    "const target = new URL(url);",
    "const transport = target.protocol === 'https:' ? https : http;",
    "const result = await new Promise((resolveRequest, rejectRequest) => {",
    "  const headers = body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {};",
    "  const req = transport.request(target, { method, headers }, (res) => {",
    "    let text = '';",
    "    res.setEncoding('utf8');",
    "    res.on('data', (chunk) => { text += chunk; });",
    "    res.on('end', () => resolveRequest({ statusCode: res.statusCode || 0, text }));",
    "  });",
    "  req.setTimeout(timeoutMs, () => req.destroy(new Error('workbench request timed out')));",
    "  req.on('error', rejectRequest);",
    "  req.write(body);",
    "  req.end();",
    "});",
    "if (result.statusCode < 200 || result.statusCode >= 300) { console.error(result.text); process.exit(result.statusCode || 1); }",
    "process.stdout.write(result.text);"
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, url.toString(), method, payload, String(timeoutMs)], {
    encoding: "utf8",
    timeout: timeoutMs + 1000
  });
  if (result.status !== 0) {
    const error = new Error(normalizeString(result.stderr) || normalizeString(result.stdout) || `workbench request failed: ${result.status}`);
    error.status = result.status;
    throw error;
  }
  return JSON.parse(result.stdout || "{}");
}

function postJsonSync(url, body = {}, options = {}) {
  return requestJsonSync(url, body, { ...options, method: "POST" });
}

function getJsonSync(url, options = {}) {
  return requestJsonSync(url, null, { ...options, method: "GET" });
}

function workbenchProjectionFrom(options = {}) {
  const loader = typeof options.workbench_projection_loader === "function"
    ? options.workbench_projection_loader
    : typeof options.workbenchProjectionLoader === "function"
      ? options.workbenchProjectionLoader
      : null;
  if (loader) {
    return loader(options);
  }
  const baseValue = normalizeString(options.workbench_base_url || options.workbenchBaseUrl);
  if (!baseValue) return null;
  const base = localWorkbenchBaseUrl(baseValue);
  const projectionId = normalizeString(
    options.current_workbench_projection_id ||
      options.currentWorkbenchProjectionId ||
      options.workbench_projection_id ||
      options.workbenchProjectionId
  );
  const url = new URL("/api/workbench/projection", base);
  if (projectionId) url.searchParams.set("id", projectionId);
  return getJsonSync(url, {
    timeout_ms: options.workbench_request_timeout_ms || options.workbenchRequestTimeoutMs
  });
}

function workbenchNextActionRunnerFrom(options = {}) {
  const baseValue = normalizeString(options.workbench_base_url || options.workbenchBaseUrl);
  if (!baseValue) return null;
  const base = localWorkbenchBaseUrl(baseValue);
  return ({ action, iteration }) => {
    const url = new URL("/api/workbench/next-action", base);
    const projectionId = normalizeString(
      options.current_workbench_projection_id ||
        options.currentWorkbenchProjectionId ||
        options.workbench_projection_id ||
        options.workbenchProjectionId
    );
    if (projectionId) url.searchParams.set("id", projectionId);
    const body = {
      expected_action: action,
      max_iterations: 1,
      snapshot_prefix: normalizeString(options.snapshot_prefix || options.snapshotPrefix) || "headless-projected-action",
      created_at: normalizeString(options.created_at || options.createdAt),
      iteration
    };
    const reviewerOrSchedulerAction = new Set([
      "run_reviewer_scope_shard",
      "run_autonomous_scheduler_loop",
      "resume_autonomous_scheduler_loop",
      "enqueue_scheduler_next_cycle"
    ]).has(action);
    const contextExecutionProfile = options.context_work_package_execution_profile || options.contextWorkPackageExecutionProfile;
    for (const [target, source] of [
      ["execution_profile", action === "run_context_work_packages"
        ? contextExecutionProfile
        : reviewerOrSchedulerAction
          ? (options.execution_profile || options.executionProfile)
          : undefined],
      [
        "context_work_package_execution_profile",
        options.context_work_package_execution_profile || options.contextWorkPackageExecutionProfile
      ],
      ["reviewer_mock_status", options.reviewer_mock_status || options.reviewerMockStatus],
      ["reviewer_mock_findings_json", options.reviewer_mock_findings_json || options.reviewerMockFindingsJson],
      ["max_external_reviewer_calls", options.max_external_reviewer_calls ?? options.maxExternalReviewerCalls],
      ["provider_cost_mode", options.provider_cost_mode || options.providerCostMode],
      ["budget_tier", options.budget_tier || options.budgetTier],
      ["risk", options.risk || options.risk_level || options.riskLevel],
      ["timeout_seconds", options.timeout_seconds || options.timeoutSeconds],
      ["record_provider_health_on_timeout", options.record_provider_health_on_timeout ?? options.recordProviderHealthOnTimeout],
      ["provider_smoke_status", options.provider_smoke_status || options.providerSmokeStatus]
    ]) {
      if (source !== undefined && source !== null && source !== "") body[target] = source;
    }
    const result = postJsonSync(url, body, {
      timeout_ms: options.workbench_request_timeout_ms || options.workbenchRequestTimeoutMs
    });
    return {
      status: result.status || "executed",
      action: result.action || action,
      result,
      projection: result.projection || result.result?.projection || null,
      next_item: result.next_item || result.result?.next_item || null
    };
  };
}

function executeHeadlessProjectedNextAction(run = {}, options = {}, index = 0) {
  if (!projectedNextActionMode(options)) {
    return {
      status: "not_configured",
      workflow_state: run.workflow_state,
      projection: run.projection
    };
  }

  if (normalizeString(options.workbench_base_url || options.workbenchBaseUrl)) {
    localWorkbenchBaseUrl(options.workbench_base_url || options.workbenchBaseUrl);
  }

  let serviceProjection = null;
  if (!options.projected_next_action_readout && !options.projectedNextActionReadout) {
    try {
      serviceProjection = workbenchProjectionFrom(options);
    } catch (error) {
      if (normalizeString(options.workbench_base_url || options.workbenchBaseUrl)) {
        return {
          status: "blocked",
          action: null,
          issues: [
            issue(
              "projected_service_projection_unavailable",
              error.message,
              "workbench_projection"
            )
          ],
          workflow_state: run.workflow_state,
          projection: run.projection
        };
      }
    }
  }
  const readout = options.projected_next_action_readout ||
    options.projectedNextActionReadout ||
    serviceProjection?.next_action_readout ||
    run.projection?.next_action_readout ||
    {};
  const action = normalizeString(readout.action);
  if (readout.status !== "ready" || isTerminalProjectedAction(action)) {
    return {
      status: "stopped",
      action,
      reason: readout.reason || "projected next action is terminal or not ready",
      workflow_state: run.workflow_state,
      projection: run.projection
    };
  }
  const runner = projectedNextActionRunnerFrom(options);
  if (!runner) {
    return {
      status: "not_configured",
      workflow_state: run.workflow_state,
      projection: run.projection
    };
  }
  if (!HEADLESS_PROJECTED_NEXT_ACTIONS.has(action)) {
    return {
      status: "blocked",
      action,
      issues: [issue("unsupported_projected_next_action", `${action || "none"} is not in the headless projected action allowlist`, "projection.next_action_readout.action")],
      workflow_state: run.workflow_state,
      projection: run.projection
    };
  }

  let result;
  try {
    result = runner({
      action,
      projection: run.projection,
      workflow_state: run.workflow_state,
      expected_action: action,
      iteration: index + 1,
      options
    });
  } catch (error) {
    return {
      status: "blocked",
      action,
      issues: [issue("projected_next_action_runner_failed", error.message, "projected_next_action_runner")],
      workflow_state: run.workflow_state,
      projection: run.projection
    };
  }

  if (!projectedActionProgressEvidence(result)) {
    return {
      status: "blocked",
      action,
      result,
      issues: [issue("projected_action_missing_progress_evidence", "projected next-action execution must return workflow_state, projection, or next_item.id", "projected_next_action_result")],
      workflow_state: run.workflow_state,
      projection: run.projection
    };
  }

  return {
    status: result.status || "executed",
    action,
    result,
    workflow_state: result.workflow_state || result.workflowState || run.workflow_state,
    projection: result.projection || result.result?.projection || result.result?.current_projection || serviceProjection || run.projection,
    next_projection_id: result.result?.next_item?.id || result.next_item?.id || null
  };
}

function nextProjectedActionOptions(options = {}, projectedAction = {}) {
  const nextProjectionId = normalizeString(projectedAction.next_projection_id);
  if (!nextProjectionId) {
    return {
      ...options,
      projected_next_action_readout: null,
      projectedNextActionReadout: null
    };
  }
  return {
    ...options,
    workbench_projection_id: nextProjectionId,
    workbenchProjectionId: nextProjectionId,
    projected_next_action_readout: null,
    projectedNextActionReadout: null
  };
}

function serviceProjectedActionConfigured(options = {}) {
  return projectedNextActionMode(options) &&
    Boolean(normalizeString(options.workbench_base_url || options.workbenchBaseUrl));
}

function recordHeadlessProjectedActionProgress(workflowState = {}, projectedAction = {}, options = {}) {
  if (projectedAction.status === "not_configured") {
    return {
      status: "not_configured",
      workflow_state: workflowState
    };
  }

  const createdAt = normalizeString(options.created_at || options.createdAt) || new Date().toISOString();
  const id = normalizeString(options.projected_action_artifact_id || options.projectedActionArtifactId) ||
    `headless-projected-action-${safeIdPart(workflowState?.manifest?.run_id)}-${safeIdPart(workflowState?.manifest?.cycle_id)}-${safeIdPart(projectedAction.action || projectedAction.status)}-001`;
  const artifact = {
    id,
    type: "evaluation",
    status: projectedAction.status === "blocked" ? "fail" : "pass",
    uri: `headless-cli://projected-action/${encodeURIComponent(workflowState?.manifest?.run_id || "unknown")}/${encodeURIComponent(workflowState?.manifest?.cycle_id || "unknown")}/${encodeURIComponent(id)}`,
    producer: "headless-cli-orchestrator",
    created_at: createdAt,
    metadata: {
      version: HEADLESS_CLI_ORCHESTRATOR_VERSION,
      type: "headless_projected_action_progress",
      status: projectedAction.status,
      action: projectedAction.action || null,
      terminal_action: projectedAction.status === "stopped" ? projectedAction.action || null : null,
      terminal_reason: projectedAction.status === "stopped" ? projectedAction.reason || null : null,
      next_projection_id: projectedAction.next_projection_id || projectedAction.result?.result?.next_item?.id || projectedAction.result?.next_item?.id || null,
      has_workflow_state: isObject(projectedAction.workflow_state || projectedAction.workflowState),
      has_projection: isObject(projectedAction.projection),
      issues: asArray(projectedAction.issues),
      result_status: projectedAction.result?.status || null
    }
  };
  const manifest = appendRunEvent(workflowState.manifest, {
    id: `event-${id}`,
    type: "headless_projected_action_progress",
    status: artifact.status,
    artifact_id: id,
    message: `headless projected next-action ${projectedAction.action || "unknown"} ${projectedAction.status}`,
    created_at: createdAt,
    metadata: artifact.metadata
  });
  const baseLedger = workflowState.artifact_ledger || workflowState.artifactLedger || {};
  const artifactLedger = recordArtifact({
    ...baseLedger,
    artifacts: Array.isArray(baseLedger.artifacts) ? baseLedger.artifacts : []
  }, artifact);

  return {
    status: "pass",
    artifact,
    workflow_state: {
      ...workflowState,
      manifest: {
        ...manifest,
        artifacts: [...asArray(manifest.artifacts), artifact]
      },
      artifact_ledger: artifactLedger
    }
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

  if (hasMaterializedContextCycle(workflowState) && selectedWorkPackages(workflowState, options).length > 0) {
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

  const selected = selectedWorkPackages(workflowState, options);
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

  const spawned = recordLifecycleFacts(workflowState, spawnFactsFor(workflowState, selected, { ...options, created_at: createdAt }));
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
      workflow_state: snapshotPublish.workflow_state || workflowState
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
