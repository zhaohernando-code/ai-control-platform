import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { decideContinuation } from "../src/workflow/autonomous-continuation.js";
import {
  createAutonomousLoopRunArtifact,
  prepareAutonomousContinuationFromLoopArtifact,
  recordReplayValidationBlocker,
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

test("prepareAutonomousContinuationFromLoopArtifact blocks scheduler reuse of invalid artifacts", async () => {
  const artifact = await createValidLoopArtifact("orchestrator-reuse");
  const ready = prepareAutonomousContinuationFromLoopArtifact(artifact);

  assert.equal(ready.status, "ready");
  assert.equal(ready.should_continue, true);
  assert.equal(ready.continuation_input.project_status.project, "ai-control-platform");
  assert.equal(ready.continuation_input.workflow_state.manifest.run_id, artifact.run_id);
  assert.equal(ready.snapshot_publish_plan.action, "publish_workbench_snapshot");

  const damaged = JSON.parse(JSON.stringify(artifact));
  damaged.result.next_decision.snapshot_publish_plan.input.manifest.run_id = "wrong-run";
  const blocked = prepareAutonomousContinuationFromLoopArtifact(damaged);

  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.should_continue, false);
  assert.equal(blocked.continuation_input, null);
  assert.equal(blocked.blockers[0].category, "replay_artifact_invalid");
  assert.equal(blocked.workflow_state.manifest.events.at(-1).type, "autonomous_loop_replay_validation");
  assert.equal(blocked.workflow_state.artifact_ledger.artifacts.at(-1).status, "fail");
  assert.ok(blocked.issues.some((entry) => entry.path === "result.next_decision.snapshot_publish_plan.input.manifest.run_id"));
  const blockedProjection = createWorkbenchProjection(blocked.workflow_state);
  assert.equal(blockedProjection.artifacts.by_status.fail, 2);
  assert.equal(blockedProjection.autonomous_run.summaries.artifacts.failed, 2);

  const failedArtifact = {
    version: "autonomous-closeout-loop-run.v1",
    run_id: artifact.run_id,
    cycle_id: artifact.cycle_id,
    status: "fail",
    phase: "closeout",
    created_at: "2026-05-21T11:00:00.000Z",
    input: artifact.input,
    result: {
      status: "fail",
      phase: "closeout",
      issues: [],
      decision: null,
      closeout: null,
      projection: null,
      next_decision: null
    }
  };
  const failedBlocked = prepareAutonomousContinuationFromLoopArtifact(failedArtifact);

  assert.equal(validateAutonomousLoopRunArtifact(failedArtifact).status, "pass");
  assert.equal(failedBlocked.status, "blocked");
  assert.equal(failedBlocked.workflow_state.manifest.events.at(-1).type, "autonomous_loop_replay_validation");
  assert.ok(failedBlocked.issues.some((entry) => entry.code === "non_reusable_artifact_status"));

  const missingCloseoutState = JSON.parse(JSON.stringify(artifact));
  delete missingCloseoutState.result.closeout.workflow_state;
  const missingCloseoutBlocked = prepareAutonomousContinuationFromLoopArtifact(missingCloseoutState);

  assert.equal(missingCloseoutBlocked.status, "blocked");
  assert.ok(missingCloseoutBlocked.issues.some((entry) => entry.code === "missing_reusable_workflow_state"));

  const missingContextSeed = JSON.parse(JSON.stringify(artifact));
  delete missingContextSeed.result.next_decision.context_pack_seed;
  const missingContextBlocked = prepareAutonomousContinuationFromLoopArtifact(missingContextSeed);

  assert.equal(missingContextBlocked.status, "blocked");
  assert.ok(missingContextBlocked.issues.some((entry) => entry.code === "missing_reusable_context_pack_seed"));

  const missingInitialPlan = JSON.parse(JSON.stringify(artifact));
  delete missingInitialPlan.result.decision.snapshot_publish_plan;
  const missingInitialPlanBlocked = prepareAutonomousContinuationFromLoopArtifact(missingInitialPlan);

  assert.equal(missingInitialPlanBlocked.status, "blocked");
  assert.ok(missingInitialPlanBlocked.issues.some((entry) => entry.code === "invalid_initial_snapshot_publish_plan"));

  const malformedInitialPlan = JSON.parse(JSON.stringify(artifact));
  malformedInitialPlan.result.decision.snapshot_publish_plan = {};
  const malformedInitialPlanBlocked = prepareAutonomousContinuationFromLoopArtifact(malformedInitialPlan);

  assert.equal(malformedInitialPlanBlocked.status, "blocked");
  assert.ok(malformedInitialPlanBlocked.issues.some((entry) => entry.code === "invalid_initial_snapshot_publish_plan"));
});

test("recordReplayValidationBlocker writes durable manifest and artifact ledger evidence", async () => {
  const artifact = await createValidLoopArtifact("orchestrator-replay-evidence");
  const workflowState = recordReplayValidationBlocker(artifact.input.workflow_state, [
    { code: "sample_replay_issue", message: "sample replay issue", path: "result" }
  ], {
    created_at: "2026-05-21T11:15:00.000Z"
  });

  const event = workflowState.manifest.events.at(-1);
  const ledgerArtifact = workflowState.artifact_ledger.artifacts.at(-1);
  const projection = createWorkbenchProjection(workflowState);

  assert.equal(event.type, "autonomous_loop_replay_validation");
  assert.equal(event.status, "blocked");
  assert.match(event.artifact_id, /-001$/);
  assert.equal(ledgerArtifact.type, "evaluation");
  assert.equal(ledgerArtifact.status, "fail");
  assert.equal(ledgerArtifact.producer, "autonomous-orchestrator");
  assert.equal(ledgerArtifact.metadata.issues[0].code, "sample_replay_issue");
  assert.equal(projection.autonomous_run.summaries.artifacts.failed, 2);

  const secondWorkflowState = recordReplayValidationBlocker(workflowState, [
    { code: "second_replay_issue", message: "second replay issue", path: "result" }
  ], {
    created_at: "2026-05-21T11:16:00.000Z"
  });

  assert.match(secondWorkflowState.manifest.events.at(-1).artifact_id, /-002$/);
  assert.notEqual(secondWorkflowState.manifest.events.at(-1).id, event.id);
  assert.equal(secondWorkflowState.artifact_ledger.artifacts.filter((entry) => entry.id.includes("autonomous-loop-replay-validation")).length, 2);

  const explicitWorkflowState = recordReplayValidationBlocker(secondWorkflowState, [
    { code: "explicit_replay_issue", message: "explicit replay issue", path: "result" }
  ], {
    artifact_id: ledgerArtifact.id,
    created_at: "2026-05-21T11:17:00.000Z"
  });

  assert.match(explicitWorkflowState.artifact_ledger.artifacts.at(-1).id, new RegExp(`${ledgerArtifact.id}-001$`));

  const mismatchedWorkflowState = JSON.parse(JSON.stringify(artifact.input.workflow_state));
  mismatchedWorkflowState.artifact_ledger.run_id = "wrong-run";
  assert.equal(recordReplayValidationBlocker(mismatchedWorkflowState, [{ code: "bad_state" }]), null);

  const mismatchedArtifact = JSON.parse(JSON.stringify(artifact));
  mismatchedArtifact.input.workflow_state.artifact_ledger.run_id = "wrong-run";
  mismatchedArtifact.result.next_decision.snapshot_publish_plan.input.manifest.run_id = "wrong-run";
  const mismatchedBlocked = prepareAutonomousContinuationFromLoopArtifact(mismatchedArtifact);

  assert.equal(mismatchedBlocked.status, "blocked");
  assert.equal(mismatchedBlocked.workflow_state, null);
});

test("run-autonomous-closeout-loop resume mode validates artifacts before scheduler continuation", async () => {
  const artifact = await createValidLoopArtifact("orchestrator-resume-cli");
  const dir = mkdtempSync(join(process.cwd(), "tmp/orchestrator-resume-cli-check-"));
  const artifactPath = join(dir, "loop-run.json");
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);

  const ready = spawnSync(process.execPath, ["tools/run-autonomous-closeout-loop.mjs", "--resume-from", artifactPath], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });

  assert.equal(ready.status, 0);
  assert.equal(JSON.parse(ready.stdout).status, "ready");

  const damagedPath = join(dir, "damaged-loop-run.json");
  const historyPath = join(dir, "projection-history.json");
  const snapshotsRoot = join(dir, "snapshots");
  writeFileSync(historyPath, JSON.stringify({ version: "projection-history.v1", latest: null, items: [] }));
  const damaged = JSON.parse(JSON.stringify(artifact));
  damaged.result.closeout.workflow_state.manifest.cycle_id = "wrong-cycle";
  writeFileSync(damagedPath, `${JSON.stringify(damaged, null, 2)}\n`);
  const blocked = spawnSync(process.execPath, [
    "tools/run-autonomous-closeout-loop.mjs",
    "--resume-from",
    damagedPath,
    "--history-path",
    historyPath,
    "--snapshots-root",
    snapshotsRoot
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });
  const blockedOutput = JSON.parse(blocked.stdout);
  const history = readJson(historyPath);
  const snapshot = readJson(blockedOutput.snapshot_publish.snapshot_path);

  assert.notEqual(blocked.status, 0);
  assert.equal(blockedOutput.status, "blocked");
  assert.equal(blockedOutput.snapshot_publish.status, "created");
  assert.equal(history.latest, artifact.run_id);
  assert.equal(snapshot.manifest.events.at(-1).type, "autonomous_loop_replay_validation");
  assert.equal(snapshot.artifact_ledger.artifacts.at(-1).status, "fail");
  assert.match(blocked.stdout, /replay_artifact_invalid/);

  const missing = spawnSync(process.execPath, ["tools/run-autonomous-closeout-loop.mjs", "--resume-from", join(dir, "missing.json")], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });

  assert.notEqual(missing.status, 0);
  assert.equal(JSON.parse(missing.stdout).status, "blocked");
  assert.match(missing.stdout, /replay_artifact_read_failed/);

  const badJsonPath = join(dir, "bad.json");
  writeFileSync(badJsonPath, "{bad json");
  const badJson = spawnSync(process.execPath, ["tools/run-autonomous-closeout-loop.mjs", "--resume-from", badJsonPath], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });

  assert.notEqual(badJson.status, 0);
  assert.equal(JSON.parse(badJson.stdout).status, "blocked");
  assert.match(badJson.stdout, /replay_artifact_read_failed/);

  const ambiguous = spawnSync(process.execPath, [
    "tools/run-autonomous-closeout-loop.mjs",
    "--input",
    artifactPath,
    "--resume-from",
    artifactPath
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });

  assert.notEqual(ambiguous.status, 0);
  assert.equal(JSON.parse(ambiguous.stdout).status, "blocked");
  assert.match(ambiguous.stdout, /ambiguous_autonomous_loop_mode/);
});
