import { assertHostBoundary } from "./host-boundary.js";

const REQUIRED_FIELDS = [
  "requirement_summary",
  "host",
  "target_project_id",
  "non_goals",
  "forbidden_actions",
  "owned_files",
  "acceptance_gates",
  "rollback_conditions",
  "subtasks"
];

const REQUIRED_ARRAY_FIELDS = [
  "non_goals",
  "forbidden_actions",
  "owned_files",
  "acceptance_gates",
  "rollback_conditions",
  "subtasks"
];

const VALID_HOSTS = new Set(["platform_core", "managed_project", "integration_adapter"]);
const PLATFORM_PROJECT_ID = "ai-control-platform";

function normalizeString(value) {
  return String(value || "").trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactStrings(value) {
  return asArray(value).map(normalizeString).filter(Boolean);
}

function projectWideOwnedFile(value = "") {
  const normalized = normalizeString(value).replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  return normalized === "." || normalized === "";
}

function projectRelativeOwnedFile(value = "") {
  const normalized = normalizeString(value).replace(/\\/g, "/").replace(/^\.\/+/, "");
  const withoutTrailingSlash = normalized.replace(/\/+$/, "");
  return Boolean(withoutTrailingSlash) &&
    !withoutTrailingSlash.startsWith("/") &&
    withoutTrailingSlash !== ".." &&
    !withoutTrailingSlash.startsWith("../") &&
    !withoutTrailingSlash.includes("/../") &&
    !withoutTrailingSlash.endsWith("/..");
}

function ownedFileInScope(ownedFile = "", rootOwnedFiles = new Set()) {
  if (rootOwnedFiles.has(ownedFile)) return true;
  return [...rootOwnedFiles].some(projectWideOwnedFile);
}

function globalGoalIdFrom(value = {}) {
  return normalizeString(value.global_goal_id || value.globalGoalId || value.source?.global_goal_id || value.source?.globalGoalId);
}

function issue(code, message, path) {
  return { code, message, path };
}

function isMissingRequiredValue(contextPack, field) {
  if (!Object.hasOwn(contextPack, field)) {
    return true;
  }

  if (REQUIRED_ARRAY_FIELDS.includes(field)) {
    return !Array.isArray(contextPack[field]) || contextPack[field].length === 0;
  }

  return normalizeString(contextPack[field]) === "";
}

function validateRequiredFields(contextPack, issues) {
  for (const field of REQUIRED_FIELDS) {
    if (isMissingRequiredValue(contextPack, field)) {
      issues.push(issue("missing_required_field", `${field} is required`, field));
    }
  }
}

function validateHostShape(contextPack, issues) {
  const host = normalizeString(contextPack.host);
  const targetProjectId = normalizeString(contextPack.target_project_id);

  if (host && !VALID_HOSTS.has(host)) {
    issues.push(issue("invalid_host", `host must be one of: ${Array.from(VALID_HOSTS).join(", ")}`, "host"));
  }

  if (host === "platform_core" && targetProjectId && targetProjectId !== PLATFORM_PROJECT_ID) {
    issues.push(
      issue(
        "platform_core_target_mismatch",
        `platform_core work must target ${PLATFORM_PROJECT_ID}`,
        "target_project_id"
      )
    );
  }
}

function validateHostBoundary(contextPack, issues) {
  const requirementSummary = normalizeString(contextPack.requirement_summary);
  const targetProjectId = normalizeString(contextPack.target_project_id);

  if (!requirementSummary || !targetProjectId) {
    return null;
  }

  try {
    return assertHostBoundary({
      request: requirementSummary,
      targetProjectId,
      explicitAdapter: contextPack.host === "integration_adapter"
    });
  } catch (error) {
    issues.push(
      issue(
        "host_boundary_violation",
        error.message,
        "target_project_id"
      )
    );
    return error.result || null;
  }
}

function validateRootOwnedFiles(contextPack, issues) {
  compactStrings(contextPack.owned_files).forEach((ownedFile, index) => {
    if (projectRelativeOwnedFile(ownedFile)) return;
    issues.push(
      issue(
        "owned_file_outside_project",
        `${ownedFile} must stay inside the target project`,
        `owned_files[${index}]`
      )
    );
  });
}

function validateSubtasks(contextPack, issues) {
  const rootOwnedFiles = new Set(compactStrings(contextPack.owned_files));
  const seenIds = new Set();
  const subtaskIds = new Set();
  const subtasks = asArray(contextPack.subtasks);

  subtasks.forEach((subtask, index) => {
    const path = `subtasks[${index}]`;
    if (!subtask || typeof subtask !== "object" || Array.isArray(subtask)) {
      issues.push(issue("invalid_subtask", "subtask must be an object", path));
      return;
    }

    const subtaskId = normalizeString(subtask.id) || `wp-${index + 1}`;
    if (seenIds.has(subtaskId)) {
      issues.push(issue("duplicate_subtask_id", `${subtaskId} is duplicated`, `${path}.id`));
    }
    seenIds.add(subtaskId);
    subtaskIds.add(subtaskId);

    const ownedFiles = compactStrings(subtask.owned_files);
    if (ownedFiles.length === 0) {
      issues.push(issue("subtask_missing_owned_files", "subtask must declare owned_files", `${path}.owned_files`));
    }

    for (const ownedFile of ownedFiles) {
      if (!projectRelativeOwnedFile(ownedFile)) {
        issues.push(
          issue(
            "subtask_owned_file_outside_project",
            `${ownedFile} must stay inside the target project`,
            `${path}.owned_files`
          )
        );
        continue;
      }
      if (!ownedFileInScope(ownedFile, rootOwnedFiles)) {
        issues.push(
          issue(
            "subtask_owned_file_out_of_scope",
            `${ownedFile} is not listed in context pack owned_files`,
            `${path}.owned_files`
          )
        );
      }
    }
  });

  subtasks.forEach((subtask, index) => {
    const dependsOn = compactStrings(subtask?.depends_on);
    for (const dependencyId of dependsOn) {
      if (!subtaskIds.has(dependencyId)) {
        issues.push(
          issue(
            "unknown_subtask_dependency",
            `${dependencyId} is not a known subtask id`,
            `subtasks[${index}].depends_on`
          )
        );
      }
    }
  });
}

export function validateContextPack(contextPack) {
  const issues = [];

  if (!contextPack || typeof contextPack !== "object" || Array.isArray(contextPack)) {
    return {
      status: "fail",
      issues: [issue("invalid_context_pack", "context pack must be an object", "")]
    };
  }

  validateRequiredFields(contextPack, issues);
  validateHostShape(contextPack, issues);
  const hostBoundary = validateHostBoundary(contextPack, issues);
  validateRootOwnedFiles(contextPack, issues);
  validateSubtasks(contextPack, issues);

  return {
    status: issues.length ? "fail" : "pass",
    issues,
    host_boundary: hostBoundary
  };
}

export function createWorkPackages(contextPack) {
  const validation = validateContextPack(contextPack);
  const hostBlockedReasons = validation.issues
    .filter((item) => item.code === "host_boundary_violation" || item.code === "platform_core_target_mismatch")
    .map((item) => ({ code: item.code, message: item.message }));
  const rootOwnedFiles = new Set(compactStrings(contextPack?.owned_files));
  const subtasks = asArray(contextPack?.subtasks);
  const knownIds = new Set(
    subtasks.map((subtask, index) => normalizeString(subtask?.id) || `wp-${index + 1}`)
  );

  return subtasks.map((subtask, index) => {
    const id = normalizeString(subtask?.id) || `wp-${index + 1}`;
    const ownedFiles = compactStrings(subtask?.owned_files);
    const dependsOn = compactStrings(subtask?.depends_on);
    const blockedReasons = [...hostBlockedReasons];

    if (ownedFiles.length === 0) {
      blockedReasons.push({ code: "missing_owned_files", message: "work package cannot dispatch without owned_files" });
    }

    for (const ownedFile of ownedFiles) {
      if (!projectRelativeOwnedFile(ownedFile)) {
        blockedReasons.push({
          code: "owned_file_outside_project",
          message: `${ownedFile} must stay inside the target project`
        });
        continue;
      }
      if (!ownedFileInScope(ownedFile, rootOwnedFiles)) {
        blockedReasons.push({
          code: "owned_file_out_of_scope",
          message: `${ownedFile} is not listed in context pack owned_files`
        });
      }
    }

    for (const dependencyId of dependsOn) {
      if (!knownIds.has(dependencyId)) {
        blockedReasons.push({
          code: "unknown_dependency",
          message: `${dependencyId} is not a known work package id`
        });
      }
    }

    return {
      id,
      title: normalizeString(subtask?.title || subtask?.summary || id),
      action: normalizeString(subtask?.action),
      global_goal_id: globalGoalIdFrom(subtask) || null,
      owned_files: ownedFiles,
      depends_on: dependsOn,
      source: subtask?.source && typeof subtask.source === "object" && !Array.isArray(subtask.source)
        ? subtask.source
        : null,
      dispatch_allowed: blockedReasons.length === 0,
      blocked_reasons: blockedReasons
    };
  });
}

export function assertContextPackReady(contextPack) {
  const validation = validateContextPack(contextPack);
  const workPackages = createWorkPackages(contextPack);
  const blockedPackages = workPackages.filter((workPackage) => !workPackage.dispatch_allowed);

  if (validation.status !== "pass" || blockedPackages.length > 0) {
    const error = new Error("context pack is not ready for dispatch");
    error.code = "CONTEXT_PACK_NOT_READY";
    error.validation = validation;
    error.work_packages = workPackages;
    throw error;
  }

  return {
    status: "ready",
    validation,
    work_packages: workPackages
  };
}

export { REQUIRED_FIELDS, VALID_HOSTS };
