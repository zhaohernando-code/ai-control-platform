import assert from "node:assert/strict";
import test from "node:test";

import {
  createMobileWorkbenchProjection,
  createWorkbenchProjection
} from "../src/workflow/workbench-projection.js";
import { baseInput } from "./helpers/workbench-projection.js";

test("workbench projection exposes autonomous scheduler loop runs", () => {
  const input = baseInput();
  const artifact = {
    id: "autonomous-scheduler-loop-run-projection-cycle-20260521-001",
    type: "evaluation",
    status: "pass",
    uri: "scheduler-loop://run/run-projection/cycle-20260521/autonomous-scheduler-loop-run-projection-cycle-20260521-001",
    producer: "autonomous-scheduler-loop",
    created_at: "2026-05-22T00:45:00.000Z",
    metadata: {
      type: "autonomous_scheduler_loop_run",
      version: "autonomous-scheduler-loop-run.v1",
      status: "pass",
      phase: "iteration_limit_reached",
      created_at: "2026-05-22T00:45:00.000Z",
      input: {
        start_projection_id: "current",
        max_iterations: 1,
        execution_profile: "approved_mock_non_dry_run",
        snapshot_prefix: "workbench-loop"
      },
      result: {
        status: "pass",
        phase: "iteration_limit_reached",
        issues: [],
        iterations: [
          {
            index: 1,
            projection_id: "current",
            status: "queued",
            next_projection_id: "workbench-loop-current-01"
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
        type: "autonomous_scheduler_loop_run",
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

  assert.equal(projection.scheduler_loop.status, "pass");
  assert.equal(projection.scheduler_loop.phase, "iteration_limit_reached");
  assert.equal(projection.scheduler_loop.run_count, 1);
  assert.equal(projection.scheduler_loop.invalid_count, 0);
  assert.equal(projection.scheduler_loop.iteration_count, 1);
  assert.equal(projection.scheduler_loop.latest_iteration_status, "queued");
  assert.equal(projection.scheduler_loop.latest_projection_id, "workbench-loop-current-01");
  assert.equal(projection.scheduler_loop.recovery_status, "ready");
  assert.equal(projection.scheduler_loop.recovery_action, "resume_from_latest_projection");
  assert.equal(projection.scheduler_loop.resumable, true);
  assert.equal(projection.scheduler_loop.resume_projection_id, "workbench-loop-current-01");
  assert.equal(projection.scheduler_loop.execution_strategy, "scheduler_dispatch_chain");
  assert.equal(projection.scheduler_loop.execution_profile, "approved_mock_non_dry_run");
  assert.equal(projection.one_screen.counters.scheduler_loop_iterations, 1);
  assert.equal(mobile.scheduler_loop.status, "pass");
  assert.equal(mobile.scheduler_loop.latest_projection_id, "workbench-loop-current-01");
  assert.equal(mobile.scheduler_loop.recovery_status, "ready");
  assert.equal(mobile.scheduler_loop.execution_strategy, "scheduler_dispatch_chain");
  assert.equal(mobile.scheduler_loop.execution_profile, "approved_mock_non_dry_run");
});

test("workbench projection blocks invalid autonomous scheduler loop history", () => {
  const input = baseInput();
  const artifact = {
    id: "autonomous-scheduler-loop-run-invalid-cycle-20260521-001",
    type: "evaluation",
    status: "pass",
    uri: "scheduler-loop://run/run-projection/cycle-20260521/autonomous-scheduler-loop-run-invalid-cycle-20260521-001",
    producer: "autonomous-scheduler-loop",
    created_at: "2026-05-22T01:10:00.000Z",
    metadata: {
      type: "autonomous_scheduler_loop_run",
      version: "autonomous-scheduler-loop-run.v1",
      status: "pass",
      phase: "iteration_limit_reached",
      created_at: "2026-05-22T01:10:00.000Z",
      input: {
        start_projection_id: "current",
        max_iterations: 1,
        execution_profile: "approved_mock_non_dry_run",
        snapshot_prefix: "workbench-loop"
      },
      result: {
        status: "fail",
        phase: "iteration_limit_reached",
        issues: [],
        iterations: [
          {
            index: 1,
            projection_id: "current",
            status: "queued",
            next_projection_id: ""
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
        type: "autonomous_scheduler_loop_run",
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

  assert.equal(projection.scheduler_loop.status, "invalid");
  assert.equal(projection.scheduler_loop.phase, "replay_validation");
  assert.equal(projection.scheduler_loop.invalid_count, 1);
  assert.equal(projection.scheduler_loop.recovery_status, "blocked");
  assert.equal(projection.scheduler_loop.recovery_action, "quarantine_invalid_loop_artifact");
  assert.equal(projection.scheduler_loop.resumable, false);
  assert.ok(projection.scheduler_loop.latest_issue);
  assert.equal(mobile.scheduler_loop.recovery_status, "blocked");
});

test("workbench projection exposes scheduler loop resume attempts", () => {
  const input = baseInput();
  const artifact = {
    id: "scheduler-loop-resume-attempt-run-projection-cycle-20260521-001",
    type: "evaluation",
    status: "fail",
    uri: "scheduler-loop://resume-attempt/run-projection/cycle-20260521/scheduler-loop-resume-attempt-run-projection-cycle-20260521-001",
    producer: "autonomous-scheduler-loop",
    created_at: "2026-05-22T02:00:00.000Z",
    metadata: {
      type: "scheduler_loop_resume_attempt",
      version: "scheduler-loop-resume-attempt.v1",
      status: "blocked",
      run_id: "run-projection",
      cycle_id: "cycle-20260521",
      source_projection_id: "source",
      resume_projection_id: "target",
      recovery_status: "blocked",
      recovery_action: "quarantine_invalid_loop_artifact",
      issues: [{ code: "invalid_loop", message: "loop artifact invalid", path: "scheduler_loop" }]
    }
  };
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: `event-${artifact.id}`,
        type: "scheduler_loop_resume_attempt",
        status: "blocked",
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

  assert.equal(projection.scheduler_loop.latest_resume_status, "blocked");
  assert.equal(projection.scheduler_loop.latest_resume_target, "target");
  assert.equal(projection.scheduler_loop.latest_resume_issue, "loop artifact invalid");
  assert.equal(mobile.scheduler_loop.latest_resume_status, "blocked");
  assert.equal(mobile.scheduler_loop.latest_resume_target, "target");
});
