import { GOVERNANCE_AUDIT_SKILL_TRIAL_EVENT } from "./governance-audit-skill-trial.js";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export const AGENT_LIFECYCLE_EVENT_TYPES = new Set([
  "WorkerSpawned",
  "WorkerCompleted",
  "WorkerEvaluation",
  "WorkerClosed",
  "PoolIterationClosed",
  "worker_spawned",
  "worker_completed",
  "worker_evaluation",
  "worker_closed",
  "pool_iteration_closed",
  "agent_lifecycle_pool"
]);

const OPERATION_EVENT_TYPES = new Set([
  "requirement_intake_submitted",
  "scheduler_dispatch_policy",
  "scheduler_dispatch_run",
  "scheduler_dispatch_continuation",
  "scheduler_next_cycle_enqueue",
  "autonomous_scheduler_loop_run",
  "scheduler_loop_resume_attempt",
  "project_status_continuation",
  "context_pack_cycle_materialized",
  "context_pack_cycle_created",
  "context_work_packages_run",
  "reviewer_provider_health",
  "reviewer_scope_split",
  "reviewer_shard_result",
  "reviewer_shard_aggregate",
  "workbench_browser_events_run",
  "frontend_acceptance_run",
  GOVERNANCE_AUDIT_SKILL_TRIAL_EVENT,
  "headless_projected_action_progress",
  ...AGENT_LIFECYCLE_EVENT_TYPES
]);

function operationSummary(type, metadata = {}) {
  if (type === "requirement_intake_submitted") {
    return metadata.requirement?.title || metadata.next_step || "requirement submitted";
  }
  if (type === "scheduler_dispatch_run") {
    return `${metadata.phase || metadata.result?.phase || "dispatch"} / ${asArray(metadata.result?.steps || metadata.steps).length} step(s)`;
  }
  if (type === "scheduler_dispatch_continuation") {
    return `${metadata.status || "unknown"} / ${metadata.next_work_package_count || 0} package(s)`;
  }
  if (type === "scheduler_next_cycle_enqueue") {
    return metadata.snapshot_id || metadata.next_step || metadata.status || "queued";
  }
  if (type === "autonomous_scheduler_loop_run") {
    return `${metadata.phase || metadata.result?.phase || "loop"} / ${asArray(metadata.result?.iterations).length} iteration(s)`;
  }
  if (type === "scheduler_loop_resume_attempt") {
    return `${metadata.status || "unknown"} -> ${metadata.resume_projection_id || "none"}`;
  }
  if (type === "project_status_continuation") {
    return `${metadata.status || "unknown"} / ${metadata.next_work_package_count || 0} package(s)`;
  }
  if (type === "context_pack_cycle_materialized") {
    return `${metadata.status || "unknown"} -> ${metadata.next_cycle_id || "next-cycle"}`;
  }
  if (type === "context_pack_cycle_created") {
    return `${metadata.status || "unknown"} / ${metadata.work_package_count || 0} work package(s)`;
  }
  if (type === "context_work_packages_run") {
    return `${metadata.status || "unknown"} / ${metadata.executed_count || 0} executed`;
  }
  if (type === "reviewer_provider_health") {
    return `${metadata.provider_health || "unknown"} / ${asArray(metadata.scheduled_actions).join(", ") || "no_action"}`;
  }
  if (type === "reviewer_scope_split") {
    return `${metadata.shard_count || asArray(metadata.shards).length} shard(s)`;
  }
  if (type === "reviewer_shard_result") {
    return metadata.shard_id || metadata.status || "shard_result";
  }
  if (type === "reviewer_shard_aggregate") {
    return `${metadata.status || "aggregate"} / ${metadata.failed_finding_count || 0} failed`;
  }
  if (type === "workbench_browser_events_run") {
    return `${metadata.status || "unknown"} / ${metadata.scenario_count || 0} scenario(s)`;
  }
  if (type === "frontend_acceptance_run") {
    return `${metadata.status || "unknown"} / ${metadata.blocking_count || 0} blocker(s)`;
  }
  if (type === GOVERNANCE_AUDIT_SKILL_TRIAL_EVENT) {
    return `${metadata.final_verdict || metadata.status || "unknown"} / ${metadata.blocking_count || 0} blocker(s)`;
  }
  if (type === "headless_projected_action_progress") {
    return `${metadata.status || "unknown"} / ${metadata.action || "projected_action"}`;
  }
  if (AGENT_LIFECYCLE_EVENT_TYPES.has(type)) {
    return metadata.worker_id || metadata.workerId || metadata.status || "agent lifecycle pool";
  }
  return metadata.status || "recorded";
}

function operationGroup(type) {
  if (type === "requirement_intake_submitted") return "requirement_intake";
  if (AGENT_LIFECYCLE_EVENT_TYPES.has(type)) return "agent_lifecycle_pool";
  if (String(type || "").startsWith("reviewer_")) return "reviewer_recovery";
  if (type === "headless_projected_action_progress") return "headless_orchestrator";
  return "scheduler";
}

function operationNextActionRole(type, metadata = {}) {
  if (type === "requirement_intake_submitted") return "automation_driver";
  if (type === "scheduler_dispatch_continuation") {
    return metadata.status === "ready" || metadata.status === "pass" ? "automation_driver" : "operator_observable";
  }
  if (type === "scheduler_next_cycle_enqueue") return "automation_driver";
  if (type === "autonomous_scheduler_loop_run") {
    return metadata.status === "pass" ? "automation_driver" : "operator_observable";
  }
  if (type === "scheduler_loop_resume_attempt") {
    return metadata.status === "pass" ? "automation_driver" : "operator_observable";
  }
  if (type === "project_status_continuation") return "operator_observable";
  if (type === "context_pack_cycle_materialized" || type === "context_pack_cycle_created" || type === "context_work_packages_run") return "operator_observable";
  if (type === "frontend_acceptance_run") {
    return Number(metadata.blocking_count || 0) > 0 && metadata.status === "fail" ? "automation_driver" : "operator_observable";
  }
  if (type === GOVERNANCE_AUDIT_SKILL_TRIAL_EVENT) {
    return Number(metadata.blocking_count || 0) > 0 && metadata.status === "fail" ? "automation_driver" : "operator_observable";
  }
  if (type === "reviewer_provider_health" || type === "reviewer_scope_split" || type === "reviewer_shard_aggregate") {
    return "automation_driver";
  }
  if (AGENT_LIFECYCLE_EVENT_TYPES.has(type)) {
    return "automation_driver";
  }
  return "operator_observable";
}

export function summarizeOperationsTimeline(manifest = {}, artifactLedger = {}) {
  const artifacts = [
    ...asArray(artifactLedger?.artifacts),
    ...asArray(manifest?.artifacts)
  ];
  const items = asArray(manifest?.events)
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => OPERATION_EVENT_TYPES.has(event?.type))
    .map(({ event, index }) => {
      const artifact = artifacts.find((entry) => entry.id === event.artifact_id) || null;
      const metadata = artifact?.metadata || event.metadata || {};
      return {
        sequence: index + 1,
        event_id: event.id || null,
        type: event.type,
        group: operationGroup(event.type),
        next_action_role: operationNextActionRole(event.type, metadata),
        status: event.status || metadata.status || artifact?.status || "unknown",
        artifact_id: event.artifact_id || artifact?.id || null,
        requirement_id: metadata.requirement?.id || metadata.requirement_id || metadata.global_goal_id || null,
        created_at: event.created_at || artifact?.created_at || null,
        summary: operationSummary(event.type, metadata)
      };
    })
    .slice(-12);
  const groupCounts = items.reduce((summary, item) => {
    summary[item.group] = (summary[item.group] || 0) + 1;
    return summary;
  }, {});
  const driverItems = items.filter((item) => item.next_action_role === "automation_driver");

  return {
    status: items.length > 0 ? "available" : "not_configured",
    count: items.length,
    group_counts: groupCounts,
    driver_count: driverItems.length,
    operator_only_count: items.length - driverItems.length,
    latest_driver: driverItems.at(-1) || null,
    latest: items.at(-1) || null,
    items
  };
}
