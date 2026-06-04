import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const CLEARED_LIFECYCLE_NEXT_ACTION_COPY = "等待状态上报；下一步查看推荐任务。";
export const CLEARED_SCHEDULER_LOOP_RECOVERY_COPY = "等待状态上报；下一步查看推荐任务。";
export const IDLE_SCHEDULER_LOOP_RECOVERY_COPY = "空闲，等待可派发任务";
export const NO_SOURCE_RESUME_ATTEMPT_COPY = "该通道未启用；无阻塞时继续主任务。";

const RAW_SCHEDULER_LOOP_RECOVERY_TOKENS = new Set([
  "idle",
  "ready",
  "not_configured",
  "no_next_action",
  "wait_for_new_work",
  "resume_from_latest_projection",
  "start_bounded_loop",
  "inspect_latest_loop_run",
  "inspect_scheduler_loop",
  "resume_autonomous_scheduler_loop",
  "no_dispatchable_scheduler_actions"
]);
const RAW_RESUME_ATTEMPT_CLAIM_TOKENS = new Set([
  "not_configured",
  "pass",
  "fail",
  "blocked",
  "ready",
  "scheduler_loop_resume_attempt",
  "resume_autonomous_scheduler_loop"
]);

export function isClearedSchedulerLoopRecoveryReadout(value) {
  const normalized = String(value || "").trim();
  if (RAW_SCHEDULER_LOOP_RECOVERY_TOKENS.has(normalized)) return false;
  return normalized === CLEARED_SCHEDULER_LOOP_RECOVERY_COPY ||
    normalized === IDLE_SCHEDULER_LOOP_RECOVERY_COPY ||
    normalized === "就绪";
}

export function isNoSourceResumeAttemptReadout(value) {
  const normalized = String(value || "").trim();
  if (RAW_RESUME_ATTEMPT_CLAIM_TOKENS.has(normalized)) return false;
  return normalized === NO_SOURCE_RESUME_ATTEMPT_COPY ||
    normalized === "--";
}

export function clearRequirementIntakeState(workflowState) {
  if (workflowState.project_status) {
    delete workflowState.project_status.plan_reviews;
    delete workflowState.project_status.requirement_intake;
  }
  workflowState.manifest.events = (workflowState.manifest.events || [])
    .filter((event) => event.type !== "requirement_intake_submitted");
  workflowState.manifest.artifacts = (workflowState.manifest.artifacts || [])
    .filter((artifact) => artifact.metadata?.type !== "requirement_intake_submitted");
  workflowState.artifact_ledger.artifacts = (workflowState.artifact_ledger.artifacts || [])
    .filter((artifact) => artifact.metadata?.type !== "requirement_intake_submitted");
}

export function clearSchedulerLoopState(workflowState) {
  const schedulerEventTypes = new Set(["autonomous_scheduler_loop_run", "scheduler_loop_resume_attempt"]);
  workflowState.manifest.events = (workflowState.manifest.events || [])
    .filter((event) => !schedulerEventTypes.has(event.type));
  workflowState.manifest.artifacts = (workflowState.manifest.artifacts || [])
    .filter((artifact) => !schedulerEventTypes.has(artifact.metadata?.type));
  workflowState.artifact_ledger.artifacts = (workflowState.artifact_ledger.artifacts || [])
    .filter((artifact) => !schedulerEventTypes.has(artifact.metadata?.type));
}

export function pendingReviewerShardWorkflowState(workflowState) {
  clearRequirementIntakeState(workflowState);
  clearSchedulerLoopState(workflowState);
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

  workflowState.manifest.events = (workflowState.manifest.events || [])
    .filter((event) => !reviewerShardEventTypes.has(event.type));
  workflowState.manifest.artifacts = (workflowState.manifest.artifacts || [])
    .filter((artifact) => !reviewerShardArtifactPrefixes.some((prefix) => String(artifact.id).startsWith(prefix)));
  workflowState.manifest.review_findings = (workflowState.manifest.review_findings || [])
    .filter((finding) => finding.category !== "reviewer");
  workflowState.artifact_ledger.artifacts = (workflowState.artifact_ledger.artifacts || [])
    .filter((artifact) => !reviewerShardArtifactPrefixes.some((prefix) => String(artifact.id).startsWith(prefix)));
}

export function writePendingReviewerProjectStatus(dir) {
  const projectStatus = {
    project: "ai-control-platform",
    status: "in_progress",
    blockers: [],
    next_step: "",
    global_goals: [
      {
        id: "reviewer-loop-browser-fixture",
        title: "Reviewer loop browser fixture",
        status: "in_progress",
        next_step: "Run pending reviewer shards through projected scheduler loop.",
        owned_files: ["src/workflow/reviewer-shard-runner.js"]
      }
    ]
  };
  const path = join(dir, "PROJECT_STATUS.reviewer-loop.json");
  writeFileSync(path, `${JSON.stringify(projectStatus, null, 2)}\n`);
  return path;
}

export function writeLifecycleCleanupProjectStatus(dir) {
  const projectStatus = {
    project: "ai-control-platform",
    status: "in_progress",
    blockers: [],
    next_step: "Run isolated lifecycle cleanup browser-event scenario.",
    global_goals: [
      {
        id: "lifecycle-cleanup-browser-fixture",
        title: "Lifecycle cleanup browser fixture",
        status: "in_progress",
        next_step: "Exercise cleanup_agent_lifecycle_pool through projected scheduler controls.",
        owned_files: ["src/workflow/agent-lifecycle-pool.js"]
      }
    ]
  };
  const path = join(dir, "PROJECT_STATUS.lifecycle-cleanup.json");
  writeFileSync(path, `${JSON.stringify(projectStatus, null, 2)}\n`);
  return path;
}

export function injectLifecycleCleanupState(workflowState) {
  workflowState.manifest.events = workflowState.manifest.events.filter((event) => ![
    "WorkerSpawned",
    "WorkerCompleted",
    "WorkerHeartbeat",
    "WorkerTimeout",
    "WorkerEvaluation",
    "WorkerClosed",
    "PoolIterationClosed"
  ].includes(event.type));
  workflowState.manifest.artifacts = workflowState.manifest.artifacts.filter((artifact) => artifact.metadata?.type !== "agent_lifecycle_pool");
  workflowState.artifact_ledger.artifacts = workflowState.artifact_ledger.artifacts.filter((artifact) => artifact.metadata?.type !== "agent_lifecycle_pool");
  workflowState.manifest.events.push(
    {
      id: "worker-spawned-browser-lifecycle",
      type: "WorkerSpawned",
      status: "pass",
      created_at: "2026-05-22T08:15:00.000Z",
      metadata: { pool_id: "pool-browser-lifecycle", worker_id: "worker-browser-lifecycle" }
    },
    {
      id: "worker-completed-browser-lifecycle",
      type: "WorkerCompleted",
      status: "pass",
      created_at: "2026-05-22T08:16:00.000Z",
      metadata: { pool_id: "pool-browser-lifecycle", worker_id: "worker-browser-lifecycle" }
    }
  );
}

export function injectLifecycleTimeoutState(workflowState) {
  workflowState.manifest.events = workflowState.manifest.events.filter((event) => ![
    "WorkerSpawned",
    "WorkerCompleted",
    "WorkerHeartbeat",
    "WorkerTimeout",
    "WorkerEvaluation",
    "WorkerClosed",
    "PoolIterationClosed"
  ].includes(event.type));
  workflowState.manifest.artifacts = workflowState.manifest.artifacts.filter((artifact) => artifact.metadata?.type !== "agent_lifecycle_pool");
  workflowState.artifact_ledger.artifacts = workflowState.artifact_ledger.artifacts.filter((artifact) => artifact.metadata?.type !== "agent_lifecycle_pool");
  workflowState.manifest.events.push(
    {
      id: "worker-spawned-browser-timeout",
      type: "WorkerSpawned",
      status: "pass",
      created_at: "2026-05-22T08:15:00.000Z",
      metadata: { pool_id: "pool-browser-timeout", worker_id: "worker-browser-timeout" }
    },
    {
      id: "worker-heartbeat-browser-timeout",
      type: "WorkerHeartbeat",
      status: "pass",
      created_at: "2026-05-22T08:16:00.000Z",
      metadata: { pool_id: "pool-browser-timeout", worker_id: "worker-browser-timeout" }
    },
    {
      id: "worker-timeout-browser-timeout",
      type: "WorkerTimeout",
      status: "fail",
      created_at: "2026-05-22T08:20:00.000Z",
      metadata: {
        pool_id: "pool-browser-timeout",
        worker_id: "worker-browser-timeout",
        issues: [{ code: "agent_lifecycle_worker_timeout", message: "worker-browser-timeout timed out" }]
      }
    }
  );
}

export function injectTerminalNextActionState(workflowState) {
  workflowState.manifest.events = workflowState.manifest.events.filter((event) => event.type !== "autonomous_scheduler_loop_run");
  workflowState.manifest.events.push({
    id: "scheduler-loop-terminal-browser",
    type: "autonomous_scheduler_loop_run",
    status: "pass",
    created_at: "2026-05-22T09:00:00.000Z",
    artifact_id: "scheduler-loop-terminal-browser-artifact"
  });
  workflowState.artifact_ledger.artifacts.push({
    id: "scheduler-loop-terminal-browser-artifact",
    type: "scheduler_loop",
    status: "pass",
    created_at: "2026-05-22T09:00:00.000Z",
    metadata: {
      version: "autonomous-scheduler-loop-run.v1",
      status: "pass",
      phase: "terminal_projected_action",
      created_at: "2026-05-22T09:00:00.000Z",
      input: {
        start_projection_id: "current-session",
        max_iterations: 1,
        execution_profile: "approved_mock_non_dry_run",
        execution_strategy: "projected_next_action",
        snapshot_prefix: "terminal-browser"
      },
      result: {
        status: "pass",
        phase: "terminal_projected_action",
        issues: [],
        iterations: [
          {
            index: 1,
            status: "stopped",
            projection_id: "current-session",
            projected_action: "inspect_scheduler_loop",
            terminal_action: "inspect_scheduler_loop",
            terminal_reason: "projected next action is not executable"
          }
        ]
      }
    }
  });
}
