import { readFileSync, writeFileSync } from "node:fs";

function asArray(value) { return Array.isArray(value) ? value : []; }

export function normalizeString(value) { return String(value || "").trim(); }

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

export function readProjectStatus(projectStatusPath = null, stateStore = null) {
  if (stateStore) return stateStore.readProjectStatus();
  return projectStatusPath ? readJson(projectStatusPath) : null;
}

export function writeProjectStatusState(projectStatusPath = null, projectStatus = {}, stateStore = null) {
  if (stateStore) return stateStore.writeProjectStatus(projectStatus);
  if (!projectStatusPath) return null;
  return writeJson(projectStatusPath, projectStatus);
}

export function workflowStateWithProjectStatus(workflowState = {}, projectStatus = {}) {
  return {
    ...workflowState,
    project_status: projectStatus,
    global_goals: asArray(projectStatus.global_goals)
  };
}
