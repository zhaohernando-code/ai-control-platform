export function shapeMobileWorkbenchProjection(projection) {
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
    workbench_browser_events: {
      status: projection.workbench_browser_events.status,
      artifact_id: projection.workbench_browser_events.artifact_id,
      scenario_count: projection.workbench_browser_events.scenario_count,
      partial_shard_ready: projection.workbench_browser_events.partial_shard_ready,
      overflow_count: projection.workbench_browser_events.overflow_count
    },
    frontend_acceptance: {
      status: projection.frontend_acceptance.status,
      artifact_id: projection.frontend_acceptance.artifact_id,
      blocking_count: projection.frontend_acceptance.blocking_count,
      finding_count: projection.frontend_acceptance.finding_count,
      latest_finding: projection.frontend_acceptance.latest_finding,
      desktop_viewports: projection.frontend_acceptance.desktop_viewports,
      mobile_viewports: projection.frontend_acceptance.mobile_viewports,
      repair_required: projection.frontend_acceptance.repair_required,
      repair_work_package_id: projection.frontend_acceptance.repair_work_package?.id || null
    },
    project_management: {
      status: projection.project_management.status,
      projects_total: projection.project_management.projects_total,
      active_projects: projection.project_management.active_projects,
      tasks_total: projection.project_management.tasks_total,
      active_tasks: projection.project_management.active_tasks,
      human_decisions: projection.project_management.human_decisions,
      projects: projection.project_management.projects.slice(0, 5),
      task_items: projection.project_management.task_items.slice(0, 12),
      task_flow: projection.project_management.task_flow
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
      failed_finding_count: projection.reviewer_shard_review.failed_finding_count,
      latest_executor_kind: projection.reviewer_shard_review.latest_executor_kind,
      latest_execution_profile: projection.reviewer_shard_review.latest_execution_profile,
      latest_provider: projection.reviewer_shard_review.latest_provider,
      latest_model: projection.reviewer_shard_review.latest_model,
      latest_external_call_budget_used: projection.reviewer_shard_review.latest_external_call_budget_used
    },
    headless_child_provider: {
      status: projection.headless_child_provider.status,
      provider: projection.headless_child_provider.provider,
      model: projection.headless_child_provider.model,
      command_runner_kind: projection.headless_child_provider.command_runner_kind,
      executor_kind: projection.headless_child_provider.executor_kind,
      mock_child_worker: projection.headless_child_provider.mock_child_worker,
      max_attempts: projection.headless_child_provider.max_attempts,
      split_retry: projection.headless_child_provider.split_retry,
      package_count: projection.headless_child_provider.package_count,
      accepted_count: projection.headless_child_provider.accepted_count,
      rejected_count: projection.headless_child_provider.rejected_count,
      attempt_count: projection.headless_child_provider.attempt_count,
      retry_attempt_count: projection.headless_child_provider.retry_attempt_count,
      split_retry_attempt_count: projection.headless_child_provider.split_retry_attempt_count,
      latest_attempt_status: projection.headless_child_provider.latest_attempt_status
    },
    projected_action_progress: {
      status: projection.projected_action_progress.status,
      action: projection.projected_action_progress.action,
      next_projection_id: projection.projected_action_progress.next_projection_id,
      has_workflow_state: projection.projected_action_progress.has_workflow_state,
      has_projection: projection.projected_action_progress.has_projection,
      issue_count: projection.projected_action_progress.issue_count,
      latest_issue: projection.projected_action_progress.latest_issue
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
      execution_strategy: projection.scheduler_loop.execution_strategy,
      execution_profile: projection.scheduler_loop.execution_profile,
      latest_resume_status: projection.scheduler_loop.latest_resume_status,
      latest_resume_target: projection.scheduler_loop.latest_resume_target
    },
    agent_lifecycle_pool: {
      status: projection.agent_lifecycle_pool.status,
      pool_id: projection.agent_lifecycle_pool.pool_id,
      spawned: projection.agent_lifecycle_pool.spawned,
      completed: projection.agent_lifecycle_pool.completed,
      evaluated: projection.agent_lifecycle_pool.evaluated,
      closed: projection.agent_lifecycle_pool.closed,
      timed_out: projection.agent_lifecycle_pool.timed_out,
      heartbeat_count: projection.agent_lifecycle_pool.heartbeat_count,
      latest_heartbeat_at: projection.agent_lifecycle_pool.latest_heartbeat_at,
      latest_timeout_at: projection.agent_lifecycle_pool.latest_timeout_at,
      timed_out_workers: projection.agent_lifecycle_pool.timed_out_workers,
      open: projection.agent_lifecycle_pool.open,
      unevaluated: projection.agent_lifecycle_pool.unevaluated,
      unclosed: projection.agent_lifecycle_pool.unclosed,
      next_action: projection.agent_lifecycle_pool.next_action,
      latest_issue: projection.agent_lifecycle_pool.latest_issue
    },
    agent_key_health: {
      status: projection.agent_key_health.status,
      agent_count: projection.agent_key_health.agent_count,
      key_count: projection.agent_key_health.key_count,
      available_key_count: projection.agent_key_health.available_key_count,
      last_refresh_at: projection.agent_key_health.last_refresh_at,
      agents: projection.agent_key_health.agents.slice(0, 8)
    },
    self_governance: {
      status: projection.self_governance.status,
      finding_count: projection.self_governance.finding_count,
      dimensions_checked: projection.self_governance.dimensions_checked,
      cadence: projection.self_governance.cadence,
      next_trigger: projection.self_governance.next_trigger,
      role_count: projection.self_governance.role_count,
      auto_repair_count: projection.self_governance.auto_repair_count,
      evidence_building_count: projection.self_governance.evidence_building_count,
      user_decision_count: projection.self_governance.user_decision_count,
      completed_improvement_count: projection.self_governance.completed_improvement_count,
      next_work_package_count: projection.self_governance.next_work_package_count,
      top_dimension: projection.self_governance.top_dimension,
      latest_decision_title: projection.self_governance.latest_decision_title,
      latest_auto_repair_title: projection.self_governance.latest_auto_repair_title,
      latest_evidence_title: projection.self_governance.latest_evidence_title
    },
    global_goal_completion: {
      status: projection.global_goal_completion.status,
      total: projection.global_goal_completion.total,
      completed: projection.global_goal_completion.completed,
      pending: projection.global_goal_completion.pending,
      blocked: projection.global_goal_completion.blocked,
      next_goal: projection.global_goal_completion.next_goal
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
    next_action_terminal: {
      status: projection.next_action_terminal.status,
      terminal_action: projection.next_action_terminal.terminal_action,
      terminal_reason: projection.next_action_terminal.terminal_reason
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
