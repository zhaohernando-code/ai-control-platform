import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSchedulerDispatchPlan } from "../src/workflow/scheduler-dispatch-plan.js";

function workflowState() {
  return JSON.parse(readFileSync("docs/examples/current-session-workbench-input.json", "utf8"));
}

function continuationInput() {
  return {
    project_status: {
      project: "ai-control-platform",
      blockers: [],
      next_step: ""
    },
    run_evaluation: { status: "pass" },
    workflow_state: workflowState()
  };
}

test("scheduler dispatch plan maps reviewer shard work packages to loop and closeout commands", () => {
  const plan = createSchedulerDispatchPlan(continuationInput(), {
    workflow_state_input_path: "tmp/scheduler/input.json",
    workflow_state_output_path: "tmp/scheduler/output.json",
    reviewer_shard_loop_artifact_path: "tmp/scheduler/reviewer-shard-loop-run.json",
    continuation_input_path: "tmp/scheduler/continuation-input.json",
    scheduler_continuation_output_path: "tmp/scheduler/scheduler-dispatch-continuation-input.json",
    history_path: "tmp/scheduler/projection-history.json",
    snapshots_root: "tmp/scheduler/snapshots",
    closeout_loop_artifact_path: "tmp/scheduler/autonomous-closeout-loop-run.json",
    workbench_writeback_mode: "service",
    workbench_base_url: "http://127.0.0.1:4180",
    projection_id: "current-session",
    reviewer_mock_status: "pass",
    next_step: "Continue after scheduler dispatch."
  });

  assert.equal(plan.status, "pass");
  assert.equal(plan.phase, "scheduler_dispatch_plan");
  assert.equal(plan.steps.length, 3);
  assert.equal(plan.steps[0].action, "run_reviewer_shard_loop");
  assert.ok(plan.steps[0].args.includes("--all"));
  assert.ok(plan.steps[0].args.includes("--record-provider-health"));
  assert.ok(plan.steps[0].args.includes("--mock-status"));
  assert.ok(plan.steps[0].work_package_ids.includes("reviewer-scope-shard-001"));
  assert.equal(plan.steps[1].action, "prepare_reviewer_shard_loop_continuation");
  assert.equal(plan.steps[1].depends_on[0], "run-reviewer-shard-loop");
  assert.equal(plan.steps[2].action, "run_autonomous_closeout_loop");
  assert.equal(plan.steps[2].depends_on[0], "prepare-reviewer-shard-loop-continuation");
  assert.deepEqual(plan.writeback, {
    mode: "service",
    base_url: "http://127.0.0.1:4180",
    projection_id: "current-session"
  });
  assert.deepEqual(plan.continuation_output, {
    mode: "file",
    path: "tmp/scheduler/scheduler-dispatch-continuation-input.json"
  });
});

test("scheduler dispatch plan fails closed when service writeback lacks base url", () => {
  const plan = createSchedulerDispatchPlan(continuationInput(), {
    workflow_state_input_path: "tmp/scheduler/input.json",
    workbench_writeback_mode: "service"
  });

  assert.equal(plan.status, "fail");
  assert.ok(plan.issues.some((entry) => entry.code === "missing_workbench_base_url"));
});

test("scheduler dispatch plan fails closed without workflow state input path", () => {
  const plan = createSchedulerDispatchPlan(continuationInput());

  assert.equal(plan.status, "fail");
  assert.ok(plan.issues.some((entry) => entry.code === "missing_workflow_state_input_path"));
});

test("scheduler dispatch plan CLI writes reviewer shard dispatch plan", () => {
  const dir = mkdtempSync(join(tmpdir(), "scheduler-dispatch-plan-"));
  const inputPath = join(dir, "continuation-input.json");
  const outputPath = join(dir, "dispatch-plan.json");
  writeFileSync(inputPath, JSON.stringify(continuationInput(), null, 2));

  const result = spawnSync(process.execPath, [
    "tools/create-scheduler-dispatch-plan.mjs",
    "--input",
    inputPath,
    "--workflow-state-input",
    "tmp/scheduler/input.json",
    "--workbench-writeback-mode",
    "service",
    "--workbench-base-url",
    "http://127.0.0.1:4180",
    "--projection-id",
    "current-session",
    "--reviewer-mock-status",
    "pass",
    "--output",
    outputPath
  ], { encoding: "utf8" });
  const summary = JSON.parse(result.stdout);
  const plan = JSON.parse(readFileSync(outputPath, "utf8"));

  assert.equal(result.status, 0);
  assert.equal(summary.status, "pass");
  assert.equal(summary.step_count, 3);
  assert.equal(plan.steps[0].action, "run_reviewer_shard_loop");
  assert.ok(plan.steps[0].args.includes("--mock-status"));
  assert.equal(plan.writeback.mode, "service");
  assert.equal(plan.writeback.base_url, "http://127.0.0.1:4180");
  assert.equal(plan.writeback.projection_id, "current-session");
});
