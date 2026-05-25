import { readFileSync } from "node:fs";

function stripRequirementIntake(workflowState) {
  if (workflowState.project_status) {
    delete workflowState.project_status.plan_reviews;
    delete workflowState.project_status.requirement_intake;
  }
  if (workflowState.manifest) {
    workflowState.manifest.events = (workflowState.manifest.events || [])
      .filter((event) => event.type !== "requirement_intake_submitted");
    workflowState.manifest.artifacts = (workflowState.manifest.artifacts || [])
      .filter((artifact) => artifact.metadata?.type !== "requirement_intake_submitted");
  }
  if (workflowState.artifact_ledger) {
    workflowState.artifact_ledger.artifacts = (workflowState.artifact_ledger.artifacts || [])
      .filter((artifact) => artifact.metadata?.type !== "requirement_intake_submitted");
  }
  return workflowState;
}

function stripSchedulerLoop(workflowState) {
  const schedulerEventTypes = new Set(["autonomous_scheduler_loop_run", "scheduler_loop_resume_attempt"]);
  if (workflowState.manifest) {
    workflowState.manifest.events = (workflowState.manifest.events || [])
      .filter((event) => !schedulerEventTypes.has(event.type));
    workflowState.manifest.artifacts = (workflowState.manifest.artifacts || [])
      .filter((artifact) => !schedulerEventTypes.has(artifact.metadata?.type));
  }
  if (workflowState.artifact_ledger) {
    workflowState.artifact_ledger.artifacts = (workflowState.artifact_ledger.artifacts || [])
      .filter((artifact) => !schedulerEventTypes.has(artifact.metadata?.type));
  }
  return workflowState;
}

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

  const base = {
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

  if (options.withoutRequirementIntake) stripRequirementIntake(base);
  if (options.withoutSchedulerLoop) stripSchedulerLoop(base);
  return base;
}
