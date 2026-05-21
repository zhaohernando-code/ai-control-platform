import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { recordArtifact } from "./artifact-ledger.js";
import { publishWorkbenchSnapshot, snapshotIssues } from "./workbench-snapshots.js";
import { createWorkbenchProjection } from "./workbench-projection.js";
import { validateWorkbenchProjectionSchema } from "./workbench-projection-schema.js";
import { appendRunEvent } from "./run-manifest.js";

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function defaultHistoryPath(root) {
  return resolve(root, "docs/examples/projection-history.json");
}

function defaultSnapshotsRoot(root) {
  return resolve(root, "docs/examples/snapshots");
}

function isWithinPath(basePath, filePath) {
  return filePath === basePath || filePath.startsWith(`${basePath}/`);
}

function readJsonOrNull(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function platformRootIssues(root) {
  const manifest = readJsonOrNull(resolve(root, "project-manifest.json"));
  if (manifest?.project_id !== "ai-control-platform" || manifest?.project_type !== "platform-core") {
    return ["closeout runner root must be ai-control-platform platform repo"];
  }
  return [];
}

function localOutputPathIssues(root, historyPath, snapshotsRoot) {
  const issues = [];
  const resolvedHistoryPath = resolve(historyPath);
  const resolvedSnapshotsRoot = resolve(snapshotsRoot);
  if (!isWithinPath(root, resolvedHistoryPath)) {
    issues.push("closeout history path must stay under the platform repo root");
  }
  if (!isWithinPath(root, resolvedSnapshotsRoot)) {
    issues.push("closeout snapshots root must stay under the platform repo root");
  }
  return issues;
}

function extractSnapshotPublishPlan(input = {}) {
  if (!isObject(input)) return null;
  if (input.action === "publish_workbench_snapshot") return input;
  return isObject(input.snapshot_publish_plan) ? input.snapshot_publish_plan : null;
}

function snapshotPlanIssues(plan = {}) {
  const issues = [];
  if (!isObject(plan)) {
    return ["snapshot_publish_plan must be an object"];
  }
  if (plan.action !== "publish_workbench_snapshot") {
    issues.push("snapshot_publish_plan.action must be publish_workbench_snapshot");
  }
  if (normalizeString(plan.endpoint) !== "/api/workbench/snapshots") {
    issues.push("snapshot_publish_plan.endpoint must be /api/workbench/snapshots");
  }
  return [...issues, ...snapshotIssues(plan)];
}

function normalizedSnapshotId(plan) {
  return normalizeString(plan?.id);
}

function evidencePath(result = {}, options = {}) {
  if (!result.snapshot_path) return "";
  const root = resolve(options.root || process.cwd());
  const snapshotPath = resolve(result.snapshot_path);
  return isWithinPath(root, snapshotPath) ? relative(root, snapshotPath) : "";
}

function closeoutArtifact(plan = {}, result = {}, options = {}) {
  const id = normalizedSnapshotId(plan) || normalizeString(result.item?.id) || "unknown";
  const status = result.status === "created" ? "pass" : "fail";
  const path = evidencePath(result, options);
  return {
    id: `closeout-snapshot-${id}`,
    type: "evaluation",
    status,
    path: path || undefined,
    uri: path ? undefined : `workbench://snapshot/${id}`,
    producer: "closeout-runner",
    created_at: options.created_at || new Date().toISOString(),
    metadata: {
      snapshot_id: id,
      mode: result.mode || options.mode || "unknown",
      closeout_status: result.status,
      response_status: result.response_status,
      projection_status: result.projection?.status,
      issues: result.issues || []
    }
  };
}

function recordCloseoutEvidence(workflowState = {}, result = {}, options = {}) {
  if (!isObject(workflowState)) return workflowState;
  const plan = options.plan || {};
  const artifact = closeoutArtifact(plan, result, options);
  const manifest = appendRunEvent(workflowState.manifest || {}, {
    id: `event-${artifact.id}`,
    type: "closeout_snapshot_publish",
    status: result.status,
    artifact_id: artifact.id,
    snapshot_id: artifact.metadata.snapshot_id,
    message: result.status === "created" ? "workbench snapshot published" : "workbench snapshot publish failed",
    created_at: artifact.created_at,
    metadata: artifact.metadata
  });
  const manifestArtifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
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
      artifacts: [...manifestArtifacts.filter((item) => item.id !== artifact.id), artifact]
    },
    artifact_ledger: artifactLedger
  };
}

function modeIssues(mode) {
  return ["local", "http"].includes(mode) ? [] : ["closeout runner mode must be local or http"];
}

async function publishSnapshotOverHttp(plan, options = {}) {
  const baseUrl = normalizeString(options.baseUrl);
  const endpoint = normalizeString(plan.endpoint) || "/api/workbench/snapshots";
  const fetchImpl = options.fetch || globalThis.fetch;
  if (!baseUrl) {
    return { status: "fail", issues: ["baseUrl is required for http closeout publishing"] };
  }
  if (typeof fetchImpl !== "function") {
    return { status: "fail", issues: ["fetch implementation is required for http closeout publishing"] };
  }

  const response = await fetchImpl(new URL(endpoint, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(plan)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      status: "fail",
      issues: payload.issues || [payload.error || `snapshot publish failed with status ${response.status}`],
      response_status: response.status
    };
  }
  const expectedProjection = createWorkbenchProjection(plan.input || plan.workflow_state || plan.workflowState);
  const projectionValidation = validateWorkbenchProjectionSchema(payload.projection);
  const id = normalizedSnapshotId(plan);

  if (payload.status !== "created" || !isObject(payload.item) || payload.item.id !== id || !isObject(payload.projection)) {
    return {
      status: "fail",
      issues: ["snapshot API response must include created status, matching item, and projection"],
      response_status: response.status
    };
  }
  if (projectionValidation.status !== "pass") {
    return {
      status: "fail",
      issues: ["snapshot API response projection must pass workbench projection schema"],
      response_status: response.status
    };
  }
  if (
    payload.projection.run_id !== expectedProjection.run_id ||
    payload.projection.cycle_id !== expectedProjection.cycle_id ||
    payload.projection.status !== expectedProjection.status
  ) {
    return {
      status: "fail",
      issues: ["snapshot API response projection must match the submitted workflow state"],
      response_status: response.status
    };
  }
  return {
    mode: "http",
    status: payload.status,
    issues: [],
    item: payload.item,
    projection: payload.projection,
    response_status: response.status
  };
}

async function executeSnapshotPublishPlan(plan = {}, options = {}) {
  const mode = options.mode || "local";
  const issues = [...modeIssues(mode), ...snapshotPlanIssues(plan)];
  if (issues.length > 0) {
    return { status: "fail", issues };
  }

  if (mode === "http") {
    return publishSnapshotOverHttp(plan, options);
  }

  const root = resolve(options.root || process.cwd());
  const rootIssues = platformRootIssues(root);
  if (rootIssues.length > 0) {
    return { status: "fail", issues: rootIssues };
  }
  const historyPath = resolve(options.historyPath || defaultHistoryPath(root));
  const snapshotsRoot = resolve(options.snapshotsRoot || defaultSnapshotsRoot(root));
  const outputPathIssues = localOutputPathIssues(root, historyPath, snapshotsRoot);
  if (outputPathIssues.length > 0) {
    return { status: "fail", issues: outputPathIssues };
  }

  const result = publishWorkbenchSnapshot(plan, {
    root,
    historyPath,
    snapshotsRoot
  });

  return {
    mode: "local",
    status: result.status,
    issues: result.issues,
    item: result.item,
    projection: result.projection,
    snapshot_path: result.snapshot_path
  };
}

async function runCloseoutPlan(input = {}, options = {}) {
  const plan = extractSnapshotPublishPlan(input);
  if (!plan) {
    return {
      status: "fail",
      issues: ["snapshot_publish_plan is required for autonomous closeout publishing"]
    };
  }
  const result = await executeSnapshotPublishPlan(plan, options);
  return {
    ...result,
    workflow_state: recordCloseoutEvidence(plan.input || plan.workflow_state || plan.workflowState, result, {
      ...options,
      plan
    })
  };
}

function readCloseoutInput(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export {
  executeSnapshotPublishPlan,
  extractSnapshotPublishPlan,
  readCloseoutInput,
  recordCloseoutEvidence,
  runCloseoutPlan,
  localOutputPathIssues,
  platformRootIssues,
  snapshotPlanIssues
};
