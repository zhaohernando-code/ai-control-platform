import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  createAutonomousLoopRunArtifact,
  runAutonomousCloseoutLoop
} from "../src/workflow/autonomous-orchestrator.js";
import { createSchedulerDispatchPlan } from "../src/workflow/scheduler-dispatch-plan.js";
import { prepareSchedulerDispatchContinuationFromRunArtifact } from "../src/workflow/scheduler-dispatch-continuation.js";

function workflowInput() {
  return JSON.parse(readFileSync("docs/examples/current-session-workbench-input.json", "utf8"));
}

async function createSchedulerRunArtifact(dir) {
  const historyPath = join(dir, "projection-history.json");
  writeFileSync(historyPath, JSON.stringify({ version: "projection-history.v1", latest: null, items: [] }));
  const input = {
    project_status: {
      project: "ai-control-platform",
      blockers: [],
      next_step: "Continue from scheduler dispatch."
    },
    run_evaluation: { status: "pass" },
    workflow_state: workflowInput()
  };
  const loop = await runAutonomousCloseoutLoop(input, {
    root: process.cwd(),
    historyPath,
    snapshotsRoot: join(dir, "snapshots"),
    created_at: "2026-05-21T23:47:00.000Z"
  });
  const closeoutArtifact = createAutonomousLoopRunArtifact(input, loop, {
    created_at: "2026-05-21T23:48:00.000Z"
  });
  const closeoutPath = join(dir, "autonomous-closeout-loop-run.json");
  writeFileSync(closeoutPath, `${JSON.stringify(closeoutArtifact, null, 2)}\n`);

  return {
    version: "scheduler-dispatch-run.v1",
    run_id: closeoutArtifact.run_id,
    cycle_id: closeoutArtifact.cycle_id,
    status: "pass",
    phase: "completed",
    created_at: "2026-05-21T23:49:00.000Z",
    input: { plan: {} },
    result: {
      status: "pass",
      phase: "completed",
      issues: [],
      steps: [
        {
          id: "run-autonomous-closeout-loop",
          status: "pass",
          dry_run: false,
          outputs: {
            autonomous_closeout_loop_artifact: {
              status: "available",
              path: closeoutPath,
              next_decision_status: "pass",
              next_decision_action: "rerun",
              next_work_package_count: 3
            }
          }
        }
      ]
    }
  };
}

test("scheduler dispatch continuation prepares next input from closeout output", async () => {
  mkdirSync("tmp", { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), "tmp/scheduler-dispatch-continuation-"));
  const runArtifact = await createSchedulerRunArtifact(dir);
  const prepared = prepareSchedulerDispatchContinuationFromRunArtifact(runArtifact);

  assert.equal(prepared.status, "ready");
  assert.equal(prepared.phase, "scheduler_dispatch_continuation");
  assert.equal(prepared.should_continue, true);
  assert.equal(prepared.scheduler_dispatch.next_work_package_count, 3);
  assert.equal(prepared.continuation_input.project_status.project, "ai-control-platform");
  assert.equal(prepared.next_decision.next_work_packages.length, 3);
});

test("scheduler dispatch continuation blocks missing closeout output", () => {
  const prepared = prepareSchedulerDispatchContinuationFromRunArtifact({
    version: "scheduler-dispatch-run.v1",
    status: "pass",
    phase: "completed",
    result: { steps: [] }
  });

  assert.equal(prepared.status, "blocked");
  assert.ok(prepared.issues.some((entry) => entry.code === "missing_closeout_loop_output_path"));
});

test("prepare-scheduler-dispatch-continuation CLI writes continuation input", async () => {
  mkdirSync("tmp", { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), "tmp/scheduler-dispatch-continuation-cli-"));
  const runArtifact = await createSchedulerRunArtifact(dir);
  const artifactPath = join(dir, "scheduler-dispatch-run.json");
  const outputPath = join(dir, "nested", "continuation-input.json");
  writeFileSync(artifactPath, `${JSON.stringify(runArtifact, null, 2)}\n`);

  const stdout = execFileSync(process.execPath, [
    "tools/prepare-scheduler-dispatch-continuation.mjs",
    "--artifact",
    artifactPath,
    "--output",
    outputPath
  ], { encoding: "utf8" });
  const summary = JSON.parse(stdout);
  const continuation = JSON.parse(readFileSync(outputPath, "utf8"));

  assert.equal(summary.status, "ready");
  assert.equal(summary.scheduler_dispatch.next_work_package_count, 3);
  assert.equal(continuation.project_status.project, "ai-control-platform");
});

test("run-scheduler-dispatch-plan CLI can write next continuation input", () => {
  mkdirSync("tmp", { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), "tmp/scheduler-dispatch-continuation-run-cli-"));
  const inputPath = join(dir, "workflow-state.json");
  const planPath = join(dir, "dispatch-plan.json");
  const runArtifactPath = join(dir, "scheduler-dispatch-run.json");
  const continuationOutputPath = join(dir, "next", "continuation-input.json");
  writeFileSync(inputPath, `${JSON.stringify(workflowInput(), null, 2)}\n`);
  const plan = createSchedulerDispatchPlan({
    project_status: {
      project: "ai-control-platform",
      blockers: [],
      next_step: ""
    },
    run_evaluation: { status: "pass" },
    workflow_state: workflowInput()
  }, {
    workflow_state_input_path: inputPath,
    workflow_state_output_path: join(dir, "workflow-state-after-reviewer-shards.json"),
    reviewer_shard_loop_artifact_path: join(dir, "reviewer-shard-loop-run.json"),
    continuation_input_path: join(dir, "reviewer-continuation-input.json"),
    history_path: join(dir, "projection-history.json"),
    snapshots_root: join(dir, "snapshots"),
    closeout_loop_artifact_path: join(dir, "autonomous-closeout-loop-run.json"),
    scheduler_continuation_output_path: continuationOutputPath,
    reviewer_mock_status: "pass"
  });
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);

  const stdout = execFileSync(process.execPath, [
    "tools/run-scheduler-dispatch-plan.mjs",
    "--plan",
    planPath,
    "--output",
    runArtifactPath
  ], { encoding: "utf8" });
  const summary = JSON.parse(stdout);
  const continuation = JSON.parse(readFileSync(continuationOutputPath, "utf8"));

  assert.equal(summary.status, "pass");
  assert.equal(summary.continuation_status, "ready");
  assert.equal(summary.continuation_next_work_packages, 3);
  assert.equal(continuation.project_status.project, "ai-control-platform");
});
