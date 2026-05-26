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
import { evaluateGlobalGoalCompletion } from "./global-goal-completion.js";
import { summarizeAgentLifecyclePool } from "./agent-lifecycle-pool.js";
import {
  FRONTEND_ACCEPTANCE_REPAIR_ACTION,
  summarizeFrontendAcceptance
} from "./frontend-acceptance.js";
import { createSelfGovernanceReport, summarizeSelfGovernance } from "./self-governance.js";
import { summarizeRequirementIntake } from "./requirement-intake.js";

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

function taskFlowFromDag(dagSummary = {}) {
  const total = Number(dagSummary.total || 0);
  const done = Number(dagSummary.by_status?.done || dagSummary.by_status?.completed || 0);
  const dispatchable = asArray(dagSummary.dispatchable).length;
  const inProgress = Math.max(0, total - done - dispatchable);

  return [
    { id: "requirements", label: "需求", status: total > 0 ? "pass" : "pending", count: total },
    { id: "breakdown", label: "拆解", status: total > 0 ? "pass" : "pending", count: total },
    { id: "subtasks", label: "子任务", status: dispatchable > 0 || inProgress > 0 ? "active" : done > 0 ? "pass" : "pending", count: total },
    { id: "review", label: "Review", status: done > 0 ? "active" : "pending", count: done },
    { id: "release", label: "发布", status: "pending", count: 0 },
    { id: "live_validation", label: "Live 验证", status: "pending", count: 0 },
    { id: "acceptance", label: "验收", status: done === total && total > 0 ? "active" : "pending", count: done }
  ];
}

function projectStatusPhase(status = "", schedulerDispatch = {}, frontendAcceptance = {}) {
  const normalized = normalizeString(status);
  if (normalizeString(schedulerDispatch.status) === "fail") return "调度修复";
  if (normalizeString(frontendAcceptance.status) === "fail") return "界面验收修复";
  if (normalized === "in_progress") return "持续开发";
  if (normalized === "completed" || normalized === "complete") return "收口验证";
  return "状态确认";
}

function summarizePlanReview(projectStatus = {}, requirementIntake = {}) {
  const latest = requirementIntake?.latest || null;
  if (!latest) {
    return {
      status: "not_configured",
      status_label: "暂无需要评估的需求",
      summary: "提交需求后，平台会先让大模型生成评估方案和验收方案，再由你审核。",
      requirement_id: null,
      requirement_title: null,
      plan_id: null,
      phase: "idle",
      phase_label: "等待评估",
      next_action: "提交需求即可进入评估",
      assessment_summary: null,
      proposed_acceptance_plan: null,
      reviewable: false,
      action_status: "等待方案生成",
      origin: "workbench_requirement_intake"
    };
  }
  const requirementTitle = normalizeString(latest.title) || null;
  const planReviewRecord = (projectStatus?.plan_reviews && projectStatus.plan_reviews[latest.id]) || null;
  const phase = normalizeString(planReviewRecord?.phase) || "pending_plan_generation";
  const failureReason = normalizeString(planReviewRecord?.generation_error?.message || planReviewRecord?.failure_reason);
  const reviewable = phase === "ready_for_review";
  const phaseLabelMap = {
    pending_plan_generation: "等待大模型生成方案",
    plan_generation_failed: "方案生成失败",
    ready_for_review: "方案待你审核",
    in_development: "开发中",
    revising: "方案退回修订",
    idle: "等待评估"
  };
  const statusLabel = reviewable
    ? "方案待审核"
    : phase === "in_development"
      ? "开发中"
      : phase === "revising"
        ? "方案已退回"
        : phase === "plan_generation_failed"
          ? "方案生成失败"
          : "评估进行中";
  const storedNextAction = normalizeString(planReviewRecord?.next_action);
  const nextAction = phase === "in_development"
    ? "开发已开始"
    : storedNextAction || (reviewable
    ? "请审核大模型生成的评估方案与验收方案"
    : phase === "revising"
        ? "等待方案修订后重新审核"
        : phase === "plan_generation_failed"
          ? "方案生成失败，请重试生成或检查模型入口"
        : "等待大模型完成评估方案与验收方案");
  const storedActionStatus = normalizeString(planReviewRecord?.action_status);
  const actionStatus = phase === "in_development"
    ? "开发中"
    : storedActionStatus || (reviewable ? "等待你确认方案" : phase === "plan_generation_failed" ? "方案生成失败" : "等待方案生成");
  return {
    status: "available",
    status_label: statusLabel,
    summary: requirementTitle
      ? `当前评估：${requirementTitle}。大模型会基于现状与目标生成评估摘要与验收方案，再由你审核。`
      : "提交需求后，平台会让大模型生成评估方案与验收方案，再由你审核。",
    requirement_id: latest.id || null,
    requirement_title: requirementTitle,
    plan_id: normalizeString(planReviewRecord?.plan_id) || null,
    phase,
    phase_label: phaseLabelMap[phase] || phase,
    next_action: nextAction,
    assessment_summary: normalizeString(planReviewRecord?.assessment_summary) ||
      (phase === "plan_generation_failed" && failureReason ? `生成失败：${failureReason}` : null),
    proposed_acceptance_plan: normalizeString(planReviewRecord?.proposed_acceptance_plan) || null,
    reviewable,
    action_status: actionStatus,
    failure_reason: failureReason || null,
    generation_error: planReviewRecord?.generation_error || null,
    generation_issues: asArray(planReviewRecord?.generation_issues),
    origin: "workbench_requirement_intake"
  };
}

function summarizeProjectManagement(input = {}, summaries = {}) {
  const projectStatus = input.project_status || input.projectStatus || {};
  const dagSummary = summaries.dagSummary || {};
  const manifestSummary = summaries.manifestSummary || {};
  const globalGoalCompletion = summaries.globalGoalCompletion || {};
  const schedulerDispatch = summaries.schedulerDispatch || {};
  const frontendAcceptance = summaries.frontendAcceptance || {};
  const nextActionReadout = summaries.nextActionReadout || {};
  const requirementIntake = summarizeRequirementIntake(projectStatus);
  const planReview = summarizePlanReview(projectStatus, requirementIntake);
  const taskFlow = taskFlowFromDag(dagSummary);
  const latestRequirement = requirementIntake.latest || null;
  const currentTask = normalizeString(
    latestRequirement?.summary ||
    nextActionReadout.reason ||
      nextActionReadout.action ||
      projectStatus.next_step ||
      projectStatus.latest_update ||
      manifestSummary.goal
  ) || "等待下一步任务";
  const activeTasks = Math.max(
    Number(dagSummary.total || 0) - Number(dagSummary.by_status?.done || dagSummary.by_status?.completed || 0),
    asArray(dagSummary.dispatchable).length
  );
  const progress = Number(globalGoalCompletion.total || 0) > 0
    ? Math.round((Number(globalGoalCompletion.completed || 0) / Number(globalGoalCompletion.total || 1)) * 100)
    : 0;
  const project = {
    project_id: normalizeString(projectStatus.project) || "ai-control-platform",
    display_name: "AI Control Platform",
    type: "platform",
    status: normalizeString(projectStatus.status) || "in_progress",
    phase: projectStatusPhase(projectStatus.status || "in_progress", schedulerDispatch, frontendAcceptance),
    current_task: currentTask,
    owner_agent: "main_orchestrator",
    progress,
    last_updated: normalizeString(projectStatus.updated_at) || normalizeString(input.generated_at) || "等待更新时间",
    risks: [
      normalizeString(schedulerDispatch.status) === "fail" ? "调度派发未通过" : null,
      Number(globalGoalCompletion.blocked || 0) > 0 ? "总目标存在阻塞" : null
    ].filter(Boolean),
    human_decisions: 0,
    latest_run_projection_id: input.projection_id || input.projectionId || null,
    task_flow: taskFlow
  };

  return {
    status: "available",
    source: "project_status_and_workflow_projection",
    projects_total: 1,
    active_projects: project.status === "completed" ? 0 : 1,
    tasks_total: Number(dagSummary.total || manifestSummary.work_package_count || 0),
    active_tasks: activeTasks,
    released_services: 0,
    human_decisions: 0,
    projects: [project],
    active_work: [project],
    task_flow: taskFlow,
    requirement_intake: requirementIntake,
    plan_review: planReview,
    design_alignment: {
      status: "partial",
      homepage_primary_surface: "project_management",
      diagnostics_surface: "run_diagnostics",
      required_project_id: "ai-control-platform"
    }
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

function summarizeWorkbenchBrowserEvents(manifest = {}, artifactLedger = {}) {
  const events = asArray(manifest?.events).filter((event) => event?.type === "workbench_browser_events_run");
  const latestEvent = events.at(-1) || null;
  if (!latestEvent) {
    return {
      status: "not_configured",
      artifact_id: null,
      scenario_count: 0,
      partial_shard_ready: false,
      latest_scenario: null,
      overflow_count: 0,
      created_at: null
    };
  }

  const artifacts = [
    ...asArray(artifactLedger?.artifacts),
    ...asArray(manifest?.artifacts)
  ];
  const artifact = artifacts.find((entry) => entry.id === latestEvent.artifact_id) || null;
  const metadata = artifact?.metadata || latestEvent.metadata || {};
  const scenarios = asArray(metadata.scenarios);
  const partialReadout = scenarios.find((scenario) => scenario?.scenario === "projected_real_partial_shard_readout") || {};
  const overflowCount = scenarios.filter((scenario) => {
    const dimensions = scenario?.dimensions || {};
    return Number(dimensions.scrollWidth || 0) > Number(dimensions.width || 0);
  }).length;

  return {
    status: artifact?.status || latestEvent.status || metadata.status || "unknown",
    artifact_id: latestEvent.artifact_id || artifact?.id || null,
    scenario_count: Number(metadata.scenario_count || scenarios.length || 0),
    partial_shard_ready: partialReadout.shard_review_next === "reviewer-scope-shard-002" &&
      partialReadout.next_action_readout === "run_reviewer_scope_shard",
    latest_scenario: scenarios.at(-1)?.scenario || null,
    overflow_count: overflowCount,
    created_at: latestEvent.created_at || artifact?.created_at || metadata.created_at || null
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
    shard_ids: shards.map((shard) => normalizeString(shard?.id)).filter(Boolean),
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
  const latestResult = resultEvents.at(-1) || null;
  const latestAggregate = aggregateEvents.at(-1) || null;
  const artifacts = [
    ...asArray(artifactLedger?.artifacts),
    ...asArray(manifest?.artifacts)
  ];
  const resultArtifact = latestResult
    ? artifacts.find((entry) => entry.id === latestResult.artifact_id) || null
    : null;
  const resultMetadata = resultArtifact?.metadata || latestResult?.metadata || {};
  const provenance = resultMetadata.executor_provenance || {};
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
      latest_executor_kind: null,
      latest_execution_profile: null,
      latest_provider: null,
      latest_model: null,
      latest_external_call_budget_used: 0,
      event_id: null,
      artifact_id: null,
      created_at: null
    };
  }

  const completedIds = new Set(resultEvents.map((event) => normalizeString(event?.metadata?.shard_id)).filter(Boolean));
  const pendingFromSplit = Math.max(0, (split.shard_count || 0) - completedIds.size);
  const pendingShardIds = asArray(split.shard_ids).filter((id) => !completedIds.has(normalizeString(id)));

  return {
    status: aggregate?.status || (pendingFromSplit > 0 ? "pending" : "pass"),
    total_shards: aggregate?.total_shards || split.shard_count || completedIds.size,
    completed_shards: aggregate?.completed_shards || completedIds.size,
    pending_shards: aggregate?.pending_shards ?? pendingFromSplit,
    failed_finding_count: aggregate?.failed_finding_count || 0,
    finding_count: aggregate?.finding_count || 0,
    next_shard: aggregate?.pending_shard_ids?.[0] || pendingShardIds[0] || (pendingFromSplit > 0 ? split.next_shard : null),
    latest_executor_kind: provenance.executor_kind || null,
    latest_execution_profile: provenance.execution_profile || null,
    latest_provider: provenance.provider || resultMetadata.provider || null,
    latest_model: provenance.model || resultMetadata.model || null,
    latest_external_call_budget_used: provenance.external_call_budget_used ?? 0,
    event_id: latestAggregate?.id || null,
    artifact_id: latestAggregate?.artifact_id || aggregateArtifact?.id || null,
    created_at: latestAggregate?.created_at || aggregateArtifact?.created_at || null
  };
}

function summarizeHeadlessChildProvider(manifest = {}, artifactLedger = {}) {
  const events = asArray(manifest?.events).filter((event) => event?.type === "context_work_packages_run");
  const latestEvent = events.at(-1) || null;
  if (!latestEvent) {
    return {
      status: "not_configured",
      provider: null,
      model: null,
      command_runner_kind: null,
      executor_kind: null,
      mock_child_worker: false,
      max_attempts: 0,
      split_retry: false,
      package_count: 0,
      accepted_count: 0,
      rejected_count: 0,
      attempt_count: 0,
      retry_attempt_count: 0,
      split_retry_attempt_count: 0,
      latest_attempt_status: null,
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
  const provenance = metadata.executor_provenance || {};
  const retryPolicy = provenance.retry_policy || {};
  const packageResults = asArray(metadata.package_results);
  const attempts = packageResults.flatMap((result) => (
    asArray(result?.completion_evidence?.child_output?.command_evidence?.attempts)
      .map((attempt) => ({ ...attempt, work_package_id: result.work_package_id || result.workPackageId || null }))
  ));
  const explicitMockChildWorker = packageResults.some((result) => {
    const childOutput = result?.completion_evidence?.child_output || {};
    return childOutput.mock_allowed === true ||
      childOutput.command_evidence?.mock_allowed === true ||
      childOutput.completion_evidence?.mock_allowed === true;
  });

  return {
    status: latestEvent.status || metadata.status || artifact?.status || "unknown",
    provider: provenance.provider || null,
    model: provenance.model || null,
    command_runner_kind: provenance.command_runner_kind || null,
    executor_kind: provenance.executor_kind || null,
    mock_child_worker: explicitMockChildWorker ||
      provenance.mock_child_worker === true ||
      provenance.mockChildWorker === true ||
      normalizeString(provenance.command_runner_kind || provenance.commandRunnerKind) === "mock_child_worker",
    max_attempts: Number(retryPolicy.max_attempts || retryPolicy.maxAttempts || 0),
    split_retry: retryPolicy.split_retry === true || retryPolicy.splitRetry === true,
    package_count: packageResults.length,
    accepted_count: packageResults.filter((result) => result?.status === "pass").length,
    rejected_count: packageResults.filter((result) => result?.status && result.status !== "pass").length,
    attempt_count: attempts.length,
    retry_attempt_count: attempts.filter((attempt) => Number(attempt?.attempt || 0) > 1).length,
    split_retry_attempt_count: attempts.filter((attempt) => attempt?.split_retry === true).length,
    latest_attempt_status: attempts.at(-1)?.status || null,
    event_id: latestEvent.id || null,
    artifact_id: latestEvent.artifact_id || artifact?.id || null,
    created_at: latestEvent.created_at || artifact?.created_at || null
  };
}

function summarizeHeadlessProjectedActionProgress(manifest = {}, artifactLedger = {}) {
  const events = asArray(manifest?.events).filter((event) => event?.type === "headless_projected_action_progress");
  const latestEvent = events.at(-1) || null;
  if (!latestEvent) {
    return {
      status: "not_configured",
      action: null,
      next_projection_id: null,
      has_workflow_state: false,
      has_projection: false,
      issue_count: 0,
      latest_issue: null,
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
  const issues = asArray(metadata.issues);

  return {
    status: metadata.status || latestEvent.status || artifact?.status || "unknown",
    action: metadata.action || null,
    next_projection_id: metadata.next_projection_id || null,
    has_workflow_state: metadata.has_workflow_state === true,
    has_projection: metadata.has_projection === true,
    issue_count: issues.length,
    latest_issue: issues[0]?.message || issues[0]?.code || null,
    event_id: latestEvent.id || null,
    artifact_id: latestEvent.artifact_id || artifact?.id || null,
    created_at: latestEvent.created_at || artifact?.created_at || null
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

const AGENT_LIFECYCLE_EVENT_TYPES = new Set([
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
  if (type === "reviewer_provider_health" || type === "reviewer_scope_split" || type === "reviewer_shard_aggregate") {
    return "automation_driver";
  }
  if (AGENT_LIFECYCLE_EVENT_TYPES.has(type)) {
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

function planReviewBlocksRequirementEvent(planReview = {}, event = {}) {
  const reviewRequirementId = normalizeString(planReview.requirement_id || planReview.requirementId);
  const eventRequirementId = normalizeString(event.requirement_id || event.requirementId);
  const phase = normalizeString(planReview.phase);
  return Boolean(
    (planReview.reviewable || phase === "pending_plan_generation" || phase === "plan_generation_failed") &&
      reviewRequirementId &&
      eventRequirementId &&
      reviewRequirementId === eventRequirementId
  );
}

function createNextActionReadout(operationsTimeline = {}, summaries = {}) {
  const lifecyclePool = summaries.agentLifecyclePool || {};
  const projectStatus = summaries.projectStatus || {};
  const globalGoals = summaries.globalGoalCompletion || {};
  const taskDag = summaries.taskDag || {};
  const frontendAcceptance = summaries.frontendAcceptance || {};
  if (lifecyclePool.next_action === "cleanup_agent_lifecycle_pool") {
    return {
      status: lifecyclePool.status === "blocked" ? "blocked" : "ready",
      action: "cleanup_agent_lifecycle_pool",
      source_event_id: lifecyclePool.event_id || null,
      source_type: "agent_lifecycle_pool",
      target_projection_id: null,
      reason: lifecyclePool.latest_issue || `agent lifecycle pool requires cleanup: open=${lifecyclePool.open || 0}, unevaluated=${lifecyclePool.unevaluated || 0}, unclosed=${lifecyclePool.unclosed || 0}`,
      requires_operator: false
    };
  }

  const pendingPlanReview = summaries.projectManagement?.plan_review || {};
  const matchingRequirementEvent = asArray(operationsTimeline.items)
    .find((item) => item.type === "requirement_intake_submitted" && planReviewBlocksRequirementEvent(pendingPlanReview, item));
  if (pendingPlanReview.phase === "plan_generation_failed") {
    return {
      status: "blocked",
      action: "retry_requirement_plan_generation",
      source_event_id: matchingRequirementEvent?.event_id || null,
      source_type: "plan_review",
      target_projection_id: null,
      reason: pendingPlanReview.failure_reason || pendingPlanReview.next_action || "requirement plan generation failed",
      requires_operator: false
    };
  }
  if (pendingPlanReview.phase === "pending_plan_generation") {
    return {
      status: "blocked",
      action: "generate_requirement_plan",
      source_event_id: matchingRequirementEvent?.event_id || null,
      source_type: "plan_review",
      target_projection_id: null,
      reason: pendingPlanReview.next_action || "requirement plan must be generated by a model before development can continue",
      requires_operator: false
    };
  }
  if (pendingPlanReview.reviewable) {
    return {
      status: "blocked",
      action: "review_requirement_plan",
      source_event_id: matchingRequirementEvent?.event_id || null,
      source_type: "plan_review",
      target_projection_id: null,
      reason: pendingPlanReview.next_action || "requirement plan requires operator review before development can continue",
      requires_operator: true
    };
  }

  const driver = operationsTimeline.latest_driver || null;
  const latest = operationsTimeline.latest || null;
  if (latest && (!driver || Number(latest.sequence || 0) > Number(driver.sequence || 0))) {
    const latestReadout = nextActionReadoutFromLatestOperatorFact(latest, summaries);
    if (latestReadout) return latestReadout;
  }
  if (!driver) {
    if (Number(globalGoals.pending || 0) > 0 && globalGoals.status === "in_progress") {
      return {
        status: "ready",
        action: "prepare_project_status_continuation",
        source_event_id: null,
        source_type: "global_goal_completion",
        target_projection_id: null,
        reason: globalGoals.next_goal?.next_step || globalGoals.next_goal?.title || "repository global goals remain pending",
        requires_operator: false
      };
    }
    if (
      globalGoals.status === "complete" &&
      Number(globalGoals.pending || 0) === 0 &&
      Number(taskDag.dispatchable?.length || 0) === 0 &&
      !normalizeString(projectStatus.next_step || projectStatus.nextStep)
    ) {
      return {
        status: "complete",
        action: "no_next_action",
        source_event_id: null,
        source_type: "global_goal_completion",
        target_projection_id: null,
        reason: "all global goals are complete and no continuation remains",
        requires_operator: false
      };
    }
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

  if (driver.type === "requirement_intake_submitted") {
    const planReview = summaries.projectManagement?.plan_review || {};
    if (planReview.phase === "plan_generation_failed") {
      return {
        status: "blocked",
        action: "retry_requirement_plan_generation",
        source_event_id: driver.event_id,
        source_type: "plan_review",
        target_projection_id: null,
        reason: planReview.failure_reason || planReview.next_action || "requirement plan generation failed",
        requires_operator: false
      };
    }
    if (planReview.phase === "pending_plan_generation") {
      return {
        status: "blocked",
        action: "generate_requirement_plan",
        source_event_id: driver.event_id,
        source_type: "plan_review",
        target_projection_id: null,
        reason: planReview.next_action || "requirement plan must be generated by a model before development can continue",
        requires_operator: false
      };
    }
    if (planReviewBlocksRequirementEvent(planReview, driver)) {
      return {
        status: "blocked",
        action: "review_requirement_plan",
        source_event_id: driver.event_id,
        source_type: "plan_review",
        target_projection_id: null,
        reason: planReview.next_action || "requirement plan requires operator review before development can continue",
        requires_operator: true
      };
    }
    return {
      status: "ready",
      action: "prepare_project_status_continuation",
      source_event_id: driver.event_id,
      source_type: driver.type,
      target_projection_id: null,
      reason: driver.summary || normalizeString(projectStatus.next_step || projectStatus.nextStep),
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
    const shardReview = summaries.reviewerShardReview || {};
    if (loop.phase === "no_dispatchable_scheduler_actions") {
      return {
        status: "idle",
        action: "wait_for_new_work",
        source_event_id: driver.event_id,
        source_type: driver.type,
        target_projection_id: loop.latest_projection_id || null,
        reason: "scheduler loop found no dispatchable actions",
        requires_operator: false
      };
    }
    if (
      loop.execution_strategy === "projected_next_action" &&
      loop.phase === "iteration_limit_reached" &&
      Number(shardReview.pending_shards || 0) > 0
    ) {
      return {
        status: "ready",
        action: "run_reviewer_scope_shard",
        source_event_id: driver.event_id,
        source_type: driver.type,
        target_projection_id: null,
        reason: `${driver.summary}; reviewer shard ${shardReview.next_shard || "next"} remains pending`,
        requires_operator: false
      };
    }
    const reason = loop.terminal_reason || loop.latest_issue || driver.summary;
    return {
      status: loop.recovery_status === "ready" ? "ready" : loop.recovery_status || "ready",
      action: loop.recovery_status === "ready" ? "resume_autonomous_scheduler_loop" : "inspect_scheduler_loop",
      source_event_id: driver.event_id,
      source_type: driver.type,
      target_projection_id: loop.resume_projection_id || loop.latest_projection_id || null,
      reason,
      requires_operator: false
    };
  }
  if (driver.type === "scheduler_loop_resume_attempt") {
    const loop = summaries.schedulerLoop || {};
    if (loop.phase === "no_dispatchable_scheduler_actions" || summaries.schedulerLoop?.latest_resume_status === "pass") {
      return {
        status: "idle",
        action: "wait_for_new_work",
        source_event_id: driver.event_id,
        source_type: driver.type,
        target_projection_id: loop.latest_resume_target || null,
        reason: "scheduler loop resume completed; wait for new dispatchable work",
        requires_operator: false
      };
    }
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
  if (driver.type === "frontend_acceptance_run" && frontendAcceptance.repair_required) {
    return {
      status: "ready",
      action: FRONTEND_ACCEPTANCE_REPAIR_ACTION,
      source_event_id: driver.event_id || frontendAcceptance.event_id || null,
      source_type: driver.type,
      target_projection_id: null,
      reason: frontendAcceptance.repair_work_package?.reason || driver.summary,
      requires_operator: false
    };
  }
  if (AGENT_LIFECYCLE_EVENT_TYPES.has(driver.type)) {
    if (
      lifecyclePool.status === "pass" &&
      !lifecyclePool.next_action &&
      Number(taskDag.dispatchable?.length || 0) > 0
    ) {
      return {
        status: "ready",
        action: "run_context_work_packages",
        source_event_id: driver.event_id,
        source_type: driver.type,
        target_projection_id: null,
        reason: "closed agent lifecycle pool still has dispatchable context work packages",
        requires_operator: false
      };
    }
    if (
      lifecyclePool.status === "pass" &&
      !lifecyclePool.next_action &&
      globalGoals.status === "in_progress" &&
      Number(globalGoals.pending || 0) > 0
    ) {
      return {
        status: "ready",
        action: "prepare_project_status_continuation",
        source_event_id: driver.event_id,
        source_type: driver.type,
        target_projection_id: null,
        reason: globalGoals.next_goal?.next_step || globalGoals.next_goal?.title || driver.summary,
        requires_operator: false
      };
    }
    if (
      lifecyclePool.status === "pass" &&
      !lifecyclePool.next_action &&
      normalizeString(projectStatus.next_step || projectStatus.nextStep)
    ) {
      return {
        status: "ready",
        action: "prepare_project_status_continuation",
        source_event_id: driver.event_id,
        source_type: driver.type,
        target_projection_id: null,
        reason: normalizeString(projectStatus.next_step || projectStatus.nextStep),
        requires_operator: false
      };
    }
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

function nextActionTerminalInfoFromReadout(readout = {}) {
  if (!readout || typeof readout !== "object") {
    return { terminal_action: null, terminal_reason: null };
  }
  if (readout.status === "ready") {
    return { terminal_action: null, terminal_reason: null };
  }
  return {
    terminal_action: readout.action || null,
    terminal_reason: readout.reason || null
  };
}

function nextActionReadoutFromLatestOperatorFact(latest = {}, summaries = {}) {
  const projectStatus = summaries.projectStatus || {};
  if (latest?.type === "requirement_intake_submitted") {
    const planReview = summaries.projectManagement?.plan_review || {};
    if (planReview.phase === "plan_generation_failed") {
      return {
        status: "blocked",
        action: "retry_requirement_plan_generation",
        source_event_id: latest.event_id,
        source_type: "plan_review",
        target_projection_id: null,
        reason: planReview.failure_reason || planReview.next_action || "requirement plan generation failed",
        requires_operator: false
      };
    }
    if (planReviewBlocksRequirementEvent(planReview, latest)) {
      return {
        status: "blocked",
        action: "review_requirement_plan",
        source_event_id: latest.event_id,
        source_type: "plan_review",
        target_projection_id: null,
        reason: planReview.next_action || "requirement plan requires operator review before development can continue",
        requires_operator: true
      };
    }
    return {
      status: "ready",
      action: "prepare_project_status_continuation",
      source_event_id: latest.event_id,
      source_type: latest.type,
      target_projection_id: null,
      reason: latest.summary || normalizeString(projectStatus.next_step || projectStatus.nextStep),
      requires_operator: false
    };
  }
  if (latest?.type === "project_status_continuation") {
    return {
      status: "ready",
      action: "create_context_pack_from_seed",
      source_event_id: latest.event_id,
      source_type: latest.type,
      target_projection_id: null,
      reason: latest.summary,
      requires_operator: false
    };
  }
  if (
    latest?.type === "context_pack_cycle_materialized" ||
    latest?.type === "context_pack_cycle_created" ||
    latest?.type === "context_work_packages_run"
  ) {
    const taskDag = summaries.taskDag || {};
    const globalGoals = summaries.globalGoalCompletion || {};
    if (Number(taskDag.dispatchable?.length || 0) > 0) {
      return {
        status: "ready",
        action: "run_context_work_packages",
        source_event_id: latest.event_id,
        source_type: latest.type,
        target_projection_id: null,
        reason: latest.summary,
        requires_operator: false
      };
    }
    if (globalGoals.status === "in_progress" && Number(globalGoals.pending || 0) > 0) {
      return {
        status: "ready",
        action: "prepare_project_status_continuation",
        source_event_id: latest.event_id,
        source_type: latest.type,
        target_projection_id: null,
        reason: globalGoals.next_goal?.next_step || globalGoals.next_goal?.title || latest.summary,
        requires_operator: false
      };
    }
    if (
      globalGoals.status === "complete" &&
      Number(globalGoals.pending || 0) === 0 &&
      !normalizeString(projectStatus.next_step || projectStatus.nextStep)
    ) {
      return {
        status: "complete",
        action: "no_next_action",
        source_event_id: latest.event_id,
        source_type: latest.type,
        target_projection_id: null,
        reason: "all global goals are complete and context work is exhausted",
        requires_operator: false
      };
    }
    return {
      status: "pending",
      action: "inspect_context_work_packages",
      source_event_id: latest.event_id,
      source_type: latest.type,
      target_projection_id: null,
      reason: latest.summary,
      requires_operator: false
    };
  }
  return null;
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
  const browserEventsSummary = summarizeWorkbenchBrowserEvents(manifest, artifactLedger);
  const frontendAcceptance = summarizeFrontendAcceptance(manifest, artifactLedger);
  const resumeHealth = summarizeResumeHealth(manifest, artifactLedger);
  const reviewerProviderHealth = summarizeReviewerProviderHealth(manifest, artifactLedger);
  const reviewerScopeSplit = summarizeReviewerScopeSplit(manifest, artifactLedger);
  const reviewerShardReview = summarizeReviewerShardReview(manifest, artifactLedger);
  const headlessChildProvider = summarizeHeadlessChildProvider(manifest, artifactLedger);
  const projectedActionProgress = summarizeHeadlessProjectedActionProgress(manifest, artifactLedger);
  const schedulerDispatch = summarizeSchedulerDispatch(manifest, artifactLedger);
  const schedulerContinuation = summarizeSchedulerDispatchContinuation(manifest, artifactLedger);
  const schedulerLoop = summarizeAutonomousSchedulerLoop(manifest, artifactLedger);
  const agentLifecyclePool = summarizeAgentLifecyclePool(manifest, artifactLedger);
  const selfGovernanceReport = createSelfGovernanceReport({
    ...input,
    generate_findings: true,
    governance_sources: {
      project_status: input.project_status || input.projectStatus || {},
      frontend_acceptance: frontendAcceptance,
      workbench_browser_events: browserEventsSummary,
      scheduler_dispatch: schedulerDispatch,
      scheduler_continuation: schedulerContinuation,
      scheduler_loop: schedulerLoop,
      reviewer_provider_health: reviewerProviderHealth,
      reviewer_shard_review: reviewerShardReview,
      closeout: closeoutSummary
    },
    workflow_state: input.workflow_state || input.workflowState || { manifest, artifact_ledger: artifactLedger }
  });
  const selfGovernance = summarizeSelfGovernance(selfGovernanceReport);
  const globalGoalCompletion = evaluateGlobalGoalCompletion(input);
  const operationsTimeline = summarizeOperationsTimeline(manifest, artifactLedger);
  const modelSummary = summarizeModelRouting(modelPlan);
  const reviewerSummary = summarizeReviewerGate(reviewerGate);
  const dagSummary = summarizeDag(dagInput);
  const projectManagementBase = summarizeProjectManagement(input, {
    dagSummary,
    manifestSummary,
    globalGoalCompletion,
    schedulerDispatch,
    frontendAcceptance
  });
  const nextActionReadout = createNextActionReadout(operationsTimeline, {
    schedulerLoop,
    reviewerProviderHealth,
    reviewerShardReview,
    agentLifecyclePool,
    frontendAcceptance,
    globalGoalCompletion,
    taskDag: dagSummary,
    projectStatus: input.project_status || input.projectStatus || {},
    projectManagement: projectManagementBase
  });
  const projectManagement = summarizeProjectManagement(input, {
    dagSummary,
    manifestSummary,
    globalGoalCompletion,
    schedulerDispatch,
    frontendAcceptance,
    nextActionReadout
  });
  const operatorEventSummary = summarizeOperatorEvents(operatorApplication, operatorEventLedger);
  const status = maxStatus([
    inputValidation.status === "pass" ? "pass" : "human_intervention",
    manifestSummary.status === "pass" ? "pass" : "human_intervention",
    operatorEventSummary.status === "fail" ? "human_intervention" : "pass",
    runEvaluation.status,
    reviewerSummary.recommended_decision_signal || reviewerSummary.status,
    dagSummary.status === "pass" ? "pass" : "human_intervention"
  ]);
  const nextActionTerminal = nextActionTerminalInfoFromReadout(nextActionReadout);

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
    workbench_browser_events: browserEventsSummary,
    frontend_acceptance: frontendAcceptance,
    resume_health: resumeHealth,
    reviewer_provider_health: reviewerProviderHealth,
    reviewer_scope_split: reviewerScopeSplit,
    reviewer_shard_review: reviewerShardReview,
    headless_child_provider: headlessChildProvider,
    projected_action_progress: projectedActionProgress,
    scheduler_dispatch: schedulerDispatch,
    scheduler_continuation: schedulerContinuation,
    scheduler_loop: schedulerLoop,
    agent_lifecycle_pool: agentLifecyclePool,
    self_governance: {
      ...selfGovernance,
      report_status: selfGovernanceReport.status,
      auto_repair_work_packages: selfGovernanceReport.auto_repair.work_packages.slice(0, 5),
      evidence_work_packages: selfGovernanceReport.evidence_building.work_packages.slice(0, 5),
      decision_packages: selfGovernanceReport.user_decisions.packages.slice(0, 5)
    },
    project_management: projectManagement,
    global_goal_completion: globalGoalCompletion,
    operations_timeline: operationsTimeline,
    next_action_readout: nextActionReadout,
    next_action_terminal: {
      status: nextActionReadout.status,
      terminal_action: nextActionTerminal.terminal_action,
      terminal_reason: nextActionTerminal.terminal_reason
    },
    model_routing: modelSummary,
    reviewer_gate: reviewerSummary,
    autonomous_run: runEvaluation.projection || runEvaluation,
    task_dag: dagSummary,
    one_screen: {
      headline: manifest?.goal || normalizeString(input.goal) || "Autonomous run",
      primary_status: status,
      next_actions: [
        ...asArray(frontendAcceptance.repair_work_package ? [frontendAcceptance.repair_work_package] : []).map((workPackage) => ({
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

export {
  summarizeCloseoutEvidence,
  summarizeWorkbenchBrowserEvents,
  summarizeFrontendAcceptance,
  summarizeResumeHealth,
  summarizeReviewerProviderHealth,
  summarizeReviewerScopeSplit,
  summarizeReviewerShardReview,
  summarizeHeadlessChildProvider,
  summarizeHeadlessProjectedActionProgress,
  summarizeSchedulerDispatchContinuation,
  summarizeAutonomousSchedulerLoop,
  summarizeSchedulerLoopResumeAttempt,
  summarizeAgentLifecyclePool,
  summarizeOperationsTimeline,
  createNextActionReadout,
  summarizeSchedulerDispatch
};
