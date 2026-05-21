import { createWorkPackages, validateContextPack } from "./context-pack.js";

const REQUIRED_MANIFEST_FIELDS = [
  "run_id",
  "cycle_id",
  "goal",
  "context_pack",
  "work_packages",
  "events",
  "artifacts",
  "gate_results",
  "review_findings",
  "recovery_attempts"
];

const REQUIRED_ARRAY_FIELDS = [
  "work_packages",
  "events",
  "artifacts",
  "gate_results",
  "review_findings",
  "recovery_attempts"
];

function normalizeString(value) {
  return String(value || "").trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cloneArray(value) {
  return asArray(value).map((item) => ({ ...item }));
}

function issue(code, message, path) {
  return { code, message, path };
}

function timestamp(value) {
  return normalizeString(value) || new Date().toISOString();
}

function packageId(workPackage, index) {
  return normalizeString(workPackage?.id || workPackage?.work_package_id) || `wp-${index + 1}`;
}

function packageOwnedFiles(workPackage) {
  return asArray(workPackage?.owned_files).map(normalizeString).filter(Boolean);
}

function generatedPackageById(contextPack) {
  return new Map(createWorkPackages(contextPack).map((workPackage, index) => [packageId(workPackage, index), workPackage]));
}

function validateRequiredManifestFields(manifest, issues) {
  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (!Object.hasOwn(manifest, field)) {
      issues.push(issue("missing_required_field", `${field} is required`, field));
      continue;
    }

    if (REQUIRED_ARRAY_FIELDS.includes(field) && !Array.isArray(manifest[field])) {
      issues.push(issue("invalid_array_field", `${field} must be an array`, field));
      continue;
    }

    if (["run_id", "cycle_id", "goal"].includes(field) && normalizeString(manifest[field]) === "") {
      issues.push(issue("missing_required_field", `${field} is required`, field));
    }
  }
}

function validateReadyContextPack(manifest, issues) {
  const contextPackValidation = validateContextPack(manifest.context_pack);
  const workPackages = createWorkPackages(manifest.context_pack);
  const blockedPackages = workPackages.filter((workPackage) => !workPackage.dispatch_allowed);

  if (contextPackValidation.status !== "pass" || blockedPackages.length > 0) {
    issues.push(
      issue(
        "context_pack_not_ready",
        "context_pack must pass validation and produce dispatchable work packages",
        "context_pack"
      )
    );
  }

  for (const contextIssue of contextPackValidation.issues || []) {
    issues.push(
      issue(
        `context_pack_${contextIssue.code}`,
        contextIssue.message,
        contextIssue.path ? `context_pack.${contextIssue.path}` : "context_pack"
      )
    );
  }

  for (const blockedPackage of blockedPackages) {
    issues.push(
      issue(
        "context_work_package_blocked",
        `${blockedPackage.id} is not dispatchable`,
        `context_pack.subtasks.${blockedPackage.id}`
      )
    );
  }
}

function validateManifestWorkPackages(manifest, issues) {
  const allowedPackages = generatedPackageById(manifest.context_pack);
  const seenIds = new Set();

  asArray(manifest.work_packages).forEach((workPackage, index) => {
    const id = packageId(workPackage, index);
    const path = `work_packages[${index}]`;
    const allowedPackage = allowedPackages.get(id);

    if (seenIds.has(id)) {
      issues.push(issue("duplicate_work_package_id", `${id} is duplicated`, `${path}.id`));
    }
    seenIds.add(id);

    if (!allowedPackage) {
      issues.push(
        issue(
          "work_package_out_of_context",
          `${id} was not generated from context_pack subtasks`,
          path
        )
      );
      return;
    }

    const allowedOwnedFiles = new Set(packageOwnedFiles(allowedPackage));
    for (const ownedFile of packageOwnedFiles(workPackage)) {
      if (!allowedOwnedFiles.has(ownedFile)) {
        issues.push(
          issue(
            "work_package_owned_file_out_of_context",
            `${ownedFile} is not allowed for work package ${id}`,
            `${path}.owned_files`
          )
        );
      }
    }
  });
}

export function createRunManifest(input = {}) {
  const contextPack = input.context_pack || input.contextPack || null;
  const workPackages = input.work_packages || (contextPack ? createWorkPackages(contextPack) : []);
  const createdAt = timestamp(input.created_at);

  return {
    run_id: normalizeString(input.run_id),
    cycle_id: normalizeString(input.cycle_id),
    goal: normalizeString(input.goal),
    context_pack: contextPack,
    work_packages: cloneArray(workPackages),
    events: cloneArray(input.events),
    artifacts: cloneArray(input.artifacts),
    gate_results: cloneArray(input.gate_results),
    review_findings: cloneArray(input.review_findings),
    recovery_attempts: cloneArray(input.recovery_attempts),
    created_at: createdAt,
    updated_at: timestamp(input.updated_at || createdAt)
  };
}

export function validateRunManifest(manifest) {
  const issues = [];

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return {
      status: "fail",
      issues: [issue("invalid_run_manifest", "run manifest must be an object", "")]
    };
  }

  validateRequiredManifestFields(manifest, issues);
  validateReadyContextPack(manifest, issues);
  validateManifestWorkPackages(manifest, issues);

  return {
    status: issues.length ? "fail" : "pass",
    issues
  };
}

export function appendRunEvent(manifest, event = {}) {
  const events = asArray(manifest?.events);
  const nextEvent = {
    ...event,
    id: normalizeString(event.id) || `event-${events.length + 1}`,
    type: normalizeString(event.type) || "note",
    created_at: timestamp(event.created_at)
  };

  return {
    ...manifest,
    events: [...events.map((item) => ({ ...item })), nextEvent],
    updated_at: nextEvent.created_at
  };
}

export function buildRunResultFromManifest(manifest) {
  return {
    run_id: manifest?.run_id || null,
    cycle_id: manifest?.cycle_id || null,
    work_packages: cloneArray(manifest?.work_packages),
    artifacts: cloneArray(manifest?.artifacts),
    gate_results: cloneArray(manifest?.gate_results),
    review_findings: cloneArray(manifest?.review_findings),
    recovery_attempts: cloneArray(manifest?.recovery_attempts)
  };
}

export { REQUIRED_MANIFEST_FIELDS };
