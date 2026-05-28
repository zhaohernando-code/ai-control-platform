import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";

export const DEFAULT_LIVE_WORKBENCH_STATE_DB = resolve(
  process.env.HOME || "/Users/hernando_zhao",
  "codex/runtime/ai-control-platform/workbench-state/workbench-state.sqlite"
);

export const DEFAULT_FORBIDDEN_LIVE_TEST_PATTERNS = [
  "WB_TEST_",
  "workbench-live-test",
  "cleanup-test",
  "Direct nonblocking verify",
  "Proxy nonblocking verify",
  "UI nonblocking submit",
  "requirement-Direct-nonblocking-verify",
  "requirement-Proxy-nonblocking-verify",
  "requirement-UI-nonblocking-submit"
];

function normalizeString(value) {
  return String(value || "").trim();
}

function sqlString(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function sqlite(dbPath, sql, options = {}) {
  if (options.write) {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const args = options.json ? ["-json", dbPath] : [dbPath];
  const result = spawnSync(options.sqliteBin || "sqlite3", args, {
    input: sql,
    encoding: "utf8",
    maxBuffer: options.maxBuffer || 50 * 1024 * 1024
  });
  if (result.status !== 0) {
    const error = new Error(normalizeString(result.stderr) || "sqlite3 command failed");
    error.code = "WORKBENCH_LIVE_STATE_SQLITE_FAILED";
    error.stderr = result.stderr;
    error.stdout = result.stdout;
    throw error;
  }
  return result.stdout;
}

function queryRows(dbPath, sql, options = {}) {
  const output = normalizeString(sqlite(dbPath, sql, { ...options, json: true }));
  return output ? JSON.parse(output) : [];
}

function parseJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function compilePatterns(patterns = DEFAULT_FORBIDDEN_LIVE_TEST_PATTERNS) {
  return patterns
    .map((pattern) => normalizeString(pattern))
    .filter(Boolean)
    .map((pattern) => pattern.toLowerCase());
}

function valueText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function matchesForbidden(value, compiledPatterns) {
  const text = valueText(value).toLowerCase();
  return compiledPatterns.some((pattern) => text.includes(pattern));
}

function issue(code, message, path, extra = {}) {
  return { code, message, path, gate_id: "workbench-live-state-cleanliness", ...extra };
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function inspectProjectStatus(projectStatus, path, compiledPatterns) {
  const issues = [];
  if (!isObject(projectStatus)) return issues;

  for (const [requirementId, review] of Object.entries(isObject(projectStatus.plan_reviews) ? projectStatus.plan_reviews : {})) {
    if (matchesForbidden(requirementId, compiledPatterns) || matchesForbidden(review, compiledPatterns)) {
      issues.push(issue(
        "live_state_test_data_residue",
        "live workbench project_status contains test requirement plan review residue",
        `${path}.plan_reviews.${requirementId}`,
        { requirement_id: requirementId }
      ));
    }
  }

  for (const [index, item] of asArray(projectStatus.requirement_intake?.items).entries()) {
    if (matchesForbidden(item, compiledPatterns)) {
      issues.push(issue(
        "live_state_test_data_residue",
        "live workbench project_status contains test requirement intake residue",
        `${path}.requirement_intake.items[${index}]`,
        { requirement_id: item?.id || null }
      ));
    }
  }

  for (const [index, goal] of asArray(projectStatus.global_goals || projectStatus.globalGoals).entries()) {
    if (matchesForbidden(goal, compiledPatterns)) {
      issues.push(issue(
        "live_state_test_data_residue",
        "live workbench project_status contains test global goal residue",
        `${path}.global_goals[${index}]`,
        { requirement_id: goal?.id || null }
      ));
    }
  }

  for (const [index, workPackage] of asArray(projectStatus.next_work_packages || projectStatus.nextWorkPackages).entries()) {
    if (matchesForbidden(workPackage, compiledPatterns)) {
      issues.push(issue(
        "live_state_test_data_residue",
        "live workbench project_status contains test work package residue",
        `${path}.next_work_packages[${index}]`,
        { work_package_id: workPackage?.id || null }
      ));
    }
  }

  return issues;
}

function inspectWorkflowState(workflowState, path, compiledPatterns) {
  const issues = [];
  if (!isObject(workflowState)) return issues;
  issues.push(...inspectProjectStatus(workflowState.project_status || workflowState.projectStatus, `${path}.project_status`, compiledPatterns));

  for (const [index, event] of asArray(workflowState.manifest?.events).entries()) {
    if (matchesForbidden(event, compiledPatterns)) {
      issues.push(issue(
        "live_state_test_data_residue",
        "live workbench workflow snapshot contains test manifest event residue",
        `${path}.manifest.events[${index}]`,
        { event_id: event?.id || null }
      ));
    }
  }

  for (const [index, workPackage] of asArray(workflowState.manifest?.work_packages || workflowState.manifest?.workPackages).entries()) {
    if (matchesForbidden(workPackage, compiledPatterns)) {
      issues.push(issue(
        "live_state_test_data_residue",
        "live workbench workflow snapshot contains test work package residue",
        `${path}.manifest.work_packages[${index}]`,
        { work_package_id: workPackage?.id || null }
      ));
    }
  }

  const artifacts = asArray(workflowState.artifact_ledger?.artifacts || workflowState.artifactLedger?.artifacts);
  for (const [index, artifact] of artifacts.entries()) {
    if (matchesForbidden(artifact, compiledPatterns)) {
      issues.push(issue(
        "live_state_test_data_residue",
        "live workbench workflow snapshot contains test artifact residue",
        `${path}.artifact_ledger.artifacts[${index}]`,
        { artifact_id: artifact?.id || null }
      ));
    }
  }

  return issues;
}

function readLiveState(dbPath, options = {}) {
  if (!existsSync(dbPath)) {
    return { exists: false, kv: [], snapshots: [] };
  }
  const kv = queryRows(
    dbPath,
    "SELECT key,json FROM workbench_kv WHERE key IN ('project_status','projection_history','operator_events');",
    options
  );
  const snapshots = queryRows(
    dbPath,
    "SELECT id,item_json,workflow_json FROM workflow_snapshots ORDER BY updated_at DESC;",
    options
  );
  return { exists: true, kv, snapshots };
}

export function inspectWorkbenchLiveStateCleanliness(options = {}) {
  const dbPath = resolve(options.dbPath || options.db_path || DEFAULT_LIVE_WORKBENCH_STATE_DB);
  const compiledPatterns = compilePatterns(options.forbiddenPatterns || options.forbidden_patterns);
  const state = readLiveState(dbPath, options);
  if (!state.exists) {
    return {
      status: "pass",
      gate_id: "workbench-live-state-cleanliness",
      checked: false,
      db_path: dbPath,
      issue_count: 0,
      issues: [],
      reason: "live workbench SQLite database does not exist"
    };
  }

  const issues = [];
  for (const row of state.kv) {
    const value = parseJson(row.json, null);
    if (row.key === "project_status") {
      issues.push(...inspectProjectStatus(value, "workbench_kv.project_status", compiledPatterns));
    } else if (row.key === "projection_history" && matchesForbidden(value, compiledPatterns)) {
      issues.push(issue(
        "live_state_test_data_residue",
        "live workbench projection history contains test residue",
        "workbench_kv.projection_history"
      ));
    } else if (row.key === "operator_events" && matchesForbidden(value, compiledPatterns)) {
      issues.push(issue(
        "live_state_test_data_residue",
        "live workbench operator events contain test residue",
        "workbench_kv.operator_events"
      ));
    }
  }

  for (const row of state.snapshots) {
    const item = parseJson(row.item_json, null);
    if (matchesForbidden(row.id, compiledPatterns) || matchesForbidden(item, compiledPatterns)) {
      issues.push(issue(
        "live_state_test_data_residue",
        "live workbench workflow snapshot item contains test residue",
        `workflow_snapshots.${row.id}.item_json`,
        { snapshot_id: row.id }
      ));
    }
    issues.push(...inspectWorkflowState(
      parseJson(row.workflow_json, null),
      `workflow_snapshots.${row.id}.workflow_json`,
      compiledPatterns
    ));
  }

  return {
    status: issues.length === 0 ? "pass" : "fail",
    gate_id: "workbench-live-state-cleanliness",
    checked: true,
    db_path: dbPath,
    issue_count: issues.length,
    issues
  };
}

function collectContaminatedRequirementIds(projectStatus, compiledPatterns) {
  const ids = new Set();
  if (!isObject(projectStatus)) return ids;
  for (const [requirementId, review] of Object.entries(isObject(projectStatus.plan_reviews) ? projectStatus.plan_reviews : {})) {
    if (matchesForbidden(requirementId, compiledPatterns) || matchesForbidden(review, compiledPatterns)) {
      ids.add(requirementId);
      if (review?.requirement_id) ids.add(review.requirement_id);
    }
  }
  for (const item of asArray(projectStatus.requirement_intake?.items)) {
    if (matchesForbidden(item, compiledPatterns) && item?.id) ids.add(item.id);
  }
  for (const goal of asArray(projectStatus.global_goals || projectStatus.globalGoals)) {
    if (matchesForbidden(goal, compiledPatterns) && goal?.id) ids.add(goal.id);
  }
  for (const workPackage of asArray(projectStatus.next_work_packages || projectStatus.nextWorkPackages)) {
    if (matchesForbidden(workPackage, compiledPatterns)) {
      const id = workPackage?.source?.requirement_id || workPackage?.source?.requirementId;
      if (id) ids.add(id);
    }
  }
  return ids;
}

function requirementIdMatches(value, ids) {
  if (!ids || ids.size === 0) return false;
  const text = valueText(value);
  return [...ids].some((id) => id && text.includes(id));
}

function shouldRemove(value, compiledPatterns, contaminatedIds) {
  return matchesForbidden(value, compiledPatterns) || requirementIdMatches(value, contaminatedIds);
}

function filterArray(value, compiledPatterns, contaminatedIds) {
  const before = asArray(value);
  const after = before.filter((item) => !shouldRemove(item, compiledPatterns, contaminatedIds));
  return { value: after, removed: before.length - after.length };
}

function cleanProjectStatus(projectStatus, compiledPatterns) {
  if (!isObject(projectStatus)) return { value: projectStatus, removed: 0, contaminatedIds: new Set() };
  const contaminatedIds = collectContaminatedRequirementIds(projectStatus, compiledPatterns);
  let removed = 0;
  const next = { ...projectStatus };

  if (isObject(next.plan_reviews)) {
    const nextReviews = {};
    for (const [requirementId, review] of Object.entries(next.plan_reviews)) {
      if (shouldRemove(requirementId, compiledPatterns, contaminatedIds) || shouldRemove(review, compiledPatterns, contaminatedIds)) {
        removed += 1;
      } else {
        nextReviews[requirementId] = review;
      }
    }
    next.plan_reviews = nextReviews;
  }

  if (isObject(next.requirement_intake)) {
    const filtered = filterArray(next.requirement_intake.items, compiledPatterns, contaminatedIds);
    removed += filtered.removed;
    const firstOpen = filtered.value[0]?.id || null;
    next.requirement_intake = {
      ...next.requirement_intake,
      items: filtered.value,
      active_requirement_id: shouldRemove(next.requirement_intake.active_requirement_id, compiledPatterns, contaminatedIds)
        ? firstOpen
        : next.requirement_intake.active_requirement_id,
      latest_requirement_id: shouldRemove(next.requirement_intake.latest_requirement_id, compiledPatterns, contaminatedIds)
        ? firstOpen
        : next.requirement_intake.latest_requirement_id
    };
  }

  for (const key of ["global_goals", "globalGoals", "next_work_packages", "nextWorkPackages"]) {
    if (Array.isArray(next[key])) {
      const filtered = filterArray(next[key], compiledPatterns, contaminatedIds);
      removed += filtered.removed;
      next[key] = filtered.value;
    }
  }

  return { value: next, removed, contaminatedIds };
}

function cleanWorkflowState(workflowState, compiledPatterns) {
  if (!isObject(workflowState)) return { value: workflowState, removed: 0 };
  let removed = 0;
  const next = { ...workflowState };
  const projectStatusCleaned = cleanProjectStatus(next.project_status || next.projectStatus, compiledPatterns);
  const contaminatedIds = projectStatusCleaned.contaminatedIds;
  removed += projectStatusCleaned.removed;
  if (next.project_status) next.project_status = projectStatusCleaned.value;
  if (next.projectStatus) next.projectStatus = projectStatusCleaned.value;

  if (isObject(next.manifest)) {
    const manifest = { ...next.manifest };
    for (const key of ["events", "work_packages", "workPackages"]) {
      if (Array.isArray(manifest[key])) {
        const filtered = filterArray(manifest[key], compiledPatterns, contaminatedIds);
        removed += filtered.removed;
        manifest[key] = filtered.value;
      }
    }
    next.manifest = manifest;
  }

  for (const ledgerKey of ["artifact_ledger", "artifactLedger"]) {
    if (isObject(next[ledgerKey]) && Array.isArray(next[ledgerKey].artifacts)) {
      const filtered = filterArray(next[ledgerKey].artifacts, compiledPatterns, contaminatedIds);
      removed += filtered.removed;
      next[ledgerKey] = { ...next[ledgerKey], artifacts: filtered.value };
    }
  }

  if (isObject(next.operator_event_ledger) && Array.isArray(next.operator_event_ledger.events)) {
    const filtered = filterArray(next.operator_event_ledger.events, compiledPatterns, contaminatedIds);
    removed += filtered.removed;
    next.operator_event_ledger = { ...next.operator_event_ledger, events: filtered.value };
  }

  return { value: next, removed };
}

function cleanProjectionHistory(history, compiledPatterns) {
  if (!isObject(history)) return { value: history, removed: 0, deletedSnapshotIds: [] };
  const items = asArray(history.items);
  const kept = [];
  const deletedSnapshotIds = [];
  for (const item of items) {
    if (shouldRemove(item, compiledPatterns, new Set())) {
      deletedSnapshotIds.push(item.id);
    } else {
      kept.push(item);
    }
  }
  const latest = kept.some((item) => item.id === history.latest) ? history.latest : kept[0]?.id || null;
  return {
    value: { ...history, latest, items: kept },
    removed: items.length - kept.length,
    deletedSnapshotIds
  };
}

function updateKeySql(key, value) {
  return `UPDATE workbench_kv SET json = ${sqlString(JSON.stringify(value))}, updated_at = ${sqlString(new Date().toISOString())} WHERE key = ${sqlString(key)};`;
}

function updateSnapshotSql(id, workflowState, itemJson = null) {
  const itemPart = itemJson ? `item_json = ${sqlString(JSON.stringify(itemJson))},` : "";
  return `UPDATE workflow_snapshots SET ${itemPart} workflow_json = ${sqlString(JSON.stringify(workflowState))}, updated_at = ${sqlString(new Date().toISOString())} WHERE id = ${sqlString(id)};`;
}

export function cleanupWorkbenchLiveTestData(options = {}) {
  const dbPath = resolve(options.dbPath || options.db_path || DEFAULT_LIVE_WORKBENCH_STATE_DB);
  const compiledPatterns = compilePatterns(options.forbiddenPatterns || options.forbidden_patterns);
  const state = readLiveState(dbPath, options);
  if (!state.exists) {
    return {
      status: "pass",
      gate_id: "workbench-live-state-cleanliness",
      db_path: dbPath,
      checked: false,
      cleaned_count: 0,
      deleted_snapshot_count: 0,
      issues: []
    };
  }

  let cleaned = 0;
  const deletedSnapshotIds = new Set();
  const statements = [];

  for (const row of state.kv) {
    const value = parseJson(row.json, null);
    if (row.key === "project_status") {
      const cleanedStatus = cleanProjectStatus(value, compiledPatterns);
      cleaned += cleanedStatus.removed;
      if (cleanedStatus.removed > 0) statements.push(updateKeySql(row.key, cleanedStatus.value));
    }
    if (row.key === "projection_history") {
      const cleanedHistory = cleanProjectionHistory(value, compiledPatterns);
      cleaned += cleanedHistory.removed;
      for (const id of cleanedHistory.deletedSnapshotIds) deletedSnapshotIds.add(id);
      if (cleanedHistory.removed > 0) statements.push(updateKeySql(row.key, cleanedHistory.value));
    }
    if (row.key === "operator_events" && matchesForbidden(value, compiledPatterns)) {
      const events = asArray(value?.events);
      const kept = events.filter((event) => !matchesForbidden(event, compiledPatterns));
      cleaned += events.length - kept.length;
      statements.push(updateKeySql(row.key, { ...value, events: kept }));
    }
  }

  for (const row of state.snapshots) {
    const item = parseJson(row.item_json, null);
    if (deletedSnapshotIds.has(row.id) || matchesForbidden(row.id, compiledPatterns) || matchesForbidden(item, compiledPatterns)) {
      deletedSnapshotIds.add(row.id);
      continue;
    }
    const workflow = parseJson(row.workflow_json, null);
    const cleanedWorkflow = cleanWorkflowState(workflow, compiledPatterns);
    cleaned += cleanedWorkflow.removed;
    if (cleanedWorkflow.removed > 0) {
      statements.push(updateSnapshotSql(row.id, cleanedWorkflow.value));
    }
  }

  for (const id of deletedSnapshotIds) {
    statements.push(`DELETE FROM workflow_snapshots WHERE id = ${sqlString(id)};`);
  }

  if (statements.length > 0) {
    sqlite(dbPath, ["BEGIN IMMEDIATE;", ...statements, "COMMIT;"].join("\n"), { ...options, write: true });
  }

  const inspection = inspectWorkbenchLiveStateCleanliness({ ...options, dbPath });
  return {
    ...inspection,
    cleaned_count: cleaned,
    deleted_snapshot_count: deletedSnapshotIds.size
  };
}
