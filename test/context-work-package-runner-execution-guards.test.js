import assert from "node:assert/strict";
import test from "node:test";

import { VERIFIED_PROVIDER_MULTI_AGENT_PROFILE } from "../src/workflow/context-work-package-execution-adapter.js";
import { runContextWorkPackages } from "../src/workflow/context-work-package-runner.js";
import {
  workflowStateWithContextCycle,
  workflowStateWithGlobalGoalPackage,
  workflowStateWithRequirementIntakePackage
} from "./helpers/context-work-package-runner.js";

test("context work package runner blocks local bounded global-goal completion without child authority", () => {
  const workflowState = workflowStateWithGlobalGoalPackage();

  const result = runContextWorkPackages(workflowState, {
    max_package_count: 1,
    created_at: "2026-05-24T03:31:00.000Z"
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.phase, "local_bounded_completion_authority");
  assert.equal(result.allows_work_package_completion, false);
  assert.ok(result.issues.some((item) => item.code === "local_bounded_global_goal_completion_requires_child_authority"));
  assert.equal(workflowState.manifest.work_packages[0].status, undefined);
  assert.equal(workflowState.manifest.events.some((event) => event.type === "WorkerSpawned"), false);
  assert.equal(workflowState.artifact_ledger.artifacts.length, 0);
});

test("context work package runner blocks local bounded requirement intake completion without child authority", () => {
  const workflowState = workflowStateWithRequirementIntakePackage();

  const result = runContextWorkPackages(workflowState, {
    max_package_count: 1,
    created_at: "2026-05-25T12:46:00.000Z"
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.phase, "local_bounded_completion_authority");
  assert.equal(result.allows_work_package_completion, false);
  assert.ok(result.issues.some((item) => item.code === "local_bounded_requirement_intake_requires_child_authority"));
  assert.equal(workflowState.manifest.work_packages[0].status, undefined);
  assert.equal(workflowState.manifest.events.some((event) => event.type === "WorkerSpawned"), false);
  assert.equal(workflowState.artifact_ledger.artifacts.length, 0);
});

test("context work package runner blocks managed project paths before completion", () => {
  const workflowState = workflowStateWithContextCycle();
  const forbiddenOwnedFiles = ["../stock_dashboard/src/runner.js"];
  workflowState.manifest.context_pack.owned_files = forbiddenOwnedFiles;
  workflowState.manifest.context_pack.subtasks = [{ id: "runtime", owned_files: forbiddenOwnedFiles }];
  workflowState.manifest.work_packages = [
    {
      id: "runtime",
      title: "Runtime",
      status: "pending",
      owned_files: forbiddenOwnedFiles
    }
  ];
  workflowState.task_dag = workflowState.manifest.work_packages;
  const eventCountBefore = workflowState.manifest.events.length;
  const artifactCountBefore = workflowState.artifact_ledger.artifacts.length;

  const result = runContextWorkPackages(workflowState, {
    max_package_count: 1,
    created_at: "2026-05-22T04:03:00.000Z"
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.phase, "fixed_development_mode_gate");
  assert.equal(result.gate_result.gate_id, "fixed-development-mode-dispatch");
  assert.ok(result.issues.some((item) => item.code === "fixed_mode_managed_project_owned_file"));
  assert.equal(workflowState.manifest.work_packages[0].status, "pending");
  assert.equal(workflowState.manifest.events.length, eventCountBefore);
  assert.equal(workflowState.artifact_ledger.artifacts.length, artifactCountBefore);
  assert.equal(result.workflow_state, undefined);
});

test("context work package runner blocks fixed gate before provider routed adapter", () => {
  const workflowState = workflowStateWithContextCycle();
  const forbiddenOwnedFiles = ["../lobechat/app/page.tsx"];
  workflowState.manifest.context_pack.owned_files = forbiddenOwnedFiles;
  workflowState.manifest.context_pack.subtasks = [{ id: "runtime", owned_files: forbiddenOwnedFiles }];
  workflowState.manifest.work_packages = [
    {
      id: "runtime",
      title: "Runtime",
      status: "pending",
      owned_files: forbiddenOwnedFiles
    }
  ];
  workflowState.task_dag = workflowState.manifest.work_packages;

  const result = runContextWorkPackages(workflowState, {
    max_package_count: 1,
    execution_mode: "provider_model_routed",
    execution_profile: "bounded_mock_multi_agent",
    created_at: "2026-05-22T04:04:00.000Z"
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.phase, "fixed_development_mode_gate");
  assert.equal(result.execution_plan, undefined);
  assert.equal(workflowState.manifest.work_packages[0].status, "pending");
});

test("no-code provider execution fails closed when it mutates the worktree", () => {
  const workflowState = workflowStateWithContextCycle();
  let statusCalls = 0;
  const result = runContextWorkPackages(workflowState, {
    selected_work_package_ids: ["runtime"],
    execution_mode: "provider_model_routed",
    execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    execution_cwd: process.cwd(),
    gitStatusProvider: () => {
      statusCalls += 1;
      return statusCalls === 1 ? "" : " M src/workflow/workbench-projection.js";
    },
    adapter_executor: (_workflowState, selected) => ({
      status: "pass",
      phase: "provider_executor_completed",
      allows_work_package_completion: true,
      completion_authority: {
        allows_work_package_completion: true,
        authority: "verified_provider_executor",
        evidence_kind: "real_provider_execution"
      },
      package_results: selected.map((node) => ({
        work_package_id: node.id,
        status: "pass",
        allows_work_package_completion: true,
        completion_authority: { allows_work_package_completion: true }
      })),
      executor_provenance: {
        executor_kind: "agent_invocation_provider_executor",
        execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
        external_calls: 1,
        deterministic: false
      }
    })
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.phase, "workspace_mutation_guard");
  assert.ok(result.issues.some((item) => item.code === "unexpected_workspace_mutation"));
  assert.equal(result.workspace_mutation.before, "");
  assert.match(result.workspace_mutation.after, /workbench-projection/);
});

test("code-output context work packages require an isolated worker worktree", () => {
  const workflowState = workflowStateWithContextCycle();
  workflowState.manifest.work_packages = workflowState.manifest.work_packages.map((workPackage) => (
    workPackage.id === "runtime"
      ? {
        ...workPackage,
        status: "pending",
        action: "fix_code",
        source: {
          ...(workPackage.source || {}),
          execution_governance: {
            version: "work-package-execution-governance.v1",
            granularity: "single_step",
            decomposition: { required: false, status: "not_required" },
            verification: { required: true, status: "defined", gate_count: 1 }
          }
        }
      }
      : workPackage
  ));
  workflowState.task_dag = workflowState.manifest.work_packages;
  let adapterCalls = 0;

  const result = runContextWorkPackages(workflowState, {
    selected_work_package_ids: ["runtime"],
    execution_mode: "provider_model_routed",
    execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    execution_cwd: "/Users/hernando_zhao/codex/projects/ai-control-platform",
    primary_worktree_path: "/Users/hernando_zhao/codex/projects/ai-control-platform",
    adapter_executor: () => {
      adapterCalls += 1;
      return { status: "pass" };
    }
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.phase, "execution_worktree_isolation");
  assert.ok(result.issues.some((item) => item.code === "code_output_requires_isolated_worktree"));
  assert.equal(adapterCalls, 0);
});

test("code-output context work packages may run in an isolated worker worktree", () => {
  const workflowState = workflowStateWithContextCycle();
  workflowState.manifest.work_packages = workflowState.manifest.work_packages.map((workPackage) => (
    workPackage.id === "runtime"
      ? {
        ...workPackage,
        status: "pending",
        action: "fix_code",
        source: {
          ...(workPackage.source || {}),
          execution_governance: {
            version: "work-package-execution-governance.v1",
            granularity: "single_step",
            decomposition: { required: false, status: "not_required" },
            verification: { required: true, status: "defined", gate_count: 1 }
          }
        }
      }
      : workPackage
  ));
  workflowState.task_dag = workflowState.manifest.work_packages;

  const result = runContextWorkPackages(workflowState, {
    selected_work_package_ids: ["runtime"],
    execution_mode: "provider_model_routed",
    execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    execution_cwd: "/Users/hernando_zhao/codex/worker-workspaces/ai-control-platform/runtime",
    primary_worktree_path: "/Users/hernando_zhao/codex/projects/ai-control-platform",
    adapter_executor: (_workflowState, selected) => ({
      status: "pass",
      phase: "provider_executor_completed",
      allows_work_package_completion: true,
      completion_authority: {
        allows_work_package_completion: true,
        authority: "verified_provider_executor",
        evidence_kind: "real_provider_execution"
      },
      package_results: selected.map((node) => ({
        work_package_id: node.id,
        status: "pass",
        allows_work_package_completion: true,
        completion_authority: { allows_work_package_completion: true }
      })),
      executor_provenance: {
        executor_kind: "agent_invocation_provider_executor",
        execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
        external_calls: 1,
        deterministic: false
      }
    })
  });

  assert.equal(result.status, "pass");
  assert.equal(result.executed_count, 1);
});
