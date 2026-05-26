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

function requirementPlanText(workPackage = {}) {
  return [
    workPackage.title,
    workPackage.reason,
    workPackage.summary,
    workPackage.source?.implementation_step,
    workPackage.source?.implementationStep,
    workPackage.source?.parent_implementation_step,
    workPackage.source?.parentImplementationStep
  ].map(normalizeString).join("\n");
}

function isRequirementPlanStep(workPackage = {}) {
  return normalizeToken(workPackage.action) === "execute_requirement_plan_step";
}

function hasManagerSliceEvidence(workPackage = {}) {
  return Boolean(
    normalizeString(workPackage.source?.plan_step_slice || workPackage.source?.planStepSlice) ||
      normalizeString(workPackage.source?.manager_decomposition_id || workPackage.source?.managerDecompositionId)
  );
}

function broadPlanStepReason(text = "") {
  if (/按.+切片|切片迁移|每个切片/.test(text)) {
    return "plan step describes slicing work instead of one executable slice";
  }
  if (/优先迁移|高频核心视图|核心视图/.test(text) && /迁移|重构/.test(text)) {
    return "plan step groups multiple high-frequency views";
  }
  if (/整体迁移|全量迁移|所有前端|所有.*代码|全部.*重构/.test(text)) {
    return "plan step targets a whole surface rather than a bounded work package";
  }
  if (/分阶段|分批|逐步/.test(text) && /迁移|重构|改造/.test(text)) {
    return "plan step is a process instruction and must be decomposed first";
  }
  return "";
}

function hasFocusedVerification(gates = []) {
  if (gates.length === 0) return false;
  return gates.some((gate) => {
    if (/node --test|npm run|pnpm |yarn |playwright|browser|验收|可展示|可提交|可触发|可端到端/.test(gate)) {
      return true;
    }
    return /验证|证据|测试|通过/.test(gate);
  });
}

export function evaluateWorkPackageExecutionGovernance(input = {}) {
  const selectedWorkPackages = asArray(input.selected_work_packages || input.selectedWorkPackages);
  const issues = [];

  selectedWorkPackages.forEach((workPackage, index) => {
    const id = workPackageId(workPackage, index);
    const path = `selected_work_packages[${index}]`;
    if (!isRequirementPlanStep(workPackage)) return;

    const gates = acceptanceGates(workPackage);
    if (!hasFocusedVerification(gates)) {
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

    const broadReason = broadPlanStepReason(requirementPlanText(workPackage));
    if (broadReason && !hasManagerSliceEvidence(workPackage)) {
      issues.push(issue(
        "requirement_plan_step_requires_manager_decomposition",
        `${id} is not directly executable: ${broadReason}`,
        path,
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
