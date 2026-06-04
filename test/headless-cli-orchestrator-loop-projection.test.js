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

test("headless CLI loop can execute projected next_action_readout through an injected runner", () => {
  const calls = [];
  const result = runHeadlessCliMainOrchestratorLoop({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState()
  }, {
    cycle_id: "cycle-headless-projected-action",
    created_at: "2026-05-23T02:00:00.000Z",
    max_package_count: 1,
    max_iterations: 1,
    allow_mock_child_worker: true,
    execution_strategy: "projected_next_action",
    projected_next_action_readout: {
      status: "ready",
      action: "cleanup_agent_lifecycle_pool"
    },
    projected_next_action_runner: ({ action, workflow_state }) => {
      calls.push(action);
      return {
        status: "executed",
        workflow_state: {
          ...workflow_state,
          projected_action_marker: action
        },
        projection: {
          next_action_readout: {
            status: "ready",
            action: "inspect_scheduler_loop"
          }
        }
      };
    }
  });

  assert.equal(result.status, "pass");
  assert.deepEqual(calls, ["cleanup_agent_lifecycle_pool"]);
  assert.equal(result.iterations[0].projected_next_action_status, "executed");
  assert.equal(result.last_result.workflow_state.projected_action_marker, "cleanup_agent_lifecycle_pool");
  assert.ok(result.last_result.workflow_state.manifest.events.some((event) => event.type === "headless_projected_action_progress"));
  assert.ok(result.last_result.workflow_state.artifact_ledger.artifacts.some((artifact) => artifact.metadata?.type === "headless_projected_action_progress"));
});

test("headless CLI loop refreshes same service projection after in-place projected action writes", () => {
  const actions = ["run_reviewer_scope_shard", "continue_after_reviewer_aggregate"];
  let serviceReadCount = 0;
  const result = runHeadlessCliMainOrchestratorLoop({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState()
  }, {
    cycle_id: "cycle-headless-in-place-projection",
    created_at: "2026-05-23T02:00:15.000Z",
    max_package_count: 1,
    max_iterations: 2,
    allow_mock_child_worker: true,
    execution_strategy: "projected_next_action",
    workbench_base_url: "http://127.0.0.1:1",
    workbench_projection_id: "same-service-projection",
    projected_next_action_runner: ({ action, workflow_state }) => ({
      status: "executed",
      workflow_state,
      projection: {
        next_action_readout: {
          status: "ready",
          action: action === "run_reviewer_scope_shard"
            ? "continue_after_reviewer_aggregate"
            : "create_context_pack_from_seed"
        }
      }
    }),
    workbench_projection_loader: () => ({
      next_action_readout: {
        status: "ready",
        action: actions[Math.min(serviceReadCount++, actions.length - 1)]
      }
    })
  });

  assert.equal(result.status, "pass");
  assert.deepEqual(result.iterations.map((iteration) => iteration.projected_next_action), actions);
  assert.deepEqual(result.iterations.map((iteration) => iteration.workbench_projection_id), [
    "same-service-projection",
    "same-service-projection"
  ]);
  assert.equal(result.last_result.projection.next_action_readout.action, "create_context_pack_from_seed");
});

test("headless CLI loop executes service projected action before local package materialization", () => {
  const calls = [];
  const result = runHeadlessCliMainOrchestratorLoop({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState()
  }, {
    cycle_id: "cycle-headless-service-first-projection",
    created_at: "2026-05-24T05:20:00.000Z",
    max_package_count: 1,
    max_iterations: 1,
    execution_strategy: "projected_next_action",
    workbench_base_url: "http://127.0.0.1:1",
    workbench_projection_id: "service-first",
    workbench_projection_loader: () => ({
      next_action_readout: {
        status: "ready",
        action: "prepare_project_status_continuation"
      }
    }),
    projected_next_action_runner: ({ action, workflow_state }) => {
      calls.push(action);
      return {
        status: "executed",
        workflow_state,
        projection: {
          next_action_readout: {
            status: "ready",
            action: "create_context_pack_from_seed"
          }
        }
      };
    }
  });

  assert.equal(result.status, "pass");
  assert.deepEqual(calls, ["prepare_project_status_continuation"]);
  assert.equal(result.iterations.length, 1);
  assert.equal(result.iterations[0].phase, "headless_projected_next_action");
  assert.equal(result.iterations[0].projected_next_action_status, "executed");
  assert.equal(result.iterations[0].projected_next_action, "prepare_project_status_continuation");
  assert.equal(result.last_result.projection.next_action_readout.action, "create_context_pack_from_seed");
});

test("headless CLI loop blocks projected next action without progress evidence", () => {
  const result = runHeadlessCliMainOrchestratorLoop({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState()
  }, {
    cycle_id: "cycle-headless-projected-blocked",
    created_at: "2026-05-23T02:00:30.000Z",
    max_package_count: 1,
    max_iterations: 1,
    allow_mock_child_worker: true,
    execution_strategy: "projected_next_action",
    projected_next_action_readout: {
      status: "ready",
      action: "cleanup_agent_lifecycle_pool"
    },
    projected_next_action_runner: () => ({
      status: "executed"
    })
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.phase, "headless_projected_next_action");
  assert.equal(result.iterations[0].projected_next_action_status, "blocked");
  assert.ok(result.issues.some((item) => item.code === "projected_action_missing_progress_evidence"));
});

test("headless CLI loop records terminal projected next-action stops", () => {
  const result = runHeadlessCliMainOrchestratorLoop({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState()
  }, {
    cycle_id: "cycle-headless-terminal-projected",
    created_at: "2026-05-23T02:00:45.000Z",
    max_package_count: 1,
    max_iterations: 1,
    allow_mock_child_worker: true,
    execution_strategy: "projected_next_action",
    projected_next_action_readout: {
      status: "pending",
      action: "inspect_latest_driver",
      reason: "latest driver needs inspection"
    }
  });

  const progressEvent = result.last_result.workflow_state.manifest.events.find((event) => event.type === "headless_projected_action_progress");
  const progressArtifact = result.last_result.workflow_state.artifact_ledger.artifacts.find((artifact) => artifact.metadata?.type === "headless_projected_action_progress");

  assert.equal(result.status, "pass");
  assert.equal(result.iterations[0].projected_next_action_status, "stopped");
  assert.equal(progressEvent.metadata.status, "stopped");
  assert.equal(progressEvent.metadata.terminal_action, "inspect_latest_driver");
  assert.equal(progressEvent.metadata.terminal_reason, "latest driver needs inspection");
  assert.equal(progressArtifact.status, "pass");
});

test("headless CLI loop rejects nonlocal workbench next-action service URLs", () => {
  assert.throws(() => runHeadlessCliMainOrchestratorLoop({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState()
  }, {
    cycle_id: "cycle-headless-nonlocal-workbench",
    created_at: "2026-05-23T02:20:00.000Z",
    max_package_count: 1,
    max_iterations: 1,
    execution_strategy: "projected_next_action",
    workbench_base_url: "https://example.com"
  }), /local http/);
});

test("headless CLI loop blocks when configured service projection cannot be loaded", () => {
  const result = runHeadlessCliMainOrchestratorLoop({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState()
  }, {
    cycle_id: "cycle-headless-missing-service-projection",
    created_at: "2026-05-23T10:40:00.000Z",
    max_package_count: 1,
    max_iterations: 1,
    allow_mock_child_worker: true,
    execution_strategy: "projected_next_action",
    workbench_base_url: "http://127.0.0.1:9",
    workbench_projection_id: "missing"
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.phase, "headless_projected_next_action");
  assert.equal(result.iterations[0].projected_next_action_status, "blocked");
  assert.ok(result.issues.some((item) => item.code === "projected_service_projection_unavailable"));
});
