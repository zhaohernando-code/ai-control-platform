import assert from "node:assert/strict";
import test from "node:test";

import { createWorkbenchProjection } from "../src/workflow/workbench-projection.js";
import { baseInput } from "./helpers/workbench-projection.js";

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
