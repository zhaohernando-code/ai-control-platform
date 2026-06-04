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
    allow_mock_child_worker: true,
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
    allow_mock_child_worker: true,
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
