import { spawnSync } from "node:child_process";

const SCHEDULER_DISPATCH_RUN_VERSION = "scheduler-dispatch-run.v1";
const ALLOWED_NPM_SCRIPTS = new Set([
  "run:reviewer-shard",
  "prepare:reviewer-shard-loop-continuation",
  "run:autonomous-closeout-loop"
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

function stepId(step, index) {
  return normalizeString(step?.id) || `step-${index + 1}`;
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
      stderr: execution.stderr || ""
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
  return {
    version: SCHEDULER_DISPATCH_RUN_VERSION,
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

export { SCHEDULER_DISPATCH_RUN_VERSION };
