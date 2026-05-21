import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { decideContinuation } from "../src/workflow/autonomous-continuation.js";
import {
  createAutonomousLoopRunArtifact,
  runAutonomousCloseoutLoop,
  validateAutonomousLoopRunArtifact
} from "../src/workflow/autonomous-orchestrator.js";
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

async function createValidLoopArtifact(prefix = "orchestrator-artifact") {
  const workflowState = readJson("docs/examples/current-session-workbench-input.json");
  mkdirSync("tmp", { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), `tmp/${prefix}-`));
  const historyPath = join(dir, "projection-history.json");
  const snapshotsRoot = join(process.cwd(), `tmp/${prefix}-snapshots`);
  const input = {
    project_status: projectStatus("Publish closeout evidence and continue."),
    run_evaluation: { status: "pass" },
    workflow_state: workflowState
  };
  writeFileSync(historyPath, JSON.stringify({ version: "projection-history.v1", latest: null, items: [] }));

  const result = await runAutonomousCloseoutLoop(input, {
    root: process.cwd(),
    historyPath,
    snapshotsRoot,
    created_at: "2026-05-21T10:55:00.000Z"
  });

  return createAutonomousLoopRunArtifact(input, result, {
    created_at: "2026-05-21T10:56:00.000Z"
  });
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

test("runAutonomousCloseoutLoop executes the reusable closeout orchestration", async () => {
  const workflowState = readJson("docs/examples/current-session-workbench-input.json");
  mkdirSync("tmp", { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), "tmp/orchestrator-loop-"));
  const historyPath = join(dir, "projection-history.json");
  const snapshotsRoot = join(process.cwd(), "tmp/orchestrator-loop-snapshots");
  writeFileSync(historyPath, JSON.stringify({ version: "projection-history.v1", latest: null, items: [] }));

  const result = await runAutonomousCloseoutLoop({
    project_status: projectStatus("Publish closeout evidence and continue."),
    run_evaluation: { status: "pass" },
    workflow_state: workflowState
  }, {
    root: process.cwd(),
    historyPath,
    snapshotsRoot,
    created_at: "2026-05-21T10:50:00.000Z"
  });

  assert.equal(result.status, "pass");
  assert.equal(result.phase, "next_continuation");
  assert.equal(result.closeout.status, "created");
  assert.equal(result.projection.closeout.status, "pass");
  assert.equal(result.next_decision.should_continue, true);
  assert.equal(result.next_decision.snapshot_publish_plan.action, "publish_workbench_snapshot");
});

test("createAutonomousLoopRunArtifact stores replayable input and output", async () => {
  const artifact = await createValidLoopArtifact();

  assert.equal(artifact.version, "autonomous-closeout-loop-run.v1");
  assert.equal(artifact.status, "pass");
  assert.equal(artifact.phase, "next_continuation");
  assert.equal(artifact.input.workflow_state.manifest.run_id, "run-20260521-platform-self-trial");
  assert.equal(artifact.result.projection.closeout.status, "pass");
  assert.equal(artifact.result.next_decision.should_continue, true);
});

test("validateAutonomousLoopRunArtifact accepts replayable closeout loop artifacts", async () => {
  const artifact = await createValidLoopArtifact("orchestrator-validation");
  const validation = validateAutonomousLoopRunArtifact(artifact);

  assert.equal(validation.status, "pass");
  assert.deepEqual(validation.issues, []);
});

test("validateAutonomousLoopRunArtifact rejects damaged or drifting artifacts", async () => {
  const artifact = await createValidLoopArtifact("orchestrator-invalid");
  const damaged = JSON.parse(JSON.stringify(artifact));
  damaged.version = "autonomous-closeout-loop-run.v0";
  damaged.result.status = "fail";
  damaged.result.next_decision = null;
  damaged.result.projection.run_id = "wrong-run";
  damaged.input.workflow_state.manifest.cycle_id = "wrong-cycle";
  damaged.result.decision.snapshot_publish_plan.input.manifest.run_id = "wrong-run";
  damaged.result.closeout.workflow_state.manifest.cycle_id = "wrong-cycle";

  const validation = validateAutonomousLoopRunArtifact(damaged);

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some((entry) => entry.code === "invalid_artifact_version"));
  assert.ok(validation.issues.some((entry) => entry.code === "artifact_status_mismatch"));
  assert.ok(validation.issues.some((entry) => entry.code === "artifact_run_id_mismatch"));
  assert.ok(validation.issues.some((entry) => entry.path === "input.workflow_state.manifest.cycle_id"));
  assert.ok(validation.issues.some((entry) => entry.path === "result.decision.snapshot_publish_plan.input.manifest.run_id"));
  assert.ok(validation.issues.some((entry) => entry.path === "result.closeout.workflow_state.manifest.cycle_id"));
  assert.ok(validation.issues.some((entry) => entry.code === "missing_next_continuation"));
});

test("check-autonomous-closeout-loop-run CLI fails closed before artifact reuse", async () => {
  const artifact = await createValidLoopArtifact("orchestrator-cli");
  const dir = mkdtempSync(join(process.cwd(), "tmp/orchestrator-cli-check-"));
  const artifactPath = join(dir, "loop-run.json");
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);

  const result = spawnSync(process.execPath, ["tools/check-autonomous-closeout-loop-run.mjs", artifactPath], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).status, "pass");

  const damagedPath = join(dir, "damaged-loop-run.json");
  const damaged = JSON.parse(JSON.stringify(artifact));
  damaged.input.workflow_state.manifest.run_id = "wrong-run";
  writeFileSync(damagedPath, `${JSON.stringify(damaged, null, 2)}\n`);
  const damagedResult = spawnSync(process.execPath, ["tools/check-autonomous-closeout-loop-run.mjs", damagedPath], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.notEqual(damagedResult.status, 0);
  assert.equal(JSON.parse(damagedResult.stdout).status, "fail");
  assert.match(damagedResult.stdout, /identity_run_id_mismatch/);
});
