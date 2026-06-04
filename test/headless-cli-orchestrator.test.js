import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CHILD_WORKER_ROLE,
  HEADLESS_MAIN_ORCHESTRATOR_ROLE,
  createHeadlessProviderExecutor,
  evaluateHeadlessChildWorkerOutput,
  headlessChildWorkerPrompt,
  parseHeadlessChildWorkerOutput,
  runHeadlessCliMainOrchestrator,
  runHeadlessCliMainOrchestratorLoop
} from "../src/workflow/headless-cli-orchestrator.js";
import {
  governedAgentStateStore,
  materializedWorkflowStateWithCompletedFirstPackage,
  projectStatus,
  sourceWorkflowState
} from "./helpers/headless-cli-orchestrator.js";

test("headless CLI orchestrator runs one main_orchestrator cycle with bounded child lifecycle facts", () => {
  const result = runHeadlessCliMainOrchestrator({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState(),
    projection_history: { version: "projection-history.v1", latest: "current-session", items: [] }
  }, {
    cycle_id: "cycle-headless-cli",
    created_at: "2026-05-23T00:01:00.000Z",
    max_package_count: 1,
    allow_mock_child_worker: true
  });
  const eventTypes = result.workflow_state.manifest.events.map((event) => event.type);

  assert.equal(result.status, "pass");
  assert.equal(result.role, HEADLESS_MAIN_ORCHESTRATOR_ROLE);
  assert.equal(result.child_role, CHILD_WORKER_ROLE);
  assert.equal(result.context_pack.host, "platform_core");
  assert.equal(result.context_pack.target_project_id, "ai-control-platform");
  assert.equal(result.child_run.status, "pass");
  assert.equal(result.child_run.artifact.metadata.executor_provenance.role, CHILD_WORKER_ROLE);
  assert.equal(result.steps[0].phase, "project_status_continuation");
  assert.equal(result.steps[0].status, "ready");
  assert.ok(eventTypes.includes("context_pack_cycle_created"));
  assert.ok(eventTypes.includes("WorkerSpawned"));
  assert.ok(eventTypes.includes("WorkerHeartbeat"));
  assert.ok(eventTypes.includes("WorkerCompleted"));
  assert.ok(eventTypes.includes("WorkerEvaluation"));
  assert.ok(eventTypes.includes("WorkerClosed"));
  assert.ok(eventTypes.includes("PoolIterationClosed"));
  assert.equal(result.lifecycle_cleanup.after.status, "pass");
  assert.equal(result.projection.agent_lifecycle_pool.status, "pass");
  assert.equal(result.continuation.should_continue, true);
  assert.equal(result.must_continue, true);
});

test("headless CLI orchestrator continues existing context cycle without rematerializing completed packages", () => {
  const result = runHeadlessCliMainOrchestrator({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: materializedWorkflowStateWithCompletedFirstPackage()
  }, {
    created_at: "2026-05-24T04:36:00.000Z",
    max_package_count: 1,
    child_worker_outputs: [
      {
        work_package_id: "pc-mobile-workbench",
        status: "pass",
        host: "platform_core",
        changed_files: ["apps/workbench/workbench.js"],
        test_results: [{ command: "npm run check:workbench:browser-events", status: "pass" }],
        durable_state_updated: true,
        process_hardening: { required: false },
        continuation_readiness: { ready: true },
        self_evaluation: { aligned: true, drifted: false }
      }
    ]
  });

  assert.equal(result.status, "pass");
  assert.equal(result.steps[1].phase, "context_pack_cycle");
  assert.equal(result.steps[1].status, "existing");
  assert.equal(result.child_run.executed_work_packages[0].id, "pc-mobile-workbench");
  assert.equal(result.workflow_state.manifest.work_packages[0].status, "completed");
  assert.equal(result.workflow_state.manifest.work_packages[1].status, "completed");
});

test("headless governed agent invocation receives sanitized workbench child-worker environment", () => {
  let sawCleanInvocationEnv = false;
  const previousCommand = process.env.AI_CONTROL_WORKBENCH_CHILD_WORKER_COMMAND;
  const previousOutputPath = process.env.AI_CONTROL_WORKBENCH_CHILD_WORKER_OUTPUT_PATH;
  process.env.AI_CONTROL_WORKBENCH_CHILD_WORKER_COMMAND = "would-recursively-spawn";
  process.env.AI_CONTROL_WORKBENCH_CHILD_WORKER_OUTPUT_PATH = "would-recursively-write";
  try {
    const executor = createHeadlessProviderExecutor({
      agent_invocation_profile: "development_flow_codex",
      stateStore: governedAgentStateStore(),
      child_worker_timeout_ms: 10000,
      agent_invocation_max_attempts: 1,
      agent_invocation_command_runner: (_command, _args, runnerOptions) => {
        const leaked = Object.keys(runnerOptions.env || {})
          .filter((name) => name.startsWith("AI_CONTROL_WORKBENCH_CHILD_WORKER_"));
        sawCleanInvocationEnv = leaked.length === 0;
        return {
          status: 0,
          stdout: JSON.stringify({
            status: sawCleanInvocationEnv ? "pass" : "fail",
            role: "bounded_child_worker",
            host: "platform_core",
            changed_files: ["src/workflow/headless-cli-orchestrator.js"],
            test_results: [{ command: "agent invocation env isolation", status: sawCleanInvocationEnv ? "pass" : "fail" }],
            durable_state_updated: true,
            process_hardening: { required: false, status: "not_required" },
            continuation_readiness: { ready: true },
            self_evaluation: { aligned: true, drifted: false, evidence_sufficient: true },
            blocker: sawCleanInvocationEnv ? null : "workbench child-worker env leaked"
          }),
          stderr: ""
        };
      }
    });
    const result = executor({
      workflow_state: sourceWorkflowState(),
      selected_work_packages: [
        {
          id: "child-env-isolation",
          title: "Child environment isolation",
          action: "continue_global_goal",
          owned_files: ["src/workflow/headless-cli-orchestrator.js"]
        }
      ],
      execution_plan: { package_plans: [] }
    });

    assert.equal(result.status, "pass");
    assert.equal(sawCleanInvocationEnv, true);
    assert.equal(result.package_results[0].status, "pass");
  } finally {
    if (previousCommand === undefined) {
      delete process.env.AI_CONTROL_WORKBENCH_CHILD_WORKER_COMMAND;
    } else {
      process.env.AI_CONTROL_WORKBENCH_CHILD_WORKER_COMMAND = previousCommand;
    }
    if (previousOutputPath === undefined) {
      delete process.env.AI_CONTROL_WORKBENCH_CHILD_WORKER_OUTPUT_PATH;
    } else {
      process.env.AI_CONTROL_WORKBENCH_CHILD_WORKER_OUTPUT_PATH = previousOutputPath;
    }
  }
});

test("headless CLI orchestrator blocks implicit mock child worker completion", () => {
  const result = runHeadlessCliMainOrchestrator({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState()
  }, {
    cycle_id: "cycle-headless-implicit-mock-blocked",
    created_at: "2026-05-23T00:01:15.000Z",
    max_package_count: 1
  });
  const childOutput = result.child_run.package_results[0].completion_evidence.child_output;

  assert.equal(result.status, "blocked");
  assert.equal(result.phase, "child_worker_acceptance");
  assert.ok(result.issues.some((item) => item.code === "package_result_not_pass"));
  assert.equal(childOutput.command_evidence.reason, "headless main orchestrator must not use implicit mock child output");
  assert.equal(result.hardening.finding.id, "headless-child-worker-acceptance-failed");
});

test("headless snapshot ids stay within publisher-safe length", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cli-long-snapshot-"));
  const historyPath = join(dir, "projection-history.json");
  const snapshotsRoot = join(dir, "snapshots");
  const result = runHeadlessCliMainOrchestrator({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState()
  }, {
    cycle_id: "cycle-headless-cli-persistence-with-a-very-long-generated-cycle-identifier-01",
    created_at: "2026-05-23T00:02:45.000Z",
    max_package_count: 1,
    allow_mock_child_worker: true,
    projection_history_path: historyPath,
    snapshots_root: snapshotsRoot,
    snapshot_prefix: "headless-cli-current"
  });

  assert.equal(result.status, "pass");
  assert.ok(result.snapshot_publish.item.id.length <= 81);
  assert.equal(result.snapshot_publish.status, "created");
});

test("headless CLI orchestrator blocks wrong role before mutating workflow state", () => {
  const inputState = sourceWorkflowState();
  const result = runHeadlessCliMainOrchestrator({
    role: CHILD_WORKER_ROLE,
    project_status: projectStatus(),
    workflow_state: inputState
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.phase, "input_validation");
  assert.ok(result.issues.some((item) => item.code === "invalid_orchestrator_role"));
  assert.equal(inputState.manifest.events.length, 0);
});
