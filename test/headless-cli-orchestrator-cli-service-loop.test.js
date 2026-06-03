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

test("run-headless-cli-orchestrator CLI continues after reviewer aggregate through service", async () => {
  mkdirSync("tmp", { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), "tmp/headless-cli-service-reviewer-aggregate-"));
  const projectStatusPath = join(dir, "PROJECT_STATUS.json");
  const workflowStatePath = join(dir, "workflow-state.json");
  const serviceHistoryPath = join(dir, "projection-history.json");
  const snapshotsRoot = join(dir, "snapshots");
  const serviceInputPath = join(snapshotsRoot, "service-reviewer-aggregate-input.json");
  const outputPath = join(dir, "headless-service-reviewer-aggregate-output.json");
  const workflowOutputPath = join(dir, "headless-service-reviewer-aggregate-workflow.json");
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
    latest: "headless-service-reviewer-aggregate",
    items: [
      {
        id: "headless-service-reviewer-aggregate",
        label: "Headless service reviewer aggregate",
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
      "headless-service-reviewer-aggregate",
      "--loop",
      "--max-iterations",
      "5",
      "--cycle-id",
      "cycle-headless-service-reviewer-aggregate",
      "--created-at",
      "2026-05-23T04:45:00.000Z",
      "--allow-mock-child-worker",
      "--execution-strategy",
      "projected_next_action",
      "--workbench-base-url",
      baseUrl,
      "--workbench-projection-id",
      "headless-service-reviewer-aggregate",
      "--execution-profile",
      "approved_mock_non_dry_run",
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
      .readWorkflowSnapshot("headless-service-reviewer-aggregate");
    const progressActions = workflowOutput.manifest.events
      .filter((event) => event.type === "headless_projected_action_progress")
      .map((event) => event.metadata.action);

    assert.equal(output.status, "pass");
    assert.deepEqual(output.iterations.map((iteration) => iteration.projected_next_action), [
      "run_reviewer_scope_shard",
      "run_reviewer_scope_shard",
      "continue_after_reviewer_aggregate",
      "create_context_pack_from_seed",
      "run_context_work_packages"
    ]);
    assert.match(output.iterations[3].workbench_projection_id, /^context-pack-cycle-headless-service-reviewer-aggregate-/);
    assert.equal(output.iterations[4].workbench_projection_id, output.iterations[3].projected_next_projection_id);
    assert.equal(progressActions.at(-1), "run_context_work_packages");
    assert.ok(serviceState.manifest.events.some((event) => event.type === "reviewer_shard_aggregate"));
    assert.ok(serviceState.manifest.events.some((event) => event.type === "project_status_continuation"));
    assert.ok(serviceState.manifest.events.some((event) => event.type === "context_pack_cycle_materialized"));
    assert.equal(output.last_result.projected_next_action.action, "run_context_work_packages");
  }, { historyPath: serviceHistoryPath, snapshotsRoot, projectStatusPath });
});

test("run-headless-cli-orchestrator CLI follows service next projection into context work packages", async () => {
  mkdirSync("tmp", { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), "tmp/headless-cli-service-projection-cursor-"));
  const projectStatusPath = join(dir, "PROJECT_STATUS.json");
  const workflowStatePath = join(dir, "workflow-state.json");
  const serviceHistoryPath = join(dir, "projection-history.json");
  const snapshotsRoot = join(dir, "snapshots");
  const serviceInputPath = join(snapshotsRoot, "service-projection-cursor-input.json");
  const outputPath = join(dir, "headless-service-projection-cursor-output.json");
  const workflowOutputPath = join(dir, "headless-service-projection-cursor-workflow.json");
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
    latest: "headless-service-projection-cursor",
    items: [
      {
        id: "headless-service-projection-cursor",
        label: "Headless service projection cursor",
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
      "headless-service-projection-cursor",
      "--loop",
      "--max-iterations",
      "5",
      "--cycle-id",
      "cycle-headless-service-projection-cursor",
      "--created-at",
      "2026-05-23T10:25:00.000Z",
      "--allow-mock-child-worker",
      "--execution-strategy",
      "projected_next_action",
      "--workbench-base-url",
      baseUrl,
      "--workbench-projection-id",
      "headless-service-projection-cursor",
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
    const store = createSqliteWorkbenchStateStore({ dbPath: serverOptions.stateDbPath });
    const serviceHistory = store.readHistory();
    const nextItem = serviceHistory.items.find((item) => item.id.startsWith("context-pack-cycle-headless-service-projection-cursor-"));
    assert.ok(nextItem, "context pack cycle snapshot must be published into service history");
    const nextState = store.readWorkflowSnapshot(nextItem.id);
    const nextEventTypes = nextState.manifest.events.map((event) => event.type);

    assert.equal(output.status, "pass");
    assert.deepEqual(output.iterations.map((iteration) => iteration.projected_next_action), [
      "run_reviewer_scope_shard",
      "run_reviewer_scope_shard",
      "continue_after_reviewer_aggregate",
      "create_context_pack_from_seed",
      "run_context_work_packages"
    ]);
    assert.ok(output.iterations[3].projected_next_projection_id);
    assert.equal(output.iterations[4].projected_next_action, "run_context_work_packages");
    assert.ok(nextEventTypes.includes("context_work_packages_run"));
    assert.equal(nextState.manifest.work_packages[0].status, "completed");
  }, { historyPath: serviceHistoryPath, snapshotsRoot, projectStatusPath });
});
