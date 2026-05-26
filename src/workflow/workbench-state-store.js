import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";

import { createWorkbenchProjection } from "./workbench-projection.js";
import {
  historyWithSnapshot,
  projectionPublishIssues,
  snapshotIssues
} from "./workbench-snapshots.js";

export const WORKBENCH_STATE_STORE_VERSION = "workbench-state-store.sqlite.v1";
export const SQLITE_SNAPSHOT_PREFIX = "sqlite://workflow-snapshot/";

function normalizeString(value) {
  return String(value || "").trim();
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sqlString(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function runSql(dbPath, sql, options = {}) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const result = spawnSync(options.sqliteBin || "sqlite3", [dbPath], {
    input: sql,
    encoding: "utf8",
    maxBuffer: options.maxBuffer || 20 * 1024 * 1024
  });
  if (result.status !== 0) {
    const error = new Error(normalizeString(result.stderr) || "sqlite3 command failed");
    error.code = "SQLITE_STATE_STORE_FAILED";
    error.stderr = result.stderr;
    error.stdout = result.stdout;
    throw error;
  }
  return result.stdout;
}

function queryRows(dbPath, sql, options = {}) {
  const result = spawnSync(options.sqliteBin || "sqlite3", ["-json", dbPath], {
    input: sql,
    encoding: "utf8",
    maxBuffer: options.maxBuffer || 20 * 1024 * 1024
  });
  if (result.status !== 0) {
    const error = new Error(normalizeString(result.stderr) || "sqlite3 query failed");
    error.code = "SQLITE_STATE_STORE_FAILED";
    error.stderr = result.stderr;
    error.stdout = result.stdout;
    throw error;
  }
  const output = normalizeString(result.stdout);
  return output ? JSON.parse(output) : [];
}

function nowIso() {
  return new Date().toISOString();
}

function schemaSql() {
  return `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS workbench_kv (
  key TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_snapshots (
  id TEXT PRIMARY KEY,
  item_json TEXT NOT NULL,
  workflow_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS workflow_snapshots_updated_at_idx ON workflow_snapshots(updated_at);
`;
}

function defaultHistory() {
  return { version: "projection-history.v1", latest: null, items: [] };
}

function defaultEvents() {
  return { version: "operator-events.v1", events: [] };
}

export function isSqliteSnapshotPath(inputPath = "") {
  return normalizeString(inputPath).startsWith(SQLITE_SNAPSHOT_PREFIX);
}

export function sqliteSnapshotInputPath(id = "") {
  return `${SQLITE_SNAPSHOT_PREFIX}${encodeURIComponent(normalizeString(id))}`;
}

export function sqliteSnapshotIdFromInputPath(inputPath = "") {
  const value = normalizeString(inputPath);
  if (!isSqliteSnapshotPath(value)) return "";
  return decodeURIComponent(value.slice(SQLITE_SNAPSHOT_PREFIX.length));
}

export function createSqliteWorkbenchStateStore(options = {}) {
  const dbPath = resolve(options.dbPath || options.db_path);
  const sqliteBin = options.sqliteBin || options.sqlite_bin || "sqlite3";
  runSql(dbPath, schemaSql(), { sqliteBin });

  const readKey = (key, fallbackValue = null) => {
    const rows = queryRows(dbPath, `SELECT json FROM workbench_kv WHERE key = ${sqlString(key)} LIMIT 1;`, { sqliteBin });
    if (!rows[0]) return fallbackValue;
    return JSON.parse(rows[0].json);
  };

  const writeKey = (key, value, updatedAt = nowIso()) => {
    runSql(dbPath, `
INSERT INTO workbench_kv(key, json, updated_at)
VALUES (${sqlString(key)}, ${sqlString(JSON.stringify(value))}, ${sqlString(updatedAt)})
ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at;
`, { sqliteBin });
    return value;
  };

  const readHistory = () => readKey("projection_history", defaultHistory());
  const writeHistory = (history) => writeKey("projection_history", history);
  const readProjectStatus = () => readKey("project_status", null);
  const writeProjectStatus = (projectStatus) => writeKey("project_status", projectStatus);
  const readEvents = () => readKey("operator_events", defaultEvents());
  const writeEvents = (events) => writeKey("operator_events", events);

  const readWorkflowSnapshot = (id) => {
    const rows = queryRows(dbPath, `SELECT workflow_json FROM workflow_snapshots WHERE id = ${sqlString(id)} LIMIT 1;`, { sqliteBin });
    if (!rows[0]) {
      const error = new Error(`workflow snapshot not found: ${id}`);
      error.code = "WORKFLOW_SNAPSHOT_NOT_FOUND";
      throw error;
    }
    return JSON.parse(rows[0].workflow_json);
  };

  const writeWorkflowSnapshot = (id, workflowState, item = null, updatedAt = nowIso()) => {
    const existingRows = queryRows(dbPath, `SELECT item_json, created_at FROM workflow_snapshots WHERE id = ${sqlString(id)} LIMIT 1;`, { sqliteBin });
    const createdAt = item?.created_at || existingRows[0]?.created_at || updatedAt;
    const itemJson = item || (existingRows[0] ? JSON.parse(existingRows[0].item_json) : {
      id,
      label: id,
      input_path: sqliteSnapshotInputPath(id),
      projection_path: null,
      created_at: createdAt,
      status: createWorkbenchProjection(workflowState).status
    });
    runSql(dbPath, `
INSERT INTO workflow_snapshots(id, item_json, workflow_json, created_at, updated_at)
VALUES (${sqlString(id)}, ${sqlString(JSON.stringify(itemJson))}, ${sqlString(JSON.stringify(workflowState))}, ${sqlString(createdAt)}, ${sqlString(updatedAt)})
ON CONFLICT(id) DO UPDATE SET
  item_json = excluded.item_json,
  workflow_json = excluded.workflow_json,
  updated_at = excluded.updated_at;
`, { sqliteBin });
    return { item: itemJson, workflow_state: workflowState };
  };

  const seedWorkflowSnapshotsFromHistory = (history, seedRoot) => {
    if (!seedRoot) return history;
    const items = Array.isArray(history.items) ? history.items : [];
    const rewrittenItems = items.map((item) => {
      if (!item?.input_path || isSqliteSnapshotPath(item.input_path)) return item;
      const sourcePath = resolve(seedRoot, item.input_path);
      if (!existsSync(sourcePath)) return item;
      const workflowState = readJsonFile(sourcePath);
      const nextItem = {
        ...item,
        input_path: sqliteSnapshotInputPath(item.id)
      };
      writeWorkflowSnapshot(item.id, workflowState, nextItem, item.created_at || nowIso());
      return nextItem;
    });
    return {
      version: history.version || "projection-history.v1",
      latest: history.latest || rewrittenItems[0]?.id || null,
      items: rewrittenItems
    };
  };

  const seedIfMissing = (key, path, fallbackValue) => {
    if (readKey(key, null) !== null) return;
    let value = path && existsSync(path) ? readJsonFile(path) : fallbackValue;
    if (key === "projection_history") {
      value = seedWorkflowSnapshotsFromHistory(value || defaultHistory(), options.seedRoot || process.cwd());
    }
    writeKey(key, value);
  };

  seedIfMissing("projection_history", options.seedHistoryPath, defaultHistory());
  seedIfMissing("project_status", options.seedProjectStatusPath, null);
  seedIfMissing("operator_events", options.seedEventsPath, defaultEvents());

  const publishSnapshot = (input = {}) => {
    const issues = snapshotIssues(input);
    if (issues.length > 0) {
      return { status: "fail", issues, item: null, projection: null };
    }
    const workflowState = input.input || input.workflow_state || input.workflowState;
    const projection = createWorkbenchProjection(workflowState);
    const publishIssues = projectionPublishIssues(projection);
    if (publishIssues.length > 0) {
      return { status: "fail", issues: publishIssues, item: null, projection };
    }
    const id = input.id.trim();
    const item = {
      id,
      label: input.label || id,
      input_path: sqliteSnapshotInputPath(id),
      projection_path: null,
      created_at: input.created_at || nowIso(),
      status: projection.status
    };
    writeWorkflowSnapshot(id, workflowState, item, item.created_at);
    const history = historyWithSnapshot(readHistory(), item);
    writeHistory(history);
    return {
      status: "created",
      issues: [],
      item,
      projection,
      history,
      snapshot_path: item.input_path
    };
  };

  return {
    version: WORKBENCH_STATE_STORE_VERSION,
    dbPath,
    readKey,
    writeKey,
    readHistory,
    writeHistory,
    readProjectStatus,
    writeProjectStatus,
    readEvents,
    writeEvents,
    readWorkflowSnapshot,
    writeWorkflowSnapshot,
    publishSnapshot
  };
}
