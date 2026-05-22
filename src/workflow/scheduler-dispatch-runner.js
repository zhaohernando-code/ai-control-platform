import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { recordArtifact } from "./artifact-ledger.js";
import { summarizeAgentLifecyclePool } from "./agent-lifecycle-pool.js";
import { appendRunEvent } from "./run-manifest.js";

const SCHEDULER_DISPATCH_RUN_VERSION = "scheduler-dispatch-run.v1";
const AGENT_LIFECYCLE_POOL_SCRIPT = "record:agent-lifecycle-pool";
const ALLOWED_NPM_SCRIPTS = new Set([
  "run:reviewer-shard",
  "prepare:reviewer-shard-loop-continuation",
  "run:autonomous-closeout-loop",
  AGENT_LIFECYCLE_POOL_SCRIPT
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function issue(code, message, path) {
  return { code, message, path };
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeIdPart(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function planWorkflowState(plan = {}) {
  return plan?.decision?.snapshot_publish_plan?.input ||
    plan?.input?.workflow_state ||
    plan?.workflow_state ||
    null;
}

function planIdentity(plan = {}) {
  const workflowState = planWorkflowState(plan);
  return {
    run_id: normalizeString(workflowState?.manifest?.run_id),
    cycle_id: normalizeString(workflowState?.manifest?.cycle_id)
  };
}

function stepId(step, index) {
  return normalizeString(step?.id) || `step-${index + 1}`;
}

function validateAgentLifecyclePoolCleanupArgs(args = [], path) {
  const issues = [];

  if (args[2] !== "--") {
    issues.push(issue("missing_npm_args_separator", "record:agent-lifecycle-pool must pass tool args after --", `${path}.args`));
  }

  const tokens = args.slice(3);
  const seen = new Set();
  let inputPath = "";
  let outputPath = "";
  let cleanupLatestPool = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = normalizeString(tokens[index]);
    const tokenPath = `${path}.args[${index + 3}]`;

    if (token === "--input" || token === "--output") {
      if (seen.has(token)) {
        issues.push(issue("duplicate_agent_lifecycle_pool_arg", `${token} must appear only once`, tokenPath));
      }
      seen.add(token);

      const value = normalizeString(tokens[index + 1]);
      if (!value || value.startsWith("--")) {
        issues.push(issue(
          token === "--input" ? "missing_agent_lifecycle_cleanup_input" : "missing_agent_lifecycle_cleanup_output",
          `${token} requires a path value`,
          `${path}.args[${index + 4}]`
        ));
      } else if (token === "--input") {
        inputPath = value;
      } else {
        outputPath = value;
      }
      index += 1;
      continue;
    }

    if (token === "--cleanup-latest-pool") {
      if (seen.has(token)) {
        issues.push(issue("duplicate_agent_lifecycle_pool_arg", "--cleanup-latest-pool must appear only once", tokenPath));
      }
      seen.add(token);
      cleanupLatestPool = true;
      continue;
    }

    if (token) {
      issues.push(issue(
        "unsupported_agent_lifecycle_pool_arg",
        `${token} is not allowed for scheduler agent lifecycle cleanup`,
        tokenPath
      ));
    }
  }

  if (!inputPath) {
    issues.push(issue("missing_agent_lifecycle_cleanup_input", "record:agent-lifecycle-pool cleanup requires --input <path>", `${path}.args`));
  }
  if (!outputPath) {
    issues.push(issue("missing_agent_lifecycle_cleanup_output", "record:agent-lifecycle-pool cleanup requires --output <path>", `${path}.args`));
  }
  if (!cleanupLatestPool) {
    issues.push(issue("missing_agent_lifecycle_cleanup_flag", "record:agent-lifecycle-pool cleanup requires --cleanup-latest-pool", `${path}.args`));
  }

  const exactCleanupShape = args.length === 8 &&
    args[2] === "--" &&
    args[3] === "--input" &&
    Boolean(normalizeString(args[4])) &&
    !normalizeString(args[4]).startsWith("--") &&
    args[5] === "--output" &&
    Boolean(normalizeString(args[6])) &&
    !normalizeString(args[6]).startsWith("--") &&
    args[7] === "--cleanup-latest-pool";

  if (inputPath && outputPath && cleanupLatestPool && !exactCleanupShape) {
    issues.push(issue(
      "invalid_agent_lifecycle_cleanup_shape",
      "record:agent-lifecycle-pool scheduler step must be exactly: npm run record:agent-lifecycle-pool -- --input <path> --output <path> --cleanup-latest-pool",
      `${path}.args`
    ));
  }

  return issues;
}

function validateStep(step = {}, index = 0) {
  const issues = [];
  const path = `steps[${index}]`;
  const args = asArray(step.args);

  if (!normalizeString(step.id)) {
    issues.push(issue("missing_step_id", "scheduler dispatch step id is required", `${path}.id`));
  }
  if (step.command !== "npm") {
    issues.push(issue("unsupported_step_command", "scheduler dispatch only supports npm command steps", `${path}.command`));
  }
  if (args[0] !== "run" || !ALLOWED_NPM_SCRIPTS.has(args[1])) {
    issues.push(issue("unsupported_npm_script", "scheduler dispatch step must use an allowed npm run script", `${path}.args`));
  }
  if (args[0] === "run" && args[1] === AGENT_LIFECYCLE_POOL_SCRIPT) {
    issues.push(...validateAgentLifecyclePoolCleanupArgs(args, path));
  }

  return issues;
}

export function validateSchedulerDispatchPlan(plan = {}) {
  const issues = [];
  if (!isObject(plan)) {
    return {
      status: "fail",
      issues: [issue("invalid_scheduler_dispatch_plan", "dispatch plan must be an object", "")]
    };
  }

  const steps = asArray(plan.steps);
  if (steps.length === 0) {
    issues.push(issue("missing_dispatch_steps", "dispatch plan must include at least one step", "steps"));
  }

  const ids = new Set();
  steps.forEach((step, index) => {
    const id = stepId(step, index);
    if (ids.has(id)) issues.push(issue("duplicate_step_id", `${id} is duplicated`, `steps[${index}].id`));
    ids.add(id);
    issues.push(...validateStep(step, index));
  });

  steps.forEach((step, index) => {
    asArray(step.depends_on || step.dependsOn).forEach((dependencyId) => {
      if (!ids.has(normalizeString(dependencyId))) {
        issues.push(issue("unknown_step_dependency", `${dependencyId} is not a known scheduler step`, `steps[${index}].depends_on`));
      }
    });
  });

  return {
    status: issues.length ? "fail" : "pass",
    issues
  };
}

function defaultExecutor(step) {
  const result = spawnSync(step.command, step.args, {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  return {
    status: result.status === 0 ? "pass" : "fail",
    exit_code: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || ""
  };
}

function canRunStep(step, completed) {
  return asArray(step.depends_on || step.dependsOn)
    .every((dependencyId) => completed.has(normalizeString(dependencyId)));
}

function readJsonOutput(path) {
  const filePath = resolve(path);
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function summarizeOutput(kind, path) {
  const outputPath = normalizeString(path);
  if (!outputPath) return null;

  try {
    const payload = readJsonOutput(outputPath);
    if (kind === "reviewer_shard_loop_artifact") {
      return {
        status: "available",
        path: outputPath,
        version: payload.version || null,
        artifact_status: payload.status || null,
        phase: payload.phase || payload.result?.phase || null,
        run_count: asArray(payload.result?.runs).length,
        aggregate_status: payload.result?.aggregate?.status || null,
        pending_shards: payload.result?.aggregate?.pending_shards ?? null
      };
    }
    if (kind === "continuation_input") {
      return {
        status: "available",
        path: outputPath,
        project_status: payload.project_status?.project || null,
        next_step: payload.project_status?.next_step || null,
        work_package_count: asArray(payload.workflow_state?.manifest?.work_packages).length
      };
    }
    if (kind === "workflow_state") {
      const lifecyclePool = summarizeAgentLifecyclePool(payload.manifest, payload.artifact_ledger || payload.artifactLedger);
      return {
        status: "available",
        path: outputPath,
        run_id: payload.manifest?.run_id || null,
        cycle_id: payload.manifest?.cycle_id || null,
        work_package_count: asArray(payload.manifest?.work_packages).length,
        agent_lifecycle_pool: lifecyclePool
      };
    }
    if (kind === "agent_lifecycle_cleanup") {
      const lifecyclePool = summarizeAgentLifecyclePool(payload.manifest, payload.artifact_ledger || payload.artifactLedger);
      return {
        status: "available",
        path: outputPath,
        cleanup_status: lifecyclePool.status,
        pool_id: lifecyclePool.pool_id,
        open: lifecyclePool.open,
        unevaluated: lifecyclePool.unevaluated,
        unclosed: lifecyclePool.unclosed,
        iteration_closed: lifecyclePool.iteration_closed,
        next_action: lifecyclePool.next_action,
        artifact_id: lifecyclePool.artifact_id,
        event_id: lifecyclePool.event_id
      };
    }
    if (kind === "autonomous_closeout_loop_artifact") {
      const nextDecision = payload.result?.next_decision || {};
      return {
        status: "available",
        path: outputPath,
        version: payload.version || null,
        artifact_status: payload.status || null,
        phase: payload.phase || payload.result?.phase || null,
        result_status: payload.result?.status || null,
        next_decision_status: nextDecision.status || null,
        next_decision_action: nextDecision.action || null,
        should_continue: nextDecision.should_continue ?? null,
        next_work_package_count: asArray(nextDecision.next_work_packages).length
      };
    }
    return {
      status: "available",
      path: outputPath
    };
  } catch (error) {
    return {
      status: "unavailable",
      path: outputPath,
      issue: error.message
    };
  }
}

function summarizeStepOutputs(outputs = {}) {
  return Object.fromEntries(
    Object.entries(outputs || {})
      .map(([kind, path]) => [kind, summarizeOutput(kind, path)])
      .filter(([, summary]) => summary !== null)
  );
}

export async function runSchedulerDispatchPlan(plan = {}, options = {}) {
  const validation = validateSchedulerDispatchPlan(plan);
  if (validation.status !== "pass") {
    return {
      status: "fail",
      phase: "validation",
      issues: validation.issues,
      steps: []
    };
  }

  const executor = options.executor || defaultExecutor;
  const completed = new Set();
  const results = [];

  for (const [index, step] of asArray(plan.steps).entries()) {
    const id = stepId(step, index);
    if (!canRunStep(step, completed)) {
      return {
        status: "fail",
        phase: "dependency",
        issues: [issue("step_dependency_not_completed", `${id} dependency is not completed`, `steps[${index}].depends_on`)],
        steps: results
      };
    }

    const execution = options.dry_run
      ? { status: "pass", exit_code: 0, stdout: "", stderr: "", dry_run: true }
      : await executor(step, { index, plan });
    const stepResult = {
      id,
      action: step.action || null,
      status: execution.status === "pass" ? "pass" : "fail",
      exit_code: execution.exit_code ?? null,
      dry_run: execution.dry_run === true,
      stdout: execution.stdout || "",
      stderr: execution.stderr || "",
      outputs: execution.status === "pass" && !options.dry_run
        ? summarizeStepOutputs(step.outputs)
        : {}
    };
    results.push(stepResult);

    if (stepResult.status !== "pass") {
      return {
        status: "fail",
        phase: "execution",
        issues: [issue("scheduler_step_failed", `${id} failed`, `steps[${index}]`)],
        steps: results
      };
    }
    completed.add(id);
  }

  return {
    status: "pass",
    phase: "completed",
    issues: [],
    steps: results
  };
}

export function createSchedulerDispatchRunArtifact(plan = {}, result = {}, options = {}) {
  const identity = planIdentity(plan);
  return {
    version: SCHEDULER_DISPATCH_RUN_VERSION,
    run_id: identity.run_id || null,
    cycle_id: identity.cycle_id || null,
    status: result.status || "fail",
    phase: result.phase || null,
    created_at: options.created_at || new Date().toISOString(),
    input: {
      plan
    },
    result: {
      status: result.status || "fail",
      phase: result.phase || null,
      issues: result.issues || [],
      steps: result.steps || []
    }
  };
}

function nextSchedulerDispatchArtifactId(workflowState = {}, options = {}) {
  const explicit = normalizeString(options.artifact_id || options.artifactId);
  if (explicit) return explicit;

  const prefix = `scheduler-dispatch-run-${safeIdPart(workflowState?.manifest?.run_id)}-${safeIdPart(workflowState?.manifest?.cycle_id)}`;
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

export function recordSchedulerDispatchRunArtifact(workflowState = {}, runArtifact = {}, options = {}) {
  if (!isObject(workflowState)) {
    return {
      status: "fail",
      issues: [issue("invalid_workflow_state", "workflow state must be an object", "workflow_state")]
    };
  }

  const runId = normalizeString(workflowState?.manifest?.run_id);
  const cycleId = normalizeString(workflowState?.manifest?.cycle_id);
  if (!runId || !cycleId) {
    return {
      status: "fail",
      issues: [issue("missing_workflow_identity", "workflow state manifest run_id and cycle_id are required", "workflow_state.manifest")]
    };
  }

  const artifactRunId = normalizeString(runArtifact.run_id || runArtifact.runId);
  const artifactCycleId = normalizeString(runArtifact.cycle_id || runArtifact.cycleId);
  if ((artifactRunId && artifactRunId !== runId) || (artifactCycleId && artifactCycleId !== cycleId)) {
    return {
      status: "fail",
      issues: [issue("scheduler_dispatch_identity_mismatch", "scheduler dispatch run identity must match workflow state", "run_artifact")]
    };
  }

  const id = nextSchedulerDispatchArtifactId(workflowState, options);
  const createdAt = normalizeString(options.created_at || options.createdAt || runArtifact.created_at) || new Date().toISOString();
  const artifact = {
    id,
    type: "evaluation",
    status: runArtifact.status || "fail",
    uri: `scheduler-dispatch://run/${encodeURIComponent(runId)}/${encodeURIComponent(cycleId)}/${encodeURIComponent(id)}`,
    producer: "scheduler-dispatch-runner",
    created_at: createdAt,
    metadata: {
      type: "scheduler_dispatch_run",
      ...runArtifact,
      run_id: runId,
      cycle_id: cycleId
    }
  };
  const manifest = appendRunEvent(workflowState.manifest, {
    id: `event-${id}`,
    type: "scheduler_dispatch_run",
    status: artifact.status,
    artifact_id: id,
    message: `scheduler dispatch ${runArtifact.phase || "run"} ${artifact.status}`,
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

export { SCHEDULER_DISPATCH_RUN_VERSION };
