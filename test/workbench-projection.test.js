import assert from "node:assert/strict";
import test from "node:test";

import { createArtifactLedger } from "../src/workflow/artifact-ledger.js";
import { createReviewerGateRequest, createReviewerTimeoutFinding } from "../src/workflow/llm-reviewer-gate.js";
import { buildModelCollaborationPlan } from "../src/workflow/model-router.js";
import { createRunManifest } from "../src/workflow/run-manifest.js";
import {
  createMobileWorkbenchProjection,
  createWorkbenchProjection,
  validateWorkbenchProjectionInput
} from "../src/workflow/workbench-projection.js";

function contextPack() {
  return {
    requirement_summary: "继续开发新中台：构建工作台 projection assembler",
    host: "platform_core",
    target_project_id: "ai-control-platform",
    non_goals: ["不修改 stock_dashboard", "不开发孤立 UI"],
    forbidden_actions: ["不得写入业务项目", "不得把 reviewer timeout 作为人工阻塞"],
    owned_files: ["src/workflow/workbench-projection.js", "test/workbench-projection.test.js"],
    acceptance_gates: ["node --test test/workbench-projection.test.js"],
    rollback_conditions: ["projection 丢失 run decision"],
    subtasks: [
      {
        id: "projection-runtime",
        title: "Workbench projection assembler runtime",
        owned_files: ["src/workflow/workbench-projection.js"]
      },
      {
        id: "projection-test",
        title: "Workbench projection tests",
        owned_files: ["test/workbench-projection.test.js"],
        depends_on: ["projection-runtime"]
      }
    ]
  };
}

function baseInput(overrides = {}) {
  const reviewerRequest = createReviewerGateRequest({
    run_id: "run-projection",
    cycle_id: "cycle-20260521",
    scope: "Review workbench projection assembler.",
    files: ["src/workflow/workbench-projection.js"],
    questions: ["projection 是否包含运行、模型、reviewer 和 DAG 状态？"]
  });
  const timeoutFinding = createReviewerTimeoutFinding(reviewerRequest, 120);
  const manifest = createRunManifest({
    run_id: "run-projection",
    cycle_id: "cycle-20260521",
    goal: "构建工作台 projection assembler",
    context_pack: contextPack(),
    work_packages: [
      { id: "projection-runtime", status: "completed", owned_files: ["src/workflow/workbench-projection.js"] },
      { id: "projection-test", status: "completed", owned_files: ["test/workbench-projection.test.js"] }
    ],
    artifacts: [{ id: "projection-patch", status: "pass" }],
    gate_results: [{ gate_id: "unit-tests", status: "pass" }],
    review_findings: [timeoutFinding],
    recovery_attempts: []
  });

  return {
    manifest,
    artifact_ledger: createArtifactLedger({
      run_id: "run-projection",
      cycle_id: "cycle-20260521",
      artifacts: [
        {
          id: "projection-patch",
          type: "patch",
          status: "pass",
          path: "src/workflow/workbench-projection.js",
          producer: "main-process",
          created_at: "2026-05-21T00:00:00.000Z"
        }
      ]
    }),
    model_plan: buildModelCollaborationPlan({
      goal: "构建工作台 projection assembler",
      stage: "implementation",
      risk: "high",
      budget_tier: "high",
      host: "platform_core",
      tags: ["boundary_sensitive"]
    }),
    reviewer_gate: {
      request: reviewerRequest,
      findings: [timeoutFinding]
    },
    task_dag: manifest.work_packages,
    generated_at: "2026-05-21T00:01:00.000Z",
    ...overrides
  };
}

test("workbench projection combines run, artifacts, model routing, reviewer and DAG state", () => {
  const projection = createWorkbenchProjection(baseInput());

  assert.equal(projection.projection_version, "workbench.v1");
  assert.equal(projection.run_id, "run-projection");
  assert.equal(projection.status, "rerun");
  assert.equal(projection.decision, "rerun");
  assert.equal(projection.manifest.status, "pass");
  assert.equal(projection.artifacts.total, 1);
  assert.equal(projection.closeout.status, "not_configured");
  assert.equal(projection.model_routing.selected_model, "gpt");
  assert.equal(projection.model_routing.has_independent_reviewer, true);
  assert.equal(projection.reviewer_gate.recommended_decision_signal, "rerun");
  assert.equal(projection.task_dag.status, "pass");
  assert.equal(projection.one_screen.counters.reviewer_findings, 1);
  assert.equal(projection.one_screen.counters.closeout_publishes, 0);
  assert.equal(projection.resume_health.status, "not_configured");
  assert.equal(projection.one_screen.counters.resume_blockers, 0);
});

test("workbench projection exposes latest closeout publication evidence", () => {
  const input = baseInput();
  const artifact = {
    id: "closeout-snapshot-run-projection",
    type: "evaluation",
    status: "pass",
    path: "docs/examples/snapshots/run-projection.workbench-input.json",
    producer: "closeout-runner",
    created_at: "2026-05-21T10:30:00.000Z",
    metadata: {
      snapshot_id: "run-projection",
      closeout_status: "created",
      issues: []
    }
  };
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: "event-closeout-snapshot-run-projection",
        type: "closeout_snapshot_publish",
        status: "created",
        artifact_id: artifact.id,
        snapshot_id: "run-projection",
        created_at: "2026-05-21T10:30:00.000Z"
      }
    ],
    artifacts: [...input.manifest.artifacts, artifact]
  };
  input.artifact_ledger = {
    ...input.artifact_ledger,
    artifacts: [...input.artifact_ledger.artifacts, artifact]
  };

  const projection = createWorkbenchProjection(input);
  const mobile = createMobileWorkbenchProjection(input);

  assert.equal(projection.closeout.status, "pass");
  assert.equal(projection.closeout.publish_status, "created");
  assert.equal(projection.closeout.artifact_id, "closeout-snapshot-run-projection");
  assert.equal(projection.closeout.path, "docs/examples/snapshots/run-projection.workbench-input.json");
  assert.equal(projection.one_screen.counters.closeout_publishes, 1);
  assert.equal(mobile.closeout.status, "pass");
  assert.equal(mobile.closeout.snapshot_id, "run-projection");
});

test("workbench projection exposes replay validation blockers as resume health", () => {
  const input = baseInput();
  const artifact = {
    id: "autonomous-loop-replay-validation-run-projection-cycle-20260521-001",
    type: "evaluation",
    status: "fail",
    uri: "autonomous-loop://replay-validation/run-projection/cycle-20260521",
    producer: "autonomous-orchestrator",
    created_at: "2026-05-21T11:15:00.000Z",
    metadata: {
      run_id: "run-projection",
      cycle_id: "cycle-20260521",
      replay_status: "blocked",
      issues: [{ code: "result_drift", message: "replay result drifted from stored projection", path: "result" }]
    }
  };
  input.manifest = {
    ...input.manifest,
    events: [
      ...input.manifest.events,
      {
        id: `event-${artifact.id}`,
        type: "autonomous_loop_replay_validation",
        status: "blocked",
        artifact_id: artifact.id,
        message: "autonomous loop replay validation blocked scheduler continuation",
        created_at: "2026-05-21T11:15:00.000Z",
        metadata: artifact.metadata
      }
    ],
    artifacts: [...input.manifest.artifacts, artifact]
  };
  input.artifact_ledger = {
    ...input.artifact_ledger,
    artifacts: [...input.artifact_ledger.artifacts, artifact]
  };

  const projection = createWorkbenchProjection(input);
  const mobile = createMobileWorkbenchProjection(input);

  assert.equal(projection.resume_health.status, "blocked");
  assert.equal(projection.resume_health.replay_status, "blocked");
  assert.equal(projection.resume_health.artifact_id, artifact.id);
  assert.equal(projection.resume_health.issue_count, 1);
  assert.equal(projection.resume_health.latest_issue, "replay result drifted from stored projection");
  assert.equal(projection.one_screen.counters.resume_blockers, 1);
  assert.equal(mobile.resume_health.status, "blocked");
  assert.equal(mobile.resume_health.latest_issue, "replay result drifted from stored projection");
});

test("workbench projection ingests operator events before summarizing run state", () => {
  const input = baseInput({
    operator_event_ledger: {
      version: "operator-events.v1",
      events: [
        {
          id: "operator-event-projection-validate",
          action: "validate",
          run_id: "run-projection",
          cycle_id: "cycle-20260521",
          created_at: "2026-05-21T00:02:00.000Z",
          metadata: {
            projection_id: "current"
          }
        }
      ]
    }
  });

  const projection = createWorkbenchProjection(input);

  assert.equal(projection.status, "rerun");
  assert.equal(projection.operator_events.status, "pass");
  assert.equal(projection.operator_events.applied_run_events, 1);
  assert.equal(projection.operator_events.applied_artifacts, 1);
  assert.equal(projection.manifest.event_count, 1);
  assert.equal(projection.artifacts.total, 2);
  assert.equal(projection.artifacts.by_type.evaluation, 1);
  assert.equal(projection.autonomous_run.summaries.artifacts.total, 2);
});

test("workbench projection ignores stale run result when operator events are present", () => {
  const input = baseInput({
    run_result: {
      run_id: "run-projection",
      cycle_id: "cycle-20260521",
      work_packages: [],
      artifacts: [{ id: "stale", status: "pass" }],
      gate_results: [],
      review_findings: [],
      recovery_attempts: []
    },
    run_evaluation: {
      run_id: "run-projection",
      cycle_id: "cycle-20260521",
      status: "pass",
      decision: "pass",
      reasons: ["stale pass"],
      projection: {
        summaries: {
          artifacts: { total: 1, passed: 1, failed: 0, unknown: 0 }
        }
      }
    },
    operator_event_ledger: {
      version: "operator-events.v1",
      events: [
        {
          id: "operator-event-projection-validate",
          action: "validate",
          run_id: "run-projection",
          cycle_id: "cycle-20260521",
          created_at: "2026-05-21T00:02:00.000Z"
        }
      ]
    }
  });

  const projection = createWorkbenchProjection(input);

  assert.equal(projection.operator_events.applied_artifacts, 1);
  assert.equal(projection.artifacts.total, 2);
  assert.equal(projection.autonomous_run.summaries.artifacts.total, 2);
  assert.notDeepEqual(projection.reasons, ["stale pass"]);
});

test("workbench projection can use explicit run evaluation when no operator events are present", () => {
  const projection = createWorkbenchProjection(
    baseInput({
      run_evaluation: {
        run_id: "run-projection",
        cycle_id: "cycle-20260521",
        status: "pass",
        decision: "pass",
        reasons: ["explicit evaluation"],
        projection: {
          run_id: "run-projection",
          cycle_id: "cycle-20260521",
          status: "pass",
          decision: "pass",
          reasons: ["explicit evaluation"],
          blockers: [],
          summaries: {
            artifacts: { total: 1, passed: 1, failed: 0, unknown: 0 }
          }
        }
      }
    })
  );

  assert.equal(projection.status, "rerun");
  assert.deepEqual(projection.reasons, ["explicit evaluation"]);
});

test("workbench projection fails closed when operator event ingestion fails", () => {
  const projection = createWorkbenchProjection(
    baseInput({
      operator_event_ledger: {
        version: "operator-events.v1",
        events: [{ id: "orphan", action: "validate" }]
      }
    })
  );

  assert.equal(projection.status, "human_intervention");
  assert.equal(projection.operator_events.status, "fail");
  assert.ok(projection.operator_events.issues.some((issue) => issue.code === "missing_operator_event_field"));
  assert.equal(projection.manifest.event_count, 0);
  assert.equal(projection.artifacts.total, 1);
});

test("mobile projection keeps the one-screen subset", () => {
  const mobile = createMobileWorkbenchProjection(baseInput());

  assert.equal(mobile.projection_version, "workbench.mobile.v1");
  assert.equal(mobile.status, "rerun");
  assert.equal(mobile.model.selected_model, "gpt");
  assert.equal(mobile.reviewer.recommended_decision_signal, "rerun");
  assert.equal(mobile.resume_health.status, "not_configured");
  assert.ok(mobile.next_actions.length <= 3);
});

test("projection input validation fails without durable sources", () => {
  const validation = validateWorkbenchProjectionInput({});
  const projection = createWorkbenchProjection({});

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some((issue) => issue.code === "missing_manifest"));
  assert.equal(projection.status, "human_intervention");
  assert.equal(projection.input_validation.status, "fail");
});
