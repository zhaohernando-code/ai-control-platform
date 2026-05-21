import assert from "node:assert/strict";
import test from "node:test";

import {
  applyRunDecisionToDag,
  buildTaskDag,
  getDispatchableNodes,
  validateTaskDag
} from "../src/workflow/task-dag.js";

test("task DAG dispatches nodes in dependency order", () => {
  const dag = buildTaskDag([
    { id: "design", status: "done" },
    { id: "runtime", depends_on: ["design"], status: "pending" },
    { id: "tests", depends_on: ["runtime"], status: "pending" },
    { id: "docs", depends_on: ["design"], status: "blocked" }
  ]);

  assert.equal(dag.status, "pass");
  assert.deepEqual(
    getDispatchableNodes(dag).map((node) => node.id),
    ["runtime"]
  );

  const nextDag = buildTaskDag(dag.nodes.map((node) => (node.id === "runtime" ? { ...node, status: "done" } : node)));

  assert.deepEqual(
    getDispatchableNodes(nextDag).map((node) => node.id),
    ["tests"]
  );
});

test("task DAG rejects unknown dependencies", () => {
  const validation = validateTaskDag([{ id: "tests", depends_on: ["runtime"] }]);

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some((issue) => issue.code === "unknown_dependency"));
});

test("task DAG rejects cycles", () => {
  const validation = validateTaskDag([
    { id: "a", depends_on: ["b"] },
    { id: "b", depends_on: ["c"] },
    { id: "c", depends_on: ["a"] }
  ]);

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some((issue) => issue.code === "cycle_detected"));
});

test("run decision pass marks source node done", () => {
  const dag = buildTaskDag([{ id: "runtime", status: "running" }]);
  const nextDag = applyRunDecisionToDag(dag, { action: "pass", source_node_id: "runtime" });

  assert.equal(nextDag.nodes.find((node) => node.id === "runtime").status, "done");
});

test("run decision rerun adds follow-up nodes from autonomous run output", () => {
  const dag = buildTaskDag([{ id: "runtime", status: "done" }]);
  const nextDag = applyRunDecisionToDag(dag, {
    action: "rerun",
    source_node_id: "runtime",
    next_work_packages: [
      {
        id: "rerun_runtime_recovery",
        action: "rerun",
        title: "Rerun failed checks with recovery context",
        depends_on: ["runtime"]
      }
    ]
  });

  assert.equal(nextDag.status, "pass");
  assert.equal(nextDag.nodes.find((node) => node.id === "rerun_runtime_recovery").status, "rerun");
  assert.deepEqual(
    getDispatchableNodes(nextDag).map((node) => node.id),
    ["rerun_runtime_recovery"]
  );
});

test("human intervention blocks unfinished nodes", () => {
  const nextDag = applyRunDecisionToDag(
    [
      { id: "done", status: "done" },
      { id: "runtime", status: "running" },
      { id: "tests", status: "pending" }
    ],
    { action: "human_intervention", blockers: [{ id: "credentials" }] }
  );

  assert.equal(nextDag.nodes.find((node) => node.id === "done").status, "done");
  assert.equal(nextDag.nodes.find((node) => node.id === "runtime").status, "blocked");
  assert.equal(nextDag.nodes.find((node) => node.id === "tests").status, "blocked");
  assert.deepEqual(getDispatchableNodes(nextDag), []);
});
