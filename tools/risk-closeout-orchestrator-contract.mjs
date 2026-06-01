const TERMINAL_STATUSES = new Set(["fixed", "invalidated", "deferred", "blocked", "requires_owner_authorization"]);

function issue(code, message, path = "") {
  return { code, message, path };
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function pathIsWithin(file, ownedPath) {
  const normalizedFile = normalizePath(file);
  const normalizedOwnedPath = normalizePath(ownedPath);
  if (!normalizedOwnedPath) return false;
  if (normalizedOwnedPath.endsWith("/")) return normalizedFile.startsWith(normalizedOwnedPath);
  return normalizedFile === normalizedOwnedPath || normalizedFile.startsWith(`${normalizedOwnedPath}/`);
}

function isIsolatedWorkerWorktreePath(value) {
  const normalized = normalizePath(value);
  const parts = normalized.split("/").filter(Boolean);
  const workerIndex = parts.indexOf("worker-workspaces");
  return normalized.startsWith("/")
    && workerIndex >= 0
    && workerIndex < parts.length - 1
    && !parts.includes(".")
    && !parts.includes("..");
}

function hasNonEmptyStrings(value) {
  return asArray(value).some(nonEmptyString);
}

function passResult(version, extra = {}) {
  return { version, status: "pass", issues: [], ...extra };
}

function failResult(version, issues, extra = {}) {
  return { version, status: "fail", issues, ...extra };
}

export function evaluateRepairAgentContract(input = {}) {
  const issues = [];
  const risk = input.risk;
  if (!isObject(risk)) {
    issues.push(issue("repair_contract_missing_risk", "risk is required", "risk"));
  }
  if (!nonEmptyString(input.run_id)) {
    issues.push(issue("repair_contract_missing_run_id", "run_id is required", "run_id"));
  }
  if (!nonEmptyString(input.worktree_path)) {
    issues.push(issue("repair_contract_missing_worktree", "worktree_path is required", "worktree_path"));
  } else if (!isIsolatedWorkerWorktreePath(input.worktree_path)) {
    issues.push(issue("repair_contract_not_isolated_worktree", "repair work must run from an isolated worker worktree", "worktree_path"));
  }
  const changedFiles = asArray(input.changed_files).filter(nonEmptyString);
  if (changedFiles.length === 0) {
    issues.push(issue("repair_contract_missing_changed_files", "changed_files must contain at least one file", "changed_files"));
  }
  if (isObject(risk) && !["open", "in_progress"].includes(risk.status)) {
    issues.push(issue("repair_contract_invalid_start_status", "repair can start only from open or in_progress", "risk.status"));
  }
  if (isObject(risk)) {
    for (const file of changedFiles) {
      if (!asArray(risk.owned_files).some((ownedPath) => pathIsWithin(file, ownedPath))) {
        issues.push(issue("repair_contract_changed_file_outside_owned_scope", `${file} is outside owned_files`, file));
      }
    }
  }
  return issues.length > 0
    ? failResult("repair-agent-contract.v1", issues)
    : passResult("repair-agent-contract.v1", { changed_files: changedFiles });
}

export function evaluateEvidenceAgentContract(input = {}) {
  const issues = [];
  const risk = input.risk;
  if (!isObject(risk)) {
    issues.push(issue("evidence_contract_missing_risk", "risk is required", "risk"));
  }
  const evidence = asArray(input.evidence).filter(isObject);
  if (evidence.length === 0) {
    issues.push(issue("evidence_contract_missing_entries", "evidence entries are required", "evidence"));
  }
  if (isObject(risk)) {
    for (const gate of asArray(risk.acceptance_gates)) {
      const matching = evidence.find((entry) => entry.gate === gate && entry.exit_code === 0 && nonEmptyString(entry.command));
      if (!matching) {
        issues.push(issue("evidence_contract_gate_not_proven", `acceptance gate was not proven: ${gate}`, gate));
      }
    }
  }
  for (const [index, entry] of evidence.entries()) {
    if (!nonEmptyString(entry.command)) {
      issues.push(issue("evidence_contract_missing_command", "evidence command is required", `evidence[${index}].command`));
    }
    if (entry.exit_code !== 0) {
      issues.push(issue("evidence_contract_nonzero_exit", "evidence command must exit 0", `evidence[${index}].exit_code`));
    }
    if (!nonEmptyString(entry.summary)) {
      issues.push(issue("evidence_contract_missing_summary", "evidence summary is required", `evidence[${index}].summary`));
    }
  }
  return issues.length > 0
    ? failResult("evidence-agent-contract.v1", issues)
    : passResult("evidence-agent-contract.v1", { proven_gates: asArray(risk?.acceptance_gates) });
}

export function evaluateReviewerHandoffContract(input = {}) {
  const issues = [];
  const risk = input.risk;
  const handoff = input.handoff;
  if (!isObject(risk)) {
    issues.push(issue("reviewer_handoff_missing_risk", "risk is required", "risk"));
  }
  if (!isObject(handoff)) {
    issues.push(issue("reviewer_handoff_missing_payload", "handoff is required", "handoff"));
  } else {
    if (handoff.risk_id !== risk?.id) {
      issues.push(issue("reviewer_handoff_risk_mismatch", "handoff risk_id must match risk.id", "handoff.risk_id"));
    }
    if (!nonEmptyString(handoff.diff_summary)) {
      issues.push(issue("reviewer_handoff_missing_diff_summary", "diff_summary is required", "handoff.diff_summary"));
    }
    if (!hasNonEmptyStrings(handoff.changed_files)) {
      issues.push(issue("reviewer_handoff_missing_changed_files", "changed_files are required", "handoff.changed_files"));
    }
    if (!hasNonEmptyStrings(handoff.evidence_refs)) {
      issues.push(issue("reviewer_handoff_missing_evidence_refs", "evidence_refs are required", "handoff.evidence_refs"));
    }
    if (!nonEmptyString(handoff.terminal_claim)) {
      issues.push(issue("reviewer_handoff_missing_terminal_claim", "terminal_claim is required", "handoff.terminal_claim"));
    }
  }
  return issues.length > 0
    ? failResult("reviewer-handoff-contract.v1", issues)
    : passResult("reviewer-handoff-contract.v1");
}

export function evaluatePhaseDeepSeekGate(input = {}) {
  const verdict = input.verdict;
  const issues = [];
  if (!isObject(verdict)) {
    issues.push(issue("deepseek_gate_missing_verdict", "DeepSeek verdict is required", "verdict"));
  } else {
    if (verdict.verdict !== "pass") {
      issues.push(issue("deepseek_gate_not_pass", "DeepSeek verdict must be pass", "verdict.verdict"));
    }
    if (asArray(verdict.blocking_findings).length > 0) {
      issues.push(issue("deepseek_gate_has_blocking_findings", "DeepSeek blocking findings must be resolved", "verdict.blocking_findings"));
    }
    if (!nonEmptyString(verdict.artifact)) {
      issues.push(issue("deepseek_gate_missing_artifact", "DeepSeek review artifact path is required", "verdict.artifact"));
    }
  }
  return issues.length > 0
    ? failResult("deepseek-phase-gate.v1", issues)
    : passResult("deepseek-phase-gate.v1");
}

export function evaluateWriteModeOrchestratorReadiness(input = {}) {
  const issues = [];
  if (input.write_mode_enabled !== true) {
    issues.push(issue("write_mode_not_implemented", "write mode is not implemented", "write_mode_enabled"));
  }
  for (const [field, message] of [
    ["repair_agent_contract", "repair agent contract must be wired"],
    ["evidence_agent_contract", "evidence agent contract must be wired"],
    ["reviewer_handoff_contract", "reviewer handoff contract must be wired"],
    ["ledger_transition_contract", "ledger transition contract must be wired"],
    ["deepseek_phase_gate", "DeepSeek phase gate must be wired"]
  ]) {
    if (input[field] !== true) {
      issues.push(issue("write_mode_contract_not_wired", message, field));
    }
  }
  return issues.length > 0
    ? failResult("write-mode-orchestrator-readiness.v1", issues)
    : passResult("write-mode-orchestrator-readiness.v1");
}

export function transitionKnownRiskStatus(risk, targetStatus, context = {}) {
  const issues = [];
  if (!isObject(risk)) {
    return failResult("known-risk-transition.v1", [issue("transition_missing_risk", "risk is required", "risk")]);
  }
  if (!["in_progress", ...TERMINAL_STATUSES].includes(targetStatus)) {
    issues.push(issue("transition_invalid_target", `unsupported target status ${targetStatus}`, "targetStatus"));
  }
  if (targetStatus === "in_progress") {
    const repair = evaluateRepairAgentContract({ risk, ...context.repair });
    if (repair.status !== "pass") issues.push(...repair.issues);
  }
  if (targetStatus === "fixed") {
    if (risk.status !== "in_progress") {
      issues.push(issue("transition_fixed_requires_in_progress", "fixed transition requires current status in_progress", "risk.status"));
    }
    const evidence = evaluateEvidenceAgentContract({ risk, evidence: context.evidence });
    const reviewer = evaluateReviewerHandoffContract({ risk, handoff: context.reviewer_handoff });
    if (evidence.status !== "pass") issues.push(...evidence.issues);
    if (reviewer.status !== "pass") issues.push(...reviewer.issues);
    if (!nonEmptyString(context.fixed_by_commit)) {
      issues.push(issue("transition_fixed_missing_commit", "fixed transition requires fixed_by_commit", "fixed_by_commit"));
    }
  }
  if (issues.length > 0) {
    return failResult("known-risk-transition.v1", issues);
  }
  const now = context.now instanceof Date ? context.now : new Date(context.now || Date.now());
  const next = {
    ...risk,
    status: targetStatus,
    updated_at: now.toISOString()
  };
  if (targetStatus === "in_progress") {
    next.attempted_count = Number.isInteger(risk.attempted_count) ? risk.attempted_count + 1 : 1;
    next.last_agent_run_id = context.repair.run_id;
  }
  if (targetStatus === "fixed") {
    next.resolution = {
      ...(isObject(risk.resolution) ? risk.resolution : {}),
      fixed_by_commit: context.fixed_by_commit
    };
    next.evidence = [...asArray(risk.evidence), ...asArray(context.evidence)];
  }
  return passResult("known-risk-transition.v1", { risk: next });
}
