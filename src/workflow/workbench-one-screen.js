function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

export function createWorkbenchOneScreenProjection({
  manifest = null,
  input = {},
  status = "fail",
  runEvaluation = {},
  manifestSummary = {},
  artifactSummary = {},
  reviewerSummary = {},
  dagSummary = {},
  closeoutSummary = {},
  browserEventsSummary = {},
  frontendAcceptance = {},
  governanceAudit = {},
  resumeHealth = {},
  reviewerProviderHealth = {},
  reviewerScopeSplit = {},
  reviewerShardReview = {},
  headlessChildProvider = {},
  projectedActionProgress = {},
  schedulerDispatch = {},
  schedulerContinuation = {},
  schedulerLoop = {},
  agentLifecyclePool = {},
  agentKeyHealth = {},
  selfGovernance = {},
  projectManagement = {},
  globalGoalCompletion = {},
  operationsTimeline = {},
  nextActionReadout = {}
} = {}) {
  return {
    headline: manifest?.goal || normalizeString(input.goal) || "Autonomous run",
    primary_status: status,
    next_actions: [
      ...asArray(frontendAcceptance.repair_work_package ? [frontendAcceptance.repair_work_package] : []).map((workPackage) => ({
        id: workPackage.id,
        action: workPackage.action,
        title: workPackage.title
      })),
      ...asArray(governanceAudit.repair_work_package ? [governanceAudit.repair_work_package] : []).map((workPackage) => ({
        id: workPackage.id,
        action: workPackage.action,
        title: workPackage.title
      })),
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
      browser_event_scenarios: browserEventsSummary.scenario_count || 0,
      frontend_acceptance_blockers: frontendAcceptance.blocking_count || 0,
      governance_audit_blockers: governanceAudit.blocking_count || 0,
      resume_blockers: resumeHealth.status === "blocked" ? resumeHealth.issue_count || 1 : 0,
      provider_health_events: reviewerProviderHealth.status === "not_configured" ? 0 : 1,
      reviewer_scope_shards: reviewerScopeSplit.shard_count || 0,
      reviewer_shards_completed: reviewerShardReview.completed_shards || 0,
      headless_child_attempts: headlessChildProvider.attempt_count || 0,
      headless_child_retry_attempts: headlessChildProvider.retry_attempt_count || 0,
      projected_action_progress_events: projectedActionProgress.status === "not_configured" ? 0 : 1,
      scheduler_dispatch_steps: schedulerDispatch.step_count || 0,
      scheduler_continuation_ready: schedulerContinuation.ready ? 1 : 0,
      scheduler_loop_iterations: schedulerLoop.iteration_count || 0,
      agent_lifecycle_open: agentLifecyclePool.open || 0,
      agent_lifecycle_unevaluated: agentLifecyclePool.unevaluated || 0,
      agent_lifecycle_unclosed: agentLifecyclePool.unclosed || 0,
      agent_lifecycle_timed_out: agentLifecyclePool.timed_out || 0,
      agent_lifecycle_heartbeats: agentLifecyclePool.heartbeat_count || 0,
      agent_lifecycle_completed: agentLifecyclePool.completed || 0,
      agent_lifecycle_evaluated: agentLifecyclePool.evaluated || 0,
      agent_lifecycle_closed: agentLifecyclePool.closed || 0,
      agent_key_total: agentKeyHealth.key_count || 0,
      agent_key_available: agentKeyHealth.available_key_count || 0,
      self_governance_findings: selfGovernance.finding_count || 0,
      self_governance_auto_repairs: selfGovernance.auto_repair_count || 0,
      self_governance_evidence_tasks: selfGovernance.evidence_building_count || 0,
      self_governance_user_decisions: selfGovernance.user_decision_count || 0,
      projects_total: projectManagement.projects_total || 0,
      active_projects: projectManagement.active_projects || 0,
      tasks_total: projectManagement.tasks_total || 0,
      active_tasks: projectManagement.active_tasks || 0,
      released_services: projectManagement.released_services || 0,
      human_decisions: projectManagement.human_decisions || 0,
      global_goals_total: globalGoalCompletion.total || 0,
      global_goals_pending: globalGoalCompletion.pending || 0,
      global_goals_completed: globalGoalCompletion.completed || 0,
      global_goals_blocked: globalGoalCompletion.blocked || 0,
      operation_events: operationsTimeline.count || 0
    },
    recommended_action: nextActionReadout.action
  };
}
