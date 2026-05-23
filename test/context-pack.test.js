import assert from "node:assert/strict";
import test from "node:test";

import {
  assertContextPackReady,
  createWorkPackages,
  validateContextPack
} from "../src/workflow/context-pack.js";

function validContextPack(overrides = {}) {
  return {
    requirement_summary: "为新中台实现平台中立 Context Pack 与 Work Package 基座",
    host: "platform_core",
    target_project_id: "ai-control-platform",
    non_goals: ["不修改 stock_dashboard", "不派发未声明 owned_files 的子任务"],
    forbidden_actions: ["不得写入业务项目", "不得回退他人改动"],
    owned_files: [
      "src/workflow/context-pack.js",
      "test/context-pack.test.js",
      "docs/contracts/CONTEXT_PACK_CN.md"
    ],
    acceptance_gates: ["node --test test/context-pack.test.js"],
    rollback_conditions: ["host boundary gate 失败", "work package 缺少 owned_files"],
    subtasks: [
      {
        id: "core",
        title: "Context Pack runtime",
        owned_files: ["src/workflow/context-pack.js"]
      },
      {
        id: "tests",
        title: "Context Pack tests",
        owned_files: ["test/context-pack.test.js"],
        depends_on: ["core"]
      }
    ],
    ...overrides
  };
}

test("context pack passes with required fields and dispatchable work packages", () => {
  const contextPack = validContextPack();
  const validation = validateContextPack(contextPack);
  const ready = assertContextPackReady(contextPack);

  assert.equal(validation.status, "pass");
  assert.equal(ready.status, "ready");
  assert.deepEqual(
    ready.work_packages.map((workPackage) => workPackage.dispatch_allowed),
    [true, true]
  );
});

test("context pack fails when required fields are missing", () => {
  const contextPack = validContextPack();
  delete contextPack.non_goals;

  const validation = validateContextPack(contextPack);

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some((issue) => issue.code === "missing_required_field" && issue.path === "non_goals"));
  assert.throws(() => assertContextPackReady(contextPack), {
    code: "CONTEXT_PACK_NOT_READY"
  });
});

test("platform requirements cannot target stock_dashboard", () => {
  const contextPack = validContextPack({
    target_project_id: "stock_dashboard"
  });

  const validation = validateContextPack(contextPack);
  const workPackages = createWorkPackages(contextPack);

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some((issue) => issue.code === "host_boundary_violation"));
  assert.equal(workPackages[0].dispatch_allowed, false);
  assert.ok(workPackages[0].blocked_reasons.some((reason) => reason.code === "host_boundary_violation"));
});

test("subtasks without owned_files are blocked", () => {
  const contextPack = validContextPack({
    subtasks: [
      {
        id: "core",
        title: "Context Pack runtime"
      }
    ]
  });

  const validation = validateContextPack(contextPack);
  const workPackages = createWorkPackages(contextPack);

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some((issue) => issue.code === "subtask_missing_owned_files"));
  assert.equal(workPackages[0].dispatch_allowed, false);
  assert.ok(workPackages[0].blocked_reasons.some((reason) => reason.code === "missing_owned_files"));
});

test("work package dependencies are preserved", () => {
  const workPackages = createWorkPackages(validContextPack());

  assert.equal(workPackages[0].id, "core");
  assert.deepEqual(workPackages[0].depends_on, []);
  assert.equal(workPackages[1].id, "tests");
  assert.deepEqual(workPackages[1].depends_on, ["core"]);
});

test("work package action and source metadata are preserved for scheduler retry routes", () => {
  const workPackages = createWorkPackages(validContextPack({
    subtasks: [
      {
        id: "agent-worker-retry-pool-main-child-1",
        title: "Retry timed-out agent worker",
        action: "retry_agent_worker",
        owned_files: ["src/workflow/context-work-package-runner.js"],
        source: {
          pool_id: "pool-main-child",
          worker_id: "child-1",
          retry_worker: { pool_id: "pool-main-child", worker_id: "child-1" },
          timed_out_workers: [{ worker_id: "child-1" }]
        }
      }
    ]
  }));

  assert.equal(workPackages[0].action, "retry_agent_worker");
  assert.equal(workPackages[0].source.pool_id, "pool-main-child");
  assert.equal(workPackages[0].source.worker_id, "child-1");
  assert.equal(workPackages[0].source.retry_worker.worker_id, "child-1");
  assert.deepEqual(workPackages[0].source.timed_out_workers.map((worker) => worker.worker_id), ["child-1"]);
});

test("work packages preserve global goal identity for durable continuation", () => {
  const workPackages = createWorkPackages(validContextPack({
    subtasks: [
      {
        id: "global-goal-platform-foundation",
        title: "Continue platform foundation",
        action: "continue_global_goal",
        global_goal_id: "platform-foundation",
        owned_files: ["src/workflow/context-pack.js"],
        source: {
          global_goal_id: "platform-foundation",
          reason: "global goal remains incomplete"
        }
      }
    ]
  }));

  assert.equal(workPackages[0].global_goal_id, "platform-foundation");
  assert.equal(workPackages[0].source.global_goal_id, "platform-foundation");
});
