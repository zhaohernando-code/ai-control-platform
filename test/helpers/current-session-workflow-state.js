import { readFileSync } from "node:fs";

export function currentSessionWorkflowState(options = {}) {
  const workflowState = JSON.parse(readFileSync("docs/examples/current-session-workbench-input.json", "utf8"));
  if (options.reviewerShardPhase === "aggregate_pass") return workflowState;

  const reviewerShardEventTypes = new Set([
    "reviewer_shard_result",
    "reviewer_shard_aggregate",
    "project_status_continuation",
    "context_pack_cycle_materialized",
    "context_pack_cycle_created",
    "context_work_packages_run"
  ]);
  const reviewerShardArtifactPrefixes = [
    "reviewer-shard-result",
    "reviewer-shard-aggregate",
    "project-status-continuation",
    "context-pack-cycle",
    "context-work-packages-run"
  ];

  return {
    ...workflowState,
    manifest: {
      ...workflowState.manifest,
      events: (workflowState.manifest.events || [])
        .filter((event) => !reviewerShardEventTypes.has(event.type)),
      artifacts: (workflowState.manifest.artifacts || [])
        .filter((artifact) => !reviewerShardArtifactPrefixes.some((prefix) => String(artifact.id).startsWith(prefix))),
      review_findings: (workflowState.manifest.review_findings || [])
        .filter((finding) => finding.category !== "reviewer")
    },
    artifact_ledger: {
      ...workflowState.artifact_ledger,
      artifacts: (workflowState.artifact_ledger.artifacts || [])
        .filter((artifact) => !reviewerShardArtifactPrefixes.some((prefix) => String(artifact.id).startsWith(prefix)))
    }
  };
}
