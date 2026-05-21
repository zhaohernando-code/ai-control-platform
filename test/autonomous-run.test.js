import assert from "node:assert/strict";
import test from "node:test";

import {
  decideNextAction,
  evaluateRunResult,
  HUMAN_INTERVENTION,
  PASS,
  RERUN,
  ROLLBACK,
  summarizeWorkbenchProjection
} from "../src/workflow/autonomous-run.js";

test("all gates passed returns pass", () => {
  const result = evaluateRunResult({
    run_id: "run-1",
    cycle_id: "cycle-1",
    work_packages: [{ id: "wp-a", status: "completed" }],
    artifacts: [{ id: "patch", status: "pass" }],
    gate_results: [
      { gate_id: "host-boundary", status: "pass" },
      { gate_id: "tests", status: "pass" }
    ],
    review_findings: [],
    recovery_attempts: []
  });

  assert.equal(result.status, PASS);
  assert.deepEqual(result.next_work_packages, []);
  assert.equal(result.projection.summaries.gates.passed, 2);
});

test("test failure triggers rerun without human intervention", () => {
  const decision = decideNextAction({
    run_id: "run-2",
    cycle_id: "cycle-1",
    work_packages: [{ id: "wp-tests", title: "Implement test fix", status: "failed" }],
    gate_results: [
      { gate_id: "host-boundary", status: "pass" },
      { gate_id: "unit-tests", category: "tests", status: "fail", message: "node --test failed" }
    ],
    review_findings: [],
    recovery_attempts: []
  });

  assert.equal(decision.status, RERUN);
  assert.ok(decision.reasons.some((reason) => reason.includes("unit-tests")));
  assert.ok(decision.next_work_packages.some((workPackage) => workPackage.action === RERUN));

  const reviewerDecision = decideNextAction({
    run_id: "run-2b",
    cycle_id: "cycle-1",
    work_packages: [{ id: "wp-review", status: "completed" }],
    gate_results: [{ gate_id: "unit-tests", status: "pass" }],
    review_findings: [
      {
        finding_id: "review-minor",
        category: "reviewer",
        severity: "medium",
        status: "fail",
        message: "missing focused test for edge case"
      }
    ],
    recovery_attempts: []
  });

  assert.equal(reviewerDecision.status, RERUN);
});

test("host boundary and severe reviewer failures trigger rollback", () => {
  const hostBoundaryDecision = decideNextAction({
    run_id: "run-3a",
    cycle_id: "cycle-1",
    work_packages: [{ id: "wp-boundary", status: "failed" }],
    gate_results: [
      {
        gate_id: "host-boundary",
        category: "host_boundary",
        status: "fail",
        message: "platform work landed in a managed project"
      }
    ],
    review_findings: [],
    recovery_attempts: []
  });

  assert.equal(hostBoundaryDecision.status, ROLLBACK);
  assert.ok(hostBoundaryDecision.next_work_packages.some((workPackage) => workPackage.action === ROLLBACK));

  const reviewerDecision = decideNextAction({
    run_id: "run-3b",
    cycle_id: "cycle-1",
    work_packages: [{ id: "wp-review", status: "completed" }],
    gate_results: [{ gate_id: "tests", status: "pass" }],
    review_findings: [
      {
        finding_id: "review-critical",
        category: "reviewer",
        severity: "critical",
        status: "fail",
        message: "reviewer found unsafe host mutation"
      }
    ],
    recovery_attempts: []
  });

  assert.equal(reviewerDecision.status, ROLLBACK);
  assert.ok(reviewerDecision.reasons.some((reason) => reason.includes("review-critical")));
});

test("consecutive recovery failures trigger human intervention", () => {
  const result = evaluateRunResult(
    {
      run_id: "run-4",
      cycle_id: "cycle-2",
      work_packages: [{ id: "wp-recovery", status: "failed" }],
      gate_results: [{ gate_id: "unit-tests", status: "fail", category: "tests" }],
      review_findings: [],
      recovery_attempts: [
        { id: "recovery-1", status: "fail" },
        { id: "recovery-2", status: "fail" },
        { id: "recovery-3", status: "fail" }
      ]
    },
    { maxConsecutiveRecoveryFailures: 3 }
  );

  assert.equal(result.status, HUMAN_INTERVENTION);
  assert.equal(result.next_work_packages.length, 0);
  assert.equal(result.projection.recovery.consecutive_failed_attempts, 3);
});

test("workbench projection summarizes key run state", () => {
  const runResult = {
    run_id: "run-5",
    cycle_id: "cycle-9",
    work_packages: [
      { id: "wp-a", title: "Base module", status: "completed", owner: "agent-a" },
      { id: "wp-b", title: "Docs", status: "failed", owner: "agent-b" }
    ],
    artifacts: [{ id: "contract-doc", status: "pass" }],
    gate_results: [{ gate_id: "unit-tests", status: "fail", category: "tests" }],
    review_findings: [{ finding_id: "finding-1", status: "pass" }],
    recovery_attempts: [{ id: "recovery-1", status: "fail" }]
  };

  const projection = summarizeWorkbenchProjection(runResult);

  assert.equal(projection.run_id, "run-5");
  assert.equal(projection.cycle_id, "cycle-9");
  assert.equal(projection.decision, RERUN);
  assert.equal(projection.summaries.work_packages.total, 2);
  assert.equal(projection.summaries.work_packages.failed, 1);
  assert.equal(projection.summaries.gates.failed, 1);
  assert.equal(projection.recovery.last_attempt_id, "recovery-1");
  assert.ok(projection.current_work_packages.some((workPackage) => workPackage.id === "wp-b"));
  assert.ok(projection.next_work_packages.some((workPackage) => workPackage.action === RERUN));
});
