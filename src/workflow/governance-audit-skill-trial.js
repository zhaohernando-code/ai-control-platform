import { recordArtifact } from "./artifact-ledger.js";
import { appendRunEvent } from "./run-manifest.js";
import {
  AUDIT_SKILL_TRIAL_RUN_VERSION,
  evaluateAuditSkillTrialRun
} from "./audit-skill-trial-run.js";

export const GOVERNANCE_AUDIT_SKILL_TRIAL_EVENT = "governance_audit_skill_trial_run";
export const GOVERNANCE_AUDIT_REPAIR_ACTION = "repair_governance_audit_defect";

const PASS_VERDICTS = new Set(["通过", "带条件通过"]);
const DEFAULT_REPAIR_GATES = [
  "npm run run:governance-audit-skill-trial",
  "npm run check:closeout"
];
const DEFAULT_REPAIR_OWNED_FILES = [
  "tools/workbench-server.mjs",
  "tools/run-governance-audit-skill-trial.mjs",
  "src/workflow/governance-audit-skill-trial.js",
  "src/workflow/autonomous-continuation.js",
  "src/workflow/workbench-projection.js",
  "test/audit-skill-trial-run.test.js",
  "test/autonomous-continuation.test.js",
  "test/workbench-projection.test.js"
];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeString(value) {
  return String(value || "").trim();
}

function safeIdPart(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "latest";
}

function uniqueStrings(values = []) {
  return [...new Set(asArray(values).map(normalizeString).filter(Boolean))];
}

function findingId(finding = {}, index = 0) {
  return normalizeString(finding.id || finding.finding_id || finding.code) || `finding-${index + 1}`;
}

function isBlockingFinding(finding = {}) {
  return normalizeString(finding.type) === "明确缺陷" &&
    ["高", "致命"].includes(normalizeString(finding.severity));
}

function targetFilesFromFindings(findings = []) {
  return uniqueStrings(findings.flatMap((finding) => (
    asArray(finding.repair_schedule?.target_files_or_modules || finding.repairSchedule?.targetFilesOrModules)
  )));
}

function verificationCommandsFromFindings(findings = []) {
  return uniqueStrings([
    ...findings.flatMap((finding) => asArray(finding.repair_schedule?.verification_commands || finding.repairSchedule?.verificationCommands)),
    ...DEFAULT_REPAIR_GATES
  ]);
}

export function createGovernanceAuditRepairWorkPackage(summary = {}) {
  const finalVerdict = normalizeString(summary.final_verdict || summary.finalVerdict);
  const blockingFindings = asArray(summary.blocking_findings || summary.blockingFindings);
  const blockingCount = Number(summary.blocking_count ?? summary.blockingCount ?? blockingFindings.length);
  if (PASS_VERDICTS.has(finalVerdict) || blockingCount <= 0) return null;

  const artifactId = normalizeString(summary.artifact_id || summary.artifactId || summary.id) || "latest";
  const findingIds = blockingFindings.map(findingId).filter(Boolean);
  const latestFinding = normalizeString(summary.latest_finding || summary.latestFinding) ||
    normalizeString(blockingFindings[0]?.summary || blockingFindings[0]?.impact || blockingFindings[0]?.id);

  return {
    id: `governance-audit-repair-${safeIdPart(artifactId)}`,
    title: "Repair governance audit blocking defects",
    action: GOVERNANCE_AUDIT_REPAIR_ACTION,
    owned_files: uniqueStrings([
      ...targetFilesFromFindings(blockingFindings),
      ...DEFAULT_REPAIR_OWNED_FILES
    ]),
    acceptance_gates: verificationCommandsFromFindings(blockingFindings),
    reason: latestFinding
      ? `${blockingCount} blocking governance audit finding(s): ${latestFinding}`
      : `${blockingCount} blocking governance audit finding(s) require repair`,
    governance_audit: {
      artifact_id: artifactId,
      final_verdict: finalVerdict,
      blocking_count: blockingCount,
      finding_count: Number(summary.finding_count ?? summary.findingCount ?? asArray(summary.findings).length),
      latest_finding: latestFinding || null,
      finding_ids: findingIds
    },
    source: {
      artifact_id: artifactId,
      role: "governance_audit_repair_worker",
      reason: "failed audit-skill-trial-run.v1 must become a bounded repair work package"
    }
  };
}

export function summarizeGovernanceAuditSkillTrial(manifest = {}, artifactLedger = {}) {
  const events = asArray(manifest?.events).filter((event) => event?.type === GOVERNANCE_AUDIT_SKILL_TRIAL_EVENT);
  const latestEvent = events.at(-1) || null;
  if (!latestEvent) {
    return {
      status: "not_configured",
      artifact_id: null,
      event_id: null,
      final_verdict: null,
      blocking_count: 0,
      finding_count: 0,
      latest_finding: null,
      repair_required: false,
      repair_work_package: null,
      created_at: null
    };
  }

  const artifacts = [
    ...asArray(artifactLedger?.artifacts),
    ...asArray(manifest?.artifacts)
  ];
  const artifact = artifacts.find((entry) => entry.id === latestEvent.artifact_id) || null;
  const metadata = artifact?.metadata || latestEvent.metadata || {};
  const findings = asArray(metadata.findings);
  const blockingFindings = findings.filter(isBlockingFinding);
  const finalVerdict = normalizeString(metadata.final_verdict || metadata.finalVerdict);
  const summary = {
    status: PASS_VERDICTS.has(finalVerdict) ? "pass" : "fail",
    artifact_id: latestEvent.artifact_id || artifact?.id || null,
    event_id: latestEvent.id || null,
    final_verdict: finalVerdict || null,
    blocking_count: blockingFindings.length,
    finding_count: findings.length,
    findings,
    blocking_findings: blockingFindings,
    latest_finding: blockingFindings[0]?.summary || blockingFindings[0]?.impact || blockingFindings[0]?.id || null,
    created_at: latestEvent.created_at || artifact?.created_at || metadata.created_at || null
  };
  const repairWorkPackage = createGovernanceAuditRepairWorkPackage(summary);
  return {
    ...summary,
    repair_required: Boolean(repairWorkPackage),
    repair_work_package: repairWorkPackage
  };
}

export function recordGovernanceAuditSkillTrialRunArtifact(workflowState = {}, artifact = {}, options = {}) {
  if (!isObject(workflowState)) {
    return {
      status: "fail",
      issues: [{ code: "invalid_workflow_state", message: "workflow state must be an object", path: "workflow_state" }]
    };
  }

  const validation = evaluateAuditSkillTrialRun(artifact);
  if (validation.status !== "pass") {
    return { status: "fail", issues: validation.issues || [] };
  }

  const id = safeIdPart(options.artifact_id || options.artifactId || artifact.id || "governance-audit-current");
  const createdAt = normalizeString(options.created_at || options.createdAt || artifact.created_at) || new Date().toISOString();
  const finalVerdict = normalizeString(artifact.final_verdict);
  const fact = {
    ...artifact,
    id,
    type: GOVERNANCE_AUDIT_SKILL_TRIAL_EVENT,
    created_at: createdAt,
    status: PASS_VERDICTS.has(finalVerdict) ? "pass" : "fail",
    blocking_count: asArray(artifact.findings).filter(isBlockingFinding).length
  };
  const recordedArtifact = {
    id,
    type: "evaluation",
    status: fact.status,
    uri: `codex://governance-audit/${encodeURIComponent(workflowState.manifest?.run_id || "unknown")}/${encodeURIComponent(workflowState.manifest?.cycle_id || "unknown")}/${encodeURIComponent(id)}`,
    producer: "governance-audit-skill-trial",
    created_at: createdAt,
    metadata: fact
  };
  const manifest = appendRunEvent(workflowState.manifest, {
    id: `event-${id}`,
    type: GOVERNANCE_AUDIT_SKILL_TRIAL_EVENT,
    status: fact.status,
    artifact_id: id,
    message: `governance audit skill trial ${fact.status}`,
    created_at: createdAt,
    metadata: fact
  });
  const baseLedger = workflowState.artifact_ledger || workflowState.artifactLedger || {};
  const artifactLedger = recordArtifact({
    ...baseLedger,
    artifacts: asArray(baseLedger.artifacts)
  }, recordedArtifact);

  return {
    status: "pass",
    artifact: recordedArtifact,
    summary: summarizeGovernanceAuditSkillTrial(manifest, artifactLedger),
    workflow_state: {
      ...workflowState,
      manifest,
      artifact_ledger: artifactLedger
    }
  };
}

export { AUDIT_SKILL_TRIAL_RUN_VERSION };
