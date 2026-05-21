import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { createSchedulerDispatchPlan } from "../src/workflow/scheduler-dispatch-plan.js";
import {
  createSchedulerDispatchRunArtifact,
  recordSchedulerDispatchRunArtifact,
  runSchedulerDispatchPlan,
  validateSchedulerDispatchPlan
} from "../src/workflow/scheduler-dispatch-runner.js";

function workflowState() {
  return JSON.parse(readFileSync("docs/examples/current-session-workbench-input.json", "utf8"));
}

function dispatchPlan(overrides = {}) {
  return createSchedulerDispatchPlan({
    project_status: {
      project: "ai-control-platform",
      blockers: [],
      next_step: ""
    },
    run_evaluation: { status: "pass" },
    workflow_state: workflowState()
  }, {
    workflow_state_input_path: "tmp/scheduler/input.json",
    ...overrides
  });
}

test("scheduler dispatch runner validates allowed npm scripts", () => {
  const plan = dispatchPlan();
  const validation = validateSchedulerDispatchPlan(plan);

  assert.equal(validation.status, "pass");

  const damaged = {
    ...plan,
    steps: [
      {
        id: "unsafe",
        command: "bash",
        args: ["-lc", "echo unsafe"]
      }
    ]
  };
  const damagedValidation = validateSchedulerDispatchPlan(damaged);

  assert.equal(damagedValidation.status, "fail");
  assert.ok(damagedValidation.issues.some((entry) => entry.code === "unsupported_step_command"));
});

test("scheduler dispatch runner executes steps with injected executor", async () => {
  const seen = [];
  const result = await runSchedulerDispatchPlan(dispatchPlan(), {
    executor: async (step) => {
      seen.push(step.id);
      return { status: "pass", exit_code: 0, stdout: step.action, stderr: "" };
    }
  });

  assert.equal(result.status, "pass");
  assert.equal(result.phase, "completed");
  assert.deepEqual(seen, [
    "run-reviewer-shard-loop",
    "prepare-reviewer-shard-loop-continuation",
    "run-autonomous-closeout-loop"
  ]);
  assert.equal(result.steps.length, 3);
});

test("scheduler dispatch runner stops on step failure", async () => {
  const result = await runSchedulerDispatchPlan(dispatchPlan(), {
    executor: async (step) => ({
      status: step.id === "prepare-reviewer-shard-loop-continuation" ? "fail" : "pass",
      exit_code: step.id === "prepare-reviewer-shard-loop-continuation" ? 1 : 0,
      stdout: "",
      stderr: "failed"
    })
  });

  assert.equal(result.status, "fail");
  assert.equal(result.phase, "execution");
  assert.equal(result.steps.length, 2);
  assert.ok(result.issues.some((entry) => entry.code === "scheduler_step_failed"));
});

test("scheduler dispatch run artifact captures dry-run result", async () => {
  const plan = dispatchPlan();
  const result = await runSchedulerDispatchPlan(plan, { dry_run: true });
  const artifact = createSchedulerDispatchRunArtifact(plan, result, {
    created_at: "2026-05-21T22:35:00.000Z"
  });

  assert.equal(artifact.version, "scheduler-dispatch-run.v1");
  assert.equal(artifact.status, "pass");
  assert.equal(artifact.phase, "completed");
  assert.ok(artifact.result.steps.every((step) => step.dry_run === true));
});

test("scheduler dispatch run artifact records into workflow state", async () => {
  const plan = dispatchPlan();
  const result = await runSchedulerDispatchPlan(plan, { dry_run: true });
  const artifact = createSchedulerDispatchRunArtifact(plan, result, {
    created_at: "2026-05-21T22:36:00.000Z"
  });
  const recorded = recordSchedulerDispatchRunArtifact(workflowState(), artifact, {
    created_at: "2026-05-21T22:37:00.000Z"
  });

  assert.equal(recorded.status, "pass");
  assert.equal(recorded.workflow_state.manifest.events.at(-1).type, "scheduler_dispatch_run");
  assert.equal(recorded.workflow_state.artifact_ledger.artifacts.at(-1).producer, "scheduler-dispatch-runner");
});

test("run-scheduler-dispatch-plan CLI writes dry-run artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "scheduler-dispatch-runner-"));
  const planPath = join(dir, "dispatch-plan.json");
  const outputPath = join(dir, "scheduler-run.json");
  writeFileSync(planPath, JSON.stringify(dispatchPlan(), null, 2));

  const result = spawnSync(process.execPath, [
    "tools/run-scheduler-dispatch-plan.mjs",
    "--plan",
    planPath,
    "--output",
    outputPath,
    "--dry-run"
  ], { encoding: "utf8" });
  const summary = JSON.parse(result.stdout);
  const artifact = JSON.parse(readFileSync(outputPath, "utf8"));

  assert.equal(result.status, 0);
  assert.equal(summary.status, "pass");
  assert.equal(summary.step_count, 3);
  assert.equal(artifact.version, "scheduler-dispatch-run.v1");
  assert.ok(artifact.result.steps.every((step) => step.dry_run === true));
});
