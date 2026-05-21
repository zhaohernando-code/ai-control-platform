import { ARTIFACT_TYPES, recordArtifact } from "./artifact-ledger.js";
import { appendRunEvent } from "./run-manifest.js";

const OPERATOR_EVENTS_VERSION = "operator-events.v1";
const DEFAULT_ARTIFACT_TYPE = "evaluation";
const DEFAULT_ARTIFACT_STATUS = "pass";
const DEFAULT_PRODUCER = "workbench-operator";

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeType(value) {
  return normalizeString(value).toLowerCase();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function issue(code, message, path) {
  return { code, message, path };
}

function timestamp(value) {
  return normalizeString(value) || new Date().toISOString();
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function sourceOperatorEvent(event) {
  return {
    id: normalizeString(event.id),
    action: normalizeString(event.action),
    run_id: normalizeString(event.run_id),
    cycle_id: normalizeString(event.cycle_id),
    created_at: timestamp(event.created_at),
    metadata: { ...objectOrEmpty(event.metadata) }
  };
}

function eventId(event, index) {
  return normalizeString(event.id) || `operator-event-${index + 1}`;
}

function runEventId(event, index) {
  return `operator-event:${eventId(event, index)}`;
}

function artifactId(event, index) {
  return `operator-artifact:${eventId(event, index)}`;
}

function artifactType(event) {
  return normalizeType(event.artifact_type || event.artifactType || event.metadata?.artifact_type) || DEFAULT_ARTIFACT_TYPE;
}

function artifactStatus(event) {
  return normalizeString(event.status || event.metadata?.status) || DEFAULT_ARTIFACT_STATUS;
}

function artifactProducer(event) {
  return normalizeString(event.producer || event.metadata?.producer) || DEFAULT_PRODUCER;
}

function idSet(entries) {
  return new Set(asArray(entries).map((entry) => normalizeString(entry?.id)).filter(Boolean));
}

function artifactEvidence(event) {
  const metadata = objectOrEmpty(event.metadata);
  const evidence = objectOrEmpty(event.evidence || metadata.evidence);
  const fallbackUri = `codex://operator-events/${encodeURIComponent(normalizeString(event.run_id))}/${encodeURIComponent(normalizeString(event.cycle_id))}/${encodeURIComponent(normalizeString(event.id) || normalizeString(event.action))}`;
  const uri = normalizeString(event.uri || metadata.uri || evidence.uri) || fallbackUri;
  const path = normalizeString(event.path || metadata.path || evidence.path);
  const contentHash = normalizeString(event.content_hash || event.contentHash || metadata.content_hash || metadata.contentHash || evidence.content_hash);

  return {
    evidence: {
      operator_event_id: normalizeString(event.id) || null,
      action: normalizeString(event.action),
      run_id: normalizeString(event.run_id),
      cycle_id: normalizeString(event.cycle_id),
      uri: uri || undefined,
      path: path || undefined,
      content_hash: contentHash || undefined
    },
    uri: uri || undefined,
    path: path || undefined,
    content_hash: contentHash || undefined
  };
}

function validateOperatorEvent(event, index, issues, options = {}) {
  const path = `events[${index}]`;

  if (!event || typeof event !== "object" || Array.isArray(event)) {
    issues.push(issue("invalid_operator_event", "operator event must be an object", path));
    return;
  }

  for (const field of ["id", "action", "run_id", "cycle_id"]) {
    if (!normalizeString(event[field])) {
      issues.push(issue("missing_operator_event_field", `${field} is required`, `${path}.${field}`));
    }
  }

  if (event.metadata !== undefined && (typeof event.metadata !== "object" || event.metadata === null || Array.isArray(event.metadata))) {
    issues.push(issue("invalid_operator_event_metadata", "metadata must be an object when provided", `${path}.metadata`));
  }

  if (normalizeString(options.run_id) && normalizeString(event.run_id) && normalizeString(event.run_id) !== normalizeString(options.run_id)) {
    issues.push(issue("operator_event_run_mismatch", "operator event run_id does not match target run", `${path}.run_id`));
  }

  if (normalizeString(options.cycle_id) && normalizeString(event.cycle_id) && normalizeString(event.cycle_id) !== normalizeString(options.cycle_id)) {
    issues.push(issue("operator_event_cycle_mismatch", "operator event cycle_id does not match target cycle", `${path}.cycle_id`));
  }

  const type = artifactType(event);
  if (type && !ARTIFACT_TYPES.has(type)) {
    issues.push(
      issue(
        "unsupported_operator_artifact_type",
        `operator event artifact type must be one of: ${Array.from(ARTIFACT_TYPES).join(", ")}`,
        `${path}.artifact_type`
      )
    );
  }
}

export function validateOperatorEventLedger(ledger, options = {}) {
  const issues = [];

  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) {
    return {
      status: "fail",
      issues: [issue("invalid_operator_event_ledger", "operator event ledger must be an object", "")]
    };
  }

  if (normalizeString(ledger.version) && normalizeString(ledger.version) !== OPERATOR_EVENTS_VERSION) {
    issues.push(issue("invalid_operator_event_ledger_version", `version must be ${OPERATOR_EVENTS_VERSION}`, "version"));
  }

  if (!Array.isArray(ledger.events)) {
    issues.push(issue("invalid_operator_events", "events must be an array", "events"));
  }

  asArray(ledger.events).forEach((event, index) => validateOperatorEvent(event, index, issues, options));

  return {
    status: issues.length ? "fail" : "pass",
    issues
  };
}

export function operatorEventToRunEvent(event, index = 0) {
  const source = sourceOperatorEvent(event);

  return {
    id: runEventId(event, index),
    type: "operator_action",
    action: source.action,
    run_id: source.run_id,
    cycle_id: source.cycle_id,
    created_at: source.created_at,
    metadata: { ...source.metadata },
    source_operator_event: source
  };
}

export function operatorEventToArtifact(event, index = 0) {
  const createdAt = timestamp(event.created_at);
  const evidence = artifactEvidence(event);

  return {
    id: artifactId(event, index),
    type: artifactType(event),
    status: artifactStatus(event),
    producer: artifactProducer(event),
    created_at: createdAt,
    ...evidence,
    metadata: {
      source_operator_event: sourceOperatorEvent(event)
    }
  };
}

export function ingestOperatorEvents(ledger, options = {}) {
  const validation = validateOperatorEventLedger(ledger, options);

  if (validation.status !== "pass") {
    return {
      status: "fail",
      issues: validation.issues,
      run_events: [],
      artifacts: []
    };
  }

  const events = asArray(ledger.events);

  return {
    status: "pass",
    issues: [],
    run_events: events.map(operatorEventToRunEvent),
    artifacts: events.map(operatorEventToArtifact)
  };
}

export function applyOperatorEventsToRunManifest(manifest, ledger, options = {}) {
  const ingestion = ingestOperatorEvents(ledger, {
    run_id: options.run_id || manifest?.run_id,
    cycle_id: options.cycle_id || manifest?.cycle_id
  });

  if (ingestion.status !== "pass") {
    return {
      ...ingestion,
      manifest,
      applied_run_events: [],
      skipped_run_event_ids: []
    };
  }

  const existingIds = idSet(manifest?.events);
  const appliedRunEvents = [];
  const skippedRunEventIds = [];
  let nextManifest = manifest;

  for (const runEvent of ingestion.run_events) {
    if (existingIds.has(runEvent.id)) {
      skippedRunEventIds.push(runEvent.id);
      continue;
    }

    nextManifest = appendRunEvent(nextManifest, runEvent);
    existingIds.add(runEvent.id);
    appliedRunEvents.push(runEvent);
  }

  return {
    status: "pass",
    issues: [],
    manifest: nextManifest,
    applied_run_events: appliedRunEvents,
    skipped_run_event_ids: skippedRunEventIds
  };
}

export function applyOperatorEventsToArtifactLedger(artifactLedger, ledger, options = {}) {
  const ingestion = ingestOperatorEvents(ledger, {
    run_id: options.run_id || artifactLedger?.run_id,
    cycle_id: options.cycle_id || artifactLedger?.cycle_id
  });

  if (ingestion.status !== "pass") {
    return {
      ...ingestion,
      artifact_ledger: artifactLedger,
      applied_artifacts: [],
      skipped_artifact_ids: []
    };
  }

  const existingIds = idSet(artifactLedger?.artifacts);
  const appliedArtifacts = [];
  const skippedArtifactIds = [];
  let nextLedger = artifactLedger;

  for (const artifact of ingestion.artifacts) {
    if (existingIds.has(artifact.id)) {
      skippedArtifactIds.push(artifact.id);
      continue;
    }

    nextLedger = recordArtifact(nextLedger, artifact);
    existingIds.add(artifact.id);
    appliedArtifacts.push(artifact);
  }

  return {
    status: "pass",
    issues: [],
    artifact_ledger: nextLedger,
    applied_artifacts: appliedArtifacts,
    skipped_artifact_ids: skippedArtifactIds
  };
}

export function applyOperatorEventsToWorkflowState(input = {}) {
  const ledger = input.operator_event_ledger || input.operatorEventLedger;
  const manifest = input.manifest;
  const artifactLedger = input.artifact_ledger || input.artifactLedger;
  const manifestRunId = normalizeString(manifest?.run_id);
  const manifestCycleId = normalizeString(manifest?.cycle_id);
  const ledgerRunId = normalizeString(artifactLedger?.run_id);
  const ledgerCycleId = normalizeString(artifactLedger?.cycle_id);
  const targetRunId = normalizeString(input.run_id) || manifestRunId || ledgerRunId;
  const targetCycleId = normalizeString(input.cycle_id) || manifestCycleId || ledgerCycleId;
  const targetIssues = [];

  if (manifestRunId && ledgerRunId && manifestRunId !== ledgerRunId) {
    targetIssues.push(issue("workflow_state_run_mismatch", "manifest run_id does not match artifact ledger run_id", "artifact_ledger.run_id"));
  }
  if (manifestCycleId && ledgerCycleId && manifestCycleId !== ledgerCycleId) {
    targetIssues.push(issue("workflow_state_cycle_mismatch", "manifest cycle_id does not match artifact ledger cycle_id", "artifact_ledger.cycle_id"));
  }

  const preflight = ingestOperatorEvents(ledger, {
    run_id: targetRunId,
    cycle_id: targetCycleId
  });

  if (targetIssues.length > 0 || preflight.status !== "pass") {
    return {
      status: "fail",
      issues: [...targetIssues, ...(preflight.issues || [])],
      manifest,
      artifact_ledger: artifactLedger,
      applied_run_events: [],
      applied_artifacts: [],
      skipped_run_event_ids: [],
      skipped_artifact_ids: []
    };
  }

  const manifestResult = applyOperatorEventsToRunManifest(manifest, ledger, {
    run_id: targetRunId,
    cycle_id: targetCycleId
  });
  const artifactResult = applyOperatorEventsToArtifactLedger(artifactLedger, ledger, {
    run_id: targetRunId,
    cycle_id: targetCycleId
  });
  const issues = [...(manifestResult.issues || []), ...(artifactResult.issues || [])];

  return {
    status: manifestResult.status === "pass" && artifactResult.status === "pass" ? "pass" : "fail",
    issues,
    manifest: manifestResult.manifest,
    artifact_ledger: artifactResult.artifact_ledger,
    applied_run_events: manifestResult.applied_run_events || [],
    applied_artifacts: artifactResult.applied_artifacts || [],
    skipped_run_event_ids: manifestResult.skipped_run_event_ids || [],
    skipped_artifact_ids: artifactResult.skipped_artifact_ids || []
  };
}

export { OPERATOR_EVENTS_VERSION };
