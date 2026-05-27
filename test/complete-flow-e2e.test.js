import assert from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runAutonomousContinuationCycle } from "../src/workflow/autonomous-orchestrator.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

test("Complete flow: continuation cycle orchestrates multiple iterations", async () => {
  const workflowState = readJson("docs/examples/current-session-workbench-input.json");
  const dir = mkdtempSync(join(process.cwd(), "tmp/e2e-"));
  const historyPath = join(dir, "history.json");
  const snapshotsRoot = join(process.cwd(), "tmp/e2e-snapshots");
  
  mkdirSync(snapshotsRoot, { recursive: true });
  writeFileSync(historyPath, JSON.stringify({ version: "projection-history.v1", latest: null, items: [] }));

  const projectStatus = {
    project: "ai-control-platform",
    blockers: [],
    next_step: "Execute continuation cycle with work packages"
  };

  const input = {
    project_status: projectStatus,
    run_evaluation: { status: "pass" },
    workflow_state: workflowState
  };

  // Run continuation cycle with max 3 iterations
  const cycle = await runAutonomousContinuationCycle(input, {
    root: process.cwd(),
    historyPath,
    snapshotsRoot,
    max_iterations: 3,
    created_at: "2026-05-27T10:10:00.000Z"
  });

  // Verify cycle completed
  assert.equal(cycle.status, "pass", "Continuation cycle should complete with pass status");
  assert.ok(cycle.total_iterations > 0, "Should run at least 1 iteration");
  assert.ok(cycle.total_iterations <= 3, "Should not exceed max iterations");
  assert.ok(cycle.iterations.length > 0, "Should have iteration records");
  
  // Verify iteration details
  cycle.iterations.forEach((iter, i) => {
    assert.ok(iter.iteration > 0, `Iteration ${i} should have valid iteration number`);
    assert.ok(["pass", "fail"].includes(iter.status), `Iteration ${i} should have valid status`);
  });

  // Verify stop reason is reasonable
  assert.ok(
    ["max_iterations_reached", "no_continuation_required", "iteration_failed", "missing_projection_state"].includes(cycle.stop_reason),
    `Stop reason should be one of expected values, got: ${cycle.stop_reason}`
  );

  console.log(`✅ Cycle completed: ${cycle.total_iterations} iterations, stopped by: ${cycle.stop_reason}`);
});

test("Complete flow: hard-exit blockers prevent continuation", async () => {
  const workflowState = readJson("docs/examples/current-session-workbench-input.json");
  const dir = mkdtempSync(join(process.cwd(), "tmp/e2e-"));
  const historyPath = join(dir, "history.json");
  const snapshotsRoot = join(process.cwd(), "tmp/e2e-snapshots");
  
  mkdirSync(snapshotsRoot, { recursive: true });
  writeFileSync(historyPath, JSON.stringify({ version: "projection-history.v1", latest: null, items: [] }));

  // Input with hard-exit blocker
  const projectStatus = {
    project: "ai-control-platform",
    blockers: [
      { id: "reviewer_smoke_stall", category: "hard_exit", message: "Reviewer smoke check stalled", requires_human: true }
    ],
    next_step: "Should stop due to hard-exit blocker"
  };

  const input = {
    project_status: projectStatus,
    run_evaluation: { status: "pass" },
    workflow_state: workflowState
  };

  const cycle = await runAutonomousContinuationCycle(input, {
    root: process.cwd(),
    historyPath,
    snapshotsRoot,
    max_iterations: 5,
    created_at: "2026-05-27T10:20:00.000Z"
  });

  // Verify hard-exit stops the cycle immediately
  assert.equal(cycle.stop_reason, "blocked_by_hard_exit", "Should stop due to hard-exit blocker");
  assert.equal(cycle.total_iterations, 0, "Should not run any iterations when hard-exit blocker present");

  console.log(`✅ Hard-exit blocker correctly stops cycle immediately`);
});

