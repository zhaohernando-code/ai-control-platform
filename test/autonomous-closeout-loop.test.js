import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { decideContinuation } from "../src/workflow/autonomous-continuation.js";
import { runCloseoutPlan } from "../src/workflow/closeout-runner.js";
import { createWorkbenchProjection } from "../src/workflow/workbench-projection.js";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function projectStatus(nextStep = "Continue autonomous platform development from closeout evidence.") {
  return {
    project: "ai-control-platform",
    blockers: [],
    next_step: nextStep
  };
}

test("continuation closeout loop remains autonomous and projection-ready", async () => {
  const workflowState = readJson("docs/examples/current-session-workbench-input.json");
  const decision = decideContinuation({
    project_status: projectStatus("Publish the latest workflow state before continuing."),
    run_evaluation: { status: "pass" },
    workflow_state: workflowState
  });

  assert.equal(decision.should_continue, true);
  assert.equal(decision.snapshot_publish_plan.action, "publish_workbench_snapshot");
  assert.deepEqual(decision.snapshot_publish_issues, []);

  mkdirSync("tmp", { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), "tmp/closeout-loop-"));
  const historyPath = join(dir, "projection-history.json");
  const snapshotsRoot = join(process.cwd(), "tmp/closeout-loop-snapshots");
  writeFileSync(historyPath, JSON.stringify({ version: "projection-history.v1", latest: null, items: [] }));

  const closeout = await runCloseoutPlan({ snapshot_publish_plan: decision.snapshot_publish_plan }, {
    root: process.cwd(),
    historyPath,
    snapshotsRoot,
    created_at: "2026-05-21T10:45:00.000Z"
  });
  const projection = createWorkbenchProjection(closeout.workflow_state);
  const nextDecision = decideContinuation({
    project_status: projectStatus("Dispatch the next work package after closeout evidence is visible."),
    run_evaluation: { status: projection.status },
    workflow_state: closeout.workflow_state
  });

  assert.equal(closeout.status, "created");
  assert.equal(closeout.evidence_snapshot_publish.status, "created");
  assert.equal(projection.closeout.status, "pass");
  assert.equal(projection.closeout.publish_status, "created");
  assert.equal(projection.one_screen.counters.closeout_publishes, 1);
  assert.equal(nextDecision.should_continue, true);
  assert.equal(nextDecision.context_pack_seed.target_project_id, "ai-control-platform");
  assert.equal(nextDecision.snapshot_publish_plan.action, "publish_workbench_snapshot");
  assert.deepEqual(nextDecision.snapshot_publish_issues, []);
});
