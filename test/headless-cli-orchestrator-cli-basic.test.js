import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  CHILD_WORKER_ROLE,
  HEADLESS_MAIN_ORCHESTRATOR_ROLE
} from "../src/workflow/headless-cli-orchestrator.js";
import {
  projectStatus,
  sourceWorkflowState
} from "./helpers/headless-cli-orchestrator.js";

test("run-headless-cli-orchestrator CLI writes replayable output", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cli-orchestrator-"));
  const projectStatusPath = join(dir, "PROJECT_STATUS.json");
  const workflowStatePath = join(dir, "workflow-state.json");
  const outputPath = join(dir, "headless-output.json");

  writeFileSync(projectStatusPath, `${JSON.stringify(projectStatus(), null, 2)}\n`);
  writeFileSync(workflowStatePath, `${JSON.stringify(sourceWorkflowState(), null, 2)}\n`);

  const result = spawnSync(process.execPath, [
    "tools/run-headless-cli-orchestrator.mjs",
    "--project-status",
    projectStatusPath,
    "--workflow-state",
    workflowStatePath,
    "--output",
    outputPath,
    "--cycle-id",
    "cycle-headless-cli-file",
    "--created-at",
    "2026-05-23T00:03:00.000Z",
    "--allow-mock-child-worker"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(readFileSync(outputPath, "utf8"));
  assert.equal(output.status, "pass");
  assert.equal(output.role, HEADLESS_MAIN_ORCHESTRATOR_ROLE);
  assert.equal(output.child_role, CHILD_WORKER_ROLE);
  assert.equal(output.workflow_state.manifest.cycle_id, "cycle-headless-cli-file");
});

test("run-headless-cli-orchestrator CLI can persist a bounded loop to projection history", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cli-orchestrator-loop-"));
  const projectStatusPath = join(dir, "PROJECT_STATUS.json");
  const workflowStatePath = join(dir, "workflow-state.json");
  const historyPath = join(dir, "projection-history.json");
  const snapshotsRoot = join(dir, "snapshots");
  const outputPath = join(dir, "headless-loop-output.json");
  const workflowOutputPath = join(dir, "headless-loop-workflow.json");

  writeFileSync(projectStatusPath, `${JSON.stringify(projectStatus(), null, 2)}\n`);
  writeFileSync(workflowStatePath, `${JSON.stringify(sourceWorkflowState(), null, 2)}\n`);

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
    historyPath,
    "--snapshots-root",
    snapshotsRoot,
    "--snapshot-prefix",
    "headless-cli-test",
    "--loop",
    "--max-iterations",
    "2",
    "--cycle-id",
    "cycle-headless-cli-loop",
    "--created-at",
    "2026-05-23T00:03:30.000Z",
    "--allow-mock-child-worker"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(readFileSync(outputPath, "utf8"));
  const history = JSON.parse(readFileSync(historyPath, "utf8"));
  const workflowOutput = JSON.parse(readFileSync(workflowOutputPath, "utf8"));
  assert.equal(output.status, "pass");
  assert.equal(output.iterations.length, 2);
  assert.equal(history.items.length, 2);
  assert.equal(workflowOutput.manifest.cycle_id, output.last_result.workflow_state.manifest.cycle_id);
  assert.equal(workflowOutput.manifest.events.at(-1).type, "headless_cli_snapshot_publish");
});

test("run-headless-cli-orchestrator CLI exposes projected next-action workbench controls", () => {
  const result = spawnSync(process.execPath, [
    "tools/run-headless-cli-orchestrator.mjs",
    "--help"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /--execution-strategy/);
  assert.match(result.stdout, /--workbench-base-url/);
  assert.match(result.stdout, /--workbench-projection-id/);
  assert.match(result.stdout, /--projected-next-action/);
  assert.match(result.stdout, /--context-work-package-execution-profile/);
  assert.match(result.stdout, /--reviewer-mock-status/);
});
