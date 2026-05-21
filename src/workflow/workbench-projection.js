import { evaluateRunResult } from "./autonomous-run.js";
import { summarizeArtifactLedger } from "./artifact-ledger.js";
import { buildRunResultFromManifest, validateRunManifest } from "./run-manifest.js";
import { summarizeReviewerGate } from "./llm-reviewer-gate.js";
import { summarizeModelRouting } from "./model-router.js";
import { applyOperatorEventsToWorkflowState } from "./operator-events.js";
import {
  buildSchedulerLoopRunRegistry,
  evaluateSchedulerLoopRecovery
} from "./autonomous-scheduler-loop.js";
import { buildTaskDag, getDispatchableNodes } from "./task-dag.js";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function issue(code, message, path) {
  return { code, message, path };
}

function statusSeverity(status) {
  return {
    pass: 1,
    rerun: 2,
    rollback: 3,
    human_intervention: 4,
    fail: 4
  }[status] || 0;
}

function maxStatus(statuses) {
  return statuses.reduce((max, status) => (statusSeverity(status) > statusSeverity(max) ? status : max), "pass");
}

function summarizeDag(dagInput) {
  const dag = buildTaskDag(dagInput || []);
  const nodes = asArray(dag.nodes);

  return {
    status: dag.status,
    issues: dag.issues || [],
    total: nodes.length,
    by_status: nodes.reduce((summary, node) => {
      summary[node.status] = (summary[node.status] || 0) + 1;
      return summary;
    }, {}),
    dispatchable: getDispatchableNodes(dag).map((node) => ({
      id: node.id,
      title: node.title,
      action: node.action,
      depends_on: node.depends_on
    }))
  };
}

function summarizeManifest(manifest) {
  const validation = validateRunManifest(manifest);
  return {
    run_id: manifest?.run_id || null,
    cycle_id: manifest?.cycle_id || null,
    goal: manifest?.goal || null,
    status: validation.status,
    issues: validation.issues || [],
    work_package_count: asArray(manifest?.work_packages).length,
    event_count: asArray(manifest?.events).length
  };
}

function summarizeOperatorEvents(application = null, ledger = null) {
  if (!ledger) {
    return {
      status: "not_configured",
      event_count: 0,
      applied_run_events: 0,
      applied_artifacts: 0,
      skipped_run_events: 0,
      skipped_artifacts: 0,
      issues: []
    };
  }

  return {
    status: application?.status || "fail",
    event_count: asArray(ledger?.events).length,
    applied_run_events: asArray(application?.applied_run_events).length,
    applied_artifacts: asArray(application?.applied_artifacts).length,
    skipped_run_events: asArray(application?.skipped_run_event_ids).length,
    skipped_artifacts: asArray(application?.skipped_artifact_ids).length,
    issues: application?.issues || []
  };
}

function summarizeCloseoutEvidence(manifest = {}, artifactLedger = {}) {
  const events = asArray(manifest?.events).filter((event) => event?.type === "closeout_snapshot_publish");
  const latestEvent = events.at(-1) || null;
  if (!latestEvent) {
    return {
      status: "not_configured",
      publish_status: null,
      event_id: null,
      artifact_id: null,
      snapshot_id: null,
      path: null,
      uri: null,
      created_at: null,
      issues: []
    };
  }

  const artifacts = [
    ...asArray(artifactLedger?.artifacts),
    ...asArray(manifest?.artifacts)
  ];
  const artifact = artifacts.find((entry) => entry.id === latestEvent.artifact_id) || null;

  return {
    status: artifact?.status || "unknown",
    publish_status: latestEvent.status || artifact?.metadata?.closeout_status || null,
    event_id: latestEvent.id || null,
    artifact_id: latestEvent.artifact_id || artifact?.id || null,
    snapshot_id: latestEvent.snapshot_id || artifact?.metadata?.snapshot_id || null,
    path: artifact?.path || null,
    uri: artifact?.uri || null,
    created_at: latestEvent.created_at || artifact?.created_at || null,
    issues: artifact?.metadata?.issues || latestEvent.metadata?.issues || []
  };
}

function summarizeResumeHealth(manifest = {}, artifactLedger = {}) {
  const events = asArray(manifest?.events).filter((event) => event?.type === "autonomous_loop_replay_validation");
  const latestEvent = events.at(-1) || null;
  if (!latestEvent) {
    return {
      status: "not_configured",
      replay_status: null,
      event_id: null,
      artifact_id: null,
      issue_count: 0,
      latest_issue: null,
      created_at: null,
      issues: []
    };
  }

  const artifacts = [
    ...asArray(artifactLedger?.artifacts),
    ...asArray(manifest?.artifacts)
  ];
  const artifact = artifacts.find((entry) => entry.id === latestEvent.artifact_id) || null;
  const issues = asArray(artifact?.metadata?.issues || latestEvent.metadata?.issues);
  const status = latestEvent.status === "blocked" || artifact?.status === "fail"
    ? "blocked"
    : artifact?.status || latestEvent.status || "unknown";

  return {
    status,
    replay_status: artifact?.metadata?.replay_status || latestEvent.metadata?.replay_status || null,
    event_id: latestEvent.id || null,
    artifact_id: latestEvent.artifact_id || artifact?.id || null,
    issue_count: issues.length,
    latest_issue: issues[0]?.message || issues[0]?.code || null,
    created_at: latestEvent.created_at || artifact?.created_at || null,
    issues
  };
}

function summarizeReviewerProviderHealth(manifest = {}, artifactLedger = {}) {
  const events = asArray(manifest?.events).filter((event) => event?.type === "reviewer_provider_health");
  const latestEvent = events.at(-1) || null;
  if (!latestEvent) {
    return {
      status: "not_configured",
      provider_health: "unknown",
      retry_strategy: null,
      next_action: null,
      provider: null,
      model: null,
      event_id: null,
      artifact_id: null,
      created_at: null
    };
  }

  const artifacts = [
    ...asArray(artifactLedger?.artifacts),
    ...asArray(manifest?.artifacts)
  ];
  const artifact = artifacts.find((entry) => entry.id === latestEvent.artifact_id) || null;
  const metadata = artifact?.metadata || latestEvent.metadata || {};
  const scheduledActions = asArray(metadata.scheduled_actions);

  return {
    status: latestEvent.status || metadata.recovery_status || "unknown",
    provider_health: metadata.provider_health || "unknown",
    retry_strategy: metadata.retry_strategy || null,
    next_action: scheduledActions[0] || null,
    provider: metadata.provider || null,
    model: metadata.model || null,
    event_id: latestEvent.id || null,
    artifact_id: latestEvent.artifact_id || artifact?.id || null,
    created_at: latestEvent.created_at || artifact?.created_at || null
  };
}

function summarizeReviewerScopeSplit(manifest = {}, artifactLedger = {}) {
  const events = asArray(manifest?.events).filter((event) => event?.type === "reviewer_scope_split");
  const latestEvent = events.at(-1) || null;
  if (!latestEvent) {
    return {
      status: "not_configured",
      shard_count: 0,
      pending_shards: 0,
      next_shard: null,
      split_required: false,
      provider: null,
      model: null,
      event_id: null,
      artifact_id: null,
      created_at: null
    };
  }

  const artifacts = [
    ...asArray(artifactLedger?.artifacts),
    ...asArray(manifest?.artifacts)
  ];
  const artifact = artifacts.find((entry) => entry.id === latestEvent.artifact_id) || null;
  const metadata = artifact?.metadata || latestEvent.metadata || {};
  const shards = asArray(metadata.shards);
  const pendingShards = shards.filter((shard) => {
    const status = normalizeString(shard?.status).toLowerCase();
    return status !== "completed" && status !== "pass";
  });

  return {
    status: latestEvent.status || metadata.status || "unknown",
    shard_count: metadata.shard_count || shards.length,
    pending_shards: metadata.pending_shards || pendingShards.length,
    next_shard: pendingShards[0]?.id || null,
    split_required: Boolean(metadata.split_required),
    provider: metadata.provider || null,
    model: metadata.model || null,
    event_id: latestEvent.id || null,
    artifact_id: latestEvent.artifact_id || artifact?.id || null,
    created_at: latestEvent.created_at || artifact?.created_at || null
  };
}

function summarizeReviewerShardReview(manifest = {}, artifactLedger = {}) {
  const split = summarizeReviewerScopeSplit(manifest, artifactLedger);
  const resultEvents = asArray(manifest?.events).filter((event) => event?.type === "reviewer_shard_result");
  const aggregateEvents = asArray(manifest?.events).filter((event) => event?.type === "reviewer_shard_aggregate");
  const latestAggregate = aggregateEvents.at(-1) || null;
  const artifacts = [
    ...asArray(artifactLedger?.artifacts),
    ...asArray(manifest?.artifacts)
  ];
  const aggregateArtifact = latestAggregate
    ? artifacts.find((entry) => entry.id === latestAggregate.artifact_id) || null
    : null;
  const aggregate = aggregateArtifact?.metadata || latestAggregate?.metadata || null;

  if (!aggregate && resultEvents.length === 0) {
    return {
      status: "not_configured",
      total_shards: split.shard_count || 0,
      completed_shards: 0,
      pending_shards: split.pending_shards || split.shard_count || 0,
      failed_finding_count: 0,
      finding_count: 0,
      next_shard: split.next_shard || null,
      event_id: null,
      artifact_id: null,
      created_at: null
    };
  }

  const completedIds = new Set(resultEvents.map((event) => normalizeString(event?.metadata?.shard_id)).filter(Boolean));
  const pendingFromSplit = Math.max(0, (split.shard_count || 0) - completedIds.size);

  return {
    status: aggregate?.status || (pendingFromSplit > 0 ? "pending" : "pass"),
    total_shards: aggregate?.total_shards || split.shard_count || completedIds.size,
    completed_shards: aggregate?.completed_shards || completedIds.size,
    pending_shards: aggregate?.pending_shards ?? pendingFromSplit,
    failed_finding_count: aggregate?.failed_finding_count || 0,
    finding_count: aggregate?.finding_count || 0,
    next_shard: aggregate?.pending_shard_ids?.[0] || (pendingFromSplit > 0 ? split.next_shard : null),
    event_id: latestAggregate?.id || null,
    artifact_id: latestAggregate?.artifact_id || aggregateArtifact?.id || null,
    created_at: latestAggregate?.created_at || aggregateArtifact?.created_at || null
  };
}

function summarizeSchedulerDispatch(manifest = {}, artifactLedger = {}) {
  const events = asArray(manifest?.events).filter((event) => event?.type === "scheduler_dispatch_run");
  const latestEvent = events.at(-1) || null;
  const policyEvents = asArray(manifest?.events).filter((event) => event?.type === "scheduler_dispatch_policy");
  const latestPolicyEvent = policyEvents.at(-1) || null;
  const artifacts = [
    ...asArray(artifactLedger?.artifacts),
    ...asArray(manifest?.artifacts)
  ];
  const policyArtifact = latestPolicyEvent
    ? artifacts.find((entry) => entry.id === latestPolicyEvent.artifact_id) || null
    : null;
  const policyMetadata = policyArtifact?.metadata || latestPolicyEvent?.metadata || {};
  const policyIssues = asArray(policyMetadata.issues);
  const policySummary = {
    policy_status: latestPolicyEvent?.status || policyMetadata.status || null,
    policy_execution_mode: policyMetadata.execution_mode || null,
    policy_issue_count: policyIssues.length,
    policy_latest_issue: policyIssues[0]?.message || policyIssues[0]?.code || null,
    policy_artifact_id: latestPolicyEvent?.artifact_id || policyArtifact?.id || null
  };

  if (!latestEvent) {
    if (latestPolicyEvent) {
      return {
        status: policySummary.policy_status === "fail" ? "blocked" : "policy_pass",
        phase: "policy",
        step_count: 0,
        failed_step_count: 0,
        dry_run: policySummary.policy_execution_mode === "dry_run",
        event_id: null,
        artifact_id: null,
        created_at: latestPolicyEvent.created_at || policyArtifact?.created_at || null,
        ...policySummary
      };
    }

    return {
      status: "not_configured",
      phase: null,
      step_count: 0,
      failed_step_count: 0,
      dry_run: false,
      event_id: null,
      artifact_id: null,
      created_at: null,
      ...policySummary
    };
  }

  const artifact = artifacts.find((entry) => entry.id === latestEvent.artifact_id) || null;
  const metadata = artifact?.metadata || latestEvent.metadata || {};
  const steps = asArray(metadata.result?.steps || metadata.steps);
  const closeoutLoop = steps.find((step) => normalizeString(step?.id) === "run-autonomous-closeout-loop")
    ?.outputs?.autonomous_closeout_loop_artifact || {};

  return {
    status: latestEvent.status || metadata.status || "unknown",
    phase: metadata.phase || metadata.result?.phase || null,
    step_count: steps.length,
    failed_step_count: steps.filter((step) => step?.status === "fail").length,
    dry_run: steps.length > 0 && steps.every((step) => step?.dry_run === true),
    event_id: latestEvent.id || null,
    artifact_id: latestEvent.artifact_id || artifact?.id || null,
    created_at: latestEvent.created_at || artifact?.created_at || null,
    next_continuation_status: closeoutLoop.next_decision_status || null,
    next_continuation_action: closeoutLoop.next_decision_action || null,
    next_work_package_count: closeoutLoop.next_work_package_count || 0,
    closeout_loop_phase: closeoutLoop.phase || null,
    ...policySummary
  };
}

function summarizeSchedulerDispatchContinuation(manifest = {}, artifactLedger = {}) {
  const events = asArray(manifest?.events).filter((event) => event?.type === "scheduler_dispatch_continuation");
  const latestEvent = events.at(-1) || null;
  const enqueueEvents = asArray(manifest?.events).filter((event) => event?.type === "scheduler_next_cycle_enqueue");
  const latestEnqueueEvent = enqueueEvents.at(-1) || null;
  const artifacts = [
    ...asArray(artifactLedger?.artifacts),
    ...asArray(manifest?.artifacts)
  ];
  const artifact = latestEvent
    ? artifacts.find((entry) => entry.id === latestEvent.artifact_id) || null
    : null;
  const enqueueArtifact = latestEnqueueEvent
    ? artifacts.find((entry) => entry.id === latestEnqueueEvent.artifact_id) || null
    : null;
  const metadata = artifact?.metadata || latestEvent?.metadata || {};
  const enqueueMetadata = enqueueArtifact?.metadata || latestEnqueueEvent?.metadata || {};
  const issues = asArray(metadata.issues);

  if (!latestEvent && !latestEnqueueEvent) {
    return {
      status: "not_configured",
      continuation_status: null,
      ready: false,
      enqueue_status: null,
      enqueue_available: false,
      continuation_input_path: null,
      source_artifact_id: null,
      artifact_id: null,
      enqueue_artifact_id: null,
      next_work_package_count: 0,
      next_step: null,
      latest_issue: null,
      created_at: null
    };
  }

  return {
    status: latestEnqueueEvent?.status || latestEvent?.status || metadata.status || "unknown",
    continuation_status: metadata.status || latestEvent?.status || null,
    ready: latestEvent?.status === "ready" || metadata.status === "ready",
    enqueue_status: latestEnqueueEvent?.status || enqueueMetadata.status || null,
    enqueue_available: latestEvent?.status === "ready" || metadata.status === "ready",
    continuation_input_path: enqueueMetadata.continuation_input_path || metadata.continuation_input_path || null,
    source_artifact_id: metadata.source_artifact_id || enqueueMetadata.source_artifact_id || null,
    artifact_id: latestEvent?.artifact_id || artifact?.id || null,
    enqueue_artifact_id: latestEnqueueEvent?.artifact_id || enqueueArtifact?.id || null,
    next_work_package_count: enqueueMetadata.next_work_package_count ?? metadata.next_work_package_count ?? 0,
    next_step: enqueueMetadata.next_step || metadata.next_step || null,
    latest_issue: issues[0]?.message || issues[0]?.code || null,
    created_at: latestEnqueueEvent?.created_at || enqueueArtifact?.created_at || latestEvent?.created_at || artifact?.created_at || null
  };
}

function summarizeAutonomousSchedulerLoop(manifest = {}, artifactLedger = {}) {
  const registry = buildSchedulerLoopRunRegistry({
    manifest,
    artifact_ledger: artifactLedger
  });
  const recovery = evaluateSchedulerLoopRecovery(registry);
  const resumeAttempt = summarizeSchedulerLoopResumeAttempt(manifest, artifactLedger);
  const latest = registry.latest || null;
  if (!latest) {
    return {
      status: "not_configured",
      phase: null,
      artifact_id: null,
      run_count: 0,
      invalid_count: 0,
      iteration_count: 0,
      latest_iteration_status: null,
      latest_projection_id: null,
      recovery_status: recovery.status,
      recovery_action: recovery.action,
      resumable: false,
      resume_projection_id: null,
      latest_resume_status: resumeAttempt.status,
      latest_resume_target: resumeAttempt.resume_projection_id,
      latest_resume_issue: resumeAttempt.latest_issue,
      issue_count: 0,
      latest_issue: null,
      created_at: null
    };
  }

  return {
    status: latest.status,
    phase: latest.phase,
    artifact_id: latest.artifact_id,
    run_count: registry.total_runs,
    invalid_count: registry.invalid_count,
    iteration_count: latest.iteration_count,
    latest_iteration_status: latest.latest_iteration_status,
    latest_projection_id: latest.latest_projection_id,
    recovery_status: recovery.status,
    recovery_action: recovery.action,
    resumable: recovery.resumable,
    resume_projection_id: recovery.resume_projection_id,
    latest_resume_status: resumeAttempt.status,
    latest_resume_target: resumeAttempt.resume_projection_id,
    latest_resume_issue: resumeAttempt.latest_issue,
    issue_count: latest.issue_count,
    latest_issue: latest.latest_issue,
    created_at: latest.created_at
  };
}

function summarizeSchedulerLoopResumeAttempt(manifest = {}, artifactLedger = {}) {
  const events = asArray(manifest?.events).filter((event) => event?.type === "scheduler_loop_resume_attempt");
  const latestEvent = events.at(-1) || null;
  if (!latestEvent) {
    return {
      status: "not_configured",
      artifact_id: null,
      resume_projection_id: null,
      recovery_status: null,
      recovery_action: null,
      loop_status: null,
      loop_phase: null,
      latest_issue: null,
      issue_count: 0,
      created_at: null
    };
  }

  const artifacts = [
    ...asArray(artifactLedger?.artifacts),
    ...asArray(manifest?.artifacts)
  ];
  const artifact = artifacts.find((entry) => entry.id === latestEvent.artifact_id) || null;
  const metadata = artifact?.metadata || latestEvent.metadata || {};
  const issues = asArray(metadata.issues);

  return {
    status: latestEvent.status || metadata.status || "unknown",
    artifact_id: latestEvent.artifact_id || artifact?.id || null,
    resume_projection_id: metadata.resume_projection_id || null,
    recovery_status: metadata.recovery_status || null,
    recovery_action: metadata.recovery_action || null,
    loop_status: metadata.loop_status || null,
    loop_phase: metadata.loop_phase || null,
    latest_issue: issues[0]?.message || issues[0]?.code || null,
    issue_count: issues.length,
    created_at: latestEvent.created_at || artifact?.created_at || null
  };
}

const OPERATION_EVENT_TYPES = new Set([
  "scheduler_dispatch_policy",
  "scheduler_dispatch_run",
  "scheduler_dispatch_continuation",
  "scheduler_next_cycle_enqueue",
  "autonomous_scheduler_loop_run",
  "scheduler_loop_resume_attempt",
  "reviewer_provider_health",
  "reviewer_scope_split",
  "reviewer_shard_result",
  "reviewer_shard_aggregate"
]);

function operationSummary(type, metadata = {}) {
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
  return metadata.status || "recorded";
}

function operationGroup(type) {
  if (String(type || "").startsWith("reviewer_")) return "reviewer_recovery";
  return "scheduler";
}

function operationNextActionRole(type, metadata = {}) {
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
  if (type === "reviewer_provider_health" || type === "reviewer_scope_split" || type === "reviewer_shard_aggregate") {
    return "automation_driver";
  }
  return "operator_observable";
}

function summarizeOperationsTimeline(manifest = {}, artifactLedger = {}) {
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

function createNextActionReadout(operationsTimeline = {}, summaries = {}) {
  const driver = operationsTimeline.latest_driver || null;
  if (!driver) {
    return {
      status: "not_configured",
      action: "wait_for_driver_event",
      source_event_id: null,
      source_type: null,
      target_projection_id: null,
      reason: "no automation driver event is available",
      requires_operator: false
    };
  }

  if (driver.type === "scheduler_dispatch_continuation") {
    return {
      status: "ready",
      action: "enqueue_scheduler_next_cycle",
      source_event_id: driver.event_id,
      source_type: driver.type,
      target_projection_id: null,
      reason: driver.summary,
      requires_operator: false
    };
  }
  if (driver.type === "scheduler_next_cycle_enqueue") {
    return {
      status: "ready",
      action: "run_autonomous_scheduler_loop",
      source_event_id: driver.event_id,
      source_type: driver.type,
      target_projection_id: null,
      reason: driver.summary,
      requires_operator: false
    };
  }
  if (driver.type === "autonomous_scheduler_loop_run") {
    const loop = summaries.schedulerLoop || {};
    return {
      status: loop.recovery_status === "ready" ? "ready" : loop.recovery_status || "ready",
      action: loop.recovery_status === "ready" ? "resume_autonomous_scheduler_loop" : "inspect_scheduler_loop",
      source_event_id: driver.event_id,
      source_type: driver.type,
      target_projection_id: loop.resume_projection_id || loop.latest_projection_id || null,
      reason: driver.summary,
      requires_operator: false
    };
  }
  if (driver.type === "scheduler_loop_resume_attempt") {
    return {
      status: "ready",
      action: "inspect_resume_target",
      source_event_id: driver.event_id,
      source_type: driver.type,
      target_projection_id: summaries.schedulerLoop?.latest_resume_target || null,
      reason: driver.summary,
      requires_operator: false
    };
  }
  if (driver.type === "reviewer_provider_health") {
    return {
      status: "ready",
      action: summaries.reviewerProviderHealth?.next_action || "run_reviewer_recovery",
      source_event_id: driver.event_id,
      source_type: driver.type,
      target_projection_id: null,
      reason: driver.summary,
      requires_operator: false
    };
  }
  if (driver.type === "reviewer_scope_split") {
    return {
      status: "ready",
      action: "run_reviewer_scope_shard",
      source_event_id: driver.event_id,
      source_type: driver.type,
      target_projection_id: null,
      reason: driver.summary,
      requires_operator: false
    };
  }
  if (driver.type === "reviewer_shard_aggregate") {
    return {
      status: "ready",
      action: "continue_after_reviewer_aggregate",
      source_event_id: driver.event_id,
      source_type: driver.type,
      target_projection_id: null,
      reason: driver.summary,
      requires_operator: false
    };
  }

  return {
    status: "pending",
    action: "inspect_latest_driver",
    source_event_id: driver.event_id,
    source_type: driver.type,
    target_projection_id: null,
    reason: driver.summary,
    requires_operator: false
  };
}

export function validateWorkbenchProjectionInput(input = {}) {
  const issues = [];

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      status: "fail",
      issues: [issue("invalid_projection_input", "workbench projection input must be an object", "")]
    };
  }

  if (!input.manifest) {
    issues.push(issue("missing_manifest", "manifest is required", "manifest"));
  }

  if (!input.artifact_ledger && !input.artifactLedger) {
    issues.push(issue("missing_artifact_ledger", "artifact ledger is required", "artifact_ledger"));
  }

  if (!input.model_plan && !input.modelPlan) {
    issues.push(issue("missing_model_plan", "model routing plan is required", "model_plan"));
  }

  return {
    status: issues.length ? "fail" : "pass",
    issues
  };
}

export function createWorkbenchProjection(input = {}) {
  const inputValidation = validateWorkbenchProjectionInput(input);
  const operatorEventLedger = input.operator_event_ledger || input.operatorEventLedger || null;
  const baseManifest = input.manifest || null;
  const baseArtifactLedger = input.artifact_ledger || input.artifactLedger || {};
  const operatorApplication = operatorEventLedger
    ? applyOperatorEventsToWorkflowState({
      manifest: baseManifest,
      artifact_ledger: baseArtifactLedger,
      operator_event_ledger: operatorEventLedger
    })
    : null;
  const manifest = operatorApplication?.status === "pass" ? operatorApplication.manifest : baseManifest;
  const artifactLedger = operatorApplication?.status === "pass" ? operatorApplication.artifact_ledger : baseArtifactLedger;
  const modelPlan = input.model_plan || input.modelPlan || {};
  const reviewerGate = input.reviewer_gate || input.reviewerGate || {};
  const dagInput = input.task_dag || input.taskDag || manifest?.work_packages || [];
  const manifestRunResult = manifest ? buildRunResultFromManifest(manifest) : {};
  const derivedRunResult = {
    ...manifestRunResult,
    artifacts: asArray(artifactLedger?.artifacts).map((artifact) => ({
      id: artifact.id,
      status: artifact.status,
      type: artifact.type,
      producer: artifact.producer
    }))
  };
  const runResult = operatorEventLedger ? derivedRunResult : (input.run_result || input.runResult || derivedRunResult);
  const runEvaluation = operatorEventLedger ? evaluateRunResult(runResult) : (input.run_evaluation || input.runEvaluation || evaluateRunResult(runResult));
  const manifestSummary = manifest ? summarizeManifest(manifest) : { status: "fail", issues: [] };
  const artifactSummary = summarizeArtifactLedger(artifactLedger);
  const closeoutSummary = summarizeCloseoutEvidence(manifest, artifactLedger);
  const resumeHealth = summarizeResumeHealth(manifest, artifactLedger);
  const reviewerProviderHealth = summarizeReviewerProviderHealth(manifest, artifactLedger);
  const reviewerScopeSplit = summarizeReviewerScopeSplit(manifest, artifactLedger);
  const reviewerShardReview = summarizeReviewerShardReview(manifest, artifactLedger);
  const schedulerDispatch = summarizeSchedulerDispatch(manifest, artifactLedger);
  const schedulerContinuation = summarizeSchedulerDispatchContinuation(manifest, artifactLedger);
  const schedulerLoop = summarizeAutonomousSchedulerLoop(manifest, artifactLedger);
  const operationsTimeline = summarizeOperationsTimeline(manifest, artifactLedger);
  const nextActionReadout = createNextActionReadout(operationsTimeline, {
    schedulerLoop,
    reviewerProviderHealth
  });
  const modelSummary = summarizeModelRouting(modelPlan);
  const reviewerSummary = summarizeReviewerGate(reviewerGate);
  const dagSummary = summarizeDag(dagInput);
  const operatorEventSummary = summarizeOperatorEvents(operatorApplication, operatorEventLedger);
  const status = maxStatus([
    inputValidation.status === "pass" ? "pass" : "human_intervention",
    manifestSummary.status === "pass" ? "pass" : "human_intervention",
    operatorEventSummary.status === "fail" ? "human_intervention" : "pass",
    runEvaluation.status,
    reviewerSummary.recommended_decision_signal || reviewerSummary.status,
    dagSummary.status === "pass" ? "pass" : "human_intervention"
  ]);

  return {
    projection_version: "workbench.v1",
    generated_at: normalizeString(input.generated_at) || new Date().toISOString(),
    run_id: manifest?.run_id || runEvaluation.run_id || null,
    cycle_id: manifest?.cycle_id || runEvaluation.cycle_id || null,
    goal: manifest?.goal || normalizeString(input.goal) || null,
    status,
    decision: runEvaluation.decision || runEvaluation.status,
    reasons: runEvaluation.reasons || [],
    blockers: runEvaluation.projection?.blockers || [],
    input_validation: inputValidation,
    manifest: manifestSummary,
    operator_events: operatorEventSummary,
    artifacts: artifactSummary,
    closeout: closeoutSummary,
    resume_health: resumeHealth,
    reviewer_provider_health: reviewerProviderHealth,
    reviewer_scope_split: reviewerScopeSplit,
    reviewer_shard_review: reviewerShardReview,
    scheduler_dispatch: schedulerDispatch,
    scheduler_continuation: schedulerContinuation,
    scheduler_loop: schedulerLoop,
    operations_timeline: operationsTimeline,
    next_action_readout: nextActionReadout,
    model_routing: modelSummary,
    reviewer_gate: reviewerSummary,
    autonomous_run: runEvaluation.projection || runEvaluation,
    task_dag: dagSummary,
    one_screen: {
      headline: manifest?.goal || normalizeString(input.goal) || "Autonomous run",
      primary_status: status,
      next_actions: [
        ...asArray(runEvaluation.next_work_packages).map((workPackage) => ({
          id: workPackage.id,
          action: workPackage.action || runEvaluation.decision,
          title: workPackage.title || workPackage.reason || workPackage.id
        })),
        ...dagSummary.dispatchable.map((node) => ({
          id: node.id,
          action: node.action || "dispatch",
          title: node.title
        }))
      ],
      counters: {
        work_packages: manifestSummary.work_package_count,
        artifacts: artifactSummary.total,
        reviewer_findings: reviewerSummary.counts?.total || 0,
        dispatchable_tasks: dagSummary.dispatchable.length,
        closeout_publishes: closeoutSummary.status === "not_configured" ? 0 : 1,
        resume_blockers: resumeHealth.status === "blocked" ? resumeHealth.issue_count || 1 : 0,
        provider_health_events: reviewerProviderHealth.status === "not_configured" ? 0 : 1,
        reviewer_scope_shards: reviewerScopeSplit.shard_count || 0,
        reviewer_shards_completed: reviewerShardReview.completed_shards || 0,
        scheduler_dispatch_steps: schedulerDispatch.step_count || 0,
        scheduler_continuation_ready: schedulerContinuation.ready ? 1 : 0,
        scheduler_loop_iterations: schedulerLoop.iteration_count || 0,
        operation_events: operationsTimeline.count || 0
      },
      recommended_action: nextActionReadout.action
    }
  };
}

export function createMobileWorkbenchProjection(input = {}) {
  const projection = createWorkbenchProjection(input);

  return {
    projection_version: "workbench.mobile.v1",
    run_id: projection.run_id,
    cycle_id: projection.cycle_id,
    status: projection.status,
    decision: projection.decision,
    headline: projection.one_screen.headline,
    counters: projection.one_screen.counters,
    next_actions: projection.one_screen.next_actions.slice(0, 3),
    blockers: projection.blockers.slice(0, 3),
    closeout: {
      status: projection.closeout.status,
      publish_status: projection.closeout.publish_status,
      artifact_id: projection.closeout.artifact_id,
      snapshot_id: projection.closeout.snapshot_id
    },
    resume_health: {
      status: projection.resume_health.status,
      replay_status: projection.resume_health.replay_status,
      artifact_id: projection.resume_health.artifact_id,
      issue_count: projection.resume_health.issue_count,
      latest_issue: projection.resume_health.latest_issue
    },
    provider_health: {
      status: projection.reviewer_provider_health.status,
      provider_health: projection.reviewer_provider_health.provider_health,
      retry_strategy: projection.reviewer_provider_health.retry_strategy,
      next_action: projection.reviewer_provider_health.next_action
    },
    scope_split: {
      status: projection.reviewer_scope_split.status,
      shard_count: projection.reviewer_scope_split.shard_count,
      pending_shards: projection.reviewer_scope_split.pending_shards,
      next_shard: projection.reviewer_scope_split.next_shard
    },
    shard_review: {
      status: projection.reviewer_shard_review.status,
      total_shards: projection.reviewer_shard_review.total_shards,
      completed_shards: projection.reviewer_shard_review.completed_shards,
      pending_shards: projection.reviewer_shard_review.pending_shards,
      failed_finding_count: projection.reviewer_shard_review.failed_finding_count
    },
    scheduler_dispatch: {
      status: projection.scheduler_dispatch.status,
      phase: projection.scheduler_dispatch.phase,
      step_count: projection.scheduler_dispatch.step_count,
      failed_step_count: projection.scheduler_dispatch.failed_step_count,
      dry_run: projection.scheduler_dispatch.dry_run,
      policy_status: projection.scheduler_dispatch.policy_status,
      policy_execution_mode: projection.scheduler_dispatch.policy_execution_mode,
      policy_issue_count: projection.scheduler_dispatch.policy_issue_count,
      policy_latest_issue: projection.scheduler_dispatch.policy_latest_issue,
      next_continuation_status: projection.scheduler_dispatch.next_continuation_status,
      next_continuation_action: projection.scheduler_dispatch.next_continuation_action,
      next_work_package_count: projection.scheduler_dispatch.next_work_package_count
    },
    scheduler_continuation: {
      status: projection.scheduler_continuation.status,
      continuation_status: projection.scheduler_continuation.continuation_status,
      ready: projection.scheduler_continuation.ready,
      enqueue_status: projection.scheduler_continuation.enqueue_status,
      enqueue_available: projection.scheduler_continuation.enqueue_available,
      next_work_package_count: projection.scheduler_continuation.next_work_package_count
    },
    scheduler_loop: {
      status: projection.scheduler_loop.status,
      phase: projection.scheduler_loop.phase,
      run_count: projection.scheduler_loop.run_count,
      invalid_count: projection.scheduler_loop.invalid_count,
      iteration_count: projection.scheduler_loop.iteration_count,
      latest_iteration_status: projection.scheduler_loop.latest_iteration_status,
      latest_projection_id: projection.scheduler_loop.latest_projection_id,
      recovery_status: projection.scheduler_loop.recovery_status,
      recovery_action: projection.scheduler_loop.recovery_action,
      resumable: projection.scheduler_loop.resumable,
      resume_projection_id: projection.scheduler_loop.resume_projection_id,
      latest_resume_status: projection.scheduler_loop.latest_resume_status,
      latest_resume_target: projection.scheduler_loop.latest_resume_target
    },
    operations_timeline: {
      status: projection.operations_timeline.status,
      count: projection.operations_timeline.count,
      group_counts: projection.operations_timeline.group_counts,
      driver_count: projection.operations_timeline.driver_count,
      operator_only_count: projection.operations_timeline.operator_only_count,
      latest_driver: projection.operations_timeline.latest_driver,
      latest: projection.operations_timeline.latest,
      items: projection.operations_timeline.items.slice(-5)
    },
    next_action_readout: {
      status: projection.next_action_readout.status,
      action: projection.next_action_readout.action,
      source_type: projection.next_action_readout.source_type,
      target_projection_id: projection.next_action_readout.target_projection_id,
      requires_operator: projection.next_action_readout.requires_operator
    },
    model: {
      selected_model: projection.model_routing.selected_model,
      has_independent_reviewer: projection.model_routing.has_independent_reviewer
    },
    reviewer: {
      status: projection.reviewer_gate.status,
      max_severity: projection.reviewer_gate.max_severity,
      recommended_decision_signal: projection.reviewer_gate.recommended_decision_signal
    }
  };
}

export {
  summarizeCloseoutEvidence,
  summarizeResumeHealth,
  summarizeReviewerProviderHealth,
  summarizeReviewerScopeSplit,
  summarizeReviewerShardReview,
  summarizeSchedulerDispatchContinuation,
  summarizeAutonomousSchedulerLoop,
  summarizeSchedulerLoopResumeAttempt,
  summarizeOperationsTimeline,
  createNextActionReadout,
  summarizeSchedulerDispatch
};
