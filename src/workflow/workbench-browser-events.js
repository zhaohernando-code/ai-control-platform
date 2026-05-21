import { recordArtifact } from "./artifact-ledger.js";
import { appendRunEvent } from "./run-manifest.js";

export const WORKBENCH_BROWSER_EVENTS_RUN_VERSION = "workbench-browser-events-run.v1";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeIdPart(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function issue(code, message, path) {
  return { code, message, path };
}

function workflowStateIdentityIssues(workflowState = {}) {
  const manifestRunId = normalizeString(workflowState?.manifest?.run_id);
  const manifestCycleId = normalizeString(workflowState?.manifest?.cycle_id);
  const ledger = workflowState?.artifact_ledger || workflowState?.artifactLedger || {};
  const ledgerRunId = normalizeString(ledger.run_id);
  const ledgerCycleId = normalizeString(ledger.cycle_id);
  const issues = [];

  if (!manifestRunId || !manifestCycleId) {
    issues.push(issue("missing_manifest_identity", "manifest run_id and cycle_id are required", "manifest"));
  }
  if (!ledgerRunId || !ledgerCycleId) {
    issues.push(issue("missing_artifact_ledger_identity", "artifact ledger run_id and cycle_id are required", "artifact_ledger"));
  }
  if (manifestRunId && ledgerRunId && manifestRunId !== ledgerRunId) {
    issues.push(issue("workflow_state_run_mismatch", "manifest run_id does not match artifact ledger run_id", "artifact_ledger.run_id"));
  }
  if (manifestCycleId && ledgerCycleId && manifestCycleId !== ledgerCycleId) {
    issues.push(issue("workflow_state_cycle_mismatch", "manifest cycle_id does not match artifact ledger cycle_id", "artifact_ledger.cycle_id"));
  }

  return issues;
}

function nextFactId(workflowState = {}, explicitId = "") {
  const runId = safeIdPart(workflowState?.manifest?.run_id);
  const cycleId = safeIdPart(workflowState?.manifest?.cycle_id);
  const prefix = explicitId || `workbench-browser-events-${runId}-${cycleId}`;
  const artifacts = workflowState?.artifact_ledger?.artifacts || workflowState?.artifactLedger?.artifacts || [];
  const events = workflowState?.manifest?.events || [];
  const usedIds = new Set([
    ...artifacts.map((item) => normalizeString(item?.id)).filter(Boolean),
    ...events.map((item) => normalizeString(item?.artifact_id)).filter(Boolean)
  ]);
  if (explicitId && !usedIds.has(explicitId)) return explicitId;

  let index = 1;
  let id = `${prefix}-${String(index).padStart(3, "0")}`;
  while (usedIds.has(id)) {
    index += 1;
    id = `${prefix}-${String(index).padStart(3, "0")}`;
  }
  return id;
}

export function validateWorkbenchBrowserEventsRunArtifact(artifact = {}) {
  const issues = [];
  if (!isObject(artifact)) {
    return {
      status: "fail",
      issues: [issue("invalid_browser_events_artifact", "workbench browser events artifact must be an object", "artifact")]
    };
  }
  if (artifact.version !== WORKBENCH_BROWSER_EVENTS_RUN_VERSION) {
    issues.push(issue("invalid_browser_events_version", `version must be ${WORKBENCH_BROWSER_EVENTS_RUN_VERSION}`, "version"));
  }
  if (!["pass", "fail"].includes(normalizeString(artifact.status))) {
    issues.push(issue("invalid_browser_events_status", "status must be pass or fail", "status"));
  }
  if (!normalizeString(artifact.created_at)) {
    issues.push(issue("missing_browser_events_created_at", "created_at is required", "created_at"));
  }
  const scenarios = asArray(artifact.scenarios);
  if (scenarios.length === 0) {
    issues.push(issue("missing_browser_event_scenarios", "scenarios must not be empty", "scenarios"));
  }
  const partial = scenarios.find((scenario) => scenario?.scenario === "projected_real_partial_shard_readout");
  if (!partial) {
    issues.push(issue("missing_partial_shard_readout", "projected_real_partial_shard_readout scenario is required", "scenarios"));
  } else {
    if (partial.shard_review_next !== "reviewer-scope-shard-002") {
      issues.push(issue("partial_shard_next_not_ready", "partial shard readout must expose reviewer-scope-shard-002", "scenarios.projected_real_partial_shard_readout.shard_review_next"));
    }
    if (partial.next_action_readout !== "run_reviewer_scope_shard") {
      issues.push(issue("partial_shard_action_not_ready", "partial shard readout must recommend run_reviewer_scope_shard", "scenarios.projected_real_partial_shard_readout.next_action_readout"));
    }
  }
  if (scenarios.some((scenario) => Number(scenario?.dimensions?.scrollWidth || 0) > Number(scenario?.dimensions?.width || 0))) {
    issues.push(issue("browser_event_horizontal_overflow", "browser event scenario contains horizontal overflow", "scenarios.dimensions"));
  }

  return {
    status: issues.length ? "fail" : "pass",
    issues
  };
}

export function recordWorkbenchBrowserEventsRunArtifact(workflowState = {}, artifact = {}, options = {}) {
  if (!isObject(workflowState)) {
    return {
      status: "fail",
      issues: [issue("invalid_workflow_state", "workflow state must be an object", "workflow_state")]
    };
  }

  const identityIssues = workflowStateIdentityIssues(workflowState);
  const validation = validateWorkbenchBrowserEventsRunArtifact(artifact);
  const issues = [...identityIssues, ...validation.issues];
  if (issues.length > 0) {
    return { status: "fail", issues };
  }

  const id = nextFactId(workflowState, normalizeString(options.artifact_id || options.artifactId || artifact.id));
  const createdAt = normalizeString(options.created_at || options.createdAt || artifact.created_at) || new Date().toISOString();
  const fact = {
    ...artifact,
    id,
    type: "workbench_browser_events_run",
    created_at: createdAt,
    scenario_count: Number(artifact.scenario_count || asArray(artifact.scenarios).length || 0)
  };
  const recordedArtifact = {
    id,
    type: "evaluation",
    status: fact.status,
    uri: `codex://workbench-browser-events/${encodeURIComponent(workflowState.manifest.run_id)}/${encodeURIComponent(workflowState.manifest.cycle_id)}/${encodeURIComponent(id)}`,
    producer: "workbench-browser-events",
    created_at: createdAt,
    metadata: fact
  };
  const manifest = appendRunEvent(workflowState.manifest, {
    id: `event-${id}`,
    type: "workbench_browser_events_run",
    status: fact.status,
    artifact_id: id,
    message: `workbench browser events ${fact.status}`,
    created_at: createdAt,
    metadata: fact
  });
  const manifestArtifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  const baseLedger = workflowState.artifact_ledger || workflowState.artifactLedger || {};
  const artifactLedger = recordArtifact({
    ...baseLedger,
    artifacts: Array.isArray(baseLedger.artifacts) ? baseLedger.artifacts : []
  }, recordedArtifact);

  return {
    status: "pass",
    fact,
    artifact: recordedArtifact,
    workflow_state: {
      ...workflowState,
      manifest: {
        ...manifest,
        artifacts: [...manifestArtifacts, recordedArtifact]
      },
      artifact_ledger: artifactLedger
    }
  };
}
