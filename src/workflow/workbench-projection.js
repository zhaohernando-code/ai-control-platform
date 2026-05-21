import { evaluateRunResult } from "./autonomous-run.js";
import { summarizeArtifactLedger } from "./artifact-ledger.js";
import { buildRunResultFromManifest, validateRunManifest } from "./run-manifest.js";
import { summarizeReviewerGate } from "./llm-reviewer-gate.js";
import { summarizeModelRouting } from "./model-router.js";
import { applyOperatorEventsToWorkflowState } from "./operator-events.js";
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
        resume_blockers: resumeHealth.status === "blocked" ? resumeHealth.issue_count || 1 : 0
      }
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

export { summarizeCloseoutEvidence, summarizeResumeHealth };
