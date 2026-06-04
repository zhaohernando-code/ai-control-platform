import { evaluateRunResult } from "./autonomous-run.js";
import { summarizeArtifactLedger } from "./artifact-ledger.js";
import { buildRunResultFromManifest, validateRunManifest } from "./run-manifest.js";
import { summarizeReviewerGate } from "./llm-reviewer-gate.js";
import { summarizeModelRouting } from "./model-router.js";
import { applyOperatorEventsToWorkflowState } from "./operator-events.js";
import {
  summarizeReviewerProviderHealth,
  summarizeReviewerScopeSplit,
  summarizeReviewerShardReview,
  summarizeHeadlessChildProvider,
  summarizeHeadlessProjectedActionProgress
} from "./workbench-reviewer-summaries.js";
import {
  summarizeSchedulerDispatch,
  summarizeSchedulerDispatchContinuation,
  summarizeAutonomousSchedulerLoop,
  summarizeSchedulerLoopResumeAttempt
} from "./workbench-scheduler-summaries.js";
import { buildTaskDag, getDispatchableNodes } from "./task-dag.js";
import { evaluateGlobalGoalCompletion } from "./global-goal-completion.js";
import { summarizeAgentLifecyclePool } from "./agent-lifecycle-pool.js";
import {
  summarizeFrontendAcceptance
} from "./frontend-acceptance.js";
import {
  summarizeGovernanceAuditSkillTrial
} from "./governance-audit-skill-trial.js";
import { createSelfGovernanceReport, summarizeSelfGovernance } from "./self-governance.js";
import { summarizeProjectManagement } from "./workbench-project-management.js";
import { createWorkbenchOneScreenProjection } from "./workbench-one-screen.js";
import {
  createNextActionReadout,
  nextActionTerminalInfoFromReadout
} from "./workbench-next-action-readout.js";
import {
  normalizeAgentKeyHealth,
  summarizeCloseoutEvidence,
  summarizeResumeHealth,
  summarizeWorkbenchBrowserEvents
} from "./workbench-projection-evidence.js";
import {
  AGENT_LIFECYCLE_EVENT_TYPES,
  summarizeOperationsTimeline
} from "./workbench-operations-timeline.js";
import { shapeMobileWorkbenchProjection } from "./workbench-mobile-projection.js";

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

function reviewerGateForManifest(reviewerGate = {}, manifest = {}) {
  const request = reviewerGate?.request || reviewerGate || {};
  const requestRunId = normalizeString(request.run_id || request.runId);
  const requestCycleId = normalizeString(request.cycle_id || request.cycleId);
  const manifestRunId = normalizeString(manifest?.run_id || manifest?.runId);
  const manifestCycleId = normalizeString(manifest?.cycle_id || manifest?.cycleId);

  if (requestRunId && manifestRunId && requestRunId !== manifestRunId) return {};
  if (requestCycleId && manifestCycleId && requestCycleId !== manifestCycleId) return {};
  return reviewerGate || {};
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
  const governanceAudit = summarizeGovernanceAuditSkillTrial(manifest, artifactLedger);
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
  const agentKeyHealth = normalizeAgentKeyHealth(input);
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
  const reviewerSummary = summarizeReviewerGate(reviewerGateForManifest(reviewerGate, manifest));
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
    governanceAudit,
    globalGoalCompletion,
    taskDag: dagSummary,
    agentLifecycleEventTypes: AGENT_LIFECYCLE_EVENT_TYPES,
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
    governance_audit: governanceAudit,
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
    agent_key_health: agentKeyHealth,
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
    one_screen: createWorkbenchOneScreenProjection({
      manifest,
      input,
      status,
      runEvaluation,
      manifestSummary,
      artifactSummary,
      reviewerSummary,
      dagSummary,
      closeoutSummary,
      browserEventsSummary,
      frontendAcceptance,
      governanceAudit,
      resumeHealth,
      reviewerProviderHealth,
      reviewerScopeSplit,
      reviewerShardReview,
      headlessChildProvider,
      projectedActionProgress,
      schedulerDispatch,
      schedulerContinuation,
      schedulerLoop,
      agentLifecyclePool,
      agentKeyHealth,
      selfGovernance,
      projectManagement,
      globalGoalCompletion,
      operationsTimeline,
      nextActionReadout
    })
  };
}

export function createMobileWorkbenchProjection(input = {}) {
  return shapeMobileWorkbenchProjection(createWorkbenchProjection(input));
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
  createWorkbenchOneScreenProjection,
  summarizeSchedulerDispatch
};
