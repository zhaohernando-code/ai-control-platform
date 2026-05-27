#!/usr/bin/env node
import { createServer, request as httpRequest } from "node:http";
import { spawnSync } from "node:child_process";
import { dirname, extname, isAbsolute, normalize, relative, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { createWorkbenchProjection } from "../src/workflow/workbench-projection.js";
import { publishWorkbenchSnapshot, snapshotIssues } from "../src/workflow/workbench-snapshots.js";
import { createSchedulerDispatchPlan } from "../src/workflow/scheduler-dispatch-plan.js";
import {
  evaluateSchedulerDispatchControlPolicy,
  normalizeSchedulerDispatchControlRequest,
  recordSchedulerDispatchPolicyDecision
} from "../src/workflow/scheduler-dispatch-policy.js";
import { recordReviewerProviderHealthFact } from "../src/workflow/reviewer-provider-health.js";
import {
  recordReviewerShardAggregate,
  recordReviewerShardResult
} from "../src/workflow/reviewer-shard-results.js";
import {
  cleanupAgentLifecyclePool,
  recordAgentLifecycleFact
} from "../src/workflow/agent-lifecycle-pool.js";
import {
  createSchedulerDispatchRunArtifact,
  recordSchedulerDispatchRunArtifact,
  runSchedulerDispatchPlan
} from "../src/workflow/scheduler-dispatch-runner.js";
import {
  prepareSchedulerDispatchContinuationFromRunArtifact,
  recordSchedulerDispatchContinuationPrepared,
  recordSchedulerNextCycleEnqueue
} from "../src/workflow/scheduler-dispatch-continuation.js";
import {
  buildSchedulerLoopRunRegistry,
  createSchedulerLoopRunArtifact,
  evaluateSchedulerLoopRecovery,
  recordAutonomousSchedulerLoopRunArtifact,
  recordSchedulerLoopResumeAttempt,
  runSchedulerLoopDriver
} from "../src/workflow/autonomous-scheduler-loop.js";
import { runReviewerShard } from "../src/workflow/reviewer-shard-runner.js";
import { createClaudeDeepSeekShardExecutor } from "../src/workflow/claude-deepseek-shard-executor.js";
import {
  evaluateReviewerExecutionPolicy,
  evaluateReviewerProviderHealthPreflight
} from "../src/workflow/reviewer-execution-policy.js";
import { recordWorkbenchBrowserEventsRunArtifact } from "../src/workflow/workbench-browser-events.js";
import { recordGovernanceAuditSkillTrialRunArtifact } from "../src/workflow/governance-audit-skill-trial.js";
import {
  prepareContinuationFromProjectStatus,
  recordProjectStatusContinuationPrepared
} from "../src/workflow/project-status-continuation.js";
import { materializeContextPackCycleFromWorkflowState } from "../src/workflow/context-pack-cycle.js";
import { runContextWorkPackages } from "../src/workflow/context-work-package-runner.js";
import { VERIFIED_PROVIDER_MULTI_AGENT_PROFILE } from "../src/workflow/context-work-package-execution-adapter.js";
import { createHeadlessProviderExecutor } from "../src/workflow/headless-cli-orchestrator.js";
import {
  applyGeneratedRequirementPlan,
  createRequirementPlanPrompt,
  markRequirementPlanGenerationFailed,
  parseRequirementPlanGenerationOutput,
  recordRequirementIntakeSubmitted,
  submitRequirementToProjectStatus,
  updateRequirementPlanReview
} from "../src/workflow/requirement-intake.js";
import {
  createSqliteWorkbenchStateStore,
  isSqliteSnapshotPath,
  sqliteSnapshotIdFromInputPath,
  sqliteSnapshotInputPath
} from "../src/workflow/workbench-state-store.js";

const root = resolve(process.cwd());
const historyPath = resolve(root, "docs/examples/projection-history.json");
const defaultEventsPath = resolve(root, "docs/examples/operator-events.json");
const defaultProjectStatusPath = resolve(root, "PROJECT_STATUS.json");
const examplesRoot = resolve(root, "docs/examples");
const defaultSnapshotsRoot = resolve(root, "tmp/workbench-snapshots");
const defaultStateDbPath = resolve(process.env.HOME || "/Users/hernando_zhao", "codex/runtime/ai-control-platform/workbench-state/workbench-state.sqlite");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon"
};

function jsonResponse(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readProjectStatus(projectStatusPath = null, stateStore = null) {
  if (stateStore) return stateStore.readProjectStatus();
  return projectStatusPath ? readJson(projectStatusPath) : null;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function writeProjectStatusState(projectStatusPath = null, projectStatus = {}, stateStore = null) {
  if (stateStore) return stateStore.writeProjectStatus(projectStatus);
  if (!projectStatusPath) return null;
  return writeJson(projectStatusPath, projectStatus);
}

/**
 * Create an initial workflow state with all required identity fields and
 * validation contracts (manifest/artifact_ledger run_id/cycle_id, model_plan,
 * operator_event_ledger). Used when there is no existing workflow snapshot
 * to bootstrap from.
 */
function createInitialWorkflowState(runId, cycleId, projectStatusPath = null, stateStore = null) {
  return {
    run_id: runId,
    cycle_id: cycleId,
    status: "pending",
    manifest: {
      run_id: runId,
      cycle_id: cycleId,
      events: [],
      artifacts: []
    },
    artifact_ledger: {
      run_id: runId,
      cycle_id: cycleId,
      artifacts: []
    },
    model_plan: {
      selected_model: "deepseek-v4-pro[1m]",
      routes: []
    },
    reviewer_gate: { findings: [] },
    operator_event_ledger: {
      run_id: runId,
      cycle_id: cycleId,
      events: []
    },
    project_status: readProjectStatus(projectStatusPath, stateStore) || {}
  };
}

function projectionInputWithProjectStatus(input = {}, projectStatusPath = null, stateStore = null) {
  const projectStatus = readProjectStatus(projectStatusPath, stateStore);
  if (!projectStatus) return input;
  return {
    ...input,
    project_status: projectStatus,
    global_goals: Array.isArray(projectStatus.global_goals) ? projectStatus.global_goals : input.global_goals
  };
}

function isWithinPath(basePath, filePath) {
  return filePath === basePath || filePath.startsWith(`${basePath}/`);
}

function historyItemPath(itemPath, field, allowedRoots = [examplesRoot, defaultSnapshotsRoot]) {
  if (!itemPath) return null;
  if (typeof itemPath !== "string" || isAbsolute(itemPath)) {
    const error = new Error(`${field} must be a relative workbench history path`);
    error.code = "INVALID_HISTORY_PATH";
    throw error;
  }

  const filePath = resolve(root, itemPath);
  if (!allowedRoots.some((allowedRoot) => isWithinPath(allowedRoot, filePath))) {
    const error = new Error(`${field} must stay under allowed workbench history roots`);
    error.code = "INVALID_HISTORY_PATH";
    throw error;
  }

  return filePath;
}

function readWorkflowStateFromItem(item = {}, allowedRoots = [examplesRoot, defaultSnapshotsRoot], stateStore = null) {
  if (stateStore) {
    if (isSqliteSnapshotPath(item.input_path)) {
      return stateStore.readWorkflowSnapshot(sqliteSnapshotIdFromInputPath(item.input_path));
    }
    return requireSqliteWorkflowSnapshot();
  }
  return readJson(historyItemPath(item.input_path, "input_path", allowedRoots));
}

function writeWorkflowStateToItem(item = {}, workflowState = {}, allowedRoots = [examplesRoot, defaultSnapshotsRoot], stateStore = null) {
  if (stateStore) {
    if (isSqliteSnapshotPath(item.input_path)) {
      return stateStore.writeWorkflowSnapshot(sqliteSnapshotIdFromInputPath(item.input_path), workflowState, item);
    }
    return requireSqliteWorkflowSnapshot();
  }
  const inputPath = historyItemPath(item.input_path, "input_path", allowedRoots);
  writeJson(inputPath, workflowState);
  return inputPath;
}

function projectionById(id = null, history = readJson(historyPath), allowedRoots = [examplesRoot, defaultSnapshotsRoot], projectStatusPath = null, stateStore = null) {
  const selectedId = id || history.latest;
  const item = history.items.find((entry) => entry.id === selectedId);

  // If no item found and history is empty, generate initial projection for new submissions
  if (!item) {
    if (history.items.length === 0 && !selectedId) {
      // First-time state: empty history, create initial projection
      const runId = `initial-workbench-${Date.now()}`;
      const cycleId = `initial-cycle-${Date.now()}`;
      const initialWorkflowState = createInitialWorkflowState(runId, cycleId, projectStatusPath, stateStore);
      return {
        history,
        item: null,
        projection: createWorkbenchProjection(initialWorkflowState)
      };
    }

    const error = new Error(`projection not found: ${selectedId}`);
    error.code = "PROJECTION_NOT_FOUND";
    throw error;
  }

  return {
    history,
    item,
    projection: item.input_path
      ? createWorkbenchProjection(projectionInputWithProjectStatus(readWorkflowStateFromItem(item, allowedRoots, stateStore), projectStatusPath, stateStore))
      : stateStore
        ? requireSqliteWorkflowSnapshot()
        : readJson(historyItemPath(item.projection_path, "projection_path", allowedRoots))
  };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function safeSnapshotIdPart(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "snapshot";
}

function requireSqliteWorkflowSnapshot() {
  const error = new Error("SQLite workbench state requires workflow snapshots");
  error.code = "WORKFLOW_SNAPSHOT_REQUIRED";
  throw error;
}

function generatedContextPackSnapshotId(selectedId) {
  return `context-pack-cycle-${safeSnapshotIdPart(selectedId)}-${Date.now()}`.slice(0, 80);
}

function requirementAutoAdvanceEnabled(input = {}) {
  return input.auto_advance !== false && input.autoAdvance !== false;
}

function requirementPlanGenerationRequested(input = {}) {
  return input.generate_plan === true ||
    input.generatePlan === true ||
    input.plan_generation_mode === "model" ||
    input.planGenerationMode === "model" ||
    Boolean(input.generated_plan || input.generatedPlan);
}

function defaultRequirementPlanGenerator(input = {}) {
  const script = normalizeString(
    input.requirement_plan_command ||
      input.requirementPlanCommand ||
      process.env.AI_CONTROL_WORKBENCH_REQUIREMENT_PLAN_COMMAND ||
      "/Users/hernando_zhao/codex/start-claude-deepseek-no-proxy.sh"
  );
  if (!script || !existsSync(script)) return null;
  const model = normalizeString(
    input.requirement_plan_model ||
      input.requirementPlanModel ||
      process.env.AI_CONTROL_WORKBENCH_REQUIREMENT_PLAN_MODEL ||
      "deepseek-v4-pro[1m]"
  );
  const role = normalizeString(
    input.requirement_plan_role ||
      input.requirementPlanRole ||
      process.env.AI_CONTROL_WORKBENCH_REQUIREMENT_PLAN_ROLE ||
      "manager"
  );
  const timeoutMs = Number(
    input.requirement_plan_timeout_ms ||
      input.requirementPlanTimeoutMs ||
      process.env.AI_CONTROL_WORKBENCH_REQUIREMENT_PLAN_TIMEOUT_MS ||
      180000
  );
  const childPath = [
    process.env.PATH,
    "/Users/hernando_zhao/.local/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin"
  ].filter(Boolean).join(":");
  const supportsModelArg = normalizeString(
    input.requirement_plan_command_supports_model_arg ||
      input.requirementPlanCommandSupportsModelArg ||
      process.env.AI_CONTROL_WORKBENCH_REQUIREMENT_PLAN_COMMAND_SUPPORTS_MODEL_ARG ||
      (/start-claude-deepseek/i.test(script) ? "0" : "1")
  ) !== "0";
  const supportsRoleArg = normalizeString(
    input.requirement_plan_command_supports_role_arg ||
      input.requirementPlanCommandSupportsRoleArg ||
      process.env.AI_CONTROL_WORKBENCH_REQUIREMENT_PLAN_COMMAND_SUPPORTS_ROLE_ARG ||
      (/start-claude-deepseek/i.test(script) ? "0" : "1")
  ) !== "0";

  return async ({ requirement }) => {
    const prompt = createRequirementPlanPrompt(requirement);
    const args = [];
    if (supportsModelArg) args.push("-m", model);
    if (supportsRoleArg) args.push("--role", role);
    args.push("-p", prompt);
    const result = spawnSync(script, args, {
      cwd: root,
      encoding: "utf8",
      timeout: Number.isFinite(timeoutMs) ? timeoutMs : 180000,
      env: {
        ...process.env,
        HOME: process.env.HOME || "/Users/hernando_zhao",
        PATH: childPath
      }
    });
    const stdout = result.stdout || "";
    const stderr = result.stderr || result.error?.message || "";
    return {
      status: result.status === 0 && !result.error && normalizeString(stdout) ? "pass" : "fail",
      stdout,
      stderr,
      generator: {
        kind: /start-claude-deepseek/i.test(script) ? "claude_deepseek_plan_mode" : "claude_plan_mode",
        command: script,
        role,
        model,
        supports_model_arg: supportsModelArg,
        supports_role_arg: supportsRoleArg,
        exit_code: result.status ?? null,
        timed_out: result.error?.code === "ETIMEDOUT"
      }
    };
  };
}

async function generateRequirementPlanIfRequested(submitted = {}, input = {}, options = {}) {
  const createdAt = input.created_at || input.createdAt;
  const failedSubmission = (issues = [], extra = {}) => {
    const marked = markRequirementPlanGenerationFailed(submitted.project_status, {
      requirement_id: submitted.requirement.id,
      issues,
      ...extra
    }, {
      created_at: createdAt
    });
    return marked.status === "pass"
      ? { ...submitted, plan_review: marked.plan_review, project_status: marked.project_status }
      : submitted;
  };

  if (!requirementPlanGenerationRequested(input)) {
    return {
      status: "not_requested",
      submission: submitted,
      issues: []
    };
  }

  const directPlan = input.generated_plan || input.generatedPlan;
  if (directPlan) {
    const applied = applyGeneratedRequirementPlan(submitted.project_status, {
      requirement_id: submitted.requirement.id,
      generated_plan: directPlan,
      generator: input.generator || { kind: "provided_generated_plan" }
    }, {
      created_at: input.created_at || input.createdAt
    });
    return {
      status: applied.status === "pass" ? "pass" : "fail",
      submission: applied.status === "pass"
        ? { ...submitted, plan_review: applied.plan_review, project_status: applied.project_status }
        : submitted,
      issues: applied.issues || []
    };
  }

  const generator = options.requirementPlanGenerator || defaultRequirementPlanGenerator(input);
  if (typeof generator !== "function") {
    const issues = [{ code: "requirement_plan_generator_unavailable", message: "model plan generator is not configured", path: "requirement_plan_generator" }];
    return {
      status: "fail",
      submission: failedSubmission(issues),
      issues
    };
  }

  let generation;
  try {
    generation = await generator({
      requirement: submitted.requirement,
      prompt: createRequirementPlanPrompt(submitted.requirement)
    });
  } catch (error) {
    const issues = [{
      code: "requirement_plan_generation_failed",
      message: error?.message || "model plan generation failed",
      path: "plan_generation"
    }];
    return {
      status: "fail",
      submission: failedSubmission(issues, { stderr: error?.stack || error?.message || "" }),
      issues
    };
  }
  if (generation?.status !== "pass") {
    const issues = [{
      code: "requirement_plan_generation_failed",
      message: "model plan generation failed",
      path: "plan_generation",
      stderr: normalizeString(generation?.stderr)
    }];
    return {
      status: "fail",
      submission: failedSubmission(issues, {
        stderr: normalizeString(generation?.stderr),
        generator: generation?.generator || generation?.provenance || null
      }),
      issues
    };
  }

  const parsed = generation.generated_plan || generation.generatedPlan
    ? parseRequirementPlanGenerationOutput(submitted.requirement, generation.generated_plan || generation.generatedPlan)
    : parseRequirementPlanGenerationOutput(submitted.requirement, generation.stdout);
  if (parsed.status !== "pass") {
    return {
      status: "fail",
      submission: failedSubmission(parsed.issues, {
        stderr: normalizeString(generation?.stderr),
        generator: generation?.generator || generation?.provenance || null
      }),
      issues: parsed.issues
    };
  }

  const applied = applyGeneratedRequirementPlan(submitted.project_status, {
    requirement_id: submitted.requirement.id,
    generated_plan: parsed,
    generator: generation.generator || generation.provenance || { kind: "model_plan_generator" }
  }, {
    created_at: input.created_at || input.createdAt
  });
  return {
    status: applied.status === "pass" ? "pass" : "fail",
    submission: applied.status === "pass"
      ? { ...submitted, plan_review: applied.plan_review, project_status: applied.project_status }
      : submitted,
    issues: applied.issues || []
  };
}

function requirementAutoAdvanceAllowedAfterPlanReview(input = {}) {
  return input.auto_advance_after_plan_review === true ||
    input.autoAdvanceAfterPlanReview === true ||
    input.plan_review_approved === true ||
    input.planReviewApproved === true;
}

function requirementAutoAdvanceInput(selectedId, input = {}) {
  return {
    start_projection_id: selectedId,
    max_iterations: Math.min(Math.max(Number(input.auto_advance_max_iterations || input.autoAdvanceMaxIterations || 3), 1), 5),
    execution_profile: input.execution_profile || input.executionProfile || "approved_mock_non_dry_run",
    execution_strategy: "projected_next_action",
    context_work_package_execution_profile: input.context_work_package_execution_profile ||
      input.contextWorkPackageExecutionProfile ||
      VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    snapshot_prefix: input.snapshot_prefix || input.snapshotPrefix || "requirement-intake-auto",
    created_at: input.created_at || input.createdAt
  };
}

async function runRequirementAutoAdvance({
  req,
  selectedId,
  input,
  item,
  readWorkflowState,
  writeWorkflowState,
  readServerHistory,
  allowedHistoryRoots,
  projectStatusPath,
  stateStore,
  workbenchProjection
}) {
  if (!requirementAutoAdvanceEnabled(input)) {
    return {
      status: "disabled",
      result: null,
      artifact: null,
      projection: workbenchProjection(readWorkflowState(item))
    };
  }

  const loopInput = requirementAutoAdvanceInput(selectedId, input);
  const loopResult = await runSchedulerLoopDriver(loopInput, {
    client: createWorkbenchLoopClient(workbenchBaseUrlFromRequest(req))
  });
  const loopArtifact = createSchedulerLoopRunArtifact(loopInput, loopResult, {
    created_at: input.created_at || input.createdAt
  });
  const latestWorkflowState = readWorkflowState(item);
  const recorded = recordAutonomousSchedulerLoopRunArtifact(latestWorkflowState, loopArtifact, {
    created_at: input.created_at || input.createdAt
  });
  if (recorded.status !== "pass") {
    return {
      status: "failed",
      result: loopResult,
      artifact: loopArtifact,
      issues: recorded.issues,
      projection: workbenchProjection(latestWorkflowState)
    };
  }

  writeWorkflowState(item, { ...latestWorkflowState, ...recorded.workflow_state });
  const history = readServerHistory();
  let projection = workbenchProjection(recorded.workflow_state);
  try {
    projection = projectionById(history.latest, history, allowedHistoryRoots, projectStatusPath, stateStore).projection;
  } catch {
    projection = workbenchProjection(recorded.workflow_state);
  }

  return {
    status: loopResult.status === "pass" ? "created" : "failed",
    result: loopResult,
    artifact: loopArtifact,
    issues: loopResult.issues || [],
    projection
  };
}

function artifactsOf(workflowState = {}) {
  return [
    ...asArray(workflowState?.artifact_ledger?.artifacts || workflowState?.artifactLedger?.artifacts),
    ...asArray(workflowState?.manifest?.artifacts)
  ];
}

function latestArtifactForEvent(workflowState = {}, eventType) {
  const event = asArray(workflowState?.manifest?.events)
    .filter((entry) => entry?.type === eventType)
    .at(-1) || null;
  if (!event) return { event: null, artifact: null, metadata: null };

  const artifact = artifactsOf(workflowState).find((entry) => entry?.id === event.artifact_id) || null;
  return {
    event,
    artifact,
    metadata: artifact?.metadata || event.metadata || null
  };
}

function latestSchedulerDispatchRun(workflowState = {}) {
  return latestArtifactForEvent(workflowState, "scheduler_dispatch_run");
}

function schedulerContinuationOutputPath(runArtifact = {}) {
  return normalizeString(runArtifact?.input?.plan?.continuation_output?.path);
}

function safeGeneratedContinuationPath(itemPath, allowedRoots) {
  if (!itemPath) {
    const error = new Error("scheduler dispatch continuation output path is required");
    error.code = "INVALID_CONTINUATION_PATH";
    throw error;
  }
  if (typeof itemPath !== "string") {
    const error = new Error("scheduler dispatch continuation output path must be a string");
    error.code = "INVALID_CONTINUATION_PATH";
    throw error;
  }
  const filePath = isAbsolute(itemPath) ? resolve(itemPath) : resolve(root, itemPath);
  if (!allowedRoots.some((allowedRoot) => isWithinPath(allowedRoot, filePath))) {
    const error = new Error("scheduler dispatch continuation output path must stay under controlled roots");
    error.code = "INVALID_CONTINUATION_PATH";
    throw error;
  }
  return filePath;
}

function generatedContinuationInputIssues(generated = {}, prepared = {}) {
  const issues = [];
  if (!generated || typeof generated !== "object" || Array.isArray(generated)) {
    return ["generated continuation input must be an object"];
  }
  if (generated.project_status?.project !== "ai-control-platform") {
    issues.push("generated continuation input must target ai-control-platform");
  }
  const generatedManifest = generated.workflow_state?.manifest || {};
  const expectedRunId = prepared.scheduler_dispatch?.run_id;
  const expectedCycleId = prepared.scheduler_dispatch?.cycle_id;
  if (expectedRunId && generatedManifest.run_id !== expectedRunId) {
    issues.push("generated continuation input run_id must match scheduler dispatch run");
  }
  if (expectedCycleId && generatedManifest.cycle_id !== expectedCycleId) {
    issues.push("generated continuation input cycle_id must match scheduler dispatch run");
  }
  const expectedWorkPackages = asArray(prepared.next_decision?.next_work_packages).length;
  const generatedNextPackages = [
    ...asArray(generated.project_status?.next_work_packages),
    ...asArray(generated.projectStatus?.next_work_packages),
    ...asArray(generated.run_evaluation?.next_work_packages),
    ...asArray(generated.runEvaluation?.next_work_packages)
  ];
  const generatedWorkPackages = generatedNextPackages.length > 0
    ? generatedNextPackages.length
    : asArray(generated.workflow_state?.manifest?.work_packages).length;
  if (expectedWorkPackages !== generatedWorkPackages) {
    issues.push("generated continuation input work package count must match replay-validated continuation");
  }
  return issues;
}

function projectionHistoryWithReadiness(history = {}, allowedRoots = [examplesRoot, defaultSnapshotsRoot], projectStatusPath = null, stateStore = null) {
  return {
    ...history,
    items: asArray(history.items).map((item) => {
      if (!item?.input_path) return item;
      try {
        const workflowState = readWorkflowStateFromItem(item, allowedRoots, stateStore);
        const projection = createWorkbenchProjection(projectionInputWithProjectStatus(workflowState, projectStatusPath, stateStore));
        return {
          ...item,
          scheduler_dispatch: {
            status: projection.scheduler_dispatch.status,
            phase: projection.scheduler_dispatch.phase,
            artifact_id: projection.scheduler_dispatch.artifact_id,
            continuation_status: projection.scheduler_continuation.continuation_status || projection.scheduler_dispatch.next_continuation_status,
            continuation_ready: projection.scheduler_continuation.ready,
            enqueue_status: projection.scheduler_continuation.enqueue_status,
            enqueue_available: projection.scheduler_continuation.enqueue_available,
            continuation_input_path: projection.scheduler_continuation.continuation_input_path,
            next_continuation_action: projection.scheduler_dispatch.next_continuation_action,
            next_work_package_count: projection.scheduler_continuation.next_work_package_count || projection.scheduler_dispatch.next_work_package_count,
            latest_issue: projection.scheduler_continuation.latest_issue
          },
          scheduler_loop: {
            status: projection.scheduler_loop.status,
            phase: projection.scheduler_loop.phase,
            run_count: projection.scheduler_loop.run_count,
            invalid_count: projection.scheduler_loop.invalid_count,
            iteration_count: projection.scheduler_loop.iteration_count,
            recovery_status: projection.scheduler_loop.recovery_status,
            recovery_action: projection.scheduler_loop.recovery_action,
            resumable: projection.scheduler_loop.resumable,
            resume_projection_id: projection.scheduler_loop.resume_projection_id,
            execution_strategy: projection.scheduler_loop.execution_strategy,
            execution_profile: projection.scheduler_loop.execution_profile,
            latest_projection_id: projection.scheduler_loop.latest_projection_id,
            latest_issue: projection.scheduler_loop.latest_issue
          }
        };
      } catch (error) {
        return {
          ...item,
          scheduler_dispatch: {
            status: "history_read_failed",
            continuation_ready: false,
            enqueue_available: false,
            latest_issue: error.message
          },
          scheduler_loop: {
            status: "history_read_failed",
            recovery_status: "blocked",
            recovery_action: "repair_history_input",
            resumable: false,
            latest_issue: error.message
          }
        };
      }
    })
  };
}

function metadataPath(filePath) {
  return isWithinPath(root, filePath) ? relative(root, filePath) : filePath;
}

function writePreparedSchedulerContinuation(runArtifact, prepared, allowedOutputRoots) {
  const outputPath = safeGeneratedContinuationPath(schedulerContinuationOutputPath(runArtifact), allowedOutputRoots);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(prepared.continuation_input, null, 2)}\n`);
  return outputPath;
}

function requestJson(url, body = null) {
  return new Promise((resolveRequest, reject) => {
    if (url.protocol !== "http:") {
      reject(new Error("workbench loop client supports only local http"));
      return;
    }
    const payload = body ? JSON.stringify(body) : null;
    const req = httpRequest(url, {
      method: payload ? "POST" : "GET",
      headers: payload
        ? {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload)
        }
        : {}
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        text += chunk;
      });
      response.on("end", () => {
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const error = new Error(json?.error || text || `workbench request failed: ${response.statusCode}`);
          error.http_status = response.statusCode;
          error.response = json;
          reject(error);
          return;
        }
        resolveRequest(json);
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function createWorkbenchLoopClient(baseUrl) {
  const base = new URL(baseUrl);
  return {
    loadHistory() {
      return requestJson(new URL("/api/workbench/projections", base));
    },
    loadProjection(projectionId) {
      const url = new URL("/api/workbench/projection", base);
      if (projectionId) url.searchParams.set("id", projectionId);
      return requestJson(url);
    },
    runNextAction(projectionId, body = {}) {
      const url = new URL("/api/workbench/next-action", base);
      if (projectionId) url.searchParams.set("id", projectionId);
      return requestJson(url, body);
    },
    createSchedulerDispatchPlan(projectionId, body = {}) {
      const url = new URL("/api/workbench/scheduler-dispatch-plan", base);
      if (projectionId) url.searchParams.set("id", projectionId);
      return requestJson(url, body);
    },
    runSchedulerDispatch(projectionId, body = {}) {
      const url = new URL("/api/workbench/scheduler-dispatch", base);
      if (projectionId) url.searchParams.set("id", projectionId);
      return requestJson(url, body);
    },
    enqueueSchedulerNextCycle(projectionId, body = {}) {
      const url = new URL("/api/workbench/scheduler-next-cycle", base);
      if (projectionId) url.searchParams.set("id", projectionId);
      return requestJson(url, body);
    },
    runAutonomousSchedulerLoop(projectionId, body = {}) {
      const url = new URL("/api/workbench/autonomous-scheduler-loop", base);
      if (projectionId) url.searchParams.set("id", projectionId);
      return requestJson(url, body);
    },
    resumeAutonomousSchedulerLoop(projectionId, body = {}) {
      const url = new URL("/api/workbench/autonomous-scheduler-loop-resume", base);
      if (projectionId) url.searchParams.set("id", projectionId);
      return requestJson(url, body);
    },
    prepareProjectStatusContinuation(projectionId, body = {}) {
      const url = new URL("/api/workbench/project-status-continuation", base);
      if (projectionId) url.searchParams.set("id", projectionId);
      return requestJson(url, body);
    },
    createContextPackFromSeed(projectionId, body = {}) {
      const url = new URL("/api/workbench/context-pack-cycle", base);
      if (projectionId) url.searchParams.set("id", projectionId);
      return requestJson(url, body);
    },
    runContextWorkPackages(projectionId, body = {}) {
      const url = new URL("/api/workbench/context-work-packages-run", base);
      if (projectionId) url.searchParams.set("id", projectionId);
      return requestJson(url, body);
    },
    runReviewerShard(projectionId, body = {}) {
      const url = new URL("/api/workbench/reviewer-shard-run", base);
      if (projectionId) url.searchParams.set("id", projectionId);
      return requestJson(url, body);
    },
    recordAgentLifecyclePool(projectionId, body = {}) {
      const url = new URL("/api/workbench/agent-lifecycle-pool", base);
      if (projectionId) url.searchParams.set("id", projectionId);
      return requestJson(url, body);
    }
  };
}

function contextWorkPackageRequiresProviderAuthority(projection = {}) {
  return asArray(projection?.task_dag?.dispatchable || projection?.taskDag?.dispatchable)
    .some((node) => {
      const action = normalizeString(node?.action);
      const id = normalizeString(node?.id);
      return action === "continue_requirement_intake" ||
        action === "execute_requirement_plan_step" ||
        action === "continue_global_goal" ||
        id.startsWith("global-goal-");
    });
}

function contextWorkPackageRunOptions(input = {}, projection = null) {
  const executionProfile = input.context_work_package_execution_profile ||
    input.contextWorkPackageExecutionProfile ||
    input.execution_profile ||
    input.executionProfile;
  const executionMode = input.execution_mode || input.executionMode;
  const shouldUseProviderDefault = !executionMode &&
    !executionProfile &&
    contextWorkPackageRequiresProviderAuthority(projection);
  return {
    max_package_count: input.max_package_count ?? input.maxPackageCount,
    created_at: input.created_at || input.createdAt,
    execution_mode: executionMode || (shouldUseProviderDefault ? "provider_model_routed" : undefined),
    execution_profile: executionProfile || (shouldUseProviderDefault ? VERIFIED_PROVIDER_MULTI_AGENT_PROFILE : undefined),
    executor_profile: input.executor_profile || input.executorProfile,
    executor_kind: input.executor_kind || input.executorKind,
    adapter_profile: input.adapter_profile || input.adapterProfile,
    risk: input.risk || input.risk_level || input.riskLevel,
    risk_level: input.risk_level || input.riskLevel,
    budget_tier: input.budget_tier || input.budgetTier,
    budget: input.budget,
    codex_plan_pressure: input.codex_plan_pressure ?? input.codexPlanPressure,
    cost_pressure: input.cost_pressure ?? input.costPressure,
    tags: Array.isArray(input.tags) ? input.tags : undefined,
    stage: input.stage
  };
}

function jsonArrayOption(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function envFlagEnabled(name) {
  const value = normalizeString(process.env[name]).toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function defaultChildProviderForCommand(command) {
  const normalizedCommand = normalizeString(command);
  if (/run-claude-deepseek-child-worker\.sh$|start-claude-deepseek/i.test(normalizedCommand)) {
    return {
      command_runner_kind: "external_provider_child_process",
      executor_kind: "claude_deepseek_cli_worker",
      provider: "claude_deepseek",
      model: normalizeString(process.env.AI_CONTROL_WORKBENCH_CLAUDE_MODEL) || "deepseek-v4-pro[1m]"
    };
  }
  if (/run-claude-child-worker\.sh$|claude/i.test(normalizedCommand)) {
    return {
      command_runner_kind: "external_provider_child_process",
      executor_kind: "claude_proxy_cli_worker",
      provider: "claude_proxy",
      model: normalizeString(process.env.AI_CONTROL_WORKBENCH_CLAUDE_MODEL) || "claude-opus-4-7"
    };
  }
  return {
    command_runner_kind: "codex_proxy_child_process",
    executor_kind: "codex_proxy_cli_worker",
    provider: "codex_proxy",
    model: "codex-cli"
  };
}

function configuredHeadlessChildProviderExecutor(options = {}) {
  if (typeof options.contextWorkPackageProviderExecutor === "function" ||
    typeof options.context_work_package_provider_executor === "function") {
    return null;
  }
  const command = normalizeString(
    options.childWorkerCommand ||
      options.child_worker_command ||
      process.env.AI_CONTROL_WORKBENCH_CHILD_WORKER_COMMAND
  );
  if (!command) return null;
  const args = Array.isArray(options.childWorkerArgs)
    ? options.childWorkerArgs
    : Array.isArray(options.child_worker_args)
      ? options.child_worker_args
      : jsonArrayOption(process.env.AI_CONTROL_WORKBENCH_CHILD_WORKER_ARGS_JSON);
  const childProvider = defaultChildProviderForCommand(command);
  return createHeadlessProviderExecutor({
    child_worker_command: command,
    child_worker_args: args,
    child_worker_timeout_ms: options.childWorkerTimeoutMs ||
      options.child_worker_timeout_ms ||
      process.env.AI_CONTROL_WORKBENCH_CHILD_WORKER_TIMEOUT_MS,
    child_worker_output_path: options.childWorkerOutputPath ||
      options.child_worker_output_path ||
      process.env.AI_CONTROL_WORKBENCH_CHILD_WORKER_OUTPUT_PATH ||
      "tmp/workbench-child-workers/{run_id}-{cycle_id}-{work_package_id}.json",
    child_worker_max_attempts: options.childWorkerMaxAttempts ||
      options.child_worker_max_attempts ||
      process.env.AI_CONTROL_WORKBENCH_CHILD_WORKER_MAX_ATTEMPTS,
    child_worker_split_retry: options.childWorkerSplitRetry === true ||
      options.child_worker_split_retry === true ||
      envFlagEnabled("AI_CONTROL_WORKBENCH_CHILD_WORKER_SPLIT_RETRY"),
    child_worker_cwd: options.childWorkerCwd ||
      options.child_worker_cwd ||
      process.env.AI_CONTROL_WORKBENCH_CHILD_WORKER_CWD ||
      root,
    command_runner_kind: childProvider.command_runner_kind,
    executor_kind: childProvider.executor_kind,
    default_child_provider: {
      provider: childProvider.provider,
      model: childProvider.model
    }
  });
}

function step03FrontendRulesPackage(node = {}) {
  const source = node.source || {};
  const implementation = normalizeString(source.implementation_step || source.implementationStep || node.reason || node.title);
  return normalizeString(node.action) === "execute_requirement_plan_step" &&
    Number(source.plan_step_index || source.planStepIndex) === 3 &&
    /antd|Ant Design/i.test(implementation) &&
    /PROJECT_RULES|前端约束|基础\/布局组件|基础组件|布局组件/.test(implementation);
}

function runPreflightCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: Number(options.timeout_ms || options.timeoutMs || 60000)
  });
  return {
    command: [command, ...args].join(" "),
    status: result.status === 0 ? "pass" : "fail",
    exit_code: result.status,
    stdout: normalizeString(result.stdout).slice(0, 1200),
    stderr: normalizeString(result.stderr).slice(0, 1200)
  };
}

function frontendStep03MainlineEvidence() {
  const requiredFiles = [
    "PROJECT_RULES.md",
    "apps/workbench/FRONTEND_REFACTOR_CONSTRAINTS.md",
    "test/workbench-shell.test.js"
  ];
  const missingFiles = requiredFiles.filter((file) => !existsSync(resolve(root, file)));
  if (missingFiles.length > 0) {
    return {
      status: "not_applicable",
      issues: missingFiles.map((file) => ({ code: "mainline_evidence_file_missing", message: `${file} is missing`, path: file }))
    };
  }

  const rules = readFileSync(resolve(root, "PROJECT_RULES.md"), "utf8");
  const constraints = readFileSync(resolve(root, "apps/workbench/FRONTEND_REFACTOR_CONSTRAINTS.md"), "utf8");
  const contentIssues = [];
  if (!/FRONTEND_REFACTOR_CONSTRAINTS\.md/.test(rules)) {
    contentIssues.push({ code: "project_rules_missing_frontend_constraints_link", message: "PROJECT_RULES.md must link the frontend refactor constraints", path: "PROJECT_RULES.md" });
  }
  if (!/antd|Ant Design/i.test(rules) || !/单页 app|single-page/i.test(rules)) {
    contentIssues.push({ code: "project_rules_missing_frontend_refactor_invariants", message: "PROJECT_RULES.md must codify antd and single-page app constraints", path: "PROJECT_RULES.md" });
  }
  if (!/antd|Ant Design/i.test(constraints) || !/Next\.js|App Router/i.test(constraints) || !/原有 CSS|CSS/i.test(constraints)) {
    contentIssues.push({ code: "frontend_constraints_incomplete", message: "frontend constraints document must codify antd, Next.js App Router, and CSS migration rules", path: "apps/workbench/FRONTEND_REFACTOR_CONSTRAINTS.md" });
  }
  if (contentIssues.length > 0) return { status: "not_applicable", issues: contentIssues };

  const commit = runPreflightCommand("git", ["log", "--grep=step 03/7", "--format=%H", "-n", "1"], { timeout_ms: 10000 });
  const testRun = runPreflightCommand(process.execPath, ["--test", "test/workbench-shell.test.js"], { timeout_ms: 60000 });
  if (commit.status !== "pass" || !normalizeString(commit.stdout)) {
    return { status: "not_applicable", issues: [{ code: "step03_mainline_commit_missing", message: "no mainline commit records frontend refactor step 03/7", path: "git.log" }], command_results: [commit] };
  }
  if (testRun.status !== "pass") {
    return { status: "blocked", issues: [{ code: "step03_preflight_test_failed", message: "focused frontend rules test failed", path: "test/workbench-shell.test.js" }], command_results: [commit, testRun] };
  }

  return {
    status: "pass",
    commit: normalizeString(commit.stdout).split(/\s+/)[0],
    files: requiredFiles,
    command_results: [commit, testRun]
  };
}

function createMainlineAlreadySatisfiedEvaluator() {
  return ({ selected_work_packages: selectedWorkPackages = [], options = {} } = {}) => {
    const selected = asArray(selectedWorkPackages);
    if (selected.length === 0 || !selected.every(step03FrontendRulesPackage)) {
      return { status: "not_applicable", phase: "mainline_already_satisfied_preflight" };
    }

    const evidence = frontendStep03MainlineEvidence();
    if (evidence.status !== "pass") {
      return {
        status: evidence.status === "blocked" ? "blocked" : "not_applicable",
        phase: "mainline_already_satisfied_preflight",
        issues: evidence.issues || [],
        package_results: [],
        executor_provenance: null
      };
    }

    const createdAt = normalizeString(options.created_at || options.createdAt) || new Date().toISOString();
    const completionAuthority = {
      allows_work_package_completion: true,
      authority: "mainline_already_satisfied_preflight",
      evidence_kind: "focused_tests_and_mainline_commit",
      reason: "current mainline already contains the reviewed frontend rules step and focused gates pass"
    };
    return {
      status: "pass",
      phase: "mainline_already_satisfied_preflight",
      allows_work_package_completion: true,
      completion_authority: completionAuthority,
      executor_provenance: {
        executor_kind: "mainline_already_satisfied_preflight",
        execution_mode: "provider_model_routed",
        execution_profile: "mainline_already_satisfied_preflight",
        external_calls: 0,
        deterministic: true,
        created_at: createdAt
      },
      package_results: selected.map((node) => ({
        work_package_id: node.id,
        status: "pass",
        result: "already_satisfied_by_mainline",
        completed_at: createdAt,
        allows_work_package_completion: true,
        completion_authority: completionAuthority,
        completion_evidence: {
          kind: "mainline_already_satisfied_preflight",
          commit: evidence.commit,
          files: evidence.files,
          command_results: evidence.command_results
        }
      })),
      issues: []
    };
  };
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolveBody(body));
    req.on("error", reject);
  });
}

function normalizeEvent(input = {}, projectionId = null) {
  const createdAt = input.created_at || new Date().toISOString();
  return {
    id: input.id || `operator-event-${createdAt}`,
    type: typeof input.type === "string" && input.type.trim() ? input.type.trim() : "operator_action",
    action: input.action.trim(),
    projection_id: input.projection_id || projectionId || null,
    run_id: input.run_id.trim(),
    cycle_id: input.cycle_id.trim(),
    created_at: createdAt,
    metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {}
  };
}

function workbenchBaseUrlFromRequest(req) {
  const host = String(req.headers.host || "").trim();
  if (!host || !/^[a-zA-Z0-9.:-]+$/.test(host)) {
    const error = new Error("request host is required for scheduler dispatch writeback planning");
    error.code = "INVALID_WORKBENCH_HOST";
    throw error;
  }
  return `http://${host}`;
}

function operatorEventIssues(input = {}) {
  const issues = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return ["event must be an object"];
  }
  for (const field of ["action", "run_id", "cycle_id"]) {
    if (typeof input[field] !== "string" || !input[field].trim()) {
      issues.push(`${field} is required`);
    }
  }
  if (input.metadata !== undefined && (!input.metadata || typeof input.metadata !== "object" || Array.isArray(input.metadata))) {
    issues.push("metadata must be an object when provided");
  }
  return issues;
}

function schedulerDispatchRunArtifactFromInput(input = {}) {
  return input.artifact || input.run_artifact || input.runArtifact || input;
}

function schedulerDispatchRunIssues(input = {}) {
  const artifact = schedulerDispatchRunArtifactFromInput(input);
  const issues = [];

  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    return ["scheduler dispatch run artifact must be an object"];
  }
  if (artifact.version !== "scheduler-dispatch-run.v1") {
    issues.push("scheduler dispatch run artifact version must be scheduler-dispatch-run.v1");
  }
  if (!["pass", "fail"].includes(String(artifact.status || ""))) {
    issues.push("scheduler dispatch run artifact status must be pass or fail");
  }
  if (!artifact.result || typeof artifact.result !== "object" || Array.isArray(artifact.result)) {
    issues.push("scheduler dispatch run artifact result is required");
  }
  if (artifact.result && !Array.isArray(artifact.result.steps)) {
    issues.push("scheduler dispatch run artifact result.steps must be an array");
  }

  return issues;
}

function latestAvailableSchedulerWorkflowStatePath(runResult = {}) {
  for (const step of [...(Array.isArray(runResult.steps) ? runResult.steps : [])].reverse()) {
    const workflowStateOutput = step.outputs?.workflow_state;
    if (workflowStateOutput?.status === "available" && workflowStateOutput.path) {
      return workflowStateOutput.path;
    }
  }
  return "";
}

function readSchedulerWorkflowStateOutput(runResult = {}) {
  const outputPath = latestAvailableSchedulerWorkflowStatePath(runResult);
  if (!outputPath) {
    return {
      status: "fail",
      issues: [{
        code: "missing_scheduler_workflow_state_output",
        message: "agent lifecycle cleanup scheduler dispatch did not produce an available workflow state output",
        path: "result.steps.outputs.workflow_state"
      }]
    };
  }

  try {
    return {
      status: "pass",
      workflow_state: readJson(resolve(root, outputPath)),
      output_path: outputPath
    };
  } catch (error) {
    return {
      status: "fail",
      issues: [{
        code: "unreadable_scheduler_workflow_state_output",
        message: error.message,
        path: outputPath
      }]
    };
  }
}

function schedulerPlanInputFromWorkflowState(workflowState, input = {}) {
  return {
    project_status: {
      project: "ai-control-platform",
      blockers: [],
      next_step: input.next_step || input.nextStep || ""
    },
    run_evaluation: input.run_evaluation || input.runEvaluation || { status: "pass" },
    workflow_state: workflowState
  };
}

function materializeSchedulerWorkflowInput(selectedId, workflowState) {
  const inputPath = `tmp/workbench-scheduler-inputs/${safeSnapshotIdPart(selectedId)}-${Date.now()}.json`;
  const absolutePath = resolve(root, inputPath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeJson(absolutePath, workflowState);
  return inputPath;
}

function schedulerPlanOptionsFromRequest(req, item, selectedId, input = {}, workflowState = null) {
  const workflowStateInputPath = isSqliteSnapshotPath(item.input_path)
    ? materializeSchedulerWorkflowInput(selectedId, workflowState)
    : item.input_path;
  return {
    workflow_state_input_path: workflowStateInputPath,
    workbench_writeback_mode: "service",
    workbench_base_url: workbenchBaseUrlFromRequest(req),
    projection_id: selectedId,
    reviewer_mock_status: input.reviewer_mock_status || input.reviewerMockStatus,
    reviewer_mock_findings_json: input.reviewer_mock_findings_json || input.reviewerMockFindingsJson,
    next_step: input.next_step || input.nextStep
  };
}

function readEvents(eventsPath, stateStore = null) {
  return stateStore ? stateStore.readEvents() : readJson(eventsPath);
}

function appendEvent(eventsPath, event, stateStore = null) {
  const ledger = readEvents(eventsPath, stateStore);
  const nextLedger = {
    version: ledger.version || "operator-events.v1",
    events: [...(Array.isArray(ledger.events) ? ledger.events : []), event]
  };
  if (stateStore) stateStore.writeEvents(nextLedger);
  else writeJson(eventsPath, nextLedger);
  return nextLedger;
}

function workflowStateWithProjectStatus(workflowState = {}, projectStatus = {}) {
  return {
    ...workflowState,
    project_status: projectStatus,
    global_goals: asArray(projectStatus.global_goals)
  };
}

const SUPPORTED_NEXT_ACTIONS = new Set([
  "prepare_project_status_continuation",
  "continue_after_reviewer_aggregate",
  "create_context_pack_from_seed",
  "run_context_work_packages",
  "enqueue_scheduler_next_cycle",
  "run_autonomous_scheduler_loop",
  "run_reviewer_scope_shard",
  "cleanup_agent_lifecycle_pool",
  "resume_autonomous_scheduler_loop"
]);

function reviewerShardExecutorFromInput(input = {}, options = {}) {
  const policy = evaluateReviewerExecutionPolicy(input);
  if (policy.status !== "pass") {
    const error = new Error("reviewer execution policy rejected");
    error.code = "reviewer_execution_policy_rejected";
    error.issues = policy.issues;
    error.policy = policy;
    throw error;
  }
  const preflight = evaluateReviewerProviderHealthPreflight(options.workflowState, policy);
  if (preflight.status !== "pass") {
    const error = new Error("reviewer provider health preflight rejected");
    error.code = "reviewer_provider_health_preflight_rejected";
    error.issues = preflight.issues;
    error.policy = policy;
    throw error;
  }

  const mockFindingsJson = normalizeString(input.reviewer_mock_findings_json || input.reviewerMockFindingsJson);
  const mockStatus = normalizeString(input.reviewer_mock_status || input.reviewerMockStatus);
  if (policy.controls.executor_mode === "mock") {
    return {
      policy,
      executor: async () => ({
        status: mockStatus || "pass",
        findings: mockFindingsJson ? JSON.parse(mockFindingsJson) : [],
        provenance: {
          executor_kind: "mock",
          provider: "mock",
          model: "mock",
          timeout_seconds: null,
          tools: "",
          external_call_budget_used: 0,
          execution_profile: policy.profile
        }
      })
    };
  }

  const timeoutSeconds = policy.controls.timeout_seconds;
  const baseExecutor = options.realReviewerExecutor || createClaudeDeepSeekShardExecutor({
    cwd: root,
    timeout_seconds: timeoutSeconds
  });
  return {
    policy,
    executor: async (request) => {
      const result = await baseExecutor(request);
      return {
        ...result,
        provenance: {
          ...(result?.provenance || {}),
          execution_profile: policy.profile,
          policy_execution_mode: policy.execution_mode,
          model_routing_selected_model: policy.controls.model_routing?.selected_model || null
        }
      };
    }
  };
}

async function executeProjectedNextAction({ req, selectedId, projection, input = {} }) {
  const readout = projection.next_action_readout || {};
  const action = normalizeString(readout.action);
  const expectedAction = normalizeString(input.expected_action || input.expectedAction);

  if (expectedAction && expectedAction !== action) {
    return {
      status: "blocked",
      http_status: 409,
      error: "projected next action drifted",
      issues: [{
        code: "next_action_drift",
        message: `expected ${expectedAction} but projection recommends ${action || "none"}`,
        path: "next_action_readout.action"
      }]
    };
  }

  if (readout.status !== "ready" || !SUPPORTED_NEXT_ACTIONS.has(action)) {
    return {
      status: "blocked",
      http_status: 409,
      error: "projected next action is not supported for autonomous execution",
      issues: [{
        code: "unsupported_projected_next_action",
        message: `${action || "none"} is not in the autonomous execution allowlist`,
        path: "next_action_readout.action"
      }]
    };
  }

  const client = createWorkbenchLoopClient(workbenchBaseUrlFromRequest(req));
  if (action === "enqueue_scheduler_next_cycle") {
    const result = await client.enqueueSchedulerNextCycle(selectedId, {
      snapshot_id: input.snapshot_id || input.snapshotId,
      label: input.label,
      created_at: input.created_at || input.createdAt
    });
    return { status: "executed", action, result };
  }

  if (action === "prepare_project_status_continuation") {
    const result = await client.prepareProjectStatusContinuation(selectedId, {
      created_at: input.created_at || input.createdAt
    });
    return { status: "executed", action, result };
  }

  if (action === "continue_after_reviewer_aggregate") {
    const result = await client.prepareProjectStatusContinuation(selectedId, {
      created_at: input.created_at || input.createdAt
    });
    return { status: "executed", action, result };
  }

  if (action === "create_context_pack_from_seed") {
    const result = await client.createContextPackFromSeed(selectedId, {
      snapshot_id: input.snapshot_id || input.snapshotId,
      cycle_id: input.cycle_id || input.cycleId,
      label: input.label,
      created_at: input.created_at || input.createdAt
    });
    return { status: "executed", action, result };
  }

  if (action === "run_context_work_packages") {
    try {
      const result = await client.runContextWorkPackages(selectedId, contextWorkPackageRunOptions(input, projection));
      return { status: "executed", action, result };
    } catch (error) {
      return {
        status: "blocked",
        http_status: error.http_status || 409,
        error: error.message,
        issues: error.response?.issues || [],
        result: error.response || null
      };
    }
  }

  if (action === "run_reviewer_scope_shard") {
    const result = await client.runReviewerShard(selectedId, {
      shard_id: input.shard_id || input.shardId,
      created_at: input.created_at || input.createdAt,
      aggregate_created_at: input.aggregate_created_at || input.aggregateCreatedAt,
      record_provider_health_on_timeout: input.record_provider_health_on_timeout ?? input.recordProviderHealthOnTimeout ?? true,
      provider_smoke_status: input.provider_smoke_status || input.providerSmokeStatus,
      execution_profile: input.execution_profile || input.executionProfile,
      max_external_reviewer_calls: input.max_external_reviewer_calls ?? input.maxExternalReviewerCalls,
      provider_cost_mode: input.provider_cost_mode || input.providerCostMode,
      budget_tier: input.budget_tier || input.budgetTier,
      risk: input.risk || input.risk_level || input.riskLevel,
      reviewer_mock_status: input.reviewer_mock_status || input.reviewerMockStatus,
      reviewer_mock_findings_json: input.reviewer_mock_findings_json || input.reviewerMockFindingsJson,
      timeout_seconds: input.timeout_seconds || input.timeoutSeconds
    });
    return { status: "executed", action, result };
  }

  if (action === "cleanup_agent_lifecycle_pool") {
    const result = await client.recordAgentLifecyclePool(selectedId, {
      cleanup_latest_pool: true,
      created_at: input.created_at || input.createdAt,
      failure: input.failure,
      blocked: input.blocked,
      message: input.message
    });
    return { status: "executed", action, result };
  }

  if (action === "resume_autonomous_scheduler_loop") {
    const result = await client.resumeAutonomousSchedulerLoop(selectedId, {
      max_iterations: input.max_iterations || input.maxIterations || 1,
      execution_profile: input.execution_profile || input.executionProfile || "approved_mock_non_dry_run",
      snapshot_prefix: input.snapshot_prefix || input.snapshotPrefix || "resume-loop",
      created_at: input.created_at || input.createdAt
    });
    return { status: "executed", action, result };
  }

  const result = await client.runAutonomousSchedulerLoop(selectedId, {
    max_iterations: input.max_iterations || input.maxIterations || 1,
    execution_profile: input.execution_profile || input.executionProfile || "approved_mock_non_dry_run",
    execution_strategy: input.execution_strategy || input.executionStrategy,
    reviewer_mock_status: input.reviewer_mock_status || input.reviewerMockStatus,
    reviewer_mock_findings_json: input.reviewer_mock_findings_json || input.reviewerMockFindingsJson,
    max_external_reviewer_calls: input.max_external_reviewer_calls ?? input.maxExternalReviewerCalls,
    provider_cost_mode: input.provider_cost_mode || input.providerCostMode,
    budget_tier: input.budget_tier || input.budgetTier,
    risk: input.risk || input.risk_level || input.riskLevel,
    timeout_seconds: input.timeout_seconds || input.timeoutSeconds,
    snapshot_prefix: input.snapshot_prefix || input.snapshotPrefix || "autonomous-loop",
    created_at: input.created_at || input.createdAt
  });
  return { status: "executed", action, result };
}

function safeStaticPath(pathname) {
  const normalized = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const filePath = resolve(root, normalized.replace(/^[/\\]/, ""));

  if (!filePath.startsWith(root)) {
    return null;
  }

  return filePath;
}

function sendStaticFile(res, filePath, options = {}) {
  const content = readFileSync(filePath);
  const transformed = typeof options.transform === "function" ? options.transform(content) : content;
  res.writeHead(200, {
    "content-type": options.content_type || MIME_TYPES[extname(filePath)] || "application/octet-stream",
    "cache-control": options.cache_control || "no-store"
  });
  res.end(transformed);
}

function isProjectMountRoot(pathname) {
  return /^\/projects\/ai-control-platform\/?$/.test(String(pathname || ""));
}

function projectMountRoutePathname(pathname) {
  const mountPrefix = "/projects/ai-control-platform";
  const routePathname = String(pathname || "");
  if (routePathname === mountPrefix) return "/";
  if (routePathname.startsWith(`${mountPrefix}/`)) {
    return routePathname.slice(mountPrefix.length) || "/";
  }
  return routePathname;
}

export function createWorkbenchServer(options = {}) {
  const eventsPath = options.eventsPath || defaultEventsPath;
  const serverHistoryPath = options.historyPath || historyPath;
  const projectStatusPath = options.projectStatusPath === null
    ? null
    : resolve(options.projectStatusPath || defaultProjectStatusPath);
  const snapshotsRoot = resolve(options.snapshotsRoot || defaultSnapshotsRoot);
  const allowedHistoryRoots = [examplesRoot, snapshotsRoot];
  const stateDbPath = normalizeString(options.stateDbPath || options.state_db || options.stateDb);
  const allowFixtureFileState = options.allowFixtureFileState === true;
  if (!stateDbPath && !options.stateStore && !allowFixtureFileState) {
    throw new Error("Workbench live state requires SQLite: pass stateDbPath or --state-db");
  }
  const stateStore = options.stateStore || (stateDbPath ? createSqliteWorkbenchStateStore({
      dbPath: stateDbPath,
      seedRoot: root,
      seedHistoryPath: serverHistoryPath,
      seedProjectStatusPath: projectStatusPath,
      seedEventsPath: eventsPath
    }) : null);
  const readServerHistory = () => stateStore ? stateStore.readHistory() : readJson(serverHistoryPath);
  const writeServerHistory = (history) => stateStore
    ? stateStore.writeHistory(history)
    : writeJson(serverHistoryPath, history);
  const readWorkflowState = (item) => readWorkflowStateFromItem(item, allowedHistoryRoots, stateStore);
  const writeWorkflowState = (item, workflowState) => writeWorkflowStateToItem(item, workflowState, allowedHistoryRoots, stateStore);
  const publishSnapshot = (input, publishOptions = {}) => stateStore
    ? stateStore.publishSnapshot(input)
    : publishWorkbenchSnapshot(input, publishOptions);
  const realReviewerExecutor = options.realReviewerExecutor;
  const requirementPlanGenerator = typeof options.requirementPlanGenerator === "function"
    ? options.requirementPlanGenerator
    : typeof options.requirement_plan_generator === "function"
      ? options.requirement_plan_generator
      : null;
  const contextWorkPackageProviderExecutor = typeof options.contextWorkPackageProviderExecutor === "function"
    ? options.contextWorkPackageProviderExecutor
    : typeof options.context_work_package_provider_executor === "function"
      ? options.context_work_package_provider_executor
      : configuredHeadlessChildProviderExecutor(options);
  const workbenchProjection = (workflowState) => createWorkbenchProjection(
    projectionInputWithProjectStatus(workflowState, projectStatusPath, stateStore)
  );
  const serveLegacyStatic = options.serveLegacyStatic === true ||
    options.serve_legacy_static === true;

  return createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    try {
      if (isProjectMountRoot(url.pathname)) {
        if (!serveLegacyStatic) {
          jsonResponse(res, 404, {
            error: "workbench pages are served by Next.js; this process only serves /api/workbench/*"
          });
          return;
        }
        const basePath = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
        res.writeHead(302, {
          location: `${basePath}apps/workbench/desktop.html${url.search}`,
          "cache-control": "no-store"
        });
        res.end();
        return;
      }

      url.pathname = projectMountRoutePathname(url.pathname);

      if (url.pathname === "/api/workbench/projection") {
        const { projection } = projectionById(url.searchParams.get("id"), readServerHistory(), allowedHistoryRoots, projectStatusPath, stateStore);
        jsonResponse(res, 200, projection);
        return;
      }

      if (url.pathname === "/api/workbench/projections") {
        const history = readServerHistory();
        jsonResponse(res, 200, projectionHistoryWithReadiness(history, allowedHistoryRoots, projectStatusPath, stateStore));
        return;
      }

      if (url.pathname === "/api/workbench/snapshot" && req.method === "GET") {
        const history = readServerHistory();
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 404, { error: `snapshot input not found: ${selectedId}` });
          return;
        }
        jsonResponse(res, 200, readWorkflowState(item));
        return;
      }

      if (url.pathname === "/api/workbench/snapshots" && req.method === "POST") {
        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }
        const issues = snapshotIssues(input);
        if (issues.length > 0) {
          jsonResponse(res, 400, { error: "invalid workflow state snapshot", issues });
          return;
        }
        const result = publishSnapshot(input, {
          root,
          historyPath: serverHistoryPath,
          snapshotsRoot
        });
        if (result.status === "fail") {
          jsonResponse(res, 400, { error: "workflow state snapshot publish failed", issues: result.issues });
          return;
        }
        jsonResponse(res, 201, { status: result.status, item: result.item, projection: result.projection });
        return;
      }

      if (url.pathname === "/api/workbench/reviewer-provider-health" && req.method === "POST") {
        const history = readServerHistory();
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }
        const workflowState = readWorkflowState(item);
        const result = recordReviewerProviderHealthFact(workflowState, {
          request: workflowState.reviewer_gate?.request || workflowState.reviewerGate?.request || workflowState.reviewer_gate || workflowState.reviewerGate,
          smoke_status: input.smoke_status || input.smokeStatus || input.provider_smoke_status,
          tools: input.tools || input.allowed_tools || input.allowedTools,
          created_at: input.created_at
        });
        if (result.status !== "pass") {
          jsonResponse(res, 400, { error: "reviewer provider health record failed", issues: result.issues });
          return;
        }

        writeWorkflowState(item, { ...workflowState, ...result.workflow_state });
        jsonResponse(res, 201, {
          status: "created",
          item,
          fact: result.fact,
          projection: workbenchProjection(result.workflow_state)
        });
        return;
      }

      if (url.pathname === "/api/workbench/reviewer-shard-result" && req.method === "POST") {
        const history = readServerHistory();
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }
        const workflowState = readWorkflowState(item);
        const result = recordReviewerShardResult(workflowState, {
          shard_id: input.shard_id || input.shardId,
          status: input.status,
          findings: input.findings || input.review_findings || [],
          created_at: input.created_at
        });
        if (result.status !== "pass") {
          jsonResponse(res, 400, { error: "reviewer shard result record failed", issues: result.issues });
          return;
        }

        let nextState = result.workflow_state;
        let aggregate = null;
        if (input.aggregate === true) {
          aggregate = recordReviewerShardAggregate(nextState, {
            created_at: input.aggregate_created_at || input.created_at
          });
          if (aggregate.status !== "pass") {
            jsonResponse(res, 400, { error: "reviewer shard aggregate record failed", issues: aggregate.issues });
            return;
          }
          nextState = aggregate.workflow_state;
        }

        writeWorkflowState(item, { ...workflowState, ...nextState });
        jsonResponse(res, 201, {
          status: "created",
          item,
          fact: result.fact,
          aggregate: aggregate?.fact || null,
          projection: workbenchProjection(nextState)
        });
        return;
      }

      if (url.pathname === "/api/workbench/agent-lifecycle-pool" && req.method === "POST") {
        const history = readServerHistory();
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }
        const workflowState = readWorkflowState(item);
        const result = (input.cleanup_latest_pool || input.cleanupLatestPool)
          ? cleanupAgentLifecyclePool(workflowState, {
            created_at: input.created_at || input.createdAt,
            failure: input.failure,
            blocked: input.blocked,
            message: input.message
          })
          : recordAgentLifecycleFact(workflowState, {
            event_type: input.event_type || input.eventType || input.type,
            pool_id: input.pool_id || input.poolId,
            worker_id: input.worker_id || input.workerId,
            status: input.status,
            message: input.message,
            created_at: input.created_at || input.createdAt
          });
        if (!["pass", "cleanup_required", "blocked"].includes(result.status)) {
          jsonResponse(res, 400, { error: "agent lifecycle pool record failed", issues: result.issues });
          return;
        }

        writeWorkflowState(item, { ...workflowState, ...result.workflow_state });
        jsonResponse(res, 201, {
          status: result.status === "blocked" ? "blocked" : "created",
          item,
          fact: result.fact || null,
          facts: result.facts || [],
          before: result.before || null,
          after: result.after || null,
          projection: workbenchProjection(result.workflow_state)
        });
        return;
      }

      if (url.pathname === "/api/workbench/workbench-browser-events-run" && req.method === "POST") {
        const history = readServerHistory();
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }
        const workflowState = readWorkflowState(item);
        const result = recordWorkbenchBrowserEventsRunArtifact(
          workflowState,
          input.artifact || input.run_artifact || input.runArtifact || input,
          {
            artifact_id: input.artifact_id || input.artifactId,
            created_at: input.created_at || input.createdAt
          }
        );
        if (result.status !== "pass") {
          jsonResponse(res, 400, { error: "workbench browser events run record failed", issues: result.issues });
          return;
        }

        writeWorkflowState(item, { ...workflowState, ...result.workflow_state });
        jsonResponse(res, 201, {
          status: "created",
          item,
          artifact: result.artifact,
          projection: workbenchProjection(result.workflow_state)
        });
        return;
      }

      if (url.pathname === "/api/workbench/governance-audit-skill-trial" && req.method === "POST") {
        const history = readServerHistory();
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }
        const workflowState = readWorkflowState(item);
        const result = recordGovernanceAuditSkillTrialRunArtifact(
          workflowState,
          input.artifact || input.run_artifact || input.runArtifact || input,
          {
            artifact_id: input.artifact_id || input.artifactId,
            created_at: input.created_at || input.createdAt
          }
        );
        if (result.status !== "pass") {
          jsonResponse(res, 400, { error: "governance audit skill trial record failed", issues: result.issues });
          return;
        }

        writeWorkflowState(item, { ...workflowState, ...result.workflow_state });
        jsonResponse(res, 201, {
          status: "created",
          item,
          artifact: result.artifact,
          summary: result.summary,
          projection: workbenchProjection(result.workflow_state)
        });
        return;
      }

      if (url.pathname === "/api/workbench/reviewer-shard-run" && req.method === "POST") {
        const history = readServerHistory();
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }
        const workflowState = readWorkflowState(item);
        let executorSetup;
        try {
          executorSetup = reviewerShardExecutorFromInput(input, { realReviewerExecutor, workflowState });
        } catch (error) {
          jsonResponse(res, 400, {
            error: error.code === "reviewer_execution_policy_rejected" || error.code === "reviewer_provider_health_preflight_rejected"
              ? "reviewer execution policy rejected"
              : "reviewer shard executor setup failed",
            issues: error.issues || [{ code: "reviewer_shard_executor_setup_failed", message: error.message, path: "reviewer_mock_findings_json" }],
            policy: error.policy || null,
            projection: workbenchProjection(workflowState)
          });
          return;
        }

        const result = await runReviewerShard(workflowState, {
          shard_id: input.shard_id || input.shardId,
          created_at: input.created_at || input.createdAt,
          aggregate_created_at: input.aggregate_created_at || input.aggregateCreatedAt,
          record_provider_health_on_timeout: input.record_provider_health_on_timeout ?? input.recordProviderHealthOnTimeout ?? true,
          provider_smoke_status: input.provider_smoke_status || input.providerSmokeStatus,
          executor: executorSetup.executor
        });
        if (result.status !== "pass") {
          jsonResponse(res, 400, { error: "reviewer shard run failed", issues: result.issues || [], projection: workbenchProjection(workflowState) });
          return;
        }

        writeWorkflowState(item, { ...workflowState, ...result.workflow_state });
        jsonResponse(res, 201, {
          status: "created",
          item,
          phase: result.phase,
          shard_id: result.result?.shard_id || result.shard?.id || null,
          shard_status: result.result?.status || null,
          result: result.result,
          reviewer_execution_policy: executorSetup.policy,
          provider_health: result.provider_health || null,
          aggregate: result.aggregate || null,
          pending_shards: result.pending_shards ?? result.aggregate?.pending_shards ?? null,
          projection: workbenchProjection(result.workflow_state)
        });
        return;
      }

      if (url.pathname === "/api/workbench/project-status-continuation" && req.method === "POST") {
        const history = readServerHistory();
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }
        const workflowState = readWorkflowState(item);
        const projectStatus = readProjectStatus(projectStatusPath, stateStore) || workflowState.project_status;
        const prepared = prepareContinuationFromProjectStatus(projectStatus, { workflow_state: workflowState });
        const recorded = recordProjectStatusContinuationPrepared(workflowState, prepared, {
          created_at: input.created_at || input.createdAt
        });
        if (recorded.status !== "pass") {
          jsonResponse(res, 400, { error: "project status continuation record failed", issues: recorded.issues });
          return;
        }

        writeWorkflowState(item, { ...workflowState, ...recorded.workflow_state });
        const statusCode = prepared.status === "ready" ? 201 : 409;
        jsonResponse(res, statusCode, {
          status: prepared.status === "ready" ? "created" : "blocked",
          item,
          continuation: prepared,
          artifact: recorded.artifact,
          projection: workbenchProjection(recorded.workflow_state)
        });
        return;
      }

      if (url.pathname === "/api/workbench/requirements" && req.method === "POST") {
        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }

        // For independent requirement submissions, create or use initial workflow state
        const history = readServerHistory();
        const selectedId = url.searchParams.get("id") || history.latest;

        let workflowState;
        let item;

        if (selectedId && history.items) {
          item = history.items.find((entry) => entry.id === selectedId);
          if (item?.input_path) {
            workflowState = readWorkflowState(item);
          }
        }

        // If no existing workflow state found, create a minimal initial one for this submission
        if (!workflowState) {
          const runId = `requirement-submission-${Date.now()}`;
          const cycleId = `cycle-${Date.now()}`;
          workflowState = createInitialWorkflowState(runId, cycleId, projectStatusPath, stateStore);
        }
        const currentProjectStatus = readProjectStatus(projectStatusPath, stateStore) || workflowState.project_status;
        const submitted = submitRequirementToProjectStatus(currentProjectStatus || {}, input, {
          created_at: input.created_at || input.createdAt,
          requirement_id: input.requirement_id || input.requirementId
        });
        if (submitted.status !== "pass") {
          jsonResponse(res, 400, { error: "invalid requirement submission", issues: submitted.issues });
          return;
        }

        const submittedRecorded = recordRequirementIntakeSubmitted(workflowState, submitted, {
          created_at: input.created_at || input.createdAt
        });
        if (submittedRecorded.status !== "pass") {
          jsonResponse(res, 400, { error: "requirement intake record failed", issues: submittedRecorded.issues });
          return;
        }

        const recordedWorkflowState = { ...workflowState, ...submittedRecorded.workflow_state };
        writeProjectStatusState(projectStatusPath, submitted.project_status, stateStore);

        // If no existing item, create a new projection history entry for this submission
        if (!item) {
          const requirementId = submitted.requirement?.id || `requirement-${Date.now()}`;
          const snapshotId = `requirement-intake-submission-${safeSnapshotIdPart(requirementId)}-${Date.now()}`;
          const createdAt = new Date().toISOString();
          // Use SQLite path format when stateStore is configured
          const inputPath = stateStore
            ? sqliteSnapshotInputPath(snapshotId)
            : `docs/examples/snapshots/${snapshotId}.workbench-input.json`;
          const newItem = {
            id: snapshotId,
            label: `需求提交: ${submitted.requirement?.title || "未命名"}`,
            input_path: inputPath,
            projection_path: null,
            created_at: createdAt,
            status: "pending"
          };
          item = newItem;
          // Add to history, using the configured store (SQLite or file)
          history.items.unshift(newItem);
          history.latest = snapshotId;
          writeServerHistory(history);
        }

        writeWorkflowState(item, recordedWorkflowState);

        const planGeneration = await generateRequirementPlanIfRequested(submitted, input, {
          requirementPlanGenerator
        });
        let effectiveSubmission = planGeneration.submission;
        if (
          effectiveSubmission.plan_review?.phase === "ready_for_review" &&
          requirementAutoAdvanceAllowedAfterPlanReview(input)
        ) {
          const approved = updateRequirementPlanReview(effectiveSubmission.project_status, {
            requirement_id: effectiveSubmission.requirement.id,
            action: "approve",
            note: "auto advance was explicitly allowed for an already-approved plan review",
            created_at: input.created_at || input.createdAt
          }, {
            created_at: input.created_at || input.createdAt
          });
          if (approved.status !== "pass") {
            jsonResponse(res, 400, { error: "plan review approval failed", issues: approved.issues });
            return;
          }
          effectiveSubmission = {
            ...effectiveSubmission,
            plan_review: approved.plan_review,
            project_status: approved.project_status
          };
        }

        const effectiveWorkflowState = workflowStateWithProjectStatus(
          submittedRecorded.workflow_state,
          effectiveSubmission.project_status
        );
        writeProjectStatusState(projectStatusPath, effectiveSubmission.project_status, stateStore);
        writeWorkflowState(item, effectiveWorkflowState);
        const projection = workbenchProjection(effectiveWorkflowState);
        const planReviewPhase = effectiveSubmission.plan_review?.phase;
        const planReviewPending = planReviewPhase === "ready_for_review" &&
          !requirementAutoAdvanceAllowedAfterPlanReview(input);
        const planGenerationPending = planReviewPhase === "pending_plan_generation";
        const planGenerationFailed = planReviewPhase === "plan_generation_failed";
        const auto_advance = planReviewPending
          ? {
            status: "waiting_for_plan_review",
            result: null,
            artifact: null,
            projection,
            reason: "requirement plan review must be approved before automatic development can continue"
          }
          : planGenerationPending
            ? {
              status: "waiting_for_plan_generation",
              result: null,
              artifact: null,
              projection,
              reason: "requirement plan must be generated by a model before review or development can continue"
            }
          : planGenerationFailed
            ? {
              status: "plan_generation_failed",
              result: null,
              artifact: null,
              projection,
              reason: effectiveSubmission.plan_review?.generation_error?.message ||
                "requirement plan generation failed and must be retried or repaired"
            }
          : await runRequirementAutoAdvance({
            req,
            selectedId,
            input,
            item,
            readWorkflowState,
            writeWorkflowState,
            readServerHistory,
            allowedHistoryRoots,
            projectStatusPath,
            stateStore,
            workbenchProjection
          });
        jsonResponse(res, 201, {
          status: "created",
          item,
          requirement: effectiveSubmission.requirement,
          plan_review: effectiveSubmission.plan_review,
          plan_generation: {
            status: planGeneration.status,
            issues: planGeneration.issues || []
          },
          artifact: submittedRecorded.artifact,
          next_action_readout: auto_advance.projection?.next_action_readout || projection.next_action_readout,
          projection: auto_advance.projection || projection,
          submitted_projection: projection,
          auto_advance
        });
        return;
      }

      if (url.pathname === "/api/workbench/plan-reviews" && req.method === "POST") {
        const history = readServerHistory();
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }
        const workflowState = readWorkflowState(item);
        const currentProjectStatus = readProjectStatus(projectStatusPath, stateStore) || workflowState.project_status;
        const updated = updateRequirementPlanReview(currentProjectStatus || {}, input, {
          created_at: input.created_at || input.createdAt
        });
        if (updated.status !== "pass") {
          jsonResponse(res, 400, { error: "invalid plan review update", issues: updated.issues });
          return;
        }

        const nextWorkflowState = {
          ...workflowState,
          project_status: updated.project_status,
          global_goals: Array.isArray(updated.project_status.global_goals) ? updated.project_status.global_goals : workflowState.global_goals
        };
        writeProjectStatusState(projectStatusPath, updated.project_status, stateStore);
        writeWorkflowState(item, nextWorkflowState);
        const projection = workbenchProjection(nextWorkflowState);
        const shouldAutoAdvanceAfterApproval = normalizeString(input.action).toLowerCase() === "approve" &&
          requirementAutoAdvanceEnabled(input);
        const auto_advance = shouldAutoAdvanceAfterApproval
          ? await runRequirementAutoAdvance({
            req,
            selectedId,
            input: {
              ...input,
              auto_advance_after_plan_review: true
            },
            item,
            readWorkflowState,
            writeWorkflowState,
            readServerHistory,
            allowedHistoryRoots,
            projectStatusPath,
            stateStore,
            workbenchProjection
          })
          : {
            status: "disabled",
            result: null,
            artifact: null,
            projection
          };
        jsonResponse(res, 201, {
          status: "updated",
          item,
          plan_review: updated.plan_review,
          projection: auto_advance.projection || projection,
          submitted_projection: projection,
          auto_advance
        });
        return;
      }

      if (url.pathname === "/api/workbench/context-pack-cycle" && req.method === "POST") {
        const history = readServerHistory();
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }
        const workflowState = readWorkflowState(item);
        const materialized = materializeContextPackCycleFromWorkflowState(workflowState, {
          cycle_id: input.cycle_id || input.cycleId,
          created_at: input.created_at || input.createdAt
        });
        if (materialized.status !== "ready") {
          jsonResponse(res, 409, {
            error: "context pack cycle is not ready",
            issues: materialized.issues || [],
            item,
            projection: workbenchProjection(workflowState)
          });
          return;
        }

        const snapshotId = normalizeString(input.snapshot_id || input.snapshotId) ||
          generatedContextPackSnapshotId(selectedId);
        const published = publishSnapshot({
          id: snapshotId,
          label: input.label || `Context pack cycle from ${selectedId}`,
          input: materialized.workflow_state,
          created_at: input.created_at || input.createdAt
        }, {
          root,
          historyPath: serverHistoryPath,
          snapshotsRoot
        });
        if (published.status === "fail") {
          jsonResponse(res, 400, { error: "context pack cycle snapshot publish failed", issues: published.issues });
          return;
        }

        if (materialized.source_record?.status === "pass") {
          writeWorkflowState(item, { ...workflowState, ...materialized.source_record.workflow_state });
        }

        jsonResponse(res, 201, {
          status: "created",
          item,
          materialized: {
            status: materialized.status,
            phase: materialized.phase,
            work_package_count: materialized.work_packages.length,
            context_pack: materialized.context_pack
          },
          source_artifact: materialized.source_record?.artifact || null,
          next_item: published.item,
          projection: published.projection,
          current_projection: materialized.source_record?.status === "pass"
            ? workbenchProjection(materialized.source_record.workflow_state)
            : workbenchProjection(workflowState)
        });
        return;
      }

      if (url.pathname === "/api/workbench/context-work-packages-run" && req.method === "POST") {
        const history = readServerHistory();
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }
        const workflowState = readWorkflowState(item);
        const projection = workbenchProjection(workflowState);
        const result = runContextWorkPackages(workflowState, {
          ...contextWorkPackageRunOptions(input, projection),
          already_satisfied_evaluator: createMainlineAlreadySatisfiedEvaluator(),
          provider_executor: contextWorkPackageProviderExecutor
        });
        if (result.status !== "pass") {
          jsonResponse(res, 409, {
            status: result.status,
            error: result.status === "validated"
              ? "context work package run validated without completion authority"
              : "context work package run failed",
            issues: result.issues || [],
            item,
            phase: result.phase,
            fixed_development_mode_gate: result.fixed_development_mode_gate || result.gate_result || null,
            work_package_execution_governance: result.work_package_execution_governance ||
              (result.phase === "work_package_execution_governance" ? result.gate_result : null),
            execution_plan: result.execution_plan || null,
            package_results: result.package_results || [],
            executor_provenance: result.executor_provenance || null,
            allows_work_package_completion: result.allows_work_package_completion === true,
            completion_authority: result.completion_authority || null,
            projection: workbenchProjection(workflowState)
          });
          return;
        }

        writeWorkflowState(item, { ...workflowState, ...result.workflow_state });
        jsonResponse(res, 201, {
          status: "created",
          item,
          phase: result.phase,
          executed_count: result.executed_count,
          executed_work_packages: result.executed_work_packages,
          artifact: result.artifact,
          projection: workbenchProjection(result.workflow_state)
        });
        return;
      }

      if (url.pathname === "/api/workbench/scheduler-dispatch-plan" && req.method === "POST") {
        const history = readServerHistory();
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }
        const workflowState = readWorkflowState(item);
        const plan = createSchedulerDispatchPlan(
          schedulerPlanInputFromWorkflowState(workflowState, input),
          schedulerPlanOptionsFromRequest(req, item, selectedId, input, workflowState)
        );
        if (plan.status !== "pass") {
          jsonResponse(res, 400, { error: "scheduler dispatch plan failed", issues: plan.issues });
          return;
        }

        jsonResponse(res, 201, {
          status: "created",
          item,
          plan
        });
        return;
      }

      if (url.pathname === "/api/workbench/scheduler-dispatch" && req.method === "POST") {
        const history = readServerHistory();
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }
        const normalizedControl = normalizeSchedulerDispatchControlRequest(input);
        if (normalizedControl.status !== "pass") {
          jsonResponse(res, 400, { error: "scheduler dispatch control request rejected", issues: normalizedControl.issues });
          return;
        }
        const controlInput = normalizedControl.input;
        const workflowState = readWorkflowState(item);
        const plan = createSchedulerDispatchPlan(
          schedulerPlanInputFromWorkflowState(workflowState, controlInput),
          schedulerPlanOptionsFromRequest(req, item, selectedId, controlInput, workflowState)
        );
        if (plan.status !== "pass") {
          jsonResponse(res, 400, { error: "scheduler dispatch plan failed", issues: plan.issues });
          return;
        }

        const policy = evaluateSchedulerDispatchControlPolicy(controlInput, plan);
        const policyRecorded = recordSchedulerDispatchPolicyDecision(workflowState, policy, {
          created_at: controlInput.created_at || controlInput.createdAt,
          plan
        });
        if (policyRecorded.status !== "pass") {
          jsonResponse(res, 400, { error: "scheduler dispatch policy record failed", issues: policyRecorded.issues });
          return;
        }
        writeWorkflowState(item, { ...workflowState, ...policyRecorded.workflow_state });

        if (policy.status !== "pass") {
          jsonResponse(res, 400, {
            error: "scheduler dispatch policy rejected",
            issues: policy.issues,
            policy,
            control: normalizedControl,
            artifact: policyRecorded.artifact,
            projection: workbenchProjection(policyRecorded.workflow_state)
          });
          return;
        }

        const runResult = await runSchedulerDispatchPlan(plan, { dry_run: policy.execution_mode === "dry_run" });
        const runArtifact = createSchedulerDispatchRunArtifact(plan, runResult, {
          created_at: controlInput.created_at || controlInput.createdAt
        });
        let workflowStateForRunRecord = policyRecorded.workflow_state;
        if (
          policy.execution_mode !== "dry_run" &&
          plan.dispatch_kind === "agent_lifecycle_cleanup" &&
          runResult.status === "pass"
        ) {
          const cleanupOutput = readSchedulerWorkflowStateOutput(runResult);
          if (cleanupOutput.status !== "pass") {
            jsonResponse(res, 400, {
              error: "scheduler dispatch cleanup output unavailable",
              issues: cleanupOutput.issues || [],
              projection: workbenchProjection(policyRecorded.workflow_state)
            });
            return;
          }
          workflowStateForRunRecord = cleanupOutput.workflow_state;
        }

        const recorded = recordSchedulerDispatchRunArtifact(workflowStateForRunRecord, runArtifact, {
          created_at: controlInput.created_at || controlInput.createdAt
        });
        if (recorded.status !== "pass") {
          jsonResponse(res, 400, { error: "scheduler dispatch run record failed", issues: recorded.issues });
          return;
        }

        let nextWorkflowState = recorded.workflow_state;
        let continuation = null;
        if (policy.execution_mode !== "dry_run" && plan.dispatch_kind !== "agent_lifecycle_cleanup") {
          continuation = prepareSchedulerDispatchContinuationFromRunArtifact(runArtifact);
          if (continuation.status !== "ready") {
            jsonResponse(res, 400, {
              error: "scheduler dispatch continuation preparation failed",
              issues: continuation.issues || [],
              continuation,
              projection: workbenchProjection(nextWorkflowState)
            });
            return;
          }
          const continuationOutputPath = writePreparedSchedulerContinuation(runArtifact, continuation, [
            resolve(root, "tmp"),
            snapshotsRoot
          ]);
          const continuationRecorded = recordSchedulerDispatchContinuationPrepared(nextWorkflowState, continuation, {
            created_at: controlInput.created_at || controlInput.createdAt,
            source_artifact_id: recorded.artifact.id,
            continuation_input_path: metadataPath(continuationOutputPath)
          });
          if (continuationRecorded.status !== "pass") {
            jsonResponse(res, 400, { error: "scheduler dispatch continuation record failed", issues: continuationRecorded.issues });
            return;
          }
          nextWorkflowState = continuationRecorded.workflow_state;
        }

        writeWorkflowState(item, { ...workflowState, ...nextWorkflowState });
        jsonResponse(res, 201, {
          status: "created",
          item,
          plan,
          policy,
          control: normalizedControl,
          result: runResult,
          artifact: recorded.artifact,
          continuation,
          projection: workbenchProjection(nextWorkflowState)
        });
        return;
      }

      if (url.pathname === "/api/workbench/scheduler-next-cycle" && req.method === "POST") {
        const history = readServerHistory();
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }
        const workflowState = readWorkflowState(item);
        const latestRun = latestSchedulerDispatchRun(workflowState);
        if (!latestRun.metadata) {
          jsonResponse(res, 400, { error: "scheduler dispatch run artifact not found" });
          return;
        }

        const continuation = prepareSchedulerDispatchContinuationFromRunArtifact(latestRun.metadata);
        if (continuation.status !== "ready") {
          jsonResponse(res, 400, {
            error: "scheduler dispatch continuation preparation failed",
            issues: continuation.issues || [],
            continuation
          });
          return;
        }

        let continuationOutputPath;
        let generatedInput;
        try {
          continuationOutputPath = safeGeneratedContinuationPath(
            schedulerContinuationOutputPath(latestRun.metadata),
            [resolve(root, "tmp"), snapshotsRoot]
          );
          generatedInput = readJson(continuationOutputPath);
        } catch (error) {
          if (error.code === "ENOENT") {
            jsonResponse(res, 400, { error: "scheduler dispatch generated continuation input not found" });
            return;
          }
          throw error;
        }
        const generatedIssues = generatedContinuationInputIssues(generatedInput, continuation);
        if (generatedIssues.length > 0) {
          jsonResponse(res, 400, { error: "generated continuation input validation failed", issues: generatedIssues });
          return;
        }

        const createdAt = input.created_at || input.createdAt;
        const sourceArtifactId = latestRun.artifact?.id || latestRun.event?.artifact_id;
        const continuationInputPath = metadataPath(continuationOutputPath);
        const existingContinuation = latestArtifactForEvent(workflowState, "scheduler_dispatch_continuation");
        const existingContinuationMatchesRun = existingContinuation.metadata?.status === "ready" &&
          existingContinuation.metadata?.source_artifact_id === sourceArtifactId &&
          existingContinuation.metadata?.continuation_input_path === continuationInputPath;
        const continuationRecorded = existingContinuationMatchesRun
          ? {
            status: "pass",
            artifact: existingContinuation.artifact,
            workflow_state: workflowState
          }
          : recordSchedulerDispatchContinuationPrepared(workflowState, continuation, {
            created_at: createdAt,
            source_artifact_id: sourceArtifactId,
            continuation_input_path: continuationInputPath
          });
        if (continuationRecorded.status !== "pass") {
          jsonResponse(res, 400, { error: "scheduler dispatch continuation record failed", issues: continuationRecorded.issues });
          return;
        }

        const requestedSnapshotId = normalizeString(input.snapshot_id || input.snapshotId);
        const snapshotId = requestedSnapshotId || `next-cycle-${selectedId}-${Date.now()}`;
        const enqueued = recordSchedulerNextCycleEnqueue(continuationRecorded.workflow_state, continuation, {
          created_at: createdAt,
          source_artifact_id: sourceArtifactId,
          continuation_artifact_id: continuationRecorded.artifact.id,
          continuation_input_path: continuationInputPath,
          snapshot_id: snapshotId
        });
        if (enqueued.status !== "pass") {
          jsonResponse(res, 400, { error: "scheduler next cycle enqueue record failed", issues: enqueued.issues });
          return;
        }

        const published = publishSnapshot({
          id: snapshotId,
          label: input.label || `Next cycle from ${selectedId}`,
          input: generatedInput.workflow_state,
          created_at: createdAt
        }, {
          root,
          historyPath: serverHistoryPath,
          snapshotsRoot
        });
        if (published.status === "fail") {
          jsonResponse(res, 400, { error: "scheduler next cycle snapshot publish failed", issues: published.issues });
          return;
        }

        writeWorkflowState(item, { ...workflowState, ...enqueued.workflow_state });

        jsonResponse(res, 201, {
          status: "queued",
          item,
          continuation,
          continuation_artifact: continuationRecorded.artifact,
          enqueue_artifact: enqueued.artifact,
          next_item: published.item,
          projection: published.projection,
          current_projection: workbenchProjection(enqueued.workflow_state)
        });
        return;
      }

      if (url.pathname === "/api/workbench/autonomous-scheduler-loop" && req.method === "POST") {
        const history = readServerHistory();
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }

        const maxIterations = Number(input.max_iterations || input.maxIterations || 1);
        const loopInput = {
          start_projection_id: selectedId,
          max_iterations: maxIterations,
          execution_profile: input.execution_profile || input.executionProfile || "approved_mock_non_dry_run",
          execution_strategy: input.execution_strategy || input.executionStrategy || "scheduler_dispatch_chain",
          reviewer_mock_status: input.reviewer_mock_status || input.reviewerMockStatus,
          reviewer_mock_findings_json: input.reviewer_mock_findings_json || input.reviewerMockFindingsJson,
          max_external_reviewer_calls: input.max_external_reviewer_calls ?? input.maxExternalReviewerCalls,
          provider_cost_mode: input.provider_cost_mode || input.providerCostMode,
          budget_tier: input.budget_tier || input.budgetTier,
          risk: input.risk || input.risk_level || input.riskLevel,
          timeout_seconds: input.timeout_seconds || input.timeoutSeconds,
          record_provider_health_on_timeout: input.record_provider_health_on_timeout ?? input.recordProviderHealthOnTimeout,
          snapshot_prefix: input.snapshot_prefix || input.snapshotPrefix || "autonomous-loop",
          created_at: input.created_at || input.createdAt
        };
        const loopResult = await runSchedulerLoopDriver(loopInput, {
          client: createWorkbenchLoopClient(workbenchBaseUrlFromRequest(req))
        });
        const loopArtifact = createSchedulerLoopRunArtifact(loopInput, loopResult, {
          created_at: input.created_at || input.createdAt
        });
        const latestWorkflowState = readWorkflowState(item);
        const recorded = recordAutonomousSchedulerLoopRunArtifact(latestWorkflowState, loopArtifact, {
          created_at: input.created_at || input.createdAt
        });
        if (recorded.status !== "pass") {
          jsonResponse(res, 400, { error: "autonomous scheduler loop record failed", issues: recorded.issues });
          return;
        }
        writeWorkflowState(item, { ...latestWorkflowState, ...recorded.workflow_state });

        jsonResponse(res, loopResult.status === "pass" ? 201 : 400, {
          status: loopResult.status === "pass" ? "created" : "failed",
          item,
          result: loopResult,
          artifact: recorded.artifact,
          projection: workbenchProjection(recorded.workflow_state)
        });
        return;
      }

      if (url.pathname === "/api/workbench/autonomous-scheduler-loop-resume" && req.method === "POST") {
        const history = readServerHistory();
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }

        const sourceWorkflowState = readWorkflowState(item);
        const registry = buildSchedulerLoopRunRegistry(sourceWorkflowState);
        const recovery = evaluateSchedulerLoopRecovery(registry);
        const sourceProjection = workbenchProjection(sourceWorkflowState);
        if (recovery.status !== "ready" || !recovery.resume_projection_id) {
          const blockedAttempt = recordSchedulerLoopResumeAttempt(sourceWorkflowState, {
            status: "blocked",
            source_projection_id: selectedId,
            recovery_status: recovery.status,
            recovery_action: recovery.action,
            issues: recovery.issues || []
          }, {
            created_at: input.created_at || input.createdAt
          });
          if (blockedAttempt.status === "pass") {
            writeWorkflowState(item, { ...sourceWorkflowState, ...blockedAttempt.workflow_state });
          }
          jsonResponse(res, 409, {
            error: "autonomous scheduler loop is not resumable",
            recovery,
            resume_attempt: blockedAttempt.artifact || null,
            projection: blockedAttempt.status === "pass"
              ? workbenchProjection(blockedAttempt.workflow_state)
              : sourceProjection
          });
          return;
        }

        const targetId = recovery.resume_projection_id;
        const targetItem = history.items.find((entry) => entry.id === targetId);
        if (!targetItem?.input_path) {
          const blockedAttempt = recordSchedulerLoopResumeAttempt(sourceWorkflowState, {
            status: "blocked",
            source_projection_id: selectedId,
            resume_projection_id: targetId,
            recovery_status: recovery.status,
            recovery_action: recovery.action,
            issues: [{ code: "resume_input_missing", message: `resume workflow state input not found: ${targetId}`, path: "recovery.resume_projection_id" }]
          }, {
            created_at: input.created_at || input.createdAt
          });
          if (blockedAttempt.status === "pass") {
            writeWorkflowState(item, { ...sourceWorkflowState, ...blockedAttempt.workflow_state });
          }
          jsonResponse(res, 400, {
            error: `resume workflow state input not found: ${targetId}`,
            recovery,
            resume_attempt: blockedAttempt.artifact || null,
            projection: blockedAttempt.status === "pass"
              ? workbenchProjection(blockedAttempt.workflow_state)
              : sourceProjection
          });
          return;
        }

        const loopInput = {
          start_projection_id: targetId,
          max_iterations: Number(input.max_iterations || input.maxIterations || 1),
          execution_profile: input.execution_profile || input.executionProfile || "approved_mock_non_dry_run",
          execution_strategy: input.execution_strategy || input.executionStrategy || "scheduler_dispatch_chain",
          reviewer_mock_status: input.reviewer_mock_status || input.reviewerMockStatus,
          reviewer_mock_findings_json: input.reviewer_mock_findings_json || input.reviewerMockFindingsJson,
          max_external_reviewer_calls: input.max_external_reviewer_calls ?? input.maxExternalReviewerCalls,
          provider_cost_mode: input.provider_cost_mode || input.providerCostMode,
          budget_tier: input.budget_tier || input.budgetTier,
          risk: input.risk || input.risk_level || input.riskLevel,
          timeout_seconds: input.timeout_seconds || input.timeoutSeconds,
          record_provider_health_on_timeout: input.record_provider_health_on_timeout ?? input.recordProviderHealthOnTimeout,
          snapshot_prefix: input.snapshot_prefix || input.snapshotPrefix || "resume-loop",
          created_at: input.created_at || input.createdAt
        };
        const loopResult = await runSchedulerLoopDriver(loopInput, {
          client: createWorkbenchLoopClient(workbenchBaseUrlFromRequest(req))
        });
        const loopArtifact = createSchedulerLoopRunArtifact(loopInput, loopResult, {
          created_at: input.created_at || input.createdAt
        });

        const targetWorkflowState = readWorkflowState(targetItem);
        const recorded = recordAutonomousSchedulerLoopRunArtifact(targetWorkflowState, loopArtifact, {
          created_at: input.created_at || input.createdAt
        });
        if (recorded.status !== "pass") {
          jsonResponse(res, 400, { error: "autonomous scheduler loop resume record failed", issues: recorded.issues });
          return;
        }
        writeWorkflowState(targetItem, { ...targetWorkflowState, ...recorded.workflow_state });

        const resumeAttempt = recordSchedulerLoopResumeAttempt(sourceWorkflowState, {
          status: loopResult.status === "pass" ? "pass" : "fail",
          source_projection_id: selectedId,
          resume_projection_id: targetId,
          recovery_status: recovery.status,
          recovery_action: recovery.action,
          loop_status: loopResult.status,
          loop_phase: loopResult.phase,
          loop_artifact_id: recorded.artifact.id,
          issues: loopResult.issues || []
        }, {
          created_at: input.created_at || input.createdAt
        });
        if (resumeAttempt.status !== "pass") {
          jsonResponse(res, 400, { error: "scheduler loop resume attempt record failed", issues: resumeAttempt.issues });
          return;
        }
        writeWorkflowState(item, { ...sourceWorkflowState, ...resumeAttempt.workflow_state });

        jsonResponse(res, loopResult.status === "pass" ? 201 : 400, {
          status: loopResult.status === "pass" ? "created" : "failed",
          source_item: item,
          item: targetItem,
          recovery,
          result: loopResult,
          artifact: recorded.artifact,
          resume_attempt: resumeAttempt.artifact,
          source_projection: workbenchProjection(resumeAttempt.workflow_state),
          projection: workbenchProjection(recorded.workflow_state)
        });
        return;
      }

      if (url.pathname === "/api/workbench/next-action" && req.method === "POST") {
        const history = readServerHistory();
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }
        const workflowState = readWorkflowState(item);
        const projection = workbenchProjection(workflowState);
        const executed = await executeProjectedNextAction({
          req,
          selectedId,
          projection,
          input
        });
        if (executed.status !== "executed") {
          jsonResponse(res, executed.http_status || 409, {
            error: executed.error,
            issues: executed.issues || [],
            item,
            next_action_readout: projection.next_action_readout,
            result: executed.result || null,
            projection
          });
          return;
        }
        const updatedWorkflowState = readWorkflowState(item);
        const updatedProjection = workbenchProjection(updatedWorkflowState);

        jsonResponse(res, 201, {
          status: "executed",
          action: executed.action,
          item,
          next_action_readout: projection.next_action_readout,
          result: executed.result,
          projection: updatedProjection,
          previous_projection: projection
        });
        return;
      }

      if (url.pathname === "/api/workbench/scheduler-dispatch-run" && req.method === "POST") {
        const history = readServerHistory();
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }

        const issues = schedulerDispatchRunIssues(input);
        if (issues.length > 0) {
          jsonResponse(res, 400, { error: "invalid scheduler dispatch run artifact", issues });
          return;
        }
        const workflowState = readWorkflowState(item);
        const result = recordSchedulerDispatchRunArtifact(
          workflowState,
          schedulerDispatchRunArtifactFromInput(input),
          { created_at: input.created_at }
        );
        if (result.status !== "pass") {
          jsonResponse(res, 400, { error: "scheduler dispatch run record failed", issues: result.issues });
          return;
        }

        writeWorkflowState(item, { ...workflowState, ...result.workflow_state });
        jsonResponse(res, 201, {
          status: "created",
          item,
          artifact: result.artifact,
          projection: workbenchProjection(result.workflow_state)
        });
        return;
      }

      if (url.pathname === "/api/workbench/events" && req.method === "GET") {
        jsonResponse(res, 200, readEvents(eventsPath, stateStore));
        return;
      }

      if (url.pathname === "/api/workbench/events" && req.method === "POST") {
        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }
        const issues = operatorEventIssues(input);
        if (issues.length > 0) {
          jsonResponse(res, 400, { error: "invalid operator event", issues });
          return;
        }
        const event = normalizeEvent(input, url.searchParams.get("projection_id"));
        const ledger = appendEvent(eventsPath, event, stateStore);
        jsonResponse(res, 201, { status: "created", event, count: ledger.events.length });
        return;
      }

      if (url.pathname === "/favicon.svg") {
        if (!serveLegacyStatic) {
          jsonResponse(res, 404, { error: "not found" });
          return;
        }
        const faviconPath = safeStaticPath("/apps/workbench/favicon.svg");
        if (faviconPath) {
          sendStaticFile(res, faviconPath);
          return;
        }
      }

      if (!serveLegacyStatic) {
        jsonResponse(res, 404, {
          error: "workbench pages are served by Next.js; this process only serves /api/workbench/*"
        });
        return;
      }

      const resolvedPath = safeStaticPath(
        url.pathname === "/" ? "/apps/workbench/desktop.html" : url.pathname
      );
      if (!resolvedPath) {
        jsonResponse(res, 404, { error: "not found" });
        return;
      }

      sendStaticFile(res, resolvedPath);
    } catch (error) {
      if (error.code === "ENOENT") {
        jsonResponse(res, 404, { error: "not found" });
        return;
      }

      if (error.code === "PROJECTION_NOT_FOUND") {
        jsonResponse(res, 404, { error: error.message });
        return;
      }

      if (error.code === "INVALID_HISTORY_PATH" || error.code === "WORKFLOW_SNAPSHOT_REQUIRED") {
        jsonResponse(res, 400, { error: error.message });
        return;
      }

      if (error.code === "INVALID_WORKBENCH_HOST") {
        jsonResponse(res, 400, { error: error.message });
        return;
      }

      if (error.code === "INVALID_CONTINUATION_PATH") {
        jsonResponse(res, 400, { error: error.message });
        return;
      }

      jsonResponse(res, 500, { error: error.message });
    }
  });
}

function valueAfter(flag, args = process.argv.slice(2)) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function normalizeCliPort(value) {
  const raw = String(value ?? "").trim();
  const port = Number(raw);
  if (!raw || !Number.isInteger(port) || port < 0 || port > 65535) {
    const error = new Error(`Invalid workbench server port: ${raw || "(empty)"}. Expected an integer from 0 to 65535.`);
    error.code = "INVALID_WORKBENCH_PORT";
    throw error;
  }
  return port;
}

function parseWorkbenchServerCliArgs(args = process.argv.slice(2), env = process.env) {
  const optionNames = new Set(["--host", "--port", "--history-path", "--snapshots-root", "--events-path", "--project-status", "--state-db", "--serve-legacy-static"]);
  const optionsWithValues = new Set(["--host", "--port", "--history-path", "--snapshots-root", "--events-path", "--project-status", "--state-db"]);
  const positionalArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (optionsWithValues.has(arg.split("=")[0])) {
      if (!arg.includes("=")) index += 1;
      continue;
    }
    if (optionNames.has(arg)) {
      index += 1;
      continue;
    }
    if (!arg.startsWith("-")) positionalArgs.push(arg);
  }

  const optionValue = (name) => {
    const equalsPrefix = `${name}=`;
    const inline = args.find((arg) => arg.startsWith(equalsPrefix));
    if (inline) return inline.slice(equalsPrefix.length);
    return valueAfter(name, args);
  };
  const portValue = args.includes("--port")
    || args.some((arg) => arg.startsWith("--port="))
    ? optionValue("--port")
    : env.PORT ?? positionalArgs[0] ?? "4180";
  return {
    port: normalizeCliPort(portValue),
    host: optionValue("--host") || "127.0.0.1",
    historyPath: optionValue("--history-path"),
    snapshotsRoot: optionValue("--snapshots-root"),
    eventsPath: optionValue("--events-path"),
    projectStatusPath: optionValue("--project-status"),
    stateDbPath: optionValue("--state-db") || process.env.AI_CONTROL_WORKBENCH_STATE_DB || defaultStateDbPath,
    serveLegacyStatic: args.includes("--serve-legacy-static") || env.AI_CONTROL_WORKBENCH_SERVE_LEGACY_STATIC === "1"
  };
}

export function startWorkbenchServer({
  port = 4180,
  host = "127.0.0.1",
  historyPath: configuredHistoryPath,
  snapshotsRoot: configuredSnapshotsRoot,
  eventsPath: configuredEventsPath,
  projectStatusPath,
  stateDbPath = defaultStateDbPath,
  serveLegacyStatic = false
} = {}) {
  const server = createWorkbenchServer({
    historyPath: configuredHistoryPath,
    snapshotsRoot: configuredSnapshotsRoot,
    eventsPath: configuredEventsPath,
    projectStatusPath,
    stateDbPath,
    serveLegacyStatic
  });
  const listenPort = normalizeCliPort(port);
  server.listen(listenPort, host);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log([
      "Usage: node tools/workbench-server.mjs [port] [--host <host>] [--port <port>] [--history-path <path>] [--snapshots-root <path>] [--events-path <path>] [--project-status <path>] [--state-db <path>] [--serve-legacy-static]",
      "",
      "Starts the local workbench API service. Paths are resolved from the platform repo root. When --state-db is set, live workbench state is stored in SQLite instead of tracked JSON state files.",
      "",
      "--serve-legacy-static   Test-only compatibility mode for the old native HTML shell.",
      "                        Production and local public routes should be served by",
      "                        the Next.js App Router runtime instead."
    ].join("\n"));
    process.exit(0);
  }
  let cliOptions;
  try {
    cliOptions = parseWorkbenchServerCliArgs();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const server = startWorkbenchServer(cliOptions);
  server.on("listening", () => {
    const address = server.address();
    console.log(`Workbench server listening on http://${address.address}:${address.port}`);
  });
}
