import assert from "node:assert/strict";
import test from "node:test";

import {
  createMobileWorkbenchProjection,
  createWorkbenchProjection
} from "../src/workflow/workbench-projection.js";
import { baseInput } from "./helpers/workbench-projection.js";

test("workbench projection exposes headless child provider retry and split evidence", () => {
  const input = baseInput();
  const artifact = {
    id: "context-work-packages-run-headless-provider",
    type: "evaluation",
    status: "pass",
    uri: "context-work-packages://run/run-projection/cycle-20260521/context-work-packages-run-headless-provider",
    producer: "context-work-package-runner",
    created_at: "2026-05-21T00:07:00.000Z",
    metadata: {
      type: "context_work_packages_run",
      status: "pass",
      executed_count: 1,
      package_results: [
        {
          work_package_id: "projection-runtime",
          status: "pass",
          completion_evidence: {
            child_output: {
              command_evidence: {
                attempts: [
                  { attempt: 1, status: "fail", exit_code: 1, split_retry: false },
                  { attempt: 2, status: "pass", exit_code: 0, split_retry: true }
                ]
              }
            }
          }
        }
      ],
      executor_provenance: {
        executor_kind: "agent_cli_worker",
        command_runner_kind: "agent_invocation_child_process",
        provider: "agent_invocation",
        model: "codex-cli",
        retry_policy: {
          max_attempts: 2,
          split_retry: true
        },
        external_calls: 1
      }
    }
  };
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: `event-${artifact.id}`,
        type: "context_work_packages_run",
        status: "pass",
        artifact_id: artifact.id,
        created_at: artifact.created_at,
        metadata: artifact.metadata
      }
    ],
    artifacts: [...input.manifest.artifacts, artifact]
  };
  input.artifact_ledger = {
    ...input.artifact_ledger,
    artifacts: [...input.artifact_ledger.artifacts, artifact]
  };

  const projection = createWorkbenchProjection(input);
  const mobile = createMobileWorkbenchProjection(input);

  assert.equal(projection.headless_child_provider.status, "pass");
  assert.equal(projection.headless_child_provider.provider, "agent_invocation");
  assert.equal(projection.headless_child_provider.executor_kind, "agent_cli_worker");
  assert.equal(projection.headless_child_provider.mock_child_worker, false);
  assert.equal(projection.headless_child_provider.command_runner_kind, "agent_invocation_child_process");
  assert.equal(projection.headless_child_provider.max_attempts, 2);
  assert.equal(projection.headless_child_provider.split_retry, true);
  assert.equal(projection.headless_child_provider.package_count, 1);
  assert.equal(projection.headless_child_provider.accepted_count, 1);
  assert.equal(projection.headless_child_provider.attempt_count, 2);
  assert.equal(projection.headless_child_provider.retry_attempt_count, 1);
  assert.equal(projection.headless_child_provider.split_retry_attempt_count, 1);
  assert.equal(projection.one_screen.counters.headless_child_attempts, 2);
  assert.equal(projection.one_screen.counters.headless_child_retry_attempts, 1);
  assert.equal(mobile.headless_child_provider.attempt_count, 2);
  assert.equal(mobile.headless_child_provider.mock_child_worker, false);
  assert.equal(mobile.headless_child_provider.split_retry_attempt_count, 1);
});

test("workbench projection exposes explicit mock child worker provenance", () => {
  const input = baseInput();
  const artifact = {
    id: "context-work-packages-run-explicit-mock-child",
    type: "evaluation",
    status: "pass",
    uri: "context-work-packages://run/run-projection/cycle-20260521/context-work-packages-run-explicit-mock-child",
    producer: "context-work-package-runner",
    created_at: "2026-05-21T00:08:00.000Z",
    metadata: {
      type: "context_work_packages_run",
      status: "pass",
      package_results: [
        {
          work_package_id: "projection-runtime",
          status: "pass",
          completion_evidence: {
            child_output: {
              mock_allowed: true,
              command_evidence: {
                mock_allowed: true,
                attempts: []
              }
            }
          }
        }
      ],
      executor_provenance: {
        executor_kind: "agent_cli_worker",
        command_runner_kind: "mock_child_worker",
        provider: "agent_invocation",
        model: "codex-cli",
        retry_policy: {
          max_attempts: 1,
          split_retry: false
        }
      }
    }
  };
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: `event-${artifact.id}`,
        type: "context_work_packages_run",
        status: "pass",
        artifact_id: artifact.id,
        created_at: artifact.created_at,
        metadata: artifact.metadata
      }
    ],
    artifacts: [...input.manifest.artifacts, artifact]
  };
  input.artifact_ledger = {
    ...input.artifact_ledger,
    artifacts: [...input.artifact_ledger.artifacts, artifact]
  };

  const projection = createWorkbenchProjection(input);
  const mobile = createMobileWorkbenchProjection(input);

  assert.equal(projection.headless_child_provider.mock_child_worker, true);
  assert.equal(projection.headless_child_provider.command_runner_kind, "mock_child_worker");
  assert.equal(mobile.headless_child_provider.mock_child_worker, true);
});

test("workbench projection exposes headless projected action progress evidence", () => {
  const input = baseInput();
  const artifact = {
    id: "headless-projected-action-run-projection-cycle-20260521-001",
    type: "evaluation",
    status: "pass",
    uri: "headless-cli://projected-action/run-projection/cycle-20260521/headless-projected-action-run-projection-cycle-20260521-001",
    producer: "headless-cli-orchestrator",
    created_at: "2026-05-21T00:08:00.000Z",
    metadata: {
      type: "headless_projected_action_progress",
      status: "executed",
      action: "run_reviewer_scope_shard",
      next_projection_id: "headless-loop-current-01",
      has_workflow_state: true,
      has_projection: true,
      issues: []
    }
  };
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: `event-${artifact.id}`,
        type: "headless_projected_action_progress",
        status: "pass",
        artifact_id: artifact.id,
        created_at: artifact.created_at,
        metadata: artifact.metadata
      }
    ],
    artifacts: [...input.manifest.artifacts, artifact]
  };
  input.artifact_ledger = {
    ...input.artifact_ledger,
    artifacts: [...input.artifact_ledger.artifacts, artifact]
  };

  const projection = createWorkbenchProjection(input);
  const mobile = createMobileWorkbenchProjection(input);

  assert.equal(projection.projected_action_progress.status, "executed");
  assert.equal(projection.projected_action_progress.action, "run_reviewer_scope_shard");
  assert.equal(projection.projected_action_progress.next_projection_id, "headless-loop-current-01");
  assert.equal(projection.projected_action_progress.has_workflow_state, true);
  assert.equal(projection.projected_action_progress.has_projection, true);
  assert.equal(projection.operations_timeline.group_counts.headless_orchestrator, 1);
  assert.equal(projection.one_screen.counters.projected_action_progress_events, 1);
  assert.equal(mobile.projected_action_progress.action, "run_reviewer_scope_shard");
  assert.equal(mobile.projected_action_progress.has_projection, true);
});
