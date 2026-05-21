const REQUIRED_DOCS = [
  "README.md",
  "PROJECT_RULES.md",
  "PROCESS.md",
  "PROJECT_STATUS.json",
  "DECISIONS.md"
];

function normalize(value) {
  return String(value || "").trim();
}

function basename(value) {
  return normalize(value).split("/").filter(Boolean).at(-1) || "";
}

export function findWorkspaceProject(index, projectId) {
  const projects = Array.isArray(index?.projects) ? index.projects : [];
  return projects.find((project) => project?.project_id === projectId) || null;
}

export function validateProjectOnboardingSync({ manifest, workspaceIndex }) {
  const issues = [];
  const projectId = normalize(manifest?.project_id);
  const manifestAliases = Array.isArray(manifest?.aliases) ? manifest.aliases.map(normalize).filter(Boolean) : [];
  const workspaceProject = findWorkspaceProject(workspaceIndex, projectId);

  if (!projectId) {
    issues.push({ code: "manifest_missing_project_id", message: "project-manifest.json must define project_id" });
  }

  if (!workspaceProject) {
    issues.push({ code: "workspace_index_missing_project", message: `${projectId} is not registered in WORKSPACE_INDEX.json` });
    return { status: "fail", issues };
  }

  if (workspaceProject.project_type !== manifest.project_type) {
    issues.push({
      code: "project_type_mismatch",
      message: `project_type mismatch: manifest=${manifest.project_type || ""}, index=${workspaceProject.project_type || ""}`
    });
  }

  if (manifest.project_type === "platform-core" && workspaceProject.project_type !== "platform-core") {
    issues.push({ code: "platform_core_type_missing", message: "platform core projects must use project_type=platform-core" });
  }

  const indexAliases = new Set((Array.isArray(workspaceProject.aliases) ? workspaceProject.aliases : []).map(normalize));
  if (manifestAliases.length && !manifestAliases.some((alias) => indexAliases.has(alias))) {
    issues.push({ code: "aliases_not_synced", message: "at least one manifest alias must be present in WORKSPACE_INDEX.json" });
  }

  const canonicalDocNames = new Set((Array.isArray(workspaceProject.canonical_docs) ? workspaceProject.canonical_docs : []).map(basename));
  for (const requiredDoc of REQUIRED_DOCS) {
    if (!canonicalDocNames.has(requiredDoc)) {
      issues.push({ code: "canonical_doc_missing", message: `${requiredDoc} must be listed in canonical_docs` });
    }
  }

  return {
    status: issues.length ? "fail" : "pass",
    issues
  };
}

export { REQUIRED_DOCS };

