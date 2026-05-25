import { runContextWorkPackages } from "./context-work-package-runner.js";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function safeIdPart(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}

function issue(code, message, path) {
  return { code, message, path };
}

function dispatchableRepairPackages(report = {}) {
  return asArray(report.auto_repair?.work_packages)
    .filter((workPackage) => normalizeString(workPackage.governance_action) === "auto_remediate_defect")
    .filter((workPackage) => normalizeString(workPackage.action) === "run_context_work_packages");
}

function workflowStateFromSelfGovernanceReport(report = {}, options = {}) {
  const createdAt = normalizeString(options.created_at || options.createdAt) || new Date().toISOString();
  const runId = normalizeString(options.run_id || options.runId) || `run-self-governance-dispatch-${safeIdPart(createdAt)}`;
  const cycleId = normalizeString(options.cycle_id || options.cycleId) || `cycle-self-governance-dispatch-${safeIdPart(createdAt)}`;
  const repairs = dispatchableRepairPackages(report);
  const workPackages = repairs.map((workPackage) => ({
    id: workPackage.id,
    title: workPackage.title,
    action: workPackage.action,
    owned_files: asArray(workPackage.owned_files),
    acceptance_gates: asArray(workPackage.acceptance_gates),
    source: {
      type: "self_governance_auto_repair",
      governance_action: workPackage.governance_action,
      source_finding_id: workPackage.source_finding_id,
      dimension: workPackage.dimension,
      severity: workPackage.severity,
      reason: workPackage.reason
    }
  }));
  const contextPack = {
    requirement_summary: "Dispatch self-governance auto-repair work packages through the platform context workflow.",
    host: "platform_core",
    target_project_id: "ai-control-platform",
    non_goals: ["Do not hand-edit specific defects outside generated work packages"],
    forbidden_actions: ["Do not bypass context work package runner or completion authority evidence"],
    owned_files: [...new Set(workPackages.flatMap((workPackage) => workPackage.owned_files))],
    acceptance_gates: [...new Set(workPackages.flatMap((workPackage) => workPackage.acceptance_gates))],
    rollback_conditions: ["self-governance dispatch cannot write durable context work package evidence"],
    subtasks: workPackages
  };

  return {
    manifest: {
      run_id: runId,
      cycle_id: cycleId,
      goal: contextPack.requirement_summary,
      context_pack: contextPack,
      work_packages: workPackages,
      events: [],
      artifacts: [],
      gate_results: [],
      review_findings: [],
      recovery_attempts: [],
      created_at: createdAt
    },
    artifact_ledger: {
      run_id: runId,
      cycle_id: cycleId,
      artifacts: []
    },
    task_dag: workPackages
  };
}

export function createSelfGovernanceDispatchPlan(report = {}, options = {}) {
  const repairs = dispatchableRepairPackages(report);
  if (repairs.length === 0) {
    return {
      version: "self-governance-dispatch-plan.v1",
      status: "not_required",
      auto_repair_count: 0,
      work_packages: [],
      issues: []
    };
  }

  return {
    version: "self-governance-dispatch-plan.v1",
    status: "ready",
    auto_repair_count: repairs.length,
    work_packages: repairs,
    workflow_state: workflowStateFromSelfGovernanceReport(report, options),
    issues: []
  };
}

export function dispatchSelfGovernanceAutoRepairs(report = {}, options = {}) {
  const plan = createSelfGovernanceDispatchPlan(report, options);
  if (plan.status !== "ready") {
    return {
      version: "self-governance-dispatch-run.v1",
      status: plan.status,
      phase: "dispatch_plan",
      plan,
      issues: plan.issues || []
    };
  }

  const maxPackageCount = Number(options.max_package_count || options.maxPackageCount || plan.work_packages.length);
  if (!Number.isFinite(maxPackageCount) || maxPackageCount <= 0) {
    return {
      version: "self-governance-dispatch-run.v1",
      status: "blocked",
      phase: "dispatch_policy",
      plan,
      issues: [issue("invalid_self_governance_dispatch_limit", "max_package_count must be positive", "max_package_count")]
    };
  }

  const runnerResult = runContextWorkPackages(plan.workflow_state, {
    ...options,
    max_package_count: maxPackageCount,
    pool_id: normalizeString(options.pool_id || options.poolId) || "self-governance-auto-repair"
  });

  return {
    version: "self-governance-dispatch-run.v1",
    status: runnerResult.status,
    phase: runnerResult.phase,
    plan,
    runner_result: runnerResult,
    started_work_package_count: runnerResult.executed_count || 0,
    started_work_package_ids: asArray(runnerResult.executed_work_packages).map((workPackage) => workPackage.id),
    workflow_state: runnerResult.workflow_state,
    issues: runnerResult.issues || []
  };
}
