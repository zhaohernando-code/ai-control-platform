const ARTIFACT_TYPES = new Set([
  "requirement",
  "context_pack",
  "patch",
  "test",
  "review",
  "evaluation",
  "design"
]);

const REQUIRED_ARTIFACT_FIELDS = ["id", "type", "status", "producer", "created_at"];
const EVIDENCE_FIELDS = ["path", "uri", "content_hash"];

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeType(value) {
  return normalizeString(value).toLowerCase();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cloneEntries(entries) {
  return asArray(entries).map((entry) => ({ ...entry }));
}

function issue(code, message, path) {
  return { code, message, path };
}

function timestamp(value) {
  return normalizeString(value) || new Date().toISOString();
}

function hasEvidence(entry) {
  return EVIDENCE_FIELDS.some((field) => normalizeString(entry?.[field]));
}

function recordShape(input = {}, index = 0) {
  return {
    id: normalizeString(input.id) || `artifact-${index + 1}`,
    type: normalizeType(input.type),
    status: normalizeString(input.status),
    path: normalizeString(input.path) || undefined,
    uri: normalizeString(input.uri) || undefined,
    content_hash: normalizeString(input.content_hash) || undefined,
    producer: normalizeString(input.producer),
    created_at: timestamp(input.created_at),
    work_package_id: normalizeString(input.work_package_id) || undefined,
    metadata: input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
      ? { ...input.metadata }
      : undefined
  };
}

function validateArtifact(entry, index, issues, seenIds) {
  const path = `artifacts[${index}]`;

  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    issues.push(issue("invalid_artifact", "artifact must be an object", path));
    return;
  }

  for (const field of REQUIRED_ARTIFACT_FIELDS) {
    if (!normalizeString(entry[field])) {
      issues.push(issue("missing_artifact_field", `${field} is required`, `${path}.${field}`));
    }
  }

  if (entry.id && seenIds.has(entry.id)) {
    issues.push(issue("duplicate_artifact_id", `${entry.id} is duplicated`, `${path}.id`));
  }
  if (entry.id) {
    seenIds.add(entry.id);
  }

  if (entry.type && !ARTIFACT_TYPES.has(normalizeType(entry.type))) {
    issues.push(
      issue(
        "invalid_artifact_type",
        `type must be one of: ${Array.from(ARTIFACT_TYPES).join(", ")}`,
        `${path}.type`
      )
    );
  }

  if (!hasEvidence(entry)) {
    issues.push(
      issue(
        "missing_artifact_evidence",
        "artifact must include path, uri, or content_hash",
        path
      )
    );
  }
}

export function createArtifactLedger(input = {}) {
  const createdAt = timestamp(input.created_at);

  return {
    run_id: normalizeString(input.run_id),
    cycle_id: normalizeString(input.cycle_id),
    artifacts: cloneEntries(input.artifacts),
    created_at: createdAt,
    updated_at: timestamp(input.updated_at || createdAt)
  };
}

export function recordArtifact(ledger, artifact) {
  const artifacts = cloneEntries(ledger?.artifacts);
  const nextArtifact = recordShape(artifact, artifacts.length);

  return {
    ...ledger,
    artifacts: [...artifacts, nextArtifact],
    updated_at: nextArtifact.created_at
  };
}

export function validateArtifactLedger(ledger) {
  const issues = [];

  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) {
    return {
      status: "fail",
      issues: [issue("invalid_artifact_ledger", "artifact ledger must be an object", "")]
    };
  }

  if (!Array.isArray(ledger.artifacts)) {
    issues.push(issue("invalid_artifacts", "artifacts must be an array", "artifacts"));
  }

  const seenIds = new Set();
  asArray(ledger.artifacts).forEach((entry, index) => validateArtifact(entry, index, issues, seenIds));

  return {
    status: issues.length ? "fail" : "pass",
    issues
  };
}

export function summarizeArtifactLedger(ledger) {
  return asArray(ledger?.artifacts).reduce(
    (summary, artifact) => {
      const type = normalizeType(artifact?.type) || "unknown";
      const status = normalizeString(artifact?.status).toLowerCase() || "unknown";

      summary.total += 1;
      summary.by_type[type] = (summary.by_type[type] || 0) + 1;
      summary.by_status[status] = (summary.by_status[status] || 0) + 1;
      return summary;
    },
    { total: 0, by_type: {}, by_status: {} }
  );
}

export { ARTIFACT_TYPES, EVIDENCE_FIELDS };
