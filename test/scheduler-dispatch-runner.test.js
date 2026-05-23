import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  cleanupAgentLifecyclePool,
  recordAgentLifecycleFact
} from "../src/workflow/agent-lifecycle-pool.js";
import { createSchedulerDispatchPlan } from "../src/workflow/scheduler-dispatch-plan.js";
import {
  createSchedulerDispatchRunArtifact,
  recordSchedulerDispatchRunArtifact,
  runSchedulerDispatchPlan,
  validateSchedulerDispatchPlan
} from "../src/workflow/scheduler-dispatch-runner.js";
import { currentSessionWorkflowState } from "./helpers/current-session-workflow-state.js";

function workflowState() {
  return currentSessionWorkflowState();
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

function lifecycleCleanupPlan(overrides = {}) {
  return createSchedulerDispatchPlan({
    status: "pass",
    action: "cleanup_agent_lifecycle_pool",
    workflow_state: workflowState(),
    next_work_packages: [
      {
        id: "agent-lifecycle-pool-cleanup-latest",
        action: "cleanup_agent_lifecycle_pool"
      }
    ]
  }, {
    workflow_state_input_path: "tmp/scheduler/input.json",
    ...overrides
  });
}

function lifecycleWorkflowStateAfterCleanup() {
  const base = {
    manifest: {
      run_id: "run-agent-lifecycle-cleanup",
      cycle_id: "cycle-agent-lifecycle-cleanup",
      events: [],
      artifacts: [],
      work_packages: []
    },
    artifact_ledger: {
      run_id: "run-agent-lifecycle-cleanup",
      cycle_id: "cycle-agent-lifecycle-cleanup",
      artifacts: []
    }
  };
  const spawned = recordAgentLifecycleFact(base, {
    event_type: "WorkerSpawned",
    pool_id: "pool-agent-lifecycle",
    worker_id: "worker-a",
    status: "pass",
    created_at: "2026-05-22T01:00:00.000Z"
  });
  const completed = recordAgentLifecycleFact(spawned.workflow_state, {
    event_type: "WorkerCompleted",
    pool_id: "pool-agent-lifecycle",
    worker_id: "worker-a",
    status: "pass",
    created_at: "2026-05-22T01:01:00.000Z"
  });
  return cleanupAgentLifecyclePool(completed.workflow_state, {
    created_at: "2026-05-22T01:02:00.000Z"
  }).workflow_state;
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

test("scheduler dispatch runner allows agent lifecycle cleanup npm script", () => {
  const validation = validateSchedulerDispatchPlan(lifecycleCleanupPlan());

  assert.equal(validation.status, "pass");
});

test("scheduler dispatch runner rejects non-cleanup agent lifecycle pool arguments", () => {
  const basePlan = lifecycleCleanupPlan();
  const cases = [
    {
      name: "event recording",
      args: [
        "run",
        "record:agent-lifecycle-pool",
        "--",
        "--input",
        "tmp/scheduler/input.json",
        "--output",
        "tmp/scheduler/output.json",
        "--cleanup-latest-pool",
        "--event-type",
        "WorkerClosed"
      ],
      codes: ["unsupported_agent_lifecycle_pool_arg"]
    },
    {
      name: "in place writes",
      args: [
        "run",
        "record:agent-lifecycle-pool",
        "--",
        "--input",
        "tmp/scheduler/input.json",
        "--cleanup-latest-pool",
        "--in-place"
      ],
      codes: ["unsupported_agent_lifecycle_pool_arg", "missing_agent_lifecycle_cleanup_output"]
    },
    {
      name: "missing cleanup flag",
      args: [
        "run",
        "record:agent-lifecycle-pool",
        "--",
        "--input",
        "tmp/scheduler/input.json",
        "--output",
        "tmp/scheduler/output.json"
      ],
      codes: ["missing_agent_lifecycle_cleanup_flag"]
    },
    {
      name: "missing input",
      args: [
        "run",
        "record:agent-lifecycle-pool",
        "--",
        "--output",
        "tmp/scheduler/output.json",
        "--cleanup-latest-pool"
      ],
      codes: ["missing_agent_lifecycle_cleanup_input"]
    },
    {
      name: "missing output",
      args: [
        "run",
        "record:agent-lifecycle-pool",
        "--",
        "--input",
        "tmp/scheduler/input.json",
        "--cleanup-latest-pool"
      ],
      codes: ["missing_agent_lifecycle_cleanup_output"]
    },
    {
      name: "unknown extra parameter",
      args: [
        "run",
        "record:agent-lifecycle-pool",
        "--",
        "--input",
        "tmp/scheduler/input.json",
        "--output",
        "tmp/scheduler/output.json",
        "--cleanup-latest-pool",
        "--unknown"
      ],
      codes: ["unsupported_agent_lifecycle_pool_arg"]
    }
  ];

  for (const item of cases) {
    const validation = validateSchedulerDispatchPlan({
      ...basePlan,
      steps: [
        {
          ...basePlan.steps[0],
          args: item.args
        }
      ]
    });
    const issueCodes = validation.issues.map((entry) => entry.code);

    assert.equal(validation.status, "fail", item.name);
    for (const code of item.codes) {
      assert.ok(issueCodes.includes(code), `${item.name} should include ${code}`);
    }
  }
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

test("scheduler dispatch runner executes agent lifecycle cleanup step", async () => {
  const seen = [];
  const result = await runSchedulerDispatchPlan(lifecycleCleanupPlan(), {
    executor: async (step) => {
      seen.push({ id: step.id, script: step.args[1] });
      return { status: "pass", exit_code: 0, stdout: "", stderr: "" };
    }
  });

  assert.equal(result.status, "pass");
  assert.deepEqual(seen, [
    { id: "cleanup-agent-lifecycle-pool", script: "record:agent-lifecycle-pool" }
  ]);
  assert.equal(result.steps[0].action, "cleanup_agent_lifecycle_pool");
});

test("scheduler dispatch runner summarizes step output artifacts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scheduler-dispatch-output-summary-"));
  const plan = dispatchPlan({
    reviewer_shard_loop_artifact_path: join(dir, "reviewer-shard-loop-run.json"),
    continuation_input_path: join(dir, "continuation-input.json"),
    closeout_loop_artifact_path: join(dir, "autonomous-closeout-loop-run.json")
  });
  const result = await runSchedulerDispatchPlan(plan, {
    executor: async (step) => {
      for (const outputPath of Object.values(step.outputs || {})) {
        mkdirSync(dir, { recursive: true });
        if (outputPath.includes("reviewer-shard-loop")) {
          writeFileSync(outputPath, JSON.stringify({
            version: "reviewer-shard-loop-run.v1",
            status: "pass",
            phase: "aggregated",
            result: { runs: [{ shard_id: "one" }], aggregate: { status: "pass", pending_shards: 0 } }
          }));
        } else if (outputPath.includes("continuation-input")) {
          writeFileSync(outputPath, JSON.stringify({
            project_status: { project: "ai-control-platform", next_step: "continue" },
            workflow_state: { manifest: { work_packages: [{ id: "next" }] } }
          }));
        } else if (outputPath.includes("autonomous-closeout-loop")) {
          writeFileSync(outputPath, JSON.stringify({
            version: "autonomous-closeout-loop-run.v1",
            status: "pass",
            phase: "next_continuation",
            result: {
              status: "pass",
              phase: "next_continuation",
              next_decision: {
                status: "pass",
                action: "rerun",
                should_continue: true,
                next_work_packages: [{ id: "next-a" }, { id: "next-b" }]
              }
            }
          }));
        }
      }
      return { status: "pass", exit_code: 0, stdout: "", stderr: "" };
    }
  });

  assert.equal(result.status, "pass");
  assert.equal(result.steps[0].outputs.reviewer_shard_loop_artifact.aggregate_status, "pass");
  assert.equal(result.steps[1].outputs.continuation_input.next_step, "continue");
  assert.equal(result.steps[2].outputs.autonomous_closeout_loop_artifact.next_decision_action, "rerun");
  assert.equal(result.steps[2].outputs.autonomous_closeout_loop_artifact.next_work_package_count, 2);
});

test("scheduler dispatch runner summarizes agent lifecycle cleanup workflow state output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scheduler-dispatch-lifecycle-summary-"));
  const outputPath = join(dir, "agent-lifecycle-cleanup-output.json");
  const plan = lifecycleCleanupPlan({
    agent_lifecycle_cleanup_output_path: outputPath
  });
  const result = await runSchedulerDispatchPlan(plan, {
    executor: async (step) => {
      writeFileSync(step.outputs.workflow_state, JSON.stringify(lifecycleWorkflowStateAfterCleanup(), null, 2));
      return { status: "pass", exit_code: 0, stdout: "", stderr: "" };
    }
  });

  assert.equal(result.status, "pass");
  assert.equal(result.steps[0].outputs.workflow_state.agent_lifecycle_pool.status, "pass");
  assert.equal(result.steps[0].outputs.workflow_state.agent_lifecycle_pool.next_action, null);
  assert.equal(result.steps[0].outputs.agent_lifecycle_cleanup.cleanup_status, "pass");
  assert.equal(result.steps[0].outputs.agent_lifecycle_cleanup.pool_id, "pool-agent-lifecycle");
  assert.equal(result.steps[0].outputs.agent_lifecycle_cleanup.next_action, null);
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

test("scheduler dispatch run artifact recording rejects identity drift", async () => {
  const plan = dispatchPlan();
  const result = await runSchedulerDispatchPlan(plan, { dry_run: true });
  const artifact = {
    ...createSchedulerDispatchRunArtifact(plan, result),
    run_id: "wrong-run"
  };
  const recorded = recordSchedulerDispatchRunArtifact(workflowState(), artifact);

  assert.equal(recorded.status, "fail");
  assert.ok(recorded.issues.some((entry) => entry.code === "scheduler_dispatch_identity_mismatch"));
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
  assert.equal(summary.continuation_status, "not_requested");
  assert.equal(artifact.version, "scheduler-dispatch-run.v1");
  assert.ok(artifact.result.steps.every((step) => step.dry_run === true));
});
