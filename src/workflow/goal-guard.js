import { inferRequestedDomain } from "./host-boundary.js";

const PLATFORM_PROJECT_ID = "ai-control-platform";
const MANAGED_PROJECT_IDS = new Set(["stock_dashboard", "lobechat", "ashare-dashboard"]);
const LEGACY_SEGMENT = "legacy";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeText(value) {
  return normalizeString(value).toLowerCase();
}

function compactStrings(value) {
  return asArray(value).map(normalizeString).filter(Boolean);
}

function issue(code, message, path) {
  return { code, message, path };
}

function inputGoal(input) {
  return normalizeString(input?.goal || input?.requirement || input?.request || input?.context_pack?.requirement_summary);
}

function workspaceProjectId(input) {
  return normalizeString(
    input?.workspace_project_id ||
      input?.workspaceProjectId ||
      input?.manifest?.project_id ||
      input?.context_pack?.target_project_id
  );
}

function isPlatformCoreGoal(goal, contextPack, manifest) {
  return Boolean(
    inferRequestedDomain(goal).domain === "platform_core" ||
      contextPack?.host === "platform_core" ||
      manifest?.project_type === "platform-core"
  );
}

function normalizePath(value) {
  return normalizeString(value).replaceAll("\\", "/");
}

function projectIdFromPath(path) {
  const normalized = normalizePath(path);
  const match = normalized.match(/(?:^|\/)codex\/projects\/([^/]+)\//);
  if (match) return match[1];

  const projectsMatch = normalized.match(/(?:^|\/)projects\/([^/]+)\//);
  if (projectsMatch) return projectsMatch[1];

  for (const projectId of MANAGED_PROJECT_IDS) {
    if (normalized === projectId || normalized.startsWith(`${projectId}/`) || normalized.includes(`/${projectId}/`)) {
      return projectId;
    }
  }

  return null;
}

function hasLegacySegment(path) {
  return normalizePath(path)
    .split("/")
    .filter(Boolean)
    .includes(LEGACY_SEGMENT);
}

function evidenceText(input) {
  return [
    ...compactStrings(input?.changed_files || input?.changedFiles),
    JSON.stringify(input?.artifact || ""),
    JSON.stringify(input?.artifacts || []),
    JSON.stringify(input?.manifest?.artifacts || [])
  ]
    .join("\n")
    .toLowerCase();
}

function extractSignals(text) {
  const normalized = normalizeText(text);
  const signals = new Set();

  for (const projectId of [PLATFORM_PROJECT_ID, ...MANAGED_PROJECT_IDS]) {
    if (normalized.includes(projectId.toLowerCase())) signals.add(projectId.toLowerCase());
  }

  if (normalized.includes("legacy")) signals.add("legacy");
  if (normalized.includes("git reset") || normalized.includes("checkout --")) signals.add("destructive_git");
  if (normalized.includes("回退")) signals.add("rollback");
  if (normalized.includes("删除")) signals.add("delete");
  if (normalized.includes("业务项目")) signals.add("managed_project");

  const pathMatches = normalized.match(/[a-z0-9_.-]+\/[a-z0-9_./-]+/g) || [];
  for (const match of pathMatches) signals.add(match);

  return signals;
}

function constraintViolated(constraint, evidenceSignals, evidence) {
  const constraintSignals = extractSignals(constraint);

  if (constraintSignals.has("managed_project")) {
    for (const projectId of MANAGED_PROJECT_IDS) {
      if (evidenceSignals.has(projectId.toLowerCase())) return true;
    }
  }

  if (constraintSignals.has("rollback") && evidenceSignals.has("destructive_git")) {
    return true;
  }

  for (const signal of constraintSignals) {
    if (signal === PLATFORM_PROJECT_ID) continue;
    if (evidenceSignals.has(signal) || evidence.includes(signal)) return true;
  }

  return false;
}

function validateChangedFiles(changedFiles, issues) {
  changedFiles.forEach((changedFile, index) => {
    const path = normalizePath(changedFile);
    const issuePath = `changed_files[${index}]`;

    if (path.startsWith("../")) {
      issues.push(issue("changed_file_out_of_scope", `${changedFile} escapes the project workspace`, issuePath));
    }

    if (hasLegacySegment(path)) {
      issues.push(issue("legacy_write_forbidden", `${changedFile} writes under legacy/`, issuePath));
    }

    const projectId = projectIdFromPath(path);
    if (projectId && projectId !== PLATFORM_PROJECT_ID) {
      issues.push(issue("changed_file_other_project", `${changedFile} targets ${projectId}`, issuePath));
    }
  });
}

function validateContextConstraints(input, issues) {
  const contextPack = input?.context_pack || {};
  const constraints = [
    ...compactStrings(contextPack.non_goals),
    ...compactStrings(contextPack.forbidden_actions)
  ];
  const evidence = evidenceText(input);
  const evidenceSignals = extractSignals(evidence);

  constraints.forEach((constraint, index) => {
    if (constraintViolated(constraint, evidenceSignals, evidence)) {
      issues.push(
        issue(
          "context_constraint_violation",
          `evidence violates context constraint: ${constraint}`,
          index < asArray(contextPack.non_goals).length ? "context_pack.non_goals" : "context_pack.forbidden_actions"
        )
      );
    }
  });
}

export function evaluateGoalAlignment(input = {}) {
  const issues = [];
  const goal = inputGoal(input);
  const contextPack = input.context_pack || {};
  const manifest = input.manifest || {};
  const currentProjectId = workspaceProjectId(input);
  const changedFiles = compactStrings(input.changed_files || input.changedFiles);
  const platformCoreGoal = isPlatformCoreGoal(goal, contextPack, manifest);

  if (platformCoreGoal && currentProjectId !== PLATFORM_PROJECT_ID) {
    issues.push(
      issue(
        "platform_goal_target_mismatch",
        `platform core goals must run in ${PLATFORM_PROJECT_ID}`,
        "workspace_project_id"
      )
    );
  }

  if (contextPack.host === "platform_core" && contextPack.target_project_id && contextPack.target_project_id !== PLATFORM_PROJECT_ID) {
    issues.push(
      issue(
        "context_pack_target_mismatch",
        `platform_core context pack must target ${PLATFORM_PROJECT_ID}`,
        "context_pack.target_project_id"
      )
    );
  }

  validateChangedFiles(changedFiles, issues);
  validateContextConstraints(input, issues);

  return {
    status: issues.length ? "fail" : "pass",
    issues,
    classification: platformCoreGoal ? "platform_core" : "managed_project",
    workspace_project_id: currentProjectId || null
  };
}

export function assertGoalAlignment(input = {}) {
  const result = evaluateGoalAlignment(input);

  if (result.status !== "pass") {
    const error = new Error("goal alignment guard failed");
    error.code = "GOAL_ALIGNMENT_VIOLATION";
    error.result = result;
    throw error;
  }

  return result;
}
