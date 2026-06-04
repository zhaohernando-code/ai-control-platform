import { isAbsolute, resolve, relative } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

import { createWorkbenchProjection } from "../src/workflow/workbench-projection.js";
import {
  isSqliteSnapshotPath,
  mergeProjectStatusHistory,
  sqliteSnapshotIdFromInputPath
} from "../src/workflow/workbench-state-store.js";

const root = resolve(process.cwd());
const historyPath = resolve(root, "docs/examples/projection-history.json");
const defaultEventsPath = resolve(root, "docs/examples/operator-events.json");
const defaultProjectStatusPath = resolve(root, "PROJECT_STATUS.json");
const examplesRoot = resolve(root, "docs/examples");
const defaultSnapshotsRoot = resolve(root, "tmp/workbench-snapshots");
const defaultStateDbPath = resolve(process.env.HOME || "/Users/hernando_zhao", "codex/runtime/ai-control-platform/workbench-state/workbench-state.sqlite");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readProjectStatus(projectStatusPath = null, stateStore = null) {
  if (stateStore) return stateStore.readProjectStatus();
  return projectStatusPath ? readJson(projectStatusPath) : null;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function writeProjectStatusState(projectStatusPath = null, projectStatus = {}, stateStore = null) {
  if (stateStore) return stateStore.writeProjectStatus(projectStatus);
  if (!projectStatusPath) return null;
  return writeJson(projectStatusPath, projectStatus);
}

/**
 * Create an initial workflow state with all required identity fields and
 * validation contracts (manifest/artifact_ledger run_id/cycle_id, model_plan,
 * operator_event_ledger). Used when there is no existing workflow snapshot
 * to bootstrap from.
 */
function createInitialWorkflowState(runId, cycleId, projectStatusPath = null, stateStore = null) {
  return {
    run_id: runId,
    cycle_id: cycleId,
    status: "pending",
    manifest: {
      run_id: runId,
      cycle_id: cycleId,
      events: [],
      artifacts: []
    },
    artifact_ledger: {
      run_id: runId,
      cycle_id: cycleId,
      artifacts: []
    },
    model_plan: {
      selected_model: "deepseek-v4-pro[1m]",
      routes: []
    },
    reviewer_gate: { findings: [] },
    operator_event_ledger: {
      run_id: runId,
      cycle_id: cycleId,
      events: []
    },
    project_status: readProjectStatus(projectStatusPath, stateStore) || {}
  };
}

function projectStatusFromHistory(history = {}, selectedId = "", allowedRoots = [examplesRoot, defaultSnapshotsRoot], stateStore = null) {
  const items = Array.isArray(history.items) ? [...history.items].reverse() : [];
  const statuses = [];
  for (const item of items) {
    if (!item?.input_path) continue;
    try {
      const workflowState = readWorkflowStateFromItem(item, allowedRoots, stateStore);
      if (workflowState?.project_status || workflowState?.projectStatus) {
        statuses.push(workflowState.project_status || workflowState.projectStatus);
      }
    } catch {
      // Stale history entries should not prevent the current projection from rendering.
    }
    if (selectedId && item.id === selectedId) break;
  }
  return mergeProjectStatusHistory(...statuses);
}

function projectionInputWithProjectStatus(input = {}, projectStatusPath = null, stateStore = null, context = {}) {
  const projectStatus = readProjectStatus(projectStatusPath, stateStore);
  const historicalProjectStatus = context.history
    ? projectStatusFromHistory(context.history, context.selectedId || context.selected_id, context.allowedRoots, stateStore)
    : null;
  const mergedProjectStatus = mergeProjectStatusHistory(
    historicalProjectStatus,
    input.project_status || input.projectStatus,
    projectStatus
  );
  const agentKeyHealth = stateStore && typeof stateStore.summarizeAgentRegistry === "function"
    ? stateStore.summarizeAgentRegistry()
    : input.agent_key_health || input.agentKeyHealth;
  if (Object.keys(mergedProjectStatus).length === 0) return agentKeyHealth ? { ...input, agent_key_health: agentKeyHealth } : input;
  return {
    ...input,
    project_status: mergedProjectStatus,
    global_goals: Array.isArray(mergedProjectStatus.global_goals) ? mergedProjectStatus.global_goals : input.global_goals,
    agent_key_health: agentKeyHealth
  };
}

function isWithinPath(basePath, filePath) {
  return filePath === basePath || filePath.startsWith(`${basePath}/`);
}

function historyItemPath(itemPath, field, allowedRoots = [examplesRoot, defaultSnapshotsRoot]) {
  if (!itemPath) return null;
  if (typeof itemPath !== "string" || isAbsolute(itemPath)) {
    const error = new Error(`${field} must be a relative workbench history path`);
    error.code = "INVALID_HISTORY_PATH";
    throw error;
  }

  const filePath = resolve(root, itemPath);
  if (!allowedRoots.some((allowedRoot) => isWithinPath(allowedRoot, filePath))) {
    const error = new Error(`${field} must stay under allowed workbench history roots`);
    error.code = "INVALID_HISTORY_PATH";
    throw error;
  }

  return filePath;
}

function readWorkflowStateFromItem(item = {}, allowedRoots = [examplesRoot, defaultSnapshotsRoot], stateStore = null) {
  if (stateStore) {
    if (isSqliteSnapshotPath(item.input_path)) {
      return stateStore.readWorkflowSnapshot(sqliteSnapshotIdFromInputPath(item.input_path));
    }
    return requireSqliteWorkflowSnapshot();
  }
  return readJson(historyItemPath(item.input_path, "input_path", allowedRoots));
}

function writeWorkflowStateToItem(item = {}, workflowState = {}, allowedRoots = [examplesRoot, defaultSnapshotsRoot], stateStore = null) {
  if (stateStore) {
    if (isSqliteSnapshotPath(item.input_path)) {
      return stateStore.writeWorkflowSnapshot(sqliteSnapshotIdFromInputPath(item.input_path), workflowState, item);
    }
    return requireSqliteWorkflowSnapshot();
  }
  const inputPath = historyItemPath(item.input_path, "input_path", allowedRoots);
  writeJson(inputPath, workflowState);
  return inputPath;
}

function projectionById(id = null, history = readJson(historyPath), allowedRoots = [examplesRoot, defaultSnapshotsRoot], projectStatusPath = null, stateStore = null) {
  const selectedId = id || history.latest;
  const item = history.items.find((entry) => entry.id === selectedId);

  // If no item found and history is empty, generate initial projection for new submissions
  if (!item) {
    if (history.items.length === 0 && !selectedId) {
      // First-time state: empty history, create initial projection
      const runId = `initial-workbench-${Date.now()}`;
      const cycleId = `initial-cycle-${Date.now()}`;
      const initialWorkflowState = createInitialWorkflowState(runId, cycleId, projectStatusPath, stateStore);
      return {
        history,
        item: null,
        projection: createWorkbenchProjection(initialWorkflowState)
      };
    }

    const error = new Error(`projection not found: ${selectedId}`);
    error.code = "PROJECTION_NOT_FOUND";
    throw error;
  }

  return {
    history,
    item,
    projection: item.input_path
      ? createWorkbenchProjection(projectionInputWithProjectStatus(readWorkflowStateFromItem(item, allowedRoots, stateStore), projectStatusPath, stateStore, {
        history,
        selectedId,
        allowedRoots
      }))
      : stateStore
        ? requireSqliteWorkflowSnapshot()
        : readJson(historyItemPath(item.projection_path, "projection_path", allowedRoots))
  };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function safeSnapshotIdPart(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "snapshot";
}

function requireSqliteWorkflowSnapshot() {
  const error = new Error("SQLite workbench state requires workflow snapshots");
  error.code = "WORKFLOW_SNAPSHOT_REQUIRED";
  throw error;
}

function normalizeEvent(input = {}, projectionId = null) {
  const createdAt = input.created_at || new Date().toISOString();
  return {
    id: input.id || `operator-event-${createdAt}`,
    type: typeof input.type === "string" && input.type.trim() ? input.type.trim() : "operator_action",
    action: input.action.trim(),
    projection_id: input.projection_id || projectionId || null,
    run_id: input.run_id.trim(),
    cycle_id: input.cycle_id.trim(),
    created_at: createdAt,
    metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {}
  };
}

function operatorEventIssues(input = {}) {
  const issues = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return ["event must be an object"];
  }
  for (const field of ["action", "run_id", "cycle_id"]) {
    if (typeof input[field] !== "string" || !input[field].trim()) {
      issues.push(`${field} is required`);
    }
  }
  if (input.metadata !== undefined && (!input.metadata || typeof input.metadata !== "object" || Array.isArray(input.metadata))) {
    issues.push("metadata must be an object when provided");
  }
  return issues;
}

function readEvents(eventsPath, stateStore = null) {
  return stateStore ? stateStore.readEvents() : readJson(eventsPath);
}

function appendEvent(eventsPath, event, stateStore = null) {
  const ledger = readEvents(eventsPath, stateStore);
  const nextLedger = {
    version: ledger.version || "operator-events.v1",
    events: [...(Array.isArray(ledger.events) ? ledger.events : []), event]
  };
  if (stateStore) stateStore.writeEvents(nextLedger);
  else writeJson(eventsPath, nextLedger);
  return nextLedger;
}

export {
  appendEvent,
  asArray,
  createInitialWorkflowState,
  defaultEventsPath,
  defaultProjectStatusPath,
  defaultSnapshotsRoot,
  defaultStateDbPath,
  examplesRoot,
  historyPath,
  historyItemPath,
  isWithinPath,
  normalizeEvent,
  normalizeString,
  operatorEventIssues,
  projectionById,
  projectionInputWithProjectStatus,
  readEvents,
  readJson,
  readProjectStatus,
  readWorkflowStateFromItem,
  requireSqliteWorkflowSnapshot,
  root,
  safeSnapshotIdPart,
  writeJson,
  writeProjectStatusState,
  writeWorkflowStateToItem
};
