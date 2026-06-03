import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { createSqliteWorkbenchStateStore } from "../src/workflow/workbench-state-store.js";
import { currentSessionWorkflowState } from "./helpers/current-session-workflow-state.js";
import {
  projectStatus,
  sourceWorkflowState,
  withWorkbenchServer
} from "./helpers/headless-cli-orchestrator.js";

test("run-headless-cli-orchestrator CLI executes projected action through local workbench service", async () => {
  mkdirSync("tmp", { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), "tmp/headless-cli-service-trial-"));
  const projectStatusPath = join(dir, "PROJECT_STATUS.json");
  const workflowStatePath = join(dir, "workflow-state.json");
  const serviceHistoryPath = join(dir, "projection-history.json");
  const snapshotsRoot = join(dir, "snapshots");
  const serviceInputPath = join(snapshotsRoot, "service-input.json");
  const outputPath = join(dir, "headless-service-output.json");
  const workflowOutputPath = join(dir, "headless-service-workflow.json");
  const status = projectStatus({
    next_step: "",
    global_goals: [
      {
        id: "service-trial-goal",
        title: "Service trial goal",
        status: "in_progress",
        next_step: "Prepare projected service continuation.",
        owned_files: ["src/workflow/headless-cli-orchestrator.js"]
      }
    ]
  });

  mkdirSync(snapshotsRoot, { recursive: true });
  writeFileSync(projectStatusPath, `${JSON.stringify(status, null, 2)}\n`);
  writeFileSync(workflowStatePath, `${JSON.stringify(sourceWorkflowState(), null, 2)}\n`);
  writeFileSync(serviceInputPath, `${JSON.stringify(sourceWorkflowState(), null, 2)}\n`);
  writeFileSync(serviceHistoryPath, `${JSON.stringify({
    version: "projection-history.v1",
    latest: "headless-service-source",
    items: [
      {
        id: "headless-service-source",
        label: "Headless service source",
        input_path: relative(process.cwd(), serviceInputPath)
      }
    ]
  }, null, 2)}\n`);

  await withWorkbenchServer(async (baseUrl, serverOptions) => {
    const result = spawnSync(process.execPath, [
      "tools/run-headless-cli-orchestrator.mjs",
      "--project-status",
      projectStatusPath,
      "--workflow-state",
      workflowStatePath,
      "--output",
      outputPath,
      "--workflow-output",
      workflowOutputPath,
      "--history-path",
      join(dir, "headless-history.json"),
      "--snapshots-root",
      snapshotsRoot,
      "--snapshot-prefix",
      "headless-service",
      "--loop",
      "--max-iterations",
      "1",
      "--cycle-id",
      "cycle-headless-service",
      "--created-at",
      "2026-05-23T03:20:00.000Z",
      "--allow-mock-child-worker",
      "--execution-strategy",
      "projected_next_action",
      "--workbench-base-url",
      baseUrl,
      "--workbench-projection-id",
      "headless-service-source"
    ], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(readFileSync(outputPath, "utf8"));
    const workflowOutput = JSON.parse(readFileSync(workflowOutputPath, "utf8"));
    const serviceState = createSqliteWorkbenchStateStore({ dbPath: serverOptions.stateDbPath })
      .readWorkflowSnapshot("headless-service-source");
    const progressEvent = workflowOutput.manifest.events.find((event) => event.type === "headless_projected_action_progress");

    assert.equal(output.status, "pass");
    assert.equal(output.iterations[0].projected_next_action_status, "executed");
    assert.equal(output.iterations[0].projected_next_action, "prepare_project_status_continuation");
    assert.equal(serviceState.manifest.events.at(-1).type, "project_status_continuation");
    assert.ok(progressEvent);
    assert.equal(progressEvent.metadata.action, "prepare_project_status_continuation");
    assert.equal(progressEvent.metadata.has_projection, true);
  }, { historyPath: serviceHistoryPath, snapshotsRoot, projectStatusPath });
});

test("run-headless-cli-orchestrator CLI passes reviewer controls to projected service actions", async () => {
  mkdirSync("tmp", { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), "tmp/headless-cli-service-reviewer-"));
  const projectStatusPath = join(dir, "PROJECT_STATUS.json");
  const workflowStatePath = join(dir, "workflow-state.json");
  const serviceHistoryPath = join(dir, "projection-history.json");
  const snapshotsRoot = join(dir, "snapshots");
  const serviceInputPath = join(snapshotsRoot, "service-reviewer-input.json");
  const outputPath = join(dir, "headless-service-reviewer-output.json");
  const workflowOutputPath = join(dir, "headless-service-reviewer-workflow.json");
  const workflowState = currentSessionWorkflowState({
    withoutRequirementIntake: true,
    withoutSchedulerLoop: true
  });

  mkdirSync(snapshotsRoot, { recursive: true });
  writeFileSync(projectStatusPath, `${JSON.stringify(projectStatus(), null, 2)}\n`);
  writeFileSync(workflowStatePath, `${JSON.stringify(sourceWorkflowState(), null, 2)}\n`);
  writeFileSync(serviceInputPath, `${JSON.stringify(workflowState, null, 2)}\n`);
  writeFileSync(serviceHistoryPath, `${JSON.stringify({
    version: "projection-history.v1",
    latest: "headless-service-reviewer",
    items: [
      {
        id: "headless-service-reviewer",
        label: "Headless service reviewer",
        input_path: relative(process.cwd(), serviceInputPath)
      }
    ]
  }, null, 2)}\n`);

  await withWorkbenchServer(async (baseUrl, serverOptions) => {
    const result = spawnSync(process.execPath, [
      "tools/run-headless-cli-orchestrator.mjs",
      "--project-status",
      projectStatusPath,
      "--workflow-state",
      workflowStatePath,
      "--output",
      outputPath,
      "--workflow-output",
      workflowOutputPath,
      "--history-path",
      join(dir, "headless-history.json"),
      "--snapshots-root",
      snapshotsRoot,
      "--snapshot-prefix",
      "headless-service-reviewer",
      "--loop",
      "--max-iterations",
      "1",
      "--cycle-id",
      "cycle-headless-service-reviewer",
      "--created-at",
      "2026-05-23T04:30:00.000Z",
      "--allow-mock-child-worker",
      "--execution-strategy",
      "projected_next_action",
      "--workbench-base-url",
      baseUrl,
      "--workbench-projection-id",
      "headless-service-reviewer",
      "--execution-profile",
      "approved_mock_non_dry_run",
      "--context-work-package-execution-profile",
      "local_bounded",
      "--reviewer-mock-status",
      "pass"
    ], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(readFileSync(outputPath, "utf8"));
    const workflowOutput = JSON.parse(readFileSync(workflowOutputPath, "utf8"));
    const serviceState = createSqliteWorkbenchStateStore({ dbPath: serverOptions.stateDbPath })
      .readWorkflowSnapshot("headless-service-reviewer");
    const progressEvent = workflowOutput.manifest.events.find((event) => event.type === "headless_projected_action_progress");
    const shardEvent = serviceState.manifest.events.find((event) => event.type === "reviewer_shard_result");

    assert.equal(output.status, "pass");
    assert.equal(output.iterations[0].projected_next_action_status, "executed");
    assert.equal(output.iterations[0].projected_next_action, "run_reviewer_scope_shard");
    assert.ok(shardEvent);
    assert.equal(shardEvent.metadata.shard_id, "reviewer-scope-shard-001");
    assert.equal(shardEvent.metadata.executor_provenance.executor_kind, "mock");
    assert.ok(progressEvent);
    assert.equal(progressEvent.metadata.action, "run_reviewer_scope_shard");
    assert.equal(progressEvent.metadata.has_projection, true);
  }, { historyPath: serviceHistoryPath, snapshotsRoot, projectStatusPath });
});
