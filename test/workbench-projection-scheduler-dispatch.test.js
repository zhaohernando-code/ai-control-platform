import assert from "node:assert/strict";
import test from "node:test";

import {
  createMobileWorkbenchProjection,
  createWorkbenchProjection
} from "../src/workflow/workbench-projection.js";
import { baseInput } from "./helpers/workbench-projection.js";

test("workbench projection exposes scheduler dispatch run status", () => {
  const input = baseInput();
  const artifact = {
    id: "scheduler-dispatch-run-run-projection-cycle-20260521-001",
    type: "evaluation",
    status: "pass",
    uri: "scheduler-dispatch://run/run-projection/cycle-20260521/scheduler-dispatch-run-run-projection-cycle-20260521-001",
    producer: "scheduler-dispatch-runner",
    created_at: "2026-05-21T22:38:00.000Z",
    metadata: {
      type: "scheduler_dispatch_run",
      status: "pass",
      phase: "completed",
      result: {
        steps: [
          { id: "run-reviewer-shard-loop", status: "pass", dry_run: false },
          { id: "prepare-reviewer-shard-loop-continuation", status: "pass", dry_run: false },
          {
            id: "run-autonomous-closeout-loop",
            status: "pass",
            dry_run: false,
            outputs: {
              autonomous_closeout_loop_artifact: {
                status: "available",
                phase: "next_continuation",
                next_decision_status: "pass",
                next_decision_action: "rerun",
                should_continue: true,
                next_work_package_count: 2
              }
            }
          }
        ]
      }
    }
  };
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: `event-${artifact.id}`,
        type: "scheduler_dispatch_run",
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

  assert.equal(projection.scheduler_dispatch.status, "pass");
  assert.equal(projection.scheduler_dispatch.phase, "completed");
  assert.equal(projection.scheduler_dispatch.step_count, 3);
  assert.equal(projection.scheduler_dispatch.failed_step_count, 0);
  assert.equal(projection.scheduler_dispatch.dry_run, false);
  assert.equal(projection.scheduler_dispatch.next_continuation_status, "pass");
  assert.equal(projection.scheduler_dispatch.next_continuation_action, "rerun");
  assert.equal(projection.scheduler_dispatch.next_work_package_count, 2);
  assert.equal(projection.one_screen.counters.scheduler_dispatch_steps, 3);
  assert.equal(mobile.scheduler_dispatch.step_count, 3);
  assert.equal(mobile.scheduler_dispatch.next_work_package_count, 2);
});

test("workbench projection exposes scheduler dispatch continuation readiness", () => {
  const input = baseInput();
  const continuationArtifact = {
    id: "scheduler-dispatch-continuation-run-projection-cycle-20260521-001",
    type: "evaluation",
    status: "pass",
    uri: "scheduler-dispatch://continuation/run-projection/cycle-20260521/scheduler-dispatch-continuation-run-projection-cycle-20260521-001",
    producer: "scheduler-dispatch-continuation",
    created_at: "2026-05-22T00:05:00.000Z",
    metadata: {
      type: "scheduler_dispatch_continuation",
      version: "scheduler-dispatch-continuation.v1",
      status: "ready",
      phase: "scheduler_dispatch_continuation",
      continuation_input_path: "tmp/scheduler/run-projection/scheduler-dispatch-continuation-input.json",
      next_step: "Continue next cycle.",
      next_work_package_count: 2,
      should_continue: true
    }
  };
  const enqueueArtifact = {
    id: "scheduler-next-cycle-enqueue-run-projection-cycle-20260521-001",
    type: "evaluation",
    status: "pass",
    uri: "scheduler-dispatch://next-cycle/run-projection/cycle-20260521/scheduler-next-cycle-enqueue-run-projection-cycle-20260521-001",
    producer: "workbench-server",
    created_at: "2026-05-22T00:06:00.000Z",
    metadata: {
      type: "scheduler_next_cycle_enqueue",
      version: "scheduler-next-cycle-enqueue.v1",
      status: "queued",
      continuation_input_path: "tmp/scheduler/run-projection/scheduler-dispatch-continuation-input.json",
      snapshot_id: "scheduler-next",
      next_step: "Continue next cycle.",
      next_work_package_count: 2,
      should_continue: true
    }
  };
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: `event-${continuationArtifact.id}`,
        type: "scheduler_dispatch_continuation",
        status: "ready",
        artifact_id: continuationArtifact.id,
        created_at: continuationArtifact.created_at,
        metadata: continuationArtifact.metadata
      },
      {
        id: `event-${enqueueArtifact.id}`,
        type: "scheduler_next_cycle_enqueue",
        status: "queued",
        artifact_id: enqueueArtifact.id,
        created_at: enqueueArtifact.created_at,
        metadata: enqueueArtifact.metadata
      }
    ],
    artifacts: [...input.manifest.artifacts, continuationArtifact, enqueueArtifact]
  };
  input.artifact_ledger = {
    ...input.artifact_ledger,
    artifacts: [...input.artifact_ledger.artifacts, continuationArtifact, enqueueArtifact]
  };

  const projection = createWorkbenchProjection(input);
  const mobile = createMobileWorkbenchProjection(input);

  assert.equal(projection.scheduler_continuation.status, "queued");
  assert.equal(projection.scheduler_continuation.continuation_status, "ready");
  assert.equal(projection.scheduler_continuation.ready, true);
  assert.equal(projection.scheduler_continuation.enqueue_status, "queued");
  assert.equal(projection.scheduler_continuation.next_work_package_count, 2);
  assert.equal(projection.one_screen.counters.scheduler_continuation_ready, 1);
  assert.equal(mobile.scheduler_continuation.ready, true);
  assert.equal(mobile.scheduler_continuation.enqueue_status, "queued");
});

test("workbench projection exposes scheduler dispatch policy blockers", () => {
  const input = baseInput();
  const artifact = {
    id: "scheduler-dispatch-policy-run-projection-cycle-20260521-001",
    type: "evaluation",
    status: "fail",
    uri: "scheduler-dispatch://policy/run-projection/cycle-20260521/scheduler-dispatch-policy-run-projection-cycle-20260521-001",
    producer: "scheduler-dispatch-policy",
    created_at: "2026-05-21T23:40:00.000Z",
    metadata: {
      type: "scheduler_dispatch_policy",
      version: "scheduler-dispatch-policy.v1",
      status: "fail",
      execution_mode: "blocked",
      issues: [
        {
          code: "missing_operator_authorization",
          message: "non-dry-run scheduler dispatch requires approved_non_dry_run authorization",
          path: "operator_authorization"
        }
      ],
      plan_step_count: 3
    }
  };
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: `event-${artifact.id}`,
        type: "scheduler_dispatch_policy",
        status: "fail",
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

  assert.equal(projection.scheduler_dispatch.status, "blocked");
  assert.equal(projection.scheduler_dispatch.phase, "policy");
  assert.equal(projection.scheduler_dispatch.policy_status, "fail");
  assert.equal(projection.scheduler_dispatch.policy_execution_mode, "blocked");
  assert.equal(projection.scheduler_dispatch.policy_issue_count, 1);
  assert.match(projection.scheduler_dispatch.policy_latest_issue, /approved_non_dry_run/);
  assert.equal(mobile.scheduler_dispatch.policy_status, "fail");
  assert.equal(mobile.scheduler_dispatch.policy_issue_count, 1);
});
