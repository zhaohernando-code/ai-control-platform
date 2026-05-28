export const DEVELOPMENT_FLOW_EVALUATION_VERSION = "development-flow-evaluation.v1";

export const DEVELOPMENT_FLOW_RUNS = ["codex_cli", "claude_cli"];

export const REQUIRED_DEVELOPMENT_FLOW_PHASES = [
  "requirement_submitted",
  "plan_generated",
  "plan_approved",
  "work_packages_created",
  "agent_selected",
  "cli_child_worker_executed",
  "code_landed",
  "acceptance_checked",
  "review_guard_checked",
  "closeout_published",
  "projection_verified",
  "final_evaluated"
];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeToken(value) {
  return normalizeString(value).toLowerCase();
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function issue(code, message, path) {
  return { code, message, path };
}

function statusPass(value) {
  return ["pass", "passed", "ok", "success"].includes(normalizeToken(value));
}

function secretLikeStrings(value, path = "") {
  const findings = [];
  const rawSecretPattern = /\b(?:sk-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})\b/g;

  if (typeof value === "string") {
    for (const match of value.matchAll(rawSecretPattern)) {
      findings.push({ path, sample: match[0].slice(0, 8) });
    }
    return findings;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => findings.push(...secretLikeStrings(item, `${path}[${index}]`)));
    return findings;
  }
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      findings.push(...secretLikeStrings(child, path ? `${path}.${key}` : key));
    }
  }
  return findings;
}

function phaseIssues(runId, run = {}) {
  const issues = [];
  const phases = asArray(run.phase_trace);
  const seen = new Map();
  phases.forEach((phase, index) => {
    const id = normalizeString(phase?.phase || phase?.id);
    if (!id) {
      issues.push(issue("invalid_phase_trace_entry", `${runId} phase entry must include phase`, `runs.${runId}.phase_trace[${index}]`));
      return;
    }
    if (seen.has(id)) {
      issues.push(issue("duplicate_development_flow_phase", `${runId} phase ${id} is duplicated`, `runs.${runId}.phase_trace[${index}]`));
    }
    seen.set(id, { phase, index });
    if (!statusPass(phase?.status)) {
      issues.push(issue("development_flow_phase_not_passed", `${runId} phase ${id} did not pass`, `runs.${runId}.phase_trace[${index}].status`));
    }
    if (!normalizeString(phase?.evidence_id || phase?.evidenceId)) {
      issues.push(issue("development_flow_phase_missing_evidence", `${runId} phase ${id} must include evidence_id`, `runs.${runId}.phase_trace[${index}].evidence_id`));
    }
  });

  let previousIndex = -1;
  for (const phase of REQUIRED_DEVELOPMENT_FLOW_PHASES) {
    const entry = seen.get(phase);
    if (!entry) {
      issues.push(issue("missing_development_flow_phase", `${runId} is missing phase ${phase}`, `runs.${runId}.phase_trace`));
      continue;
    }
    if (entry.index <= previousIndex) {
      issues.push(issue("development_flow_phase_out_of_order", `${runId} phase ${phase} is out of order`, `runs.${runId}.phase_trace[${entry.index}]`));
    }
    previousIndex = entry.index;
  }

  const approvedIndex = seen.get("plan_approved")?.index ?? -1;
  const executedIndex = seen.get("cli_child_worker_executed")?.index ?? -1;
  if (approvedIndex >= 0 && executedIndex >= 0 && executedIndex < approvedIndex) {
    issues.push(issue("unapproved_plan_execution", `${runId} executed before plan approval`, `runs.${runId}.phase_trace`));
  }

  return issues;
}

function provenanceIssues(runId, run = {}) {
  const issues = [];
  const provenance = run.model_provenance || run.modelProvenance || {};
  if (!isObject(provenance)) {
    return [issue("missing_model_provenance", `${runId} must record model provenance`, `runs.${runId}.model_provenance`)];
  }
  if (provenance.real_model_call !== true && provenance.realModelCall !== true) {
    issues.push(issue("missing_real_model_call_provenance", `${runId} must prove a real CLI/model call`, `runs.${runId}.model_provenance.real_model_call`));
  }
  if (Number(provenance.external_calls || provenance.externalCalls || 0) < 1) {
    issues.push(issue("missing_external_call_count", `${runId} must record at least one external model call`, `runs.${runId}.model_provenance.external_calls`));
  }
  if (!normalizeString(provenance.runner)) {
    issues.push(issue("missing_model_runner", `${runId} must record runner`, `runs.${runId}.model_provenance.runner`));
  }
  if (!normalizeString(provenance.model)) {
    issues.push(issue("missing_model_id", `${runId} must record model`, `runs.${runId}.model_provenance.model`));
  }
  return issues;
}

function runEvidenceIssues(runId, run = {}) {
  const issues = [];
  const diffSummary = run.diff_summary || run.diffSummary || {};
  if (diffSummary.has_diff !== true && asArray(diffSummary.changed_files || diffSummary.changedFiles).length === 0) {
    issues.push(issue("missing_real_code_diff", `${runId} must land a real fixture code diff`, `runs.${runId}.diff_summary`));
  }
  if (!asArray(run.test_results || run.testResults).some((testResult) => statusPass(testResult?.status || testResult?.result))) {
    issues.push(issue("missing_acceptance_test_pass", `${runId} must record passing acceptance test evidence`, `runs.${runId}.test_results`));
  }
  if (!statusPass(run.output_contract?.status || run.outputContract?.status)) {
    issues.push(issue("output_contract_not_passed", `${runId} model output contract must pass`, `runs.${runId}.output_contract.status`));
  }
  if (!statusPass(run.review_guard?.status || run.reviewGuard?.status)) {
    issues.push(issue("missing_review_guard_pass", `${runId} must record review/guard pass evidence`, `runs.${runId}.review_guard.status`));
  }
  if (!statusPass(run.closeout?.status)) {
    issues.push(issue("missing_closeout_pass", `${runId} must record closeout pass evidence`, `runs.${runId}.closeout.status`));
  }
  if (!statusPass(run.projection?.status)) {
    issues.push(issue("missing_projection_pass", `${runId} must record projection pass evidence`, `runs.${runId}.projection.status`));
  }
  if (!isObject(run.agent_selection || run.agentSelection)) {
    issues.push(issue("missing_agent_selection", `${runId} must record selected agent`, `runs.${runId}.agent_selection`));
  }
  return issues;
}

function expectedRunner(runId) {
  return runId === "codex_cli" ? "codex" : "claude";
}

function runnerContractIssues(runId, run = {}) {
  const provenance = run.model_provenance || run.modelProvenance || {};
  const runner = normalizeToken(provenance.runner);
  const expected = expectedRunner(runId);
  if (runner && runner !== expected) {
    return [issue("development_flow_runner_mismatch", `${runId} must use runner=${expected}`, `runs.${runId}.model_provenance.runner`)];
  }
  return [];
}

export function evaluateDevelopmentFlowArtifact(artifact = {}) {
  const issues = [];

  if (!isObject(artifact)) {
    return {
      version: DEVELOPMENT_FLOW_EVALUATION_VERSION,
      status: "fail",
      issues: [issue("invalid_development_flow_artifact", "artifact must be an object", "")]
    };
  }

  if (normalizeString(artifact.version) !== DEVELOPMENT_FLOW_EVALUATION_VERSION) {
    issues.push(issue("invalid_development_flow_version", `version must be ${DEVELOPMENT_FLOW_EVALUATION_VERSION}`, "version"));
  }

  const runs = artifact.runs || {};
  for (const runId of DEVELOPMENT_FLOW_RUNS) {
    const run = runs[runId];
    if (!isObject(run)) {
      issues.push(issue("missing_development_flow_run", `${runId} run is required`, `runs.${runId}`));
      continue;
    }
    if (!statusPass(run.status)) {
      issues.push(issue("development_flow_run_not_passed", `${runId} did not pass`, `runs.${runId}.status`));
    }
    issues.push(...phaseIssues(runId, run));
    issues.push(...provenanceIssues(runId, run));
    issues.push(...runnerContractIssues(runId, run));
    issues.push(...runEvidenceIssues(runId, run));
  }

  for (const finding of secretLikeStrings(artifact)) {
    issues.push(issue("raw_secret_in_development_flow_artifact", "development flow artifact must not contain raw secrets", finding.path));
  }

  return {
    version: DEVELOPMENT_FLOW_EVALUATION_VERSION,
    status: issues.length === 0 ? "pass" : "fail",
    required_runs: DEVELOPMENT_FLOW_RUNS,
    required_phases: REQUIRED_DEVELOPMENT_FLOW_PHASES,
    issues
  };
}
