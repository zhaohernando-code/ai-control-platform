import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import { createWorkbenchProjection } from "./workbench-projection.js";
import { validateWorkbenchProjectionSchema } from "./workbench-projection-schema.js";

function normalizeString(value) {
  return String(value || "").trim();
}

function isWithinPath(basePath, filePath) {
  return filePath === basePath || filePath.startsWith(`${basePath}/`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readHistory(path) {
  try {
    return readJson(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { version: "projection-history.v1", latest: null, items: [] };
    }
    throw error;
  }
}

function safeSnapshotId(id) {
  return typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/.test(id.trim());
}

function snapshotIssues(input = {}) {
  const issues = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return ["snapshot request must be an object"];
  }
  if (!safeSnapshotId(input.id)) {
    issues.push("id must be a safe snapshot id");
  }
  const workflowState = input.input || input.workflow_state || input.workflowState;
  if (!workflowState || typeof workflowState !== "object" || Array.isArray(workflowState)) {
    issues.push("input must be a workflow state object");
  }
  return issues;
}

function historyWithSnapshot(history, item) {
  const items = Array.isArray(history.items) ? history.items.filter((entry) => entry.id !== item.id) : [];
  return {
    version: history.version || "projection-history.v1",
    latest: item.id,
    items: [item, ...items]
  };
}

function snapshotPath(snapshotsRoot, id) {
  const filePath = resolve(snapshotsRoot, `${id}.workbench-input.json`);
  if (!isWithinPath(snapshotsRoot, filePath)) {
    const error = new Error("snapshot path must stay under snapshot root");
    error.code = "INVALID_HISTORY_PATH";
    throw error;
  }
  return filePath;
}

function projectionPublishIssues(projection) {
  const schemaValidation = validateWorkbenchProjectionSchema(projection);
  const issues = [];
  if (schemaValidation.status !== "pass") {
    issues.push(...schemaValidation.issues.map((item) => `projection schema invalid: ${item.message}`));
  }
  if (projection?.input_validation?.status !== "pass") {
    issues.push("projection input validation must pass before snapshot publish");
  }
  if (projection?.manifest?.status !== "pass") {
    issues.push("projection manifest validation must pass before snapshot publish");
  }
  if (projection?.operator_events?.status !== "pass") {
    issues.push("operator events must apply before snapshot publish");
  }
  return issues;
}

export function publishWorkbenchSnapshot(input = {}, options = {}) {
  const issues = snapshotIssues(input);
  if (issues.length > 0) {
    return {
      status: "fail",
      issues,
      item: null,
      projection: null
    };
  }

  const root = resolve(options.root || process.cwd());
  const historyPath = resolve(options.historyPath);
  const snapshotsRoot = resolve(options.snapshotsRoot);
  const workflowState = input.input || input.workflow_state || input.workflowState;
  const projection = createWorkbenchProjection(workflowState);
  const id = input.id.trim();
  const publishIssues = projectionPublishIssues(projection);
  if (publishIssues.length > 0) {
    return {
      status: "fail",
      issues: publishIssues,
      item: null,
      projection
    };
  }

  const filePath = snapshotPath(snapshotsRoot, id);
  const history = readHistory(historyPath);
  const item = {
    id,
    label: input.label || id,
    input_path: relative(root, filePath),
    projection_path: null,
    created_at: input.created_at || new Date().toISOString(),
    status: projection.status
  };
  const nextHistory = historyWithSnapshot(history, item);

  mkdirSync(snapshotsRoot, { recursive: true });
  mkdirSync(dirname(historyPath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(workflowState, null, 2)}\n`);
  writeFileSync(historyPath, `${JSON.stringify(nextHistory, null, 2)}\n`);

  return {
    status: "created",
    issues: [],
    item,
    projection,
    history: nextHistory,
    snapshot_path: filePath
  };
}

export { historyWithSnapshot, projectionPublishIssues, safeSnapshotId, snapshotIssues, snapshotPath };
