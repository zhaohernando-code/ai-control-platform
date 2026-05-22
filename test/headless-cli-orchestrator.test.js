import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { createRunManifest } from "../src/workflow/run-manifest.js";
import {
  CHILD_WORKER_ROLE,
  HEADLESS_MAIN_ORCHESTRATOR_ROLE,
  evaluateHeadlessChildWorkerOutput,
  parseHeadlessChildWorkerOutput,
  runHeadlessCliMainOrchestrator,
  runHeadlessCliMainOrchestratorLoop
} from "../src/workflow/headless-cli-orchestrator.js";

function projectStatus(overrides = {}) {
  return {
    project: "ai-control-platform",
    status: "in_progress",
    blockers: [],
    next_step: "Implement the next headless CLI orchestrator slice.",
    global_goals: [
      {
        id: "autonomous-scheduler-and-reviewer-loop",
        title: "任务拆解、调度、multi-LLM reviewer、自恢复和持续运行闭环",
        status: "in_progress",
        next_step: "Wire a headless CLI main orchestrator adapter.",
        next_work_packages: [
          {
            id: "headless-cli-orchestrator-adapter",
            title: "Headless CLI orchestrator adapter",
            action: "implement_headless_cli_orchestrator",
            owned_files: [
              "src/workflow/headless-cli-orchestrator.js",
              "tools/run-headless-cli-orchestrator.mjs",
              "test/headless-cli-orchestrator.test.js",
              "docs/examples/process-hardening-current.json"
            ]
          }
        ],
        owned_files: [
          "src/workflow/headless-cli-orchestrator.js",
          "tools/run-headless-cli-orchestrator.mjs",
          "test/headless-cli-orchestrator.test.js",
          "docs/examples/process-hardening-current.json"
        ]
      }
    ],
    ...overrides
  };
}

function sourceWorkflowState() {
  const contextPack = {
    requirement_summary: "Source workflow state for headless CLI orchestrator.",
    host: "platform_core",
    target_project_id: "ai-control-platform",
    non_goals: ["Do not modify managed projects"],
    forbidden_actions: ["Do not skip main-process evaluation"],
    owned_files: ["src/workflow/headless-cli-orchestrator.js"],
    acceptance_gates: ["node --test test/headless-cli-orchestrator.test.js"],
    rollback_conditions: ["host boundary violation"],
    subtasks: [
      {
        id: "source",
        title: "Source",
        owned_files: ["src/workflow/headless-cli-orchestrator.js"]
      }
    ]
  };
  const manifest = createRunManifest({
    run_id: "run-headless-cli",
    cycle_id: "cycle-source",
    goal: contextPack.requirement_summary,
    context_pack: contextPack,
    events: [],
    artifacts: [],
    gate_results: [],
    review_findings: [],
    recovery_attempts: [],
    created_at: "2026-05-23T00:00:00.000Z"
  });

  return {
    generated_at: "2026-05-23T00:00:00.000Z",
    project_status: projectStatus(),
    manifest,
    artifact_ledger: {
      run_id: manifest.run_id,
      cycle_id: manifest.cycle_id,
      artifacts: []
    },
    model_plan: { selected_model: "gpt-5.5", routes: [] },
    reviewer_gate: { findings: [] },
    task_dag: manifest.work_packages
  };
}

test("headless CLI orchestrator runs one main_orchestrator cycle with bounded child lifecycle facts", () => {
  const result = runHeadlessCliMainOrchestrator({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState(),
    projection_history: { version: "projection-history.v1", latest: "current-session", items: [] }
  }, {
    cycle_id: "cycle-headless-cli",
    created_at: "2026-05-23T00:01:00.000Z",
    max_package_count: 1
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

test("headless child worker acceptance checks host, owned files, tests, durable state, hardening, and continuation", () => {
  const evaluation = evaluateHeadlessChildWorkerOutput({
    id: "wp",
    owned_files: ["src/workflow/headless-cli-orchestrator.js"]
  }, {
    host: "platform_core",
    changed_files: ["src/workflow/headless-cli-orchestrator.js"],
    test_results: [{ command: "node --test test/headless-cli-orchestrator.test.js", status: "pass" }],
    durable_state_updated: true,
    process_hardening: { required: false },
    continuation_readiness: { ready: true },
    self_evaluation: { aligned: true, drifted: false }
  });

  assert.equal(evaluation.status, "pass");
  assert.equal(evaluation.checked.host_boundary, "platform_core");
});

test("headless CLI orchestrator can execute a real child command runner and parse structured output", () => {
  const calls = [];
  const result = runHeadlessCliMainOrchestrator({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState()
  }, {
    cycle_id: "cycle-headless-real-child",
    created_at: "2026-05-23T00:01:30.000Z",
    max_package_count: 1,
    command_runner_kind: "codex_proxy_child_process",
    child_worker_runner: ({ prompt_file, work_package, timeout_ms }) => {
      calls.push({ prompt_file, work_package, timeout_ms });
      return {
        status: 0,
        stdout: JSON.stringify({
          status: "pass",
          role: CHILD_WORKER_ROLE,
          host: "platform_core",
          changed_files: ["src/workflow/headless-cli-orchestrator.js"],
          test_results: [{ command: "node --test test/headless-cli-orchestrator.test.js", status: "pass" }],
          durable_state_updated: true,
          process_hardening: { required: false, status: "not_required" },
          continuation_readiness: { ready: true },
          self_evaluation: { aligned: true, drifted: false, evidence_sufficient: true }
        }),
        stderr: ""
      };
    }
  });

  assert.equal(result.status, "pass");
  assert.equal(calls.length, 1);
  assert.match(readFileSync(calls[0].prompt_file, "utf8"), /role=child_worker/);
  assert.equal(result.child_run.artifact.metadata.executor_provenance.command_runner_kind, "codex_proxy_child_process");
  assert.equal(result.child_run.artifact.metadata.package_results[0].completion_evidence.child_output.command_evidence.exit_code, 0);
});

test("headless CLI orchestrator can use default child provider config with retry and split policy", () => {
  const calls = [];
  const result = runHeadlessCliMainOrchestrator({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState()
  }, {
    cycle_id: "cycle-headless-default-provider",
    created_at: "2026-05-23T01:40:00.000Z",
    max_package_count: 1,
    default_child_provider: {
      command: "codex-proxy",
      args: ["run", "--prompt", "{prompt_file}"],
      provider: "codex_proxy",
      model: "codex-cli",
      retry_policy: { max_attempts: 2, split_retry: true }
    },
    child_worker_runner: ({ attempt, split_retry }) => {
      calls.push({ attempt, split_retry });
      if (attempt === 1) {
        return {
          status: 124,
          stdout: "",
          stderr: "child worker timeout"
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          status: "pass",
          role: CHILD_WORKER_ROLE,
          host: "platform_core",
          changed_files: ["src/workflow/headless-cli-orchestrator.js"],
          test_results: [{ command: "node --test test/headless-cli-orchestrator.test.js", status: "pass" }],
          durable_state_updated: true,
          process_hardening: { required: false, status: "not_required" },
          continuation_readiness: { ready: true },
          self_evaluation: { aligned: true, drifted: false, evidence_sufficient: true }
        }),
        stderr: ""
      };
    }
  });
  const childOutput = result.child_run.artifact.metadata.package_results[0].completion_evidence.child_output;
  const provenance = result.child_run.artifact.metadata.executor_provenance;

  assert.equal(result.status, "pass");
  assert.deepEqual(calls, [
    { attempt: 1, split_retry: false },
    { attempt: 2, split_retry: true }
  ]);
  assert.equal(provenance.provider, "codex_proxy");
  assert.equal(provenance.retry_policy.max_attempts, 2);
  assert.equal(provenance.retry_policy.split_retry, true);
  assert.equal(childOutput.command_evidence.attempts.length, 2);
  assert.equal(childOutput.command_evidence.attempts[1].split_retry, true);
});

test("headless CLI orchestrator persists workflow snapshots into projection history", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cli-snapshot-"));
  const historyPath = join(dir, "projection-history.json");
  const snapshotsRoot = join(dir, "snapshots");
  const result = runHeadlessCliMainOrchestrator({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState()
  }, {
    cycle_id: "cycle-headless-persist",
    created_at: "2026-05-23T00:02:00.000Z",
    max_package_count: 1,
    projection_history_path: historyPath,
    snapshots_root: snapshotsRoot,
    snapshot_prefix: "headless-test"
  });
  const history = JSON.parse(readFileSync(historyPath, "utf8"));
  const snapshot = JSON.parse(readFileSync(result.snapshot_publish.snapshot_path, "utf8"));

  assert.equal(result.status, "pass");
  assert.equal(result.snapshot_publish.status, "created");
  assert.equal(history.latest, "headless-test-cycle-headless-persist");
  assert.equal(snapshot.manifest.events.at(-1).type, "headless_cli_snapshot_publish");
  assert.equal(snapshot.artifact_ledger.artifacts.at(-1).metadata.type, "headless_cli_snapshot_publish");
  assert.equal(result.projection.run_id, "run-headless-cli");
});

test("headless CLI loop continues from persisted workflow state and snapshots every iteration", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cli-loop-"));
  const historyPath = join(dir, "projection-history.json");
  const snapshotsRoot = join(dir, "snapshots");
  const result = runHeadlessCliMainOrchestratorLoop({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState()
  }, {
    cycle_id: "cycle-headless-loop",
    created_at: "2026-05-23T00:02:30.000Z",
    max_package_count: 1,
    max_iterations: 2,
    projection_history_path: historyPath,
    snapshots_root: snapshotsRoot,
    snapshot_prefix: "headless-loop-test"
  });
  const history = JSON.parse(readFileSync(historyPath, "utf8"));

  assert.equal(result.status, "pass");
  assert.equal(result.phase, "headless_loop_iteration_limit_reached");
  assert.equal(result.iterations.length, 2);
  assert.deepEqual(result.iterations.map((iteration) => iteration.snapshot_status), ["created", "created"]);
  assert.equal(history.items.length, 2);
  assert.equal(history.latest, result.iterations.at(-1).snapshot_id);
  assert.notEqual(result.iterations[0].cycle_id, result.iterations[1].cycle_id);
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
    projection_history_path: historyPath,
    snapshots_root: snapshotsRoot,
    snapshot_prefix: "headless-cli-current"
  });

  assert.equal(result.status, "pass");
  assert.ok(result.snapshot_publish.item.id.length <= 81);
  assert.equal(result.snapshot_publish.status, "created");
});

test("headless CLI orchestrator hardens timed-out child command output before retry", () => {
  const result = runHeadlessCliMainOrchestrator({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState()
  }, {
    cycle_id: "cycle-headless-timeout-child",
    created_at: "2026-05-23T00:01:45.000Z",
    max_package_count: 1,
    command_runner_kind: "codex_proxy_child_process",
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
  assert.equal(latestEvent.type, "headless_cli_process_hardening");
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

test("run-headless-cli-orchestrator CLI writes replayable output", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cli-orchestrator-"));
  const projectStatusPath = join(dir, "PROJECT_STATUS.json");
  const workflowStatePath = join(dir, "workflow-state.json");
  const outputPath = join(dir, "headless-output.json");

  writeFileSync(projectStatusPath, `${JSON.stringify(projectStatus(), null, 2)}\n`);
  writeFileSync(workflowStatePath, `${JSON.stringify(sourceWorkflowState(), null, 2)}\n`);

  const result = spawnSync(process.execPath, [
    "tools/run-headless-cli-orchestrator.mjs",
    "--project-status",
    projectStatusPath,
    "--workflow-state",
    workflowStatePath,
    "--output",
    outputPath,
    "--cycle-id",
    "cycle-headless-cli-file",
    "--created-at",
    "2026-05-23T00:03:00.000Z"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(readFileSync(outputPath, "utf8"));
  assert.equal(output.status, "pass");
  assert.equal(output.role, HEADLESS_MAIN_ORCHESTRATOR_ROLE);
  assert.equal(output.child_role, CHILD_WORKER_ROLE);
  assert.equal(output.workflow_state.manifest.cycle_id, "cycle-headless-cli-file");
});

test("run-headless-cli-orchestrator CLI can persist a bounded loop to projection history", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cli-orchestrator-loop-"));
  const projectStatusPath = join(dir, "PROJECT_STATUS.json");
  const workflowStatePath = join(dir, "workflow-state.json");
  const historyPath = join(dir, "projection-history.json");
  const snapshotsRoot = join(dir, "snapshots");
  const outputPath = join(dir, "headless-loop-output.json");
  const workflowOutputPath = join(dir, "headless-loop-workflow.json");

  writeFileSync(projectStatusPath, `${JSON.stringify(projectStatus(), null, 2)}\n`);
  writeFileSync(workflowStatePath, `${JSON.stringify(sourceWorkflowState(), null, 2)}\n`);

  const result = spawnSync(process.execPath, [
    "tools/run-headless-cli-orchestrator.mjs",
    "--project-status",
    projectStatusPath,
    "--workflow-state",
    workflowStatePath,
    "--output",
    outputPath,
    "--workflow-output",
    workflowOutputPath,
    "--history-path",
    historyPath,
    "--snapshots-root",
    snapshotsRoot,
    "--snapshot-prefix",
    "headless-cli-test",
    "--loop",
    "--max-iterations",
    "2",
    "--cycle-id",
    "cycle-headless-cli-loop",
    "--created-at",
    "2026-05-23T00:03:30.000Z"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(readFileSync(outputPath, "utf8"));
  const history = JSON.parse(readFileSync(historyPath, "utf8"));
  const workflowOutput = JSON.parse(readFileSync(workflowOutputPath, "utf8"));
  assert.equal(output.status, "pass");
  assert.equal(output.iterations.length, 2);
  assert.equal(history.items.length, 2);
  assert.equal(workflowOutput.manifest.cycle_id, output.last_result.workflow_state.manifest.cycle_id);
  assert.equal(workflowOutput.manifest.events.at(-1).type, "headless_cli_snapshot_publish");
});
