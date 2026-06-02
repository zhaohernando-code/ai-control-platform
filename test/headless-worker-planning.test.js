import assert from "node:assert/strict";
import test from "node:test";

import {
  CHILD_WORKER_ROLE,
  HEADLESS_MAIN_ORCHESTRATOR_ROLE,
  createHeadlessWorkerSpawnFacts,
  headlessChildWorkerId,
  headlessLifecyclePoolId,
  selectHeadlessWorkPackages
} from "../src/workflow/headless-worker-planning.js";

function workflowState() {
  return {
    manifest: {
      run_id: "run-headless",
      cycle_id: "cycle-001",
      work_packages: [
        { id: "ready-a", status: "pending", owned_files: ["src/workflow/a.js"] },
        { id: "blocked-b", status: "pending", dispatch_allowed: false, owned_files: ["src/workflow/b.js"] },
        { id: "done-c", status: "completed", owned_files: ["src/workflow/c.js"] },
        { id: "ready-d", status: "running", owned_files: ["src/workflow/d.js"] }
      ]
    }
  };
}

test("selectHeadlessWorkPackages skips completed and dispatch-blocked packages", () => {
  const selected = selectHeadlessWorkPackages(workflowState(), { max_package_count: 3 });
  assert.deepEqual(selected.map((workPackage) => workPackage.id), ["ready-a", "ready-d"]);
});

test("selectHeadlessWorkPackages enforces a minimum selection cap of one", () => {
  const selected = selectHeadlessWorkPackages(workflowState(), { max_package_count: 0 });
  assert.deepEqual(selected.map((workPackage) => workPackage.id), ["ready-a"]);
});

test("headless worker ids use safe defaults and explicit overrides", () => {
  assert.equal(headlessLifecyclePoolId(workflowState()), "headless-cli-run-headless-cycle-001");
  assert.equal(
    headlessLifecyclePoolId(workflowState(), { pool_id: "explicit-pool" }),
    "explicit-pool"
  );
  assert.equal(
    headlessChildWorkerId({ id: "Needs Review / Release" }, 0),
    "child-Needs-Review-Release"
  );
  assert.equal(
    headlessChildWorkerId({ id: "ready-a" }, 0, { worker_id: "explicit-worker" }),
    "explicit-worker"
  );
});

test("createHeadlessWorkerSpawnFacts emits spawn and heartbeat facts per package", () => {
  const selected = selectHeadlessWorkPackages(workflowState(), { max_package_count: 1 });
  const facts = createHeadlessWorkerSpawnFacts(workflowState(), selected, {
    created_at: "2026-06-02T14:00:00.000Z",
    executor_kind: "governed_agent"
  });

  assert.equal(facts.length, 2);
  assert.deepEqual(facts.map((fact) => fact.event_type), ["WorkerSpawned", "WorkerHeartbeat"]);
  assert.deepEqual(facts.map((fact) => fact.worker_id), ["child-ready-a", "child-ready-a"]);
  assert.deepEqual(facts.map((fact) => fact.pool_id), [
    "headless-cli-run-headless-cycle-001",
    "headless-cli-run-headless-cycle-001"
  ]);
  assert.deepEqual(facts.map((fact) => fact.status), ["pass", "pass"]);
  assert.deepEqual(facts[0].source, {
    orchestrator_role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    worker_role: CHILD_WORKER_ROLE,
    work_package_id: "ready-a",
    owned_files: ["src/workflow/a.js"],
    executor: "governed_agent"
  });
});
