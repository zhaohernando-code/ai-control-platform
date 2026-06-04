import assert from "node:assert/strict";
import test from "node:test";

import {
  createMobileWorkbenchProjection,
  createWorkbenchProjection
} from "../src/workflow/workbench-projection.js";
import { baseInput } from "./helpers/workbench-projection.js";

test("workbench projection exposes compact operations timeline", () => {
  const input = baseInput();
  const dispatchArtifact = {
    id: "scheduler-dispatch-run-projection-cycle-20260521-001",
    type: "evaluation",
    status: "pass",
    uri: "scheduler-dispatch://run/run-projection/cycle-20260521/scheduler-dispatch-run-projection-cycle-20260521-001",
    producer: "scheduler-dispatch-runner",
    created_at: "2026-05-22T02:10:00.000Z",
    metadata: {
      type: "scheduler_dispatch_run",
      status: "pass",
      phase: "completed",
      result: { steps: [{ id: "run-reviewer-shard-loop" }] }
    }
  };
  const resumeArtifact = {
    id: "scheduler-loop-resume-attempt-run-projection-cycle-20260521-001",
    type: "evaluation",
    status: "pass",
    uri: "scheduler-loop://resume-attempt/run-projection/cycle-20260521/scheduler-loop-resume-attempt-run-projection-cycle-20260521-001",
    producer: "autonomous-scheduler-loop",
    created_at: "2026-05-22T02:11:00.000Z",
    metadata: {
      type: "scheduler_loop_resume_attempt",
      version: "scheduler-loop-resume-attempt.v1",
      status: "pass",
      resume_projection_id: "next-projection",
      issues: []
    }
  };
  const providerArtifact = {
    id: "reviewer-provider-health-run-projection-cycle-20260521-001",
    type: "evaluation",
    status: "pass",
    uri: "codex://reviewer-provider-health/run-projection/cycle-20260521/reviewer-provider-health-run-projection-cycle-20260521-001",
    producer: "reviewer-provider-health",
    created_at: "2026-05-22T02:12:00.000Z",
    metadata: {
      type: "reviewer_provider_health",
      status: "retry",
      provider_health: "healthy",
      scheduled_actions: ["split_scope"]
    }
  };
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: `event-${dispatchArtifact.id}`,
        type: "scheduler_dispatch_run",
        status: "pass",
        artifact_id: dispatchArtifact.id,
        created_at: dispatchArtifact.created_at,
        metadata: dispatchArtifact.metadata
      },
      {
        id: `event-${resumeArtifact.id}`,
        type: "scheduler_loop_resume_attempt",
        status: "pass",
        artifact_id: resumeArtifact.id,
        created_at: resumeArtifact.created_at,
        metadata: resumeArtifact.metadata
      },
      {
        id: `event-${providerArtifact.id}`,
        type: "reviewer_provider_health",
        status: "retry",
        artifact_id: providerArtifact.id,
        created_at: providerArtifact.created_at,
        metadata: providerArtifact.metadata
      }
    ],
    artifacts: [...input.manifest.artifacts, dispatchArtifact, resumeArtifact, providerArtifact]
  };
  input.artifact_ledger = {
    ...input.artifact_ledger,
    artifacts: [...input.artifact_ledger.artifacts, dispatchArtifact, resumeArtifact, providerArtifact]
  };

  const projection = createWorkbenchProjection(input);
  const mobile = createMobileWorkbenchProjection(input);

  assert.equal(projection.operations_timeline.status, "available");
  assert.equal(projection.operations_timeline.count, 3);
  assert.equal(projection.operations_timeline.group_counts.scheduler, 2);
  assert.equal(projection.operations_timeline.group_counts.reviewer_recovery, 1);
  assert.equal(projection.operations_timeline.driver_count, 2);
  assert.equal(projection.operations_timeline.operator_only_count, 1);
  assert.equal(projection.operations_timeline.items[0].type, "scheduler_dispatch_run");
  assert.equal(projection.operations_timeline.items[0].next_action_role, "operator_observable");
  assert.equal(projection.operations_timeline.items[1].type, "scheduler_loop_resume_attempt");
  assert.equal(projection.operations_timeline.items[1].group, "scheduler");
  assert.equal(projection.operations_timeline.items[1].next_action_role, "automation_driver");
  assert.equal(projection.operations_timeline.latest.type, "reviewer_provider_health");
  assert.equal(projection.operations_timeline.latest.group, "reviewer_recovery");
  assert.equal(projection.operations_timeline.latest_driver.type, "reviewer_provider_health");
  assert.equal(projection.next_action_readout.status, "ready");
  assert.equal(projection.next_action_readout.action, "split_scope");
  assert.equal(projection.next_action_readout.source_type, "reviewer_provider_health");
  assert.equal(projection.one_screen.counters.operation_events, 3);
  assert.equal(projection.one_screen.recommended_action, "split_scope");
  assert.equal(mobile.operations_timeline.status, "available");
  assert.equal(mobile.operations_timeline.latest.type, "reviewer_provider_health");
  assert.equal(mobile.next_action_readout.action, "split_scope");
});

test("workbench operations timeline follows manifest order across clock skew", () => {
  const input = baseInput();
  const reviewerArtifact = {
    id: "reviewer-scope-split-clock-skew",
    type: "evaluation",
    status: "pass",
    uri: "codex://reviewer-scope-split/clock-skew",
    producer: "reviewer-scope-splitter",
    created_at: "2026-05-22T20:20:30.000Z",
    metadata: {
      type: "reviewer_scope_split",
      status: "planned",
      shard_count: 2,
      shards: [{ id: "reviewer-scope-shard-001" }]
    }
  };
  const continuationArtifact = {
    id: "scheduler-dispatch-continuation-clock-skew",
    type: "evaluation",
    status: "pass",
    uri: "scheduler-dispatch://continuation/clock-skew",
    producer: "scheduler-dispatch-continuation",
    created_at: "2026-05-22T17:36:04.000Z",
    metadata: {
      type: "scheduler_dispatch_continuation",
      status: "ready",
      next_decision: { action: "rerun", next_work_packages: [{ id: "next" }] }
    }
  };
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: `event-${reviewerArtifact.id}`,
        type: "reviewer_scope_split",
        status: "planned",
        artifact_id: reviewerArtifact.id,
        created_at: reviewerArtifact.created_at,
        metadata: reviewerArtifact.metadata
      },
      {
        id: `event-${continuationArtifact.id}`,
        type: "scheduler_dispatch_continuation",
        status: "pass",
        artifact_id: continuationArtifact.id,
        created_at: continuationArtifact.created_at,
        metadata: continuationArtifact.metadata
      }
    ],
    artifacts: [...input.manifest.artifacts, reviewerArtifact, continuationArtifact]
  };
  input.artifact_ledger = {
    ...input.artifact_ledger,
    artifacts: [...input.artifact_ledger.artifacts, reviewerArtifact, continuationArtifact]
  };

  const projection = createWorkbenchProjection(input);

  assert.equal(projection.operations_timeline.items.at(-1).type, "scheduler_dispatch_continuation");
  assert.equal(projection.operations_timeline.latest_driver.type, "scheduler_dispatch_continuation");
  assert.equal(projection.next_action_readout.action, "enqueue_scheduler_next_cycle");
});
