import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRunManifest } from "../src/workflow/run-manifest.js";
import {
  HEADLESS_MAIN_ORCHESTRATOR_ROLE,
  publishHeadlessWorkflowSnapshot,
  runHeadlessCliMainOrchestrator,
  runHeadlessCliMainOrchestratorLoop
} from "../src/workflow/headless-cli-orchestrator.js";
import { publishWorkbenchSnapshot } from "../src/workflow/workbench-snapshots.js";

function projectStatus(overrides = {}) {
  return {
    project: "ai-control-platform",
    status: "in_progress",
    blockers: [],
    next_step: "Implement the next headless CLI orchestrator slice.",
    global_goals: [
      {
        id: "headless-loop-continuation",
        title: "Headless loop continuation",
        status: "in_progress",
        next_step: "Run the next bounded headless loop iteration.",
        next_work_packages: [
          {
            id: "headless-loop-package",
            title: "Headless loop package",
            action: "continue_headless_loop",
            owned_files: ["src/workflow/headless-cli-orchestrator.js"]
          }
        ],
        owned_files: ["src/workflow/headless-cli-orchestrator.js"]
      }
    ],
    ...overrides
  };
}

function sourceWorkflowState() {
  const contextPack = {
    requirement_summary: "Source workflow state for headless CLI loop continuation.",
    host: "platform_core",
    target_project_id: "ai-control-platform",
    owned_files: ["src/workflow/headless-cli-orchestrator.js"],
    acceptance_gates: ["node --test test/headless-cli-loop-continuation.test.js"],
    subtasks: [
      {
        id: "source",
        title: "Source",
        owned_files: ["src/workflow/headless-cli-orchestrator.js"]
      }
    ]
  };
  const manifest = createRunManifest({
    run_id: "run-headless-cli-loop",
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

test("headless snapshot publish rolls back initial snapshot when evidence publish fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cli-snapshot-rollback-"));
  const historyPath = join(dir, "projection-history.json");
  const snapshotsRoot = join(dir, "snapshots");
  const ready = runHeadlessCliMainOrchestrator({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState()
  }, {
    cycle_id: "cycle-headless-rollback",
    created_at: "2026-05-23T00:02:00.000Z",
    max_package_count: 1,
    allow_mock_child_worker: true
  });
  let publishCalls = 0;

  assert.equal(ready.status, "pass");
  const result = publishHeadlessWorkflowSnapshot(ready.workflow_state, {
    created_at: "2026-05-23T00:02:10.000Z",
    projection_history_path: historyPath,
    snapshots_root: snapshotsRoot,
    snapshot_prefix: "headless-rollback",
    publish_workbench_snapshot: (plan, options) => {
      publishCalls += 1;
      if (publishCalls === 1) {
        return publishWorkbenchSnapshot(plan, options);
      }
      return {
        status: "fail",
        issues: ["forced evidence publish failure"],
        item: null,
        projection: null
      };
    }
  });

  const snapshotPath = join(snapshotsRoot, "headless-rollback-cycle-headless-rollback.workbench-input.json");
  assert.equal(result.status, "fail");
  assert.equal(result.initial_publish_rolled_back, true);
  assert.equal(publishCalls, 2);
  assert.equal(existsSync(snapshotPath), false);
  assert.equal(existsSync(historyPath), false);
});

test("headless orchestrator snapshot failure does not expose publisher-mutated workflow state", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cli-snapshot-dirty-state-"));
  const historyPath = join(dir, "projection-history.json");
  const snapshotsRoot = join(dir, "snapshots");
  let publishCalls = 0;

  const result = runHeadlessCliMainOrchestrator({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState()
  }, {
    cycle_id: "cycle-headless-dirty-snapshot",
    created_at: "2026-05-23T00:02:20.000Z",
    max_package_count: 1,
    allow_mock_child_worker: true,
    projection_history_path: historyPath,
    snapshots_root: snapshotsRoot,
    snapshot_prefix: "headless-dirty",
    publish_workbench_snapshot: (plan, options) => {
      publishCalls += 1;
      if (publishCalls === 1) {
        return publishWorkbenchSnapshot(plan, options);
      }
      return {
        status: "fail",
        issues: ["forced evidence publish failure"],
        item: null,
        projection: null
      };
    }
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.phase, "headless_snapshot_publish");
  assert.equal(result.snapshot_publish.initial_publish_rolled_back, true);
  assert.equal(publishCalls, 2);
  assert.equal(existsSync(historyPath), false);
  assert.equal(
    result.workflow_state.manifest.events.some((event) => event.type === "headless_cli_snapshot_publish"),
    false
  );
  assert.equal(
    result.snapshot_publish.workflow_state.manifest.events.some((event) => event.type === "headless_cli_snapshot_publish"),
    true
  );
});

test("headless CLI loop records continuation and restores state across bounded iterations", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cli-loop-continuation-"));
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
    allow_mock_child_worker: true,
    projection_history_path: historyPath,
    snapshots_root: snapshotsRoot,
    snapshot_prefix: "headless-loop-continuation"
  });
  const history = JSON.parse(readFileSync(historyPath, "utf8"));

  assert.equal(result.status, "pass");
  assert.equal(result.phase, "headless_loop_iteration_limit_reached");
  assert.deepEqual(result.iterations.map((iteration) => iteration.phase), [
    "headless_cli_orchestrator_cycle",
    "headless_cli_orchestrator_cycle"
  ]);
  assert.deepEqual(result.iterations.map((iteration) => iteration.must_continue), [true, true]);
  assert.deepEqual(result.iterations.map((iteration) => iteration.next_action), [
    "prepare_project_status_continuation",
    "prepare_project_status_continuation"
  ]);
  assert.deepEqual(result.iterations.map((iteration) => iteration.snapshot_status), ["created", "created"]);
  assert.equal(history.latest, result.iterations.at(-1).snapshot_id);
  assert.equal(result.last_result.workflow_state.manifest.cycle_id, result.iterations.at(-1).cycle_id);
  assert.notEqual(result.iterations[0].cycle_id, result.iterations[1].cycle_id);
});
