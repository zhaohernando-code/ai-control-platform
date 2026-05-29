// Characterization tests for the canonical task-status derivation in task-dag.js.
//
// PURPOSE: pin the EXACT observable behavior of status normalization, default-status
// derivation, dispatchability, and run-decision application BEFORE any consolidation of
// the duplicated status logic (audit P0-1: "no single state machine; status semantics
// re-derived in task-dag, continuation, runner, projection"). These tests document what
// the code does TODAY, including quirks — they are a refactor safety net, not an
// endorsement of the current behavior. If a future change alters a result here, that is a
// behavior change that must be made deliberately, not by accident.

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyRunDecisionToDag,
  buildTaskDag,
  getDispatchableNodes,
  validateTaskDag,
  ALLOWED_STATUSES
} from "../src/workflow/task-dag.js";

// --- status synonym mapping -------------------------------------------------------------
// normalizeStatus is private, but observable through node.status after buildTaskDag.
function statusOf(input) {
  return buildTaskDag([{ id: "n", status: input }]).nodes[0].status;
}

test("characterize: success synonyms all normalize to done", () => {
  for (const syn of ["done", "pass", "passed", "ok", "success", "succeeded", "complete", "completed", "PASS", "  Done  "]) {
    assert.equal(statusOf(syn), "done", `"${syn}" should map to done`);
  }
});

test("characterize: running synonyms all normalize to running", () => {
  for (const syn of ["running", "active", "in_progress", "in-progress", "IN_PROGRESS"]) {
    assert.equal(statusOf(syn), "running", `"${syn}" should map to running`);
  }
});

test("characterize: failure/timeout synonyms all normalize to blocked", () => {
  for (const syn of ["blocked", "fail", "failed", "error", "errored", "timeout", "timed_out"]) {
    assert.equal(statusOf(syn), "blocked", `"${syn}" should map to blocked`);
  }
});

test("characterize: pending synonyms all normalize to pending", () => {
  for (const syn of ["pending", "queued", "ready", "todo"]) {
    assert.equal(statusOf(syn), "pending", `"${syn}" should map to pending`);
  }
});

test("characterize: empty/missing status falls back to pending", () => {
  assert.equal(statusOf(""), "pending");
  assert.equal(statusOf(undefined), "pending");
  assert.equal(statusOf(null), "pending");
});

test("characterize: unknown status passes through verbatim (lowercased) and is then invalid", () => {
  // An unrecognized token is NOT coerced — it is returned lowercased as-is...
  assert.equal(statusOf("frobnicated"), "frobnicated");
  // ...and validateTaskDag then rejects it, because it is not in ALLOWED_STATUSES.
  const validation = validateTaskDag([{ id: "n", status: "frobnicated" }]);
  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some((i) => i.code === "invalid_status"));
  assert.equal(ALLOWED_STATUSES.has("frobnicated"), false);
});

// --- field precedence in normalizeNode --------------------------------------------------

test("characterize: status field precedence is status > state > result > outcome", () => {
  // First present (truthy) wins, in this exact order.
  assert.equal(buildTaskDag([{ id: "n", status: "pass", state: "fail" }]).nodes[0].status, "done");
  assert.equal(buildTaskDag([{ id: "n", state: "running", result: "pass" }]).nodes[0].status, "running");
  assert.equal(buildTaskDag([{ id: "n", result: "ok", outcome: "fail" }]).nodes[0].status, "done");
  assert.equal(buildTaskDag([{ id: "n", outcome: "failed" }]).nodes[0].status, "blocked");
});

test("characterize: node id is derived from first present of id/work_package_id/task_id/gate_id/name", () => {
  assert.equal(buildTaskDag([{ work_package_id: "wp1" }]).nodes[0].id, "wp1");
  assert.equal(buildTaskDag([{ task_id: "t1" }]).nodes[0].id, "t1");
  assert.equal(buildTaskDag([{ gate_id: "g1" }]).nodes[0].id, "g1");
  assert.equal(buildTaskDag([{ name: "byname" }]).nodes[0].id, "byname");
  // Nothing present -> positional fallback wp-<index+1>.
  assert.equal(buildTaskDag([{ status: "pending" }]).nodes[0].id, "wp-1");
});

test("characterize: dependencies read from depends_on || dependencies || after", () => {
  assert.deepEqual(buildTaskDag([{ id: "a" }, { id: "b", dependencies: ["a"] }]).nodes[1].depends_on, ["a"]);
  assert.deepEqual(buildTaskDag([{ id: "a" }, { id: "b", after: ["a"] }]).nodes[1].depends_on, ["a"]);
});

// --- defaultStatusFor -------------------------------------------------------------------

test("characterize: dispatch_allowed:false forces blocked regardless of stated status", () => {
  // defaultStatusFor returns blocked, but an explicit status still wins via normalizeStatus.
  assert.equal(buildTaskDag([{ id: "n", dispatch_allowed: false }]).nodes[0].status, "blocked");
  // Explicit status overrides the default (fallback only applies when status is empty).
  assert.equal(buildTaskDag([{ id: "n", dispatch_allowed: false, status: "pass" }]).nodes[0].status, "done");
});

test("characterize: action rerun/rollback becomes the default status when no explicit status", () => {
  assert.equal(buildTaskDag([{ id: "n", action: "rerun" }]).nodes[0].status, "rerun");
  assert.equal(buildTaskDag([{ id: "n", action: "rollback" }]).nodes[0].status, "rollback");
});

// --- dispatchability edge cases ---------------------------------------------------------

test("characterize: a node with blocked_reasons is never dispatchable even if pending+ready", () => {
  const dag = buildTaskDag([{ id: "n", status: "pending", blocked_reasons: [{ code: "x" }] }]);
  assert.deepEqual(getDispatchableNodes(dag), []);
});

test("characterize: getDispatchableNodes returns [] when the DAG is invalid", () => {
  // Unknown dependency makes validation fail -> no dispatch, even though 'a' looks ready.
  const dag = buildTaskDag([{ id: "a", status: "pending", depends_on: ["ghost"] }]);
  assert.equal(dag.status, "fail");
  assert.deepEqual(getDispatchableNodes(dag), []);
});

// --- run-decision application quirks (refactor footguns) --------------------------------

test("characterize: FOOTGUN — pass decision with NO source node marks ALL running nodes done", () => {
  // This is a real divergence risk: an unsourced pass sweeps every running node to done.
  const dag = buildTaskDag([
    { id: "r1", status: "running" },
    { id: "r2", status: "running" },
    { id: "p1", status: "pending" }
  ]);
  const next = applyRunDecisionToDag(dag, { action: "pass" });
  assert.equal(next.nodes.find((n) => n.id === "r1").status, "done");
  assert.equal(next.nodes.find((n) => n.id === "r2").status, "done");
  assert.equal(next.nodes.find((n) => n.id === "p1").status, "pending");
});

test("characterize: pass decision WITH source node only marks that node done", () => {
  const dag = buildTaskDag([
    { id: "r1", status: "running" },
    { id: "r2", status: "running" }
  ]);
  const next = applyRunDecisionToDag(dag, { action: "pass", source_node_id: "r1" });
  assert.equal(next.nodes.find((n) => n.id === "r1").status, "done");
  assert.equal(next.nodes.find((n) => n.id === "r2").status, "running");
});

test("characterize: applied_decision echoes the raw decision token, source_node_id, blockers", () => {
  const next = applyRunDecisionToDag([{ id: "n", status: "running" }], {
    decision: "human_intervention",
    blockers: [{ id: "creds" }]
  });
  assert.equal(next.applied_decision, "human_intervention");
  assert.deepEqual(next.blockers, [{ id: "creds" }]);
});

test("characterize: run decision accepts action OR status OR decision as the verb", () => {
  // All three keys are interchangeable inputs for the decision verb.
  for (const key of ["action", "status", "decision"]) {
    const next = applyRunDecisionToDag([{ id: "n", status: "running" }], { [key]: "pass", source_node_id: "n" });
    assert.equal(next.nodes[0].status, "done", `verb via "${key}" should mark done`);
  }
});
