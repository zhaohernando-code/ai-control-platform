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

test("headless CLI orchestrator hardens timed-out child command output before retry", () => {
  const result = runHeadlessCliMainOrchestrator({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState()
  }, {
    cycle_id: "cycle-headless-timeout-child",
    created_at: "2026-05-23T00:01:45.000Z",
    max_package_count: 1,
    command_runner_kind: "agent_invocation_child_process",
    child_worker_runner: () => ({
      status: 124,
      stdout: "",
      stderr: "child worker timeout"
    })
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.phase, "child_worker_acceptance");
  assert.ok(result.issues.some((item) => item.code === "package_result_not_pass"));
  assert.equal(result.child_run.package_results[0].completion_evidence.child_output.command_evidence.timed_out, true);
  assert.equal(result.hardening.finding.id, "headless-child-worker-acceptance-failed");
  assert.equal(result.lifecycle_cleanup.status, "blocked");
  assert.deepEqual(result.lifecycle_cleanup.facts.map((fact) => fact.event_type), [
    "WorkerCompleted",
    "WorkerEvaluation",
    "WorkerClosed",
    "PoolIterationClosed"
  ]);
  assert.equal(result.lifecycle_cleanup.after.open, 0);
  assert.equal(result.lifecycle_cleanup.after.unevaluated, 0);
  assert.equal(result.lifecycle_cleanup.after.unclosed, 0);
  assert.ok(result.workflow_state.manifest.events.some((event) => event.type === "WorkerClosed"));
  assert.ok(result.workflow_state.manifest.events.some((event) => event.type === "PoolIterationClosed"));
});

test("headless child worker output parser accepts fenced json and rejects prose", () => {
  assert.equal(parseHeadlessChildWorkerOutput("plain prose"), null);
  assert.equal(parseHeadlessChildWorkerOutput("```json\n{\"status\":\"pass\"}\n```").status, "pass");
});

test("headless CLI orchestrator hardens no-diff child worker output before retry", () => {
  const result = runHeadlessCliMainOrchestrator({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState()
  }, {
    cycle_id: "cycle-headless-no-diff",
    created_at: "2026-05-23T00:02:00.000Z",
    max_package_count: 1,
    child_worker_outputs: [
      {
        work_package_id: "headless-cli-orchestrator-adapter",
        host: "platform_core",
        changed_files: [],
        test_results: [{ command: "node --test test/headless-cli-orchestrator.test.js", status: "pass" }],
        durable_state_updated: true,
        process_hardening: { required: false },
        continuation_readiness: { ready: true },
        self_evaluation: { aligned: true, drifted: false }
      }
    ]
  });
  const latestEvent = result.workflow_state.manifest.events.at(-1);

  assert.equal(result.status, "blocked");
  assert.equal(result.phase, "child_worker_acceptance");
  assert.ok(result.issues.some((item) => item.code === "package_result_not_pass"));
  assert.equal(result.hardening.status, "pass");
  assert.equal(result.hardening.finding.id, "headless-child-worker-acceptance-failed");
  assert.equal(result.lifecycle_cleanup.status, "blocked");
  assert.equal(result.lifecycle_cleanup.after.open, 0);
  assert.equal(result.lifecycle_cleanup.after.unevaluated, 0);
  assert.equal(result.lifecycle_cleanup.after.unclosed, 0);
  assert.equal(latestEvent.type, "PoolIterationClosed");
});

test("headless CLI orchestrator accepts no-diff child output only with already-satisfied integration evidence", () => {
  const evaluation = evaluateHeadlessChildWorkerOutput({
    owned_files: ["."]
  }, {
    status: "pass",
    role: CHILD_WORKER_ROLE,
    host: "platform_core",
    changed_files: [],
    no_diff: true,
    test_results: [{ command: "node --test test/headless-cli-orchestrator.test.js", status: "pass" }],
    durable_state_updated: true,
    process_hardening: { required: false },
    continuation_readiness: { ready: true },
    self_evaluation: { aligned: true, drifted: false },
    command_evidence: {
      exit_code: 0,
      child_worker_integration: {
        required: true,
        status: "pass",
        message: "child returned pass with no new committed delta; current mainline accepted as already satisfying the work package",
        base_commit: "abc123",
        integrated_commit: "abc123"
      }
    }
  });

  assert.equal(evaluation.status, "pass");
  assert.equal(evaluation.issues.some((item) => item.code === "child_worker_no_diff"), false);
});
