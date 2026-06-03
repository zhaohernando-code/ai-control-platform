export const REQUIREMENT_PLAN_GENERATION_PROMPT_VERSION = "requirement-plan-generation-prompt.v1";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function compactStrings(value) {
  return asArray(value).map(normalizeString).filter(Boolean);
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function issue(code, message, path) {
  return { code, message, path };
}

function jsonCandidate(text) {
  const value = normalizeString(text);
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const objectStart = value.indexOf("{");
  const objectEnd = value.lastIndexOf("}");
  if (objectStart !== -1 && objectEnd > objectStart) return value.slice(objectStart, objectEnd + 1);
  return "";
}

function normalizeStringList(value) {
  return compactStrings(value).slice(0, 12);
}

export function createRequirementPlanPrompt(requirement = {}) {
  return [
    "# Requirement Plan Generation",
    "",
    "你处于计划生成模式。只生成方案，不写代码，不修改文件，不声称已经实现。",
    "请基于用户需求生成可审核的中台任务方案。不要复制粘贴用户原话作为方案；需要抽象目标、范围、验收标准、风险和门禁证据。",
    "必须只返回一个 JSON object，不要包裹解释性文字。",
    "",
    "输入需求：",
    JSON.stringify({
      id: requirement.id || null,
      title: requirement.title || null,
      project_id: requirement.project_id || null,
      surface_area: requirement.surface_area || null,
      surface_label: requirement.surface_label || null,
      problem_statement: requirement.problem_statement || null,
      constraints: requirement.constraints || null
    }, null, 2),
    "",
    "输出 JSON schema：",
    JSON.stringify({
      assessment_summary: "一段中文评估摘要，说明目标、影响范围和关键不确定性",
      proposed_acceptance_plan: "面向用户审核的中文 Markdown 方案，包含目标、实施范围、验收标准、风险、门禁证据",
      implementation_outline: ["可执行步骤 1", "可执行步骤 2"],
      acceptance_gates: ["需要运行或验证的门禁"],
      risks: ["需要用户知道的风险或假设"]
    }, null, 2)
  ].join("\n");
}

function generatedPlanFromOutput(value) {
  if (isObject(value)) return value;
  const candidate = jsonCandidate(value);
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function evaluateGeneratedRequirementPlan(requirement = {}, generatedPlan = {}) {
  const issues = [];
  const assessment = normalizeString(generatedPlan.assessment_summary || generatedPlan.assessmentSummary);
  const plan = normalizeString(generatedPlan.proposed_acceptance_plan || generatedPlan.proposedAcceptancePlan);
  const implementationOutline = normalizeStringList(generatedPlan.implementation_outline || generatedPlan.implementationOutline);
  const acceptanceGates = normalizeStringList(generatedPlan.acceptance_gates || generatedPlan.acceptanceGates);
  const risks = normalizeStringList(generatedPlan.risks);
  const problem = normalizeString(requirement.problem_statement);

  if (!assessment) {
    issues.push(issue("missing_generated_assessment_summary", "generated plan must include assessment_summary", "assessment_summary"));
  }
  if (!plan) {
    issues.push(issue("missing_generated_acceptance_plan", "generated plan must include proposed_acceptance_plan", "proposed_acceptance_plan"));
  }
  if (implementationOutline.length === 0) {
    issues.push(issue("missing_generated_implementation_outline", "generated plan must include implementation_outline", "implementation_outline"));
  }
  if (acceptanceGates.length === 0) {
    issues.push(issue("missing_generated_acceptance_gates", "generated plan must include acceptance_gates", "acceptance_gates"));
  }
  if (problem && plan === problem) {
    issues.push(issue("generated_plan_copies_problem_statement", "generated plan must not be a verbatim copy of problem_statement", "proposed_acceptance_plan"));
  }

  return {
    status: issues.length ? "fail" : "pass",
    assessment_summary: assessment,
    proposed_acceptance_plan: plan,
    implementation_outline: implementationOutline,
    acceptance_gates: acceptanceGates,
    risks,
    issues
  };
}

export function parseRequirementPlanGenerationOutput(requirement = {}, output = "") {
  const parsed = generatedPlanFromOutput(output);
  if (!parsed) {
    return {
      status: "fail",
      issues: [issue("invalid_requirement_plan_generation_output", "plan generator must return a JSON object", "output")]
    };
  }
  return evaluateGeneratedRequirementPlan(requirement, parsed);
}
