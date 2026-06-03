import { recordArtifact } from "./artifact-ledger.js";
import { createProcessHardeningPlan } from "./process-hardening.js";
import { appendRunEvent } from "./run-manifest.js";

const HEADLESS_CLI_ORCHESTRATOR_VERSION = "headless-cli-orchestrator.v1";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeToken(value) {
  return normalizeString(value).toLowerCase();
}

function safeIdPart(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function processHardeningFindingFor(rejectedResults = []) {
  return {
    id: "headless-child-worker-acceptance-failed",
    status: "fail",
    category: "process_gap",
    severity: "p1",
    message: "Headless main orchestrator rejected child worker output; retry must first preserve the failure as a gate or regression.",
    enforcement_target: "src/workflow/headless-cli-orchestrator.js; test/headless-cli-orchestrator.test.js; docs/examples/process-hardening-current.json",
    regression_test: "headless CLI orchestrator hardens no-diff child worker output before retry",
    verification: "node --test test/headless-cli-orchestrator.test.js; npm run check:process-hardening; npm run check:closeout",
    hardening_status: "completed",
    rejected_results: rejectedResults
  };
}

export function recordHeadlessProcessHardening(workflowState = {}, rejectedResults = [], options = {}) {
  const createdAt = normalizeString(options.created_at || options.createdAt) || new Date().toISOString();
  const finding = processHardeningFindingFor(rejectedResults);
  const plan = createProcessHardeningPlan({
    run_id: workflowState?.manifest?.run_id,
    cycle_id: workflowState?.manifest?.cycle_id,
    findings: [finding]
  });
  const id = normalizeString(options.process_hardening_artifact_id || options.processHardeningArtifactId) ||
    `headless-process-hardening-${safeIdPart(workflowState?.manifest?.run_id)}-${safeIdPart(workflowState?.manifest?.cycle_id)}-001`;
  const artifact = {
    id,
    type: "evaluation",
    status: "pass",
    uri: `headless-cli://process-hardening/${encodeURIComponent(workflowState?.manifest?.run_id || "unknown")}/${encodeURIComponent(workflowState?.manifest?.cycle_id || "unknown")}`,
    producer: "headless-cli-orchestrator",
    created_at: createdAt,
    metadata: {
      version: HEADLESS_CLI_ORCHESTRATOR_VERSION,
      type: "headless_cli_process_hardening",
      status: "completed",
      finding,
      plan
    }
  };
  const manifest = appendRunEvent(workflowState.manifest, {
    id: `event-${id}`,
    type: "headless_cli_process_hardening",
    status: "completed",
    artifact_id: id,
    message: "headless child worker failure was converted into process-hardening evidence before retry",
    created_at: createdAt,
    metadata: artifact.metadata
  });
  const baseLedger = workflowState.artifact_ledger || workflowState.artifactLedger || {};
  const artifactLedger = recordArtifact({
    ...baseLedger,
    artifacts: Array.isArray(baseLedger.artifacts) ? baseLedger.artifacts : []
  }, artifact);

  return {
    status: "pass",
    finding,
    plan,
    workflow_state: {
      ...workflowState,
      manifest: {
        ...manifest,
        review_findings: [...asArray(manifest.review_findings), finding],
        artifacts: [...asArray(manifest.artifacts), artifact]
      },
      artifact_ledger: artifactLedger
    }
  };
}

export function rejectedPackageResults(runResult = {}) {
  return asArray(runResult.package_results)
    .filter((result) => normalizeToken(result?.status) !== "pass");
}
