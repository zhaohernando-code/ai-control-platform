import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createArtifactLedger, validateArtifactLedger } from "../src/workflow/artifact-ledger.js";
import { createRunManifest, validateRunManifest } from "../src/workflow/run-manifest.js";
import {
  applyOperatorEventsToArtifactLedger,
  applyOperatorEventsToRunManifest,
  applyOperatorEventsToWorkflowState,
  ingestOperatorEvents,
  operatorEventToArtifact,
  operatorEventToRunEvent,
  validateOperatorEventLedger
} from "../src/workflow/operator-events.js";

function validOperatorEvent(overrides = {}) {
  return {
    id: "operator-event-1",
    action: "validate",
    run_id: "run-operator",
    cycle_id: "cycle-20260521",
    created_at: "2026-05-21T00:00:00.000Z",
    metadata: {
      projection_id: "current",
      note: "operator validated the workbench projection"
    },
    ...overrides
  };
}

function validContextPack() {
  return {
    requirement_summary: "把 operator events 摄入 run manifest 与 artifact ledger",
    host: "platform_core",
    target_project_id: "ai-control-platform",
    non_goals: ["不修改业务项目"],
    forbidden_actions: ["不得写入 stock_dashboard"],
    owned_files: ["src/workflow/operator-events.js", "test/operator-events.test.js"],
    acceptance_gates: ["node --test test/operator-events.test.js"],
    rollback_conditions: ["operator events 无法归属到 run/cycle"],
    subtasks: [
      {
        id: "operator-events",
        title: "Operator event ingestion",
        owned_files: ["src/workflow/operator-events.js", "test/operator-events.test.js"]
      }
    ]
  };
}

function validManifest(overrides = {}) {
  return createRunManifest({
    run_id: "run-operator",
    cycle_id: "cycle-20260521",
    goal: "摄入 operator events",
    context_pack: validContextPack(),
    work_packages: [{ id: "operator-events", title: "Operator event ingestion", status: "completed" }],
    events: [],
    artifacts: [],
    gate_results: [{ gate_id: "unit", status: "pass" }],
    review_findings: [],
    recovery_attempts: [],
    ...overrides
  });
}

test("operator event ingestion creates run events and artifact ledger entries", () => {
  const ledger = {
    version: "operator-events.v1",
    events: [validOperatorEvent()]
  };

  const result = ingestOperatorEvents(ledger, {
    run_id: "run-operator",
    cycle_id: "cycle-20260521"
  });
  const artifactLedger = createArtifactLedger({
    run_id: "run-operator",
    cycle_id: "cycle-20260521",
    artifacts: result.artifacts
  });

  assert.equal(result.status, "pass");
  assert.equal(result.run_events.length, 1);
  assert.equal(result.artifacts.length, 1);
  assert.deepEqual(result.run_events[0].source_operator_event, {
    id: "operator-event-1",
    action: "validate",
    run_id: "run-operator",
    cycle_id: "cycle-20260521",
    created_at: "2026-05-21T00:00:00.000Z",
    metadata: {
      projection_id: "current",
      note: "operator validated the workbench projection"
    }
  });
  assert.equal(result.artifacts[0].type, "evaluation");
  assert.equal(result.artifacts[0].status, "pass");
  assert.equal(result.artifacts[0].producer, "workbench-operator");
  assert.match(result.artifacts[0].uri, /^codex:\/\/operator-events\/run-operator\/cycle-20260521\/operator-event-1$/);
  assert.equal(validateArtifactLedger(artifactLedger).status, "pass");
});

test("operator event validation fails for unattributable events", () => {
  const validation = validateOperatorEventLedger({
    version: "operator-events.v1",
    events: [{ action: "validate" }]
  });

  assert.equal(validation.status, "fail");
  assert.deepEqual(
    validation.issues.map((entry) => [entry.code, entry.path]),
    [
      ["missing_operator_event_field", "events[0].id"],
      ["missing_operator_event_field", "events[0].run_id"],
      ["missing_operator_event_field", "events[0].cycle_id"]
    ]
  );
});

test("operator event validation fails when target ownership does not match", () => {
  const validation = validateOperatorEventLedger({
    version: "operator-events.v1",
    events: [validOperatorEvent({ run_id: "other-run" })]
  }, {
    run_id: "run-operator",
    cycle_id: "cycle-20260521"
  });

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some((entry) => entry.code === "operator_event_run_mismatch"));
});

test("operator event validation fails for unsupported artifact types without changing artifact ledger", () => {
  const result = ingestOperatorEvents({
    version: "operator-events.v1",
    events: [validOperatorEvent({ artifact_type: "operator_event" })]
  });

  assert.equal(result.status, "fail");
  assert.deepEqual(result.run_events, []);
  assert.deepEqual(result.artifacts, []);
  assert.ok(result.issues.some((entry) => entry.code === "unsupported_operator_artifact_type"));
});

test("operator event converters preserve source facts", () => {
  const event = validOperatorEvent({
    action: "approve",
    artifact_type: "review",
    status: "pass",
    producer: "platform-operator",
    evidence: { uri: "codex://operator-events/custom" }
  });

  const runEvent = operatorEventToRunEvent(event);
  const artifact = operatorEventToArtifact(event);

  assert.equal(runEvent.action, "approve");
  assert.equal(runEvent.run_id, "run-operator");
  assert.equal(runEvent.cycle_id, "cycle-20260521");
  assert.equal(runEvent.created_at, "2026-05-21T00:00:00.000Z");
  assert.equal(runEvent.metadata.note, "operator validated the workbench projection");
  assert.equal(artifact.type, "review");
  assert.equal(artifact.status, "pass");
  assert.equal(artifact.producer, "platform-operator");
  assert.equal(artifact.evidence.uri, "codex://operator-events/custom");
  assert.equal(validateArtifactLedger(createArtifactLedger({ artifacts: [artifact] })).status, "pass");
});

test("example operator events ingestion fixture remains valid", () => {
  const fixture = JSON.parse(readFileSync(new URL("../docs/examples/operator-events-ingestion.json", import.meta.url), "utf8"));
  const result = ingestOperatorEvents(fixture);

  assert.equal(result.status, "pass");
  assert.equal(result.run_events.length, 2);
  assert.equal(validateArtifactLedger(createArtifactLedger({ artifacts: result.artifacts })).status, "pass");
});

test("operator events can be applied to run manifest without duplicating events", () => {
  const ledger = {
    version: "operator-events.v1",
    events: [validOperatorEvent()]
  };
  const manifest = validManifest();

  const first = applyOperatorEventsToRunManifest(manifest, ledger);
  const second = applyOperatorEventsToRunManifest(first.manifest, ledger);

  assert.equal(first.status, "pass");
  assert.equal(first.applied_run_events.length, 1);
  assert.equal(first.manifest.events.length, 1);
  assert.equal(first.manifest.events[0].source_operator_event.action, "validate");
  assert.equal(validateRunManifest(first.manifest).status, "pass");
  assert.equal(second.applied_run_events.length, 0);
  assert.deepEqual(second.skipped_run_event_ids, ["operator-event:operator-event-1"]);
  assert.equal(second.manifest.events.length, 1);
});

test("operator events can be applied to artifact ledger without duplicating artifacts", () => {
  const ledger = {
    version: "operator-events.v1",
    events: [validOperatorEvent()]
  };
  const artifactLedger = createArtifactLedger({
    run_id: "run-operator",
    cycle_id: "cycle-20260521",
    artifacts: []
  });

  const first = applyOperatorEventsToArtifactLedger(artifactLedger, ledger);
  const second = applyOperatorEventsToArtifactLedger(first.artifact_ledger, ledger);

  assert.equal(first.status, "pass");
  assert.equal(first.applied_artifacts.length, 1);
  assert.equal(first.artifact_ledger.artifacts.length, 1);
  assert.equal(first.artifact_ledger.artifacts[0].metadata.source_operator_event.action, "validate");
  assert.equal(validateArtifactLedger(first.artifact_ledger).status, "pass");
  assert.equal(second.applied_artifacts.length, 0);
  assert.deepEqual(second.skipped_artifact_ids, ["operator-artifact:operator-event-1"]);
  assert.equal(second.artifact_ledger.artifacts.length, 1);
});

test("operator events can update workflow state in one call", () => {
  const ledger = {
    version: "operator-events.v1",
    events: [validOperatorEvent()]
  };

  const result = applyOperatorEventsToWorkflowState({
    manifest: validManifest(),
    artifact_ledger: createArtifactLedger({
      run_id: "run-operator",
      cycle_id: "cycle-20260521",
      artifacts: []
    }),
    operator_event_ledger: ledger
  });

  assert.equal(result.status, "pass");
  assert.equal(result.manifest.events.length, 1);
  assert.equal(result.artifact_ledger.artifacts.length, 1);
});

test("workflow state apply fails closed before partial mutation on manifest and ledger mismatch", () => {
  const ledger = {
    version: "operator-events.v1",
    events: [validOperatorEvent({ run_id: "run-operator", cycle_id: "cycle-20260521" })]
  };
  const manifest = validManifest();
  const artifactLedger = createArtifactLedger({
    run_id: "other-run",
    cycle_id: "cycle-20260521",
    artifacts: []
  });

  const result = applyOperatorEventsToWorkflowState({
    manifest,
    artifact_ledger: artifactLedger,
    operator_event_ledger: ledger
  });

  assert.equal(result.status, "fail");
  assert.ok(result.issues.some((entry) => entry.code === "workflow_state_run_mismatch"));
  assert.equal(result.manifest.events.length, 0);
  assert.equal(result.artifact_ledger.artifacts.length, 0);
  assert.equal(result.applied_run_events.length, 0);
  assert.equal(result.applied_artifacts.length, 0);
});
