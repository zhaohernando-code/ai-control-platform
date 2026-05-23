import { readFileSync } from "node:fs";

export function currentSessionWorkflowState(options = {}) {
  const workflowState = JSON.parse(readFileSync("docs/examples/current-session-workbench-input.json", "utf8"));
  if (options.reviewerShardPhase === "aggregate_pass") return workflowState;

  const reviewerShardEventTypes = new Set([
    "reviewer_shard_result",
    "reviewer_shard_aggregate"
  ]);
  const reviewerShardArtifactPrefixes = [
    "reviewer-shard-result",
    "reviewer-shard-aggregate"
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
