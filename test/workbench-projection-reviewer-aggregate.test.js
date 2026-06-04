import assert from "node:assert/strict";
import test from "node:test";

import {
  createMobileWorkbenchProjection,
  createWorkbenchProjection
} from "../src/workflow/workbench-projection.js";
import { baseInput } from "./helpers/workbench-projection.js";

test("workbench projection exposes reviewer shard aggregate status", () => {
  const input = baseInput();
  const splitArtifact = {
    id: "reviewer-scope-split-run-projection-cycle-20260521-001",
    type: "evaluation",
    status: "pass",
    uri: "codex://reviewer-scope-split/run-projection/cycle-20260521/reviewer-scope-split-run-projection-cycle-20260521-001",
    producer: "reviewer-scope-splitter",
    created_at: "2026-05-21T12:08:00.000Z",
    metadata: {
      type: "reviewer_scope_split",
      status: "pass",
      shard_count: 2,
      pending_shards: 2,
      shards: [
        { id: "reviewer-scope-shard-001", status: "pending" },
        { id: "reviewer-scope-shard-002", status: "pending" }
      ]
    }
  };
  const aggregateArtifact = {
    id: "reviewer-shard-aggregate-run-projection-cycle-20260521-001",
    type: "review",
    status: "fail",
    uri: "codex://reviewer-shard-aggregate/run-projection/cycle-20260521/reviewer-shard-aggregate-run-projection-cycle-20260521-001",
    producer: "reviewer-shard-aggregate",
    created_at: "2026-05-21T12:12:00.000Z",
    metadata: {
      type: "reviewer_shard_aggregate",
      status: "fail",
      total_shards: 2,
      completed_shards: 2,
      pending_shards: 0,
      finding_count: 1,
      failed_finding_count: 1
    }
  };
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: `event-${splitArtifact.id}`,
        type: "reviewer_scope_split",
        status: "planned",
        artifact_id: splitArtifact.id,
        created_at: splitArtifact.created_at,
        metadata: splitArtifact.metadata
      },
      {
        id: "event-reviewer-scope-shard-001",
        type: "reviewer_shard_result",
        status: "pass",
        created_at: "2026-05-21T12:10:00.000Z",
        metadata: { shard_id: "reviewer-scope-shard-001", status: "pass" }
      },
      {
        id: "event-reviewer-scope-shard-002",
        type: "reviewer_shard_result",
        status: "fail",
        created_at: "2026-05-21T12:11:00.000Z",
        metadata: {
          shard_id: "reviewer-scope-shard-002",
          status: "fail",
          executor_provenance: {
            executor_kind: "agent_invocation",
            execution_profile: "approved_bounded_real_reviewer",
            provider: "deepseek",
            model: "deepseek-v4-pro",
            external_call_budget_used: 1
          }
        }
      },
      {
        id: `event-${aggregateArtifact.id}`,
        type: "reviewer_shard_aggregate",
        status: "fail",
        artifact_id: aggregateArtifact.id,
        created_at: aggregateArtifact.created_at,
        metadata: aggregateArtifact.metadata
      }
    ],
    artifacts: [...input.manifest.artifacts, splitArtifact, aggregateArtifact]
  };
  input.artifact_ledger = {
    ...input.artifact_ledger,
    artifacts: [...input.artifact_ledger.artifacts, splitArtifact, aggregateArtifact]
  };

  const projection = createWorkbenchProjection(input);
  const mobile = createMobileWorkbenchProjection(input);

  assert.equal(projection.reviewer_shard_review.status, "fail");
  assert.equal(projection.reviewer_shard_review.completed_shards, 2);
  assert.equal(projection.reviewer_shard_review.pending_shards, 0);
  assert.equal(projection.reviewer_shard_review.failed_finding_count, 1);
  assert.equal(projection.reviewer_shard_review.latest_executor_kind, "agent_invocation");
  assert.equal(projection.reviewer_shard_review.latest_execution_profile, "approved_bounded_real_reviewer");
  assert.equal(projection.reviewer_shard_review.latest_external_call_budget_used, 1);
  assert.equal(projection.one_screen.counters.reviewer_shards_completed, 2);
  assert.equal(mobile.shard_review.failed_finding_count, 1);
  assert.equal(mobile.shard_review.latest_executor_kind, "agent_invocation");
  assert.equal(projection.next_action_readout.action, "continue_after_reviewer_aggregate");
});

test("workbench projection advances from reviewer aggregate continuation fact", () => {
  const input = baseInput();
  const aggregateArtifact = {
    id: "reviewer-shard-aggregate-run-projection-cycle-20260521-001",
    type: "review",
    status: "pass",
    uri: "codex://reviewer-shard-aggregate/run-projection/cycle-20260521/reviewer-shard-aggregate-run-projection-cycle-20260521-001",
    producer: "reviewer-shard-aggregate",
    created_at: "2026-05-21T12:12:00.000Z",
    metadata: {
      type: "reviewer_shard_aggregate",
      status: "pass",
      total_shards: 2,
      completed_shards: 2,
      pending_shards: 0,
      finding_count: 0,
      failed_finding_count: 0,
      merged_findings: []
    }
  };
  const continuationArtifact = {
    id: "project-status-continuation-after-reviewer-aggregate",
    type: "evaluation",
    status: "pass",
    uri: "project-status://continuation/run-projection/cycle-20260521/project-status-continuation-after-reviewer-aggregate",
    producer: "project-status-continuation",
    created_at: "2026-05-21T12:13:00.000Z",
    metadata: {
      type: "project_status_continuation",
      version: "project-status-continuation.v1",
      status: "ready",
      next_work_package_count: 1
    }
  };
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: `event-${aggregateArtifact.id}`,
        type: "reviewer_shard_aggregate",
        status: "pass",
        artifact_id: aggregateArtifact.id,
        created_at: aggregateArtifact.created_at,
        metadata: aggregateArtifact.metadata
      },
      {
        id: `event-${continuationArtifact.id}`,
        type: "project_status_continuation",
        status: "ready",
        artifact_id: continuationArtifact.id,
        created_at: continuationArtifact.created_at,
        metadata: continuationArtifact.metadata
      }
    ],
    artifacts: [...input.manifest.artifacts, aggregateArtifact, continuationArtifact]
  };
  input.artifact_ledger = {
    ...input.artifact_ledger,
    artifacts: [...input.artifact_ledger.artifacts, aggregateArtifact, continuationArtifact]
  };

  const projection = createWorkbenchProjection(input);

  assert.equal(projection.operations_timeline.latest_driver.type, "reviewer_shard_aggregate");
  assert.equal(projection.operations_timeline.latest.type, "project_status_continuation");
  assert.equal(projection.next_action_readout.status, "ready");
  assert.equal(projection.next_action_readout.action, "create_context_pack_from_seed");
  assert.equal(projection.next_action_readout.source_type, "project_status_continuation");
});
