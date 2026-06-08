import assert from "node:assert/strict";
import test from "node:test";

import { VERIFIED_PROVIDER_MULTI_AGENT_PROFILE } from "../src/workflow/context-work-package-execution-adapter.js";
import {
  markContextWorkPackageDispatchFailed,
  runContextWorkPackages,
  stageContextWorkPackageDispatch
} from "../src/workflow/context-work-package-runner.js";
import { workflowStateWithContextCycle } from "./helpers/context-work-package-runner.js";

test("context work package dispatch can be staged as running before background provider execution", () => {
  const workflowState = workflowStateWithContextCycle();

  const staged = stageContextWorkPackageDispatch(workflowState, {
    max_package_count: 1,
    execution_mode: "provider_model_routed",
    execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    dispatch_run_id: "dispatch-running-001",
    created_at: "2026-05-28T13:30:00.000Z"
  });

  assert.equal(staged.status, "pass");
  assert.equal(staged.phase, "context_work_packages_dispatch_started");
  assert.deepEqual(staged.selected_work_package_ids, ["runtime"]);
  const runtime = staged.workflow_state.manifest.work_packages.find((item) => item.id === "runtime");
  assert.equal(runtime.status, "running");
  assert.equal(runtime.result, "dispatch_started");
  assert.equal(runtime.dispatch_run_id, "dispatch-running-001");
  assert.ok(staged.workflow_state.manifest.events.some((event) => event.type === "context_work_packages_dispatch_started"));
});

test("context work package dispatch scopes implicit selection by requirement id", () => {
  const workflowState = workflowStateWithContextCycle();
  const workPackages = [
    {
      id: "task-a-package",
      title: "Task A package",
      status: "pending",
      owned_files: ["src/workflow/context-work-package-runner.js"],
      acceptance_gates: ["node --test test/context-work-package-runner.test.js"],
      source: { requirement_id: "task-a" }
    },
    {
      id: "task-b-package",
      title: "Task B package",
      status: "pending",
      owned_files: ["test/context-work-package-runner.test.js"],
      acceptance_gates: ["node --test test/context-work-package-runner.test.js"],
      source: { requirement_id: "task-b" }
    }
  ];
  workflowState.manifest.work_packages = workPackages;
  workflowState.manifest.context_pack.subtasks = workPackages;
  workflowState.task_dag = workPackages;

  const staged = stageContextWorkPackageDispatch(workflowState, {
    requirement_id: "task-b",
    max_package_count: 1,
    execution_mode: "provider_model_routed",
    execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    dispatch_run_id: "dispatch-task-b-001",
    created_at: "2026-05-28T13:30:30.000Z"
  });

  assert.equal(staged.status, "pass");
  assert.deepEqual(staged.selected_work_package_ids, ["task-b-package"]);
  assert.equal(
    staged.workflow_state.manifest.work_packages.find((item) => item.id === "task-a-package").status,
    "pending"
  );
  assert.equal(
    staged.workflow_state.manifest.work_packages.find((item) => item.id === "task-b-package").status,
    "running"
  );
});

test("context work package dispatch does not fall back to another requirement", () => {
  const workflowState = workflowStateWithContextCycle();
  const workPackages = [{
    id: "task-a-package",
    title: "Task A package",
    status: "pending",
    owned_files: ["src/workflow/context-work-package-runner.js"],
    acceptance_gates: ["node --test test/context-work-package-runner.test.js"],
    source: { requirement_id: "task-a" }
  }];
  workflowState.manifest.work_packages = workPackages;
  workflowState.manifest.context_pack.subtasks = workPackages;
  workflowState.task_dag = workPackages;

  const staged = stageContextWorkPackageDispatch(workflowState, {
    requirement_id: "task-b",
    max_package_count: 1,
    execution_mode: "provider_model_routed",
    execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    dispatch_run_id: "dispatch-task-b-empty-001",
    created_at: "2026-05-28T13:30:40.000Z"
  });

  assert.equal(staged.status, "blocked");
  assert.equal(staged.phase, "no_dispatchable_work_packages");
  assert.ok(staged.issues.some((item) => item.code === "no_dispatchable_work_packages"));
});

test("context work package runner can complete a staged running package by explicit id", () => {
  const workflowState = workflowStateWithContextCycle();
  const staged = stageContextWorkPackageDispatch(workflowState, {
    max_package_count: 1,
    execution_mode: "provider_model_routed",
    execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    dispatch_run_id: "dispatch-complete-001",
    created_at: "2026-05-28T13:31:00.000Z"
  });

  const result = runContextWorkPackages(staged.workflow_state, {
    selected_work_package_ids: staged.selected_work_package_ids,
    execution_mode: "provider_model_routed",
    execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    created_at: "2026-05-28T13:32:00.000Z",
    provider_executor: ({ selected_work_packages }) => ({
      status: "pass",
      completion_evidence: {
        kind: "provider_execution",
        summary: "background provider completed staged package"
      },
      package_results: selected_work_packages.map((workPackage) => ({
        work_package_id: workPackage.id,
        status: "pass",
        result: "pass",
        completion_evidence: {
          kind: "package_completion",
          artifact_id: `background-${workPackage.id}`
        }
      })),
      executor_provenance: {
        executor_kind: "background_provider_executor",
        provider: "multi_provider",
        execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
        external_calls: 1,
        deterministic: false
      }
    })
  });

  assert.equal(result.status, "pass");
  assert.equal(result.executed_count, 1);
  assert.equal(result.workflow_state.manifest.work_packages.find((item) => item.id === "runtime").status, "completed");
});

test("context work package dispatch failure is persisted as failed", () => {
  const workflowState = workflowStateWithContextCycle();
  const staged = stageContextWorkPackageDispatch(workflowState, {
    max_package_count: 1,
    execution_mode: "provider_model_routed",
    execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    dispatch_run_id: "dispatch-failed-001",
    created_at: "2026-05-28T13:33:00.000Z"
  });

  const failed = markContextWorkPackageDispatchFailed(staged.workflow_state, {
    selected_work_package_ids: staged.selected_work_package_ids,
    dispatch_run_id: "dispatch-failed-001",
    created_at: "2026-05-28T13:34:00.000Z",
    issues: [{ code: "provider_executor_timeout", message: "provider timed out", path: "provider_executor" }]
  });

  assert.equal(failed.status, "pass");
  const runtime = failed.workflow_state.manifest.work_packages.find((item) => item.id === "runtime");
  assert.equal(runtime.status, "failed");
  assert.equal(runtime.result, "dispatch_failed");
  assert.equal(runtime.failure_issues[0].code, "provider_executor_timeout");
  assert.ok(failed.workflow_state.manifest.events.some((event) => event.type === "context_work_packages_dispatch_failed"));
});

test("context work package dispatch retries a failed package whose dependencies are complete", () => {
  const workflowState = workflowStateWithContextCycle();
  const workPackages = workflowState.manifest.work_packages.map((workPackage) => {
    if (workPackage.id === "runtime") return { ...workPackage, status: "completed" };
    if (workPackage.id === "tests") return { ...workPackage, status: "failed", result: "dispatch_failed" };
    return workPackage;
  });
  const stateWithFailedPackage = {
    ...workflowState,
    manifest: {
      ...workflowState.manifest,
      work_packages: workPackages
    },
    task_dag: workPackages
  };

  const staged = stageContextWorkPackageDispatch(stateWithFailedPackage, {
    max_package_count: 1,
    execution_mode: "provider_model_routed",
    execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    dispatch_run_id: "dispatch-retry-failed-001",
    created_at: "2026-05-28T14:20:00.000Z"
  });

  assert.equal(staged.status, "pass");
  assert.deepEqual(staged.selected_work_package_ids, ["tests"]);
  const testsPackage = staged.workflow_state.manifest.work_packages.find((item) => item.id === "tests");
  assert.equal(testsPackage.status, "running");
  assert.equal(testsPackage.result, "dispatch_started");
});
