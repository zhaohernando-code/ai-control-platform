import { CHILD_WORKER_ROLE } from "./headless-worker-planning.js";

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

function compactStrings(value) {
  return asArray(value).map(normalizeString).filter(Boolean);
}

function issue(code, message, path) {
  return { code, message, path };
}

function testResultsPass(testResults = []) {
  return asArray(testResults).length > 0 &&
    asArray(testResults).every((result) => ["pass", "passed", "ok", "success"].includes(normalizeToken(result?.status || result?.result)));
}

function durableStatePass(output = {}) {
  return output.durable_state_updated === true ||
    output.workflow_state_updated === true ||
    isObject(output.durable_state) ||
    isObject(output.workflow_state || output.workflowState);
}

function pathMatchesOwnedFile(changedFile = "", ownedFile = "") {
  const changed = normalizeString(changedFile).replace(/\\/g, "/").replace(/^\.\/+/, "");
  const owned = normalizeString(ownedFile).replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  if ((owned === "." || owned === "") && changed && !changed.startsWith("../") && !changed.startsWith("/")) {
    return true;
  }
  return Boolean(changed && owned && (changed === owned || changed.startsWith(`${owned}/`)));
}

function changedFileAllowedByOwnedFiles(changedFile = "", ownedFiles = []) {
  return compactStrings(ownedFiles).some((ownedFile) => pathMatchesOwnedFile(changedFile, ownedFile));
}

function childOutputAllowsNoDiff(output = {}, integrationEvidence = {}) {
  const noDiff = output.no_diff === true || output.noDiff === true;
  const alreadySatisfied = normalizeString(integrationEvidence.message).toLowerCase().includes("already satisfying") ||
    normalizeString(integrationEvidence.message).toLowerCase().includes("no new committed delta");
  const sameCommit = normalizeString(integrationEvidence.base_commit || integrationEvidence.baseCommit) &&
    normalizeString(integrationEvidence.integrated_commit || integrationEvidence.integratedCommit) ===
      normalizeString(integrationEvidence.base_commit || integrationEvidence.baseCommit);
  return noDiff &&
    integrationEvidence.required === true &&
    integrationEvidence.status === "pass" &&
    (alreadySatisfied || sameCommit);
}

export function evaluateHeadlessChildWorkerOutput(workPackage = {}, output = {}) {
  const issues = [];
  const ownedFiles = compactStrings(workPackage.owned_files);
  const changedFiles = compactStrings([
    ...asArray(output.changed_files || output.changedFiles || output.diff_files || output.diffFiles),
    ...asArray(output.touched_files || output.touchedFiles)
  ]);
  const testResults = asArray(output.test_results || output.testResults);
  const selfEvaluation = output.self_evaluation || output.selfEvaluation || {};
  const processHardening = output.process_hardening || output.processHardening || {};
  const continuationReadiness = output.continuation_readiness || output.continuationReadiness || {};
  const outputStatus = normalizeToken(output.status);
  const commandEvidence = output.command_evidence || output.commandEvidence || {};
  const commandExitCode = Number(commandEvidence.exit_code ?? commandEvidence.exitCode ?? 0);
  const integrationEvidence = commandEvidence.child_worker_integration || commandEvidence.childWorkerIntegration || {};

  if (!isObject(output)) {
    return {
      status: "fail",
      issues: [issue("invalid_child_worker_output", "child worker output must be an object", "child_output")]
    };
  }
  if (!["pass", "passed", "ok", "success"].includes(outputStatus)) {
    issues.push(issue("child_worker_status_not_pass", "child worker output status must be pass", "child_output.status"));
  }
  if (normalizeString(output.host || output.host_classification) !== "platform_core") {
    issues.push(issue("child_worker_host_boundary_missing", "child worker output must declare host=platform_core", "child_output.host"));
  }
  if (commandEvidence.timed_out === true || commandEvidence.timedOut === true) {
    issues.push(issue("child_worker_command_timed_out", "child worker command timed out before acceptable completion", "child_output.command_evidence.timed_out"));
  }
  if (Number.isFinite(commandExitCode) && commandExitCode !== 0) {
    issues.push(issue("child_worker_command_failed", "child worker command must exit 0 before acceptance", "child_output.command_evidence.exit_code"));
  }
  if (integrationEvidence.required === true && integrationEvidence.status !== "pass") {
    issues.push(issue("child_worker_mainline_integration_missing", "isolated child worker changes must be integrated into the primary mainline before acceptance", "child_output.command_evidence.child_worker_integration"));
  }
  if (changedFiles.length === 0 && !childOutputAllowsNoDiff(output, integrationEvidence)) {
    issues.push(issue("child_worker_no_diff", "child worker produced no changed files", "child_output.changed_files"));
  }
  for (const changedFile of changedFiles) {
    if (!changedFileAllowedByOwnedFiles(changedFile, ownedFiles)) {
      issues.push(issue("child_worker_owned_file_violation", `${changedFile} is outside work package owned_files`, "child_output.changed_files"));
    }
  }
  if (!testResultsPass(testResults)) {
    issues.push(issue("child_worker_tests_missing_or_failed", "child worker must provide passing focused test evidence", "child_output.test_results"));
  }
  if (!durableStatePass(output)) {
    issues.push(issue("child_worker_durable_state_missing", "child worker must update or return durable state evidence", "child_output.durable_state_updated"));
  }
  if (processHardening.required === true && processHardening.status !== "completed") {
    issues.push(issue("child_worker_process_hardening_incomplete", "required process hardening must be completed before acceptance", "child_output.process_hardening"));
  }
  if (continuationReadiness.ready !== true) {
    issues.push(issue("child_worker_continuation_not_ready", "child worker must declare continuation readiness", "child_output.continuation_readiness.ready"));
  }
  if (selfEvaluation.aligned !== true || selfEvaluation.drifted === true) {
    issues.push(issue("child_worker_self_evaluation_failed", "child worker self evaluation must confirm alignment and no drift", "child_output.self_evaluation"));
  }

  return {
    status: issues.length ? "fail" : "pass",
    issues,
    checked: {
      host_boundary: "platform_core",
      owned_files: changedFiles,
      test_count: testResults.length,
      durable_state: durableStatePass(output),
      process_hardening: processHardening.required === true ? processHardening.status : "not_required",
      continuation_ready: continuationReadiness.ready === true
    }
  };
}

export function defaultHeadlessChildWorkerOutput(workPackage = {}, options = {}) {
  const ownedFiles = compactStrings(workPackage.owned_files);
  return {
    status: "pass",
    role: CHILD_WORKER_ROLE,
    host: "platform_core",
    changed_files: ownedFiles.slice(0, Math.max(1, Number(options.changed_file_count || options.changedFileCount || 1))),
    test_results: compactStrings(options.acceptance_gates || ["node --test test/headless-cli-orchestrator.test.js"]).map((command) => ({
      command,
      status: "pass"
    })),
    durable_state_updated: true,
    process_hardening: { required: false, status: "not_required" },
    continuation_readiness: { ready: true },
    self_evaluation: {
      aligned: true,
      drifted: false,
      evidence_sufficient: true
    },
    completion_evidence: {
      summary: `bounded child worker completed ${workPackage.id || "work package"}`,
      owned_files: ownedFiles
    }
  };
}

export function missingHeadlessChildWorkerOutput(workPackage = {}) {
  return {
    status: "fail",
    role: CHILD_WORKER_ROLE,
    host: "platform_core",
    changed_files: [],
    test_results: [],
    durable_state_updated: false,
    process_hardening: { required: true, status: "pending" },
    continuation_readiness: { ready: false },
    self_evaluation: {
      aligned: false,
      drifted: false,
      evidence_sufficient: false
    },
    blocker: `child worker execution evidence is required for ${workPackage.id || "work package"}`,
    read_files: [],
    next_minimal_patch_position: "headless_cli.child_worker_execution",
    command_evidence: {
      executor_configured: false,
      mock_allowed: false,
      reason: "headless main orchestrator must not use implicit mock child output"
    }
  };
}

function parseJsonCandidate(text = "") {
  const value = normalizeString(text);
  if (!value) return null;
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced
    ? fenced[1].trim()
    : (() => {
        const objectStart = value.indexOf("{");
        const objectEnd = value.lastIndexOf("}");
        return objectStart >= 0 && objectEnd > objectStart ? value.slice(objectStart, objectEnd + 1) : value;
      })();
  try {
    const parsed = JSON.parse(candidate);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseHeadlessChildWorkerOutput(raw = {}) {
  if (isObject(raw)) return raw;
  return parseJsonCandidate(raw) || null;
}
