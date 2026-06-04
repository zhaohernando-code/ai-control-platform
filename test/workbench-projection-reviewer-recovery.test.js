import assert from "node:assert/strict";
import test from "node:test";

import {
  createMobileWorkbenchProjection,
  createWorkbenchProjection
} from "../src/workflow/workbench-projection.js";
import { baseInput } from "./helpers/workbench-projection.js";

test("workbench projection exposes reviewer provider health scheduler facts", () => {
  const input = baseInput();
  const artifact = {
    id: "reviewer-provider-health-run-projection-cycle-20260521-001",
    type: "evaluation",
    status: "pass",
    uri: "codex://reviewer-provider-health/run-projection/cycle-20260521/reviewer-provider-health-run-projection-cycle-20260521-001",
    producer: "reviewer-provider-health",
    created_at: "2026-05-21T12:05:00.000Z",
    metadata: {
      type: "reviewer_provider_health",
      recovery_status: "retry",
      provider_health: "healthy",
      retry_strategy: "rerun_without_tools_or_split_scope",
      scheduled_actions: ["rerun_without_tools", "split_scope"],
      provider: "claude-code",
      model: "deepseek-v4-pro"
    }
  };
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: `event-${artifact.id}`,
        type: "reviewer_provider_health",
        status: "retry",
        artifact_id: artifact.id,
        message: "provider smoke passed after reviewer timeout",
        created_at: "2026-05-21T12:05:00.000Z",
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

  assert.equal(projection.reviewer_provider_health.status, "retry");
  assert.equal(projection.reviewer_provider_health.provider_health, "healthy");
  assert.equal(projection.reviewer_provider_health.retry_strategy, "rerun_without_tools_or_split_scope");
  assert.equal(projection.reviewer_provider_health.next_action, "rerun_without_tools");
  assert.equal(projection.one_screen.counters.provider_health_events, 1);
  assert.equal(mobile.provider_health.provider_health, "healthy");
  assert.equal(mobile.provider_health.next_action, "rerun_without_tools");
});

test("workbench projection exposes reviewer scope split shard status", () => {
  const input = baseInput();
  const artifact = {
    id: "reviewer-scope-split-run-projection-cycle-20260521-001",
    type: "evaluation",
    status: "pass",
    uri: "codex://reviewer-scope-split/run-projection/cycle-20260521/reviewer-scope-split-run-projection-cycle-20260521-001",
    producer: "reviewer-scope-splitter",
    created_at: "2026-05-21T12:08:00.000Z",
    metadata: {
      type: "reviewer_scope_split",
      status: "pass",
      split_required: true,
      shard_count: 2,
      pending_shards: 2,
      provider: "claude-code",
      model: "deepseek-v4-pro",
      shards: [
        { id: "reviewer-scope-shard-001", status: "pending" },
        { id: "reviewer-scope-shard-002", status: "pending" }
      ]
    }
  };
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: `event-${artifact.id}`,
        type: "reviewer_scope_split",
        status: "planned",
        artifact_id: artifact.id,
        message: "Reviewer scope split into 2 bounded shard(s).",
        created_at: "2026-05-21T12:08:00.000Z",
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

  assert.equal(projection.reviewer_scope_split.status, "planned");
  assert.equal(projection.reviewer_scope_split.shard_count, 2);
  assert.equal(projection.reviewer_scope_split.pending_shards, 2);
  assert.equal(projection.reviewer_scope_split.next_shard, "reviewer-scope-shard-001");
  assert.equal(projection.one_screen.counters.reviewer_scope_shards, 2);
  assert.equal(mobile.scope_split.next_shard, "reviewer-scope-shard-001");
});

test("workbench projection advances next reviewer shard after partial result", () => {
  const input = baseInput();
  const splitArtifact = {
    id: "reviewer-scope-split-partial",
    type: "evaluation",
    status: "pass",
    uri: "codex://reviewer-scope-split/partial",
    producer: "reviewer-scope-split",
    created_at: "2026-05-21T12:05:00.000Z",
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
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: "event-reviewer-scope-split-partial",
        type: "reviewer_scope_split",
        status: "pass",
        artifact_id: splitArtifact.id,
        created_at: splitArtifact.created_at,
        metadata: splitArtifact.metadata
      },
      {
        id: "event-reviewer-scope-shard-partial-001",
        type: "reviewer_shard_result",
        status: "pass",
        created_at: "2026-05-21T12:06:00.000Z",
        metadata: { shard_id: "reviewer-scope-shard-001", status: "pass" }
      }
    ],
    artifacts: [...input.manifest.artifacts, splitArtifact]
  };
  input.artifact_ledger = {
    ...input.artifact_ledger,
    artifacts: [...input.artifact_ledger.artifacts, splitArtifact]
  };

  const projection = createWorkbenchProjection(input);

  assert.equal(projection.reviewer_shard_review.completed_shards, 1);
  assert.equal(projection.reviewer_shard_review.pending_shards, 1);
  assert.equal(projection.reviewer_shard_review.next_shard, "reviewer-scope-shard-002");
});
