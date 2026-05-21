import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { createWorkbenchProjection } from "./workbench-projection.js";

function normalizeString(value) {
  return String(value || "").trim();
}

function isWithinPath(basePath, filePath) {
  return filePath === basePath || filePath.startsWith(`${basePath}/`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
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
  const filePath = snapshotPath(snapshotsRoot, input.id);
  const history = readJson(historyPath);
  const item = {
    id: input.id,
    label: input.label || input.id,
    input_path: relative(root, filePath),
    projection_path: null,
    created_at: input.created_at || new Date().toISOString(),
    status: projection.status
  };
  const nextHistory = historyWithSnapshot(history, item);

  mkdirSync(snapshotsRoot, { recursive: true });
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

export { historyWithSnapshot, safeSnapshotId, snapshotIssues, snapshotPath };
