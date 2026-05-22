import assert from "node:assert/strict";
import test from "node:test";

import {
  createProcessHardeningPlan,
  evaluateProcessHardening,
  findingsRequiringProcessHardening
} from "../src/workflow/process-hardening.js";

const falseSuccessFinding = {
  id: "event-write-false-success",
  status: "fail",
  category: "false_success",
  severity: "p1",
  message: "Workbench shows a success state even when operator event persistence fails."
};

test("p1 false-success reviewer finding requires process hardening", () => {
  const findings = findingsRequiringProcessHardening([falseSuccessFinding]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, "event-write-false-success");
});

test("process hardening plan starts pending until invariant and gate evidence exist", () => {
  const plan = createProcessHardeningPlan({
    run_id: "run-process",
    cycle_id: "cycle-1",
    findings: [falseSuccessFinding]
  });
  const evaluation = evaluateProcessHardening({
    findings: [falseSuccessFinding],
    plan
  });

  assert.equal(plan.status, "pending");
  assert.equal(plan.items.length, 1);
  assert.equal(evaluation.status, "fail");
  assert.equal(evaluation.completed_count, 0);
  assert.ok(evaluation.issues.some((issue) => issue.code === "missing_enforcement_target"));
  assert.ok(evaluation.issues.some((issue) => issue.code === "hardening_not_completed"));
});

test("process hardening passes only with completed gate and verification evidence", () => {
  const evaluation = evaluateProcessHardening({
    findings: [falseSuccessFinding],
    hardening_items: [
      {
        finding_id: "event-write-false-success",
        invariant: "Operator controls cannot show success unless their event has been persisted.",
        enforcement_target: "test/workbench-shell.test.js",
        regression_test: "workbench controls do not show success when operator event persistence fails",
        verification: "Playwright success and forced-failure event persistence scenarios",
        status: "completed"
      }
    ]
  });

  assert.equal(evaluation.status, "pass");
  assert.equal(evaluation.required_count, 1);
  assert.equal(evaluation.completed_count, 1);
  assert.equal(evaluation.issues.length, 0);
});

test("completed hardening item covers spawned child process lifecycle cleanup", () => {
  const finding = {
    id: "agent-lifecycle-pool-cleanup-gap",
    status: "fail",
    category: "continuation_gap",
    severity: "p1",
    message: "Spawned child processes can be left without durable evaluate and close facts."
  };
  const evaluation = evaluateProcessHardening({
    findings: [finding],
    hardening_items: [
      {
        finding_id: "agent-lifecycle-pool-cleanup-gap",
        invariant: "Every spawned child process must be tracked, evaluated, closed, and exposed as durable agent lifecycle pool facts before the main process advances.",
        enforcement_target: "src/workflow/agent-lifecycle-pool.js; src/workflow/autonomous-continuation.js; src/workflow/workbench-projection.js",
        regression_test: "agent lifecycle summary; continuation schedules cleanup; workbench projection exposes agent lifecycle pool cleanup readout",
        verification: "node --test test/agent-lifecycle-pool.test.js test/autonomous-continuation.test.js test/workbench-projection.test.js; npm run check:process-hardening",
        status: "completed"
      }
    ]
  });

  assert.equal(evaluation.status, "pass");
  assert.equal(evaluation.required_count, 1);
  assert.equal(evaluation.completed_count, 1);
});

test("non-blocking reviewer nits do not require process hardening", () => {
  const evaluation = evaluateProcessHardening({
    findings: [
      {
        id: "copy-nit",
        status: "fail",
        category: "copy",
        severity: "low",
        message: "Minor wording issue."
      }
    ],
    hardening_items: []
  });

  assert.equal(evaluation.status, "pass");
  assert.equal(evaluation.required_count, 0);
});
