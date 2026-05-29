import { PASS_SYNONYMS, FAIL_SYNONYMS, normalizeToken } from "./status-vocabulary.js";

const PASS = "pass";
const RERUN = "rerun";
const ROLLBACK = "rollback";
const HUMAN_INTERVENTION = "human_intervention";

const TERMINAL_PASS_STATUSES = new Set(PASS_SYNONYMS);
const TERMINAL_FAIL_STATUSES = new Set(FAIL_SYNONYMS);
const CRITICAL_SEVERITIES = new Set(["critical", "fatal", "blocker", "p0", "p1"]);
const ROLLBACK_CATEGORIES = new Set([
  "host_boundary",
  "host-boundary",
  "owned_files",
  "owned-files",
  "security",
  "data_loss",
  "data-loss"
]);
const HUMAN_CATEGORIES = new Set([
  "credentials",
  "credential",
  "missing_credentials",
  "missing-credentials",
  "secrets",
  "secret",
  "destructive_action",
  "destructive-action",
  "requirements_conflict",
  "requirement_conflict",
  "requirements-conflict",
  "requirement-conflict"
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeStatus(value) {
  const status = normalizeToken(value);
  if (TERMINAL_PASS_STATUSES.has(status)) return PASS;
  if (TERMINAL_FAIL_STATUSES.has(status)) return "fail";
  return status || "unknown";
}

function itemId(item, fallback) {
  return item?.id || item?.work_package_id || item?.gate_id || item?.finding_id || item?.name || fallback;
}

function itemMessage(item, fallback) {
  return item?.reason || item?.message || item?.summary || item?.description || fallback;
}

function itemCategory(item) {
  return normalizeToken(item?.category || item?.type || item?.gate_id || item?.code || item?.source);
}

function isHumanEscalation(item) {
  const category = itemCategory(item);
  const code = normalizeToken(item?.code);
  return Boolean(
    item?.requires_human ||
      item?.requiresHuman ||
      item?.human_intervention_required ||
      item?.missing_credentials ||
      item?.destructive ||
      item?.destructive_action ||
      HUMAN_CATEGORIES.has(category) ||
      HUMAN_CATEGORIES.has(code)
  );
}

function isRollbackFailure(item) {
  const category = itemCategory(item);
  const severity = normalizeToken(item?.severity || item?.level);
  const code = normalizeToken(item?.code);
  return Boolean(
    item?.requires_rollback ||
      item?.rollback_required ||
      ROLLBACK_CATEGORIES.has(category) ||
      ROLLBACK_CATEGORIES.has(code) ||
      (category.includes("reviewer") && CRITICAL_SEVERITIES.has(severity)) ||
      (category.includes("host") && category.includes("boundary")) ||
      (category.includes("owned") && category.includes("file"))
  );
}

function summarizeStatuses(items) {
  return asArray(items).reduce(
    (summary, item) => {
      const status = normalizeStatus(item?.status || item?.result || item?.outcome);
      summary.total += 1;
      if (status === PASS) summary.passed += 1;
      else if (status === "fail") summary.failed += 1;
      else summary.unknown += 1;
      return summary;
    },
    { total: 0, passed: 0, failed: 0, unknown: 0 }
  );
}

function failedItems(items) {
  return asArray(items).filter((item) => normalizeStatus(item?.status || item?.result || item?.outcome) === "fail");
}

function consecutiveFailedRecoveryAttempts(recoveryAttempts) {
  let count = 0;
  for (const attempt of [...asArray(recoveryAttempts)].reverse()) {
    const status = normalizeStatus(attempt?.status || attempt?.result || attempt?.outcome);
    if (status === "fail") count += 1;
    else if (status === PASS) break;
  }
  return count;
}

function buildReasons(prefix, items) {
  return asArray(items).map((item, index) => {
    const id = itemId(item, `${prefix}_${index + 1}`);
    return `${prefix}:${id}: ${itemMessage(item, "failed")}`;
  });
}

function workPackageStatus(workPackage) {
  return normalizeStatus(workPackage?.status || workPackage?.result || workPackage?.outcome);
}

function failedWorkPackages(workPackages) {
  return asArray(workPackages).filter((workPackage) => {
    const status = workPackageStatus(workPackage);
    return status === "fail" || status === "blocked";
  });
}

function packageReference(workPackage, index) {
  return {
    id: itemId(workPackage, `work_package_${index + 1}`),
    title: workPackage?.title || workPackage?.name || itemId(workPackage, `work_package_${index + 1}`),
    owner: workPackage?.owner || workPackage?.agent || null
  };
}

function recoveryWorkPackage(action, reason, source = null) {
  return {
    id: `${action}_${source?.id || "run"}_recovery`,
    action,
    title: action === ROLLBACK ? "Rollback failed run changes and prepare a clean retry" : "Rerun failed checks with recovery context",
    reason,
    source
  };
}

function nextPackagesForRerun(runResult, reasons) {
  const failedPackages = failedWorkPackages(runResult.work_packages).map(packageReference);
  return [
    ...failedPackages,
    recoveryWorkPackage(RERUN, reasons[0] || "recoverable run failure")
  ];
}

function nextPackagesForRollback(runResult, reasons) {
  const failedPackages = failedWorkPackages(runResult.work_packages).map(packageReference);
  return [
    recoveryWorkPackage(ROLLBACK, reasons[0] || "non-recoverable boundary or review failure"),
    ...failedPackages
  ];
}

export function decideNextAction(runResult, options = {}) {
  const maxConsecutiveRecoveryFailures = options.maxConsecutiveRecoveryFailures ?? 3;
  const failedGates = failedItems(runResult?.gate_results);
  const failedFindings = failedItems(runResult?.review_findings);
  const failedArtifacts = failedItems(runResult?.artifacts);
  const humanItems = [...failedGates, ...failedFindings, ...failedArtifacts].filter(isHumanEscalation);
  const rollbackItems = [...failedGates, ...failedFindings, ...failedArtifacts].filter(isRollbackFailure);
  const recoveryFailures = consecutiveFailedRecoveryAttempts(runResult?.recovery_attempts);

  if (humanItems.length > 0) {
    const reasons = buildReasons("human", humanItems);
    return {
      action: HUMAN_INTERVENTION,
      status: HUMAN_INTERVENTION,
      reasons,
      next_work_packages: [],
      blockers: humanItems.map((item, index) => ({ id: itemId(item, `blocker_${index + 1}`), category: itemCategory(item) }))
    };
  }

  if (recoveryFailures >= maxConsecutiveRecoveryFailures) {
    const reason = `recovery: consecutive recovery failures reached ${recoveryFailures}/${maxConsecutiveRecoveryFailures}`;
    return {
      action: HUMAN_INTERVENTION,
      status: HUMAN_INTERVENTION,
      reasons: [reason],
      next_work_packages: [],
      blockers: [{ id: "recovery_attempts", category: "recovery_exhausted", count: recoveryFailures }]
    };
  }

  if (rollbackItems.length > 0) {
    const reasons = buildReasons("rollback", rollbackItems);
    return {
      action: ROLLBACK,
      status: ROLLBACK,
      reasons,
      next_work_packages: nextPackagesForRollback(runResult, reasons),
      blockers: []
    };
  }

  const rerunItems = [...failedGates, ...failedFindings, ...failedArtifacts];
  if (rerunItems.length > 0) {
    const reasons = buildReasons("rerun", rerunItems);
    return {
      action: RERUN,
      status: RERUN,
      reasons,
      next_work_packages: nextPackagesForRerun(runResult, reasons),
      blockers: []
    };
  }

  const incompletePackages = asArray(runResult?.work_packages).filter((workPackage) => {
    const status = workPackageStatus(workPackage);
    return !TERMINAL_PASS_STATUSES.has(status) && status !== PASS;
  });

  if (incompletePackages.length > 0) {
    const reasons = buildReasons("rerun", incompletePackages);
    return {
      action: RERUN,
      status: RERUN,
      reasons,
      next_work_packages: nextPackagesForRerun({ ...runResult, work_packages: incompletePackages }, reasons),
      blockers: []
    };
  }

  return {
    action: PASS,
    status: PASS,
    reasons: ["all gates, reviews, artifacts, and work packages passed"],
    next_work_packages: [],
    blockers: []
  };
}

export function summarizeWorkbenchProjection(runResult, decision = decideNextAction(runResult)) {
  const workPackages = asArray(runResult?.work_packages);
  const recoveryAttempts = asArray(runResult?.recovery_attempts);
  const lastRecoveryAttempt = recoveryAttempts.at(-1) || null;

  return {
    run_id: runResult?.run_id || null,
    cycle_id: runResult?.cycle_id || null,
    status: decision.status,
    decision: decision.action,
    reasons: decision.reasons,
    blockers: decision.blockers || [],
    summaries: {
      work_packages: summarizeStatuses(workPackages),
      artifacts: summarizeStatuses(runResult?.artifacts),
      gates: summarizeStatuses(runResult?.gate_results),
      review_findings: summarizeStatuses(runResult?.review_findings),
      recovery_attempts: summarizeStatuses(recoveryAttempts)
    },
    current_work_packages: workPackages.map(packageReference),
    next_work_packages: decision.next_work_packages,
    recovery: {
      consecutive_failed_attempts: consecutiveFailedRecoveryAttempts(recoveryAttempts),
      last_attempt_id: lastRecoveryAttempt ? itemId(lastRecoveryAttempt, "recovery_attempt") : null,
      last_attempt_status: lastRecoveryAttempt
        ? normalizeStatus(lastRecoveryAttempt.status || lastRecoveryAttempt.result || lastRecoveryAttempt.outcome)
        : null
    }
  };
}

export function evaluateRunResult(runResult, options = {}) {
  const decision = decideNextAction(runResult, options);
  return {
    run_id: runResult?.run_id || null,
    cycle_id: runResult?.cycle_id || null,
    status: decision.status,
    decision: decision.action,
    reasons: decision.reasons,
    next_work_packages: decision.next_work_packages,
    projection: summarizeWorkbenchProjection(runResult, decision)
  };
}

export { HUMAN_INTERVENTION, PASS, RERUN, ROLLBACK };
