export const FIXED_DEVELOPMENT_MODE_GATE_ID = "fixed-development-mode-dispatch";

const PLATFORM_PROJECT_ID = "ai-control-platform";
const PLATFORM_HOST = "platform_core";
const MANAGED_PROJECT_PATH_PATTERNS = [
  /(^|[/\\])stock_dashboard([/\\]|$)/,
  /(^|[/\\])lobechat([/\\]|$)/,
  /(^|[/\\])projects[/\\]stock_dashboard([/\\]|$)/,
  /(^|[/\\])projects[/\\]lobechat([/\\]|$)/
];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function compactStrings(value) {
  return asArray(value).map(normalizeString).filter(Boolean);
}

function issue(code, message, path) {
  return { code, message, path, gate_id: FIXED_DEVELOPMENT_MODE_GATE_ID };
}

function selectedId(workPackage, index) {
  return normalizeString(workPackage?.id || workPackage?.work_package_id) || `work_package_${index + 1}`;
}

function forbiddenManagedProjectPath(path) {
  const normalized = normalizeString(path).replaceAll("\\", "/");
  return MANAGED_PROJECT_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

function outsideTargetProjectPath(path) {
  const normalized = normalizeString(path).replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  return !normalized ||
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.endsWith("/..");
}

function pushManagedProjectOwnedFileIssues(issues, ownedFiles, options = {}) {
  compactStrings(ownedFiles).forEach((ownedFile, ownedFileIndex) => {
    if (!forbiddenManagedProjectPath(ownedFile)) return;
    issues.push(
      issue(
        options.code,
        `${options.label} owned_files must not point at managed project path ${ownedFile}`,
        `${options.path}[${ownedFileIndex}]`
      )
    );
  });
}

function pushOwnedFileBoundaryIssues(issues, ownedFiles, options = {}) {
  compactStrings(ownedFiles).forEach((ownedFile, ownedFileIndex) => {
    if (!outsideTargetProjectPath(ownedFile)) return;
    issues.push(
      issue(
        options.code,
        `${options.label} owned_files must stay inside the ai-control-platform project: ${ownedFile}`,
        `${options.path}[${ownedFileIndex}]`
      )
    );
  });
}

export function evaluateFixedDevelopmentModeGate(input = {}) {
  const manifest = input.manifest || input.workflow_state?.manifest || input.workflowState?.manifest || {};
  const contextPack = manifest.context_pack || {};
  const selectedWorkPackages = asArray(input.selected_work_packages || input.selectedWorkPackages);
  const issues = [];

  if (normalizeString(contextPack.host) !== PLATFORM_HOST) {
    issues.push(
      issue(
        "fixed_mode_host_not_platform_core",
        "run_context_work_packages requires a platform_core Context Pack",
        "manifest.context_pack.host"
      )
    );
  }

  if (normalizeString(contextPack.target_project_id) !== PLATFORM_PROJECT_ID) {
    issues.push(
      issue(
        "fixed_mode_target_not_platform",
        "run_context_work_packages requires target_project_id=ai-control-platform",
        "manifest.context_pack.target_project_id"
      )
    );
  }

  if (compactStrings(contextPack.owned_files).length === 0) {
    issues.push(
      issue(
        "fixed_mode_context_missing_owned_files",
        "Context Pack must declare root owned_files before dispatch",
        "manifest.context_pack.owned_files"
      )
    );
  }
  pushManagedProjectOwnedFileIssues(issues, contextPack.owned_files, {
    code: "fixed_mode_context_managed_project_owned_file",
    label: "Context Pack root",
    path: "manifest.context_pack.owned_files"
  });
  pushOwnedFileBoundaryIssues(issues, contextPack.owned_files, {
    code: "fixed_mode_context_owned_file_outside_project",
    label: "Context Pack root",
    path: "manifest.context_pack.owned_files"
  });

  if (asArray(contextPack.subtasks).length === 0 && asArray(manifest.work_packages).length === 0) {
    issues.push(
      issue(
        "fixed_mode_missing_subtasks_or_work_packages",
        "Context Pack or manifest must declare subtasks/work_packages before dispatch",
        "manifest.context_pack.subtasks"
      )
    );
  }
  asArray(contextPack.subtasks).forEach((subtask, index) => {
    const id = selectedId(subtask, index);
    pushManagedProjectOwnedFileIssues(issues, subtask?.owned_files, {
      code: "fixed_mode_subtask_managed_project_owned_file",
      label: `${id} subtask`,
      path: `manifest.context_pack.subtasks[${index}].owned_files`
    });
    pushOwnedFileBoundaryIssues(issues, subtask?.owned_files, {
      code: "fixed_mode_subtask_owned_file_outside_project",
      label: `${id} subtask`,
      path: `manifest.context_pack.subtasks[${index}].owned_files`
    });
  });

  selectedWorkPackages.forEach((workPackage, index) => {
    const id = selectedId(workPackage, index);
    const ownedFiles = compactStrings(workPackage?.owned_files);
    const basePath = `selected_work_packages[${index}]`;

    if (ownedFiles.length === 0) {
      issues.push(
        issue(
          "fixed_mode_work_package_missing_owned_files",
          `${id} must declare owned_files before dispatch`,
          `${basePath}.owned_files`
        )
      );
      return;
    }

    pushManagedProjectOwnedFileIssues(issues, ownedFiles, {
      code: "fixed_mode_managed_project_owned_file",
      label: id,
      path: `${basePath}.owned_files`
    });
    pushOwnedFileBoundaryIssues(issues, ownedFiles, {
      code: "fixed_mode_owned_file_outside_project",
      label: id,
      path: `${basePath}.owned_files`
    });
  });

  return {
    gate_id: FIXED_DEVELOPMENT_MODE_GATE_ID,
    status: issues.length > 0 ? "fail" : "pass",
    host: normalizeString(contextPack.host),
    target_project_id: normalizeString(contextPack.target_project_id),
    checked_work_package_count: selectedWorkPackages.length,
    checked_work_package_ids: selectedWorkPackages.map(selectedId),
    issues
  };
}
