export const WORK_PACKAGE_EXECUTION_GOVERNANCE_GATE_ID = "work-package-execution-governance";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeToken(value) {
  return normalizeString(value).toLowerCase();
}

function compactStrings(value) {
  return asArray(value).map(normalizeString).filter(Boolean);
}

function issue(code, message, path, metadata = {}) {
  return {
    code,
    message,
    path,
    gate_id: WORK_PACKAGE_EXECUTION_GOVERNANCE_GATE_ID,
    ...metadata
  };
}

function workPackageId(workPackage = {}, index = 0) {
  return normalizeString(workPackage.id || workPackage.work_package_id || workPackage.workPackageId) ||
    `work_package_${index + 1}`;
}

function acceptanceGates(workPackage = {}) {
  return compactStrings([
    ...asArray(workPackage.acceptance_gates || workPackage.acceptanceGates),
    ...asArray(workPackage.source?.acceptance_gates || workPackage.source?.acceptanceGates)
  ]);
}

function isRequirementPlanStep(workPackage = {}) {
  return normalizeToken(workPackage.action) === "execute_requirement_plan_step";
}

function executionGovernance(workPackage = {}) {
  const value = workPackage.execution_governance ||
    workPackage.executionGovernance ||
    workPackage.source?.execution_governance ||
    workPackage.source?.executionGovernance;
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function executionGranularity(governance = {}) {
  return normalizeToken(governance.granularity || governance.execution_granularity || governance.executionGranularity);
}

function decompositionStatus(governance = {}) {
  const decomposition = governance.decomposition && typeof governance.decomposition === "object"
    ? governance.decomposition
    : {};
  return normalizeToken(
    governance.decomposition_status ||
      governance.decompositionStatus ||
      decomposition.status
  );
}

function decompositionRequired(governance = {}) {
  const decomposition = governance.decomposition && typeof governance.decomposition === "object"
    ? governance.decomposition
    : {};
  return governance.decomposition_required === true ||
    governance.decompositionRequired === true ||
    decomposition.required === true;
}

function verificationRequired(governance = {}) {
  const verification = governance.verification && typeof governance.verification === "object"
    ? governance.verification
    : {};
  return governance.verification_required !== false &&
    governance.verificationRequired !== false &&
    verification.required !== false;
}

function hasStructuredVerification(workPackage = {}, governance = {}) {
  const gates = acceptanceGates(workPackage);
  if (gates.length === 0) return false;
  const verification = governance.verification;
  if (verification && typeof verification === "object" && !Array.isArray(verification)) {
    const status = normalizeToken(verification.status);
    const gateCount = Number(verification.gate_count ?? verification.gateCount ?? 0);
    return verification.required !== false &&
      status === "defined" &&
      Number.isFinite(gateCount) &&
      gateCount > 0 &&
      gates.length >= gateCount;
  }
  return false;
}

function hasCompletedDecompositionEvidence(workPackage = {}, governance = {}) {
  const decomposition = governance.decomposition && typeof governance.decomposition === "object"
    ? governance.decomposition
    : {};
  if (decompositionStatus(governance) === "completed" &&
    (normalizeString(governance.decomposition_id || governance.decompositionId || decomposition.evidence_id || decomposition.evidenceId) ||
      normalizeString(governance.parent_work_package_id || governance.parentWorkPackageId || decomposition.parent_work_package_id || decomposition.parentWorkPackageId) ||
      normalizeString(decomposition.slice_id || decomposition.sliceId) ||
      normalizeString(workPackage.source?.plan_step_slice || workPackage.source?.planStepSlice))) {
    return true;
  }
  return false;
}

export function evaluateWorkPackageExecutionGovernance(input = {}) {
  const selectedWorkPackages = asArray(input.selected_work_packages || input.selectedWorkPackages);
  const issues = [];

  selectedWorkPackages.forEach((workPackage, index) => {
    const id = workPackageId(workPackage, index);
    const path = `selected_work_packages[${index}]`;
    if (!isRequirementPlanStep(workPackage)) return;

    const governance = executionGovernance(workPackage);
    if (!governance) {
      issues.push(issue(
        "requirement_plan_step_missing_execution_governance",
        `${id} must declare structured execution governance before dispatch`,
        `${path}.source.execution_governance`,
        {
          severity: "high",
          repair_action: "return_to_manager_decomposition",
          work_package_id: id
        }
      ));
      return;
    }

    if (verificationRequired(governance) && !hasStructuredVerification(workPackage, governance)) {
      issues.push(issue(
        "requirement_plan_step_missing_focused_verification",
        `${id} must declare focused executable verification before dispatch`,
        `${path}.acceptance_gates`,
        {
          severity: "high",
          repair_action: "return_to_manager_decomposition",
          work_package_id: id
        }
      ));
    }

    const granularity = executionGranularity(governance);
    if (!["single_step", "bounded_slice"].includes(granularity)) {
      issues.push(issue(
        "requirement_plan_step_invalid_execution_granularity",
        `${id} must declare execution_governance.granularity as single_step or bounded_slice`,
        `${path}.source.execution_governance.granularity`,
        {
          severity: "high",
          repair_action: "return_to_manager_decomposition",
          work_package_id: id
        }
      ));
    }

    if (decompositionRequired(governance) && !hasCompletedDecompositionEvidence(workPackage, governance)) {
      issues.push(issue(
        "requirement_plan_step_requires_manager_decomposition",
        `${id} requires completed manager decomposition evidence before dispatch`,
        `${path}.source.execution_governance`,
        {
          severity: "high",
          repair_action: "split_into_executable_work_packages_before_dispatch",
          work_package_id: id
        }
      ));
    }
  });

  return {
    gate_id: WORK_PACKAGE_EXECUTION_GOVERNANCE_GATE_ID,
    status: issues.length > 0 ? "fail" : "pass",
    checked_work_package_count: selectedWorkPackages.length,
    checked_work_package_ids: selectedWorkPackages.map(workPackageId),
    issues
  };
}
