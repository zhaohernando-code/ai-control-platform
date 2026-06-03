import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { recordArtifact } from "./artifact-ledger.js";
import { appendRunEvent } from "./run-manifest.js";
import { publishWorkbenchSnapshot, snapshotPath } from "./workbench-snapshots.js";

const HEADLESS_CLI_ORCHESTRATOR_VERSION = "headless-cli-orchestrator.v1";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function issue(code, message, path) {
  return { code, message, path };
}

function safeIdPart(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

export function snapshotPersistenceConfig(options = {}) {
  const historyPath = normalizeString(options.projection_history_path || options.projectionHistoryPath || options.history_path || options.historyPath);
  const snapshotsRoot = normalizeString(options.snapshots_root || options.snapshotsRoot);
  if (!historyPath && !snapshotsRoot) {
    return {
      status: "not_configured",
      issues: []
    };
  }
  const issues = [];
  if (!historyPath) {
    issues.push(issue("missing_projection_history_path", "projection history path is required when headless snapshot persistence is configured", "projection_history_path"));
  }
  if (!snapshotsRoot) {
    issues.push(issue("missing_snapshots_root", "snapshots root is required when headless snapshot persistence is configured", "snapshots_root"));
  }
  return {
    status: issues.length ? "fail" : "configured",
    issues,
    root: normalizeString(options.root) || process.cwd(),
    history_path: historyPath,
    snapshots_root: snapshotsRoot
  };
}

function headlessSnapshotId(workflowState = {}, options = {}) {
  const explicit = normalizeString(options.snapshot_id || options.snapshotId);
  if (explicit) return safeIdPart(explicit).slice(0, 80);
  const prefix = normalizeString(options.snapshot_prefix || options.snapshotPrefix) || "headless-cli";
  return `${safeIdPart(prefix)}-${safeIdPart(workflowState?.manifest?.cycle_id)}`.slice(0, 80);
}

function headlessSnapshotArtifact(snapshotId, result = {}, options = {}) {
  const createdAt = normalizeString(options.created_at || options.createdAt) || new Date().toISOString();
  const status = result.status === "created" ? "pass" : "fail";
  return {
    id: `headless-cli-snapshot-${snapshotId}`,
    type: "evaluation",
    status,
    path: result.item?.input_path || undefined,
    uri: result.item?.input_path ? undefined : `workbench://snapshot/${snapshotId}`,
    producer: "headless-cli-orchestrator",
    created_at: createdAt,
    metadata: {
      version: HEADLESS_CLI_ORCHESTRATOR_VERSION,
      type: "headless_cli_snapshot_publish",
      snapshot_id: snapshotId,
      publish_status: result.status,
      projection_status: result.projection?.status || null,
      history_latest: result.history?.latest || null,
      issues: result.issues || []
    }
  };
}

function readExistingFile(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function restoreFile(path, content) {
  if (content === null) {
    rmSync(path, { force: true });
    return;
  }
  writeFileSync(path, content);
}

function rollbackInitialSnapshotPublish(paths = {}) {
  restoreFile(paths.snapshot_path, paths.snapshot_content);
  restoreFile(paths.history_path, paths.history_content);
}

function recordHeadlessSnapshotEvidence(workflowState = {}, snapshotId, result = {}, options = {}) {
  const artifact = headlessSnapshotArtifact(snapshotId, result, options);
  const manifest = appendRunEvent(workflowState.manifest, {
    id: `event-${artifact.id}`,
    type: "headless_cli_snapshot_publish",
    status: result.status === "created" ? "created" : "fail",
    artifact_id: artifact.id,
    snapshot_id: snapshotId,
    message: result.status === "created"
      ? "headless CLI workflow snapshot published"
      : "headless CLI workflow snapshot publish failed",
    created_at: artifact.created_at,
    metadata: artifact.metadata
  });
  const baseLedger = workflowState.artifact_ledger || workflowState.artifactLedger || {};
  const artifactLedger = recordArtifact({
    ...baseLedger,
    artifacts: Array.isArray(baseLedger.artifacts)
      ? baseLedger.artifacts.filter((item) => item.id !== artifact.id)
      : []
  }, artifact);

  return {
    ...workflowState,
    manifest: {
      ...manifest,
      artifacts: [...asArray(manifest.artifacts).filter((item) => item.id !== artifact.id), artifact]
    },
    artifact_ledger: artifactLedger
  };
}

export function publishHeadlessWorkflowSnapshot(workflowState = {}, options = {}) {
  const config = snapshotPersistenceConfig(options);
  if (config.status !== "configured") {
    return {
      status: config.status,
      issues: config.issues,
      workflow_state: workflowState
    };
  }

  const snapshotId = headlessSnapshotId(workflowState, options);
  const publishSnapshot = typeof options.publish_workbench_snapshot === "function"
    ? options.publish_workbench_snapshot
    : publishWorkbenchSnapshot;
  const plannedSnapshotPath = snapshotPath(config.snapshots_root, snapshotId);
  const rollbackState = {
    snapshot_path: plannedSnapshotPath,
    snapshot_content: readExistingFile(plannedSnapshotPath),
    history_path: config.history_path,
    history_content: readExistingFile(config.history_path)
  };
  const basePlan = {
    id: snapshotId,
    label: normalizeString(options.snapshot_label || options.snapshotLabel) || "Headless CLI orchestrator cycle",
    input: workflowState,
    created_at: normalizeString(options.created_at || options.createdAt) || new Date().toISOString()
  };
  const initial = publishSnapshot(basePlan, {
    root: config.root,
    historyPath: config.history_path,
    snapshotsRoot: config.snapshots_root
  });
  if (initial.status !== "created") {
    return {
      status: "fail",
      issues: initial.issues || [],
      item: initial.item,
      projection: initial.projection,
      workflow_state: workflowState,
      initial_publish: initial
    };
  }

  const evidencedWorkflowState = recordHeadlessSnapshotEvidence(workflowState, snapshotId, initial, options);
  const evidence = publishSnapshot({
    ...basePlan,
    input: evidencedWorkflowState
  }, {
    root: config.root,
    historyPath: config.history_path,
    snapshotsRoot: config.snapshots_root
  });
  if (evidence.status !== "created") {
    let rollbackError = null;
    try {
      rollbackInitialSnapshotPublish(rollbackState);
    } catch (error) {
      rollbackError = error?.message || String(error);
    }
    return {
      status: "fail",
      issues: rollbackError
        ? [...asArray(evidence.issues), `initial snapshot rollback failed: ${rollbackError}`]
        : evidence.issues || [],
      item: evidence.item,
      projection: evidence.projection,
      workflow_state: evidencedWorkflowState,
      initial_publish: initial,
      evidence_snapshot_publish: evidence,
      initial_publish_rolled_back: rollbackError ? false : true
    };
  }

  return {
    status: "created",
    issues: [],
    item: evidence.item,
    projection: evidence.projection,
    workflow_state: evidencedWorkflowState,
    snapshot_path: evidence.snapshot_path,
    history: evidence.history,
    initial_publish: initial,
    evidence_snapshot_publish: evidence
  };
}
