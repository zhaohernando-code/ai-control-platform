// Scheduler dispatch / loop summarizers, extracted from workbench-projection.js
// (P2-8 god-file split #3). Each turns a run manifest + artifact ledger into a scheduler
// projection sub-summary. Depends only on local array/string normalization plus the
// scheduler-loop registry/recovery helpers.

import { buildSchedulerLoopRunRegistry, evaluateSchedulerLoopRecovery } from "./autonomous-scheduler-loop.js";

function asArray(value) {
  return Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : value === null || value === undefined ? "" : String(value).trim();
}

export function summarizeSchedulerDispatch(manifest = {}, artifactLedger = {}) {
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

export function summarizeSchedulerDispatchContinuation(manifest = {}, artifactLedger = {}) {
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

export function summarizeAutonomousSchedulerLoop(manifest = {}, artifactLedger = {}) {
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
      execution_strategy: null,
      execution_profile: null,
      latest_resume_status: resumeAttempt.status,
      latest_resume_target: resumeAttempt.resume_projection_id,
      latest_resume_issue: resumeAttempt.latest_issue,
      terminal_action: null,
      terminal_reason: null,
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
    execution_strategy: latest.execution_strategy,
    execution_profile: latest.execution_profile,
    latest_resume_status: resumeAttempt.status,
    latest_resume_target: resumeAttempt.resume_projection_id,
    latest_resume_issue: resumeAttempt.latest_issue,
    terminal_action: latest.terminal_action,
    terminal_reason: latest.terminal_reason,
    issue_count: latest.issue_count,
    latest_issue: latest.latest_issue || latest.terminal_reason,
    created_at: latest.created_at
  };
}

export function summarizeSchedulerLoopResumeAttempt(manifest = {}, artifactLedger = {}) {
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
