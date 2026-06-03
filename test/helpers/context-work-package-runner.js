import { materializeContextPackCycleFromWorkflowState } from "../../src/workflow/context-pack-cycle.js";
import { createRunManifest } from "../../src/workflow/run-manifest.js";
import {
  prepareContinuationFromProjectStatus,
  recordProjectStatusContinuationPrepared
} from "../../src/workflow/project-status-continuation.js";

export function workflowStateWithContextCycle() {
  const workflowState = {
    manifest: {
      run_id: "run-context-work",
      cycle_id: "cycle-source",
      goal: "source",
      context_pack: {
        requirement_summary: "中台工作台 source",
        host: "platform_core",
        target_project_id: "ai-control-platform",
        non_goals: ["不修改业务项目"],
        forbidden_actions: ["不得越过 owned_files"],
        owned_files: ["src/workflow/context-work-package-runner.js", "test/context-work-package-runner.test.js"],
        acceptance_gates: ["node --test test/context-work-package-runner.test.js"],
        rollback_conditions: ["runner 状态不一致"],
        subtasks: [{ id: "source", owned_files: ["src/workflow/context-work-package-runner.js"] }]
      },
      work_packages: [{ id: "source", title: "Source", status: "completed", owned_files: ["src/workflow/context-work-package-runner.js"] }],
      events: [],
      artifacts: [],
      gate_results: [],
      review_findings: [],
      recovery_attempts: []
    },
    artifact_ledger: {
      run_id: "run-context-work",
      cycle_id: "cycle-source",
      artifacts: []
    },
    model_plan: {
      selected_model: "deepseek-v4-flash",
      routes: []
    },
    reviewer_gate: { findings: [] }
  };
  const prepared = prepareContinuationFromProjectStatus({
    project: "ai-control-platform",
    status: "in_progress",
    blockers: [],
    next_step: "",
    global_goals: [
      {
        id: "context-work",
        title: "Context work",
        status: "in_progress",
        next_step: "中台工作台 run context work packages.",
        next_work_packages: [
          {
            id: "runtime",
            title: "Runtime",
            owned_files: ["src/workflow/context-work-package-runner.js"]
          },
          {
            id: "tests",
            title: "Tests",
            owned_files: ["test/context-work-package-runner.test.js"],
            depends_on: ["runtime"]
          }
        ]
      }
    ]
  }, { workflow_state: workflowState });
  const recorded = recordProjectStatusContinuationPrepared(workflowState, prepared, {
    created_at: "2026-05-22T04:00:00.000Z"
  });
  return materializeContextPackCycleFromWorkflowState(recorded.workflow_state, {
    cycle_id: "cycle-context-work",
    created_at: "2026-05-22T04:01:00.000Z"
  }).workflow_state;
}

export function workflowStateWithRetryAgentWorker() {
  const contextPack = {
    requirement_summary: "Retry timed-out child agent worker",
    host: "platform_core",
    target_project_id: "ai-control-platform",
    non_goals: ["Do not modify managed business projects"],
    forbidden_actions: ["Do not skip main-process evaluation gates"],
    owned_files: ["src/workflow/context-work-package-runner.js"],
    acceptance_gates: ["node --test test/context-work-package-runner.test.js"],
    rollback_conditions: ["retry facts are not recorded"],
    subtasks: [
      {
        id: "agent-worker-retry-pool-main-child-child-1",
        title: "Retry timed-out agent worker child-1",
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
  };
  const manifest = createRunManifest({
    run_id: "run-retry-agent",
    cycle_id: "cycle-retry-agent",
    goal: contextPack.requirement_summary,
    context_pack: contextPack,
    events: [],
    artifacts: [],
    gate_results: [],
    review_findings: [],
    recovery_attempts: [],
    created_at: "2026-05-22T09:00:00.000Z"
  });

  return {
    manifest,
    artifact_ledger: {
      run_id: manifest.run_id,
      cycle_id: manifest.cycle_id,
      artifacts: []
    }
  };
}

export function workflowStateWithGlobalGoalPackage() {
  const contextPack = {
    requirement_summary: "Continue repository global goal",
    host: "platform_core",
    target_project_id: "ai-control-platform",
    non_goals: ["Do not fake broad global-goal completion"],
    forbidden_actions: ["Do not complete without child-worker authority"],
    owned_files: ["src/workflow/context-work-package-runner.js"],
    acceptance_gates: ["node --test test/context-work-package-runner.test.js"],
    rollback_conditions: ["global goal package completed without authority"],
    subtasks: [
      {
        id: "global-goal-autonomous-scheduler-and-reviewer-loop",
        title: "Continue scheduler/reviewer loop",
        action: "continue_global_goal",
        owned_files: ["src/workflow/context-work-package-runner.js"]
      }
    ]
  };
  const manifest = createRunManifest({
    run_id: "run-global-goal",
    cycle_id: "cycle-global-goal",
    goal: contextPack.requirement_summary,
    context_pack: contextPack,
    events: [],
    artifacts: [],
    gate_results: [],
    review_findings: [],
    recovery_attempts: [],
    created_at: "2026-05-24T03:30:00.000Z"
  });

  return {
    manifest,
    artifact_ledger: {
      run_id: manifest.run_id,
      cycle_id: manifest.cycle_id,
      artifacts: []
    },
    task_dag: manifest.work_packages
  };
}

export function workflowStateWithRequirementIntakePackage() {
  const contextPack = {
    requirement_summary: "Implement requirement intake update",
    host: "platform_core",
    target_project_id: "ai-control-platform",
    non_goals: ["Do not fake product implementation"],
    forbidden_actions: ["Do not complete without child-worker authority"],
    owned_files: ["apps/workbench", "src/workflow/requirement-intake.js"],
    acceptance_gates: ["node --test test/workbench-server.test.js"],
    rollback_conditions: ["requirement package completed without implementation evidence"],
    subtasks: [
      {
        id: "requirement-intake-replay-20260525-module-update-continue",
        title: "Continue requirement intake",
        action: "continue_requirement_intake",
        owned_files: ["apps/workbench", "src/workflow/requirement-intake.js"],
        global_goal_id: "requirement-intake-replay-20260525-module-update"
      }
    ]
  };
  const manifest = createRunManifest({
    run_id: "run-requirement-intake",
    cycle_id: "cycle-requirement-intake",
    goal: contextPack.requirement_summary,
    context_pack: contextPack,
    events: [],
    artifacts: [],
    gate_results: [],
    review_findings: [],
    recovery_attempts: [],
    created_at: "2026-05-25T12:45:00.000Z"
  });

  return {
    manifest,
    artifact_ledger: {
      run_id: manifest.run_id,
      cycle_id: manifest.cycle_id,
      artifacts: []
    },
    task_dag: manifest.work_packages
  };
}
