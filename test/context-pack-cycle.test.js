import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { materializeContextPackCycleFromWorkflowState } from "../src/workflow/context-pack-cycle.js";
import {
  prepareContinuationFromProjectStatus,
  recordProjectStatusContinuationPrepared
} from "../src/workflow/project-status-continuation.js";
import { validateRunManifest } from "../src/workflow/run-manifest.js";

function sourceWorkflowState() {
  const workflowState = JSON.parse(readFileSync("docs/examples/current-session-workbench-input.json", "utf8"));
  workflowState.manifest.events = [];
  return workflowState;
}

function sourceWithProjectStatusContinuation() {
  const workflowState = sourceWorkflowState();
  const prepared = prepareContinuationFromProjectStatus({
    project: "ai-control-platform",
    status: "in_progress",
    next_step: "",
    blockers: [],
    global_goals: [
      {
        id: "context-cycle",
        title: "Context cycle",
        status: "in_progress",
        next_step: "Build the next platform context pack cycle.",
        owned_files: ["src/workflow/context-pack-cycle.js", "test/context-pack-cycle.test.js"]
      }
    ]
  }, { workflow_state: workflowState });
  const recorded = recordProjectStatusContinuationPrepared(workflowState, prepared, {
    created_at: "2026-05-22T03:20:00.000Z"
  });

  return recorded.workflow_state;
}

test("context pack cycle materializes latest project status continuation seed", () => {
  const source = sourceWithProjectStatusContinuation();
  const result = materializeContextPackCycleFromWorkflowState(source, {
    cycle_id: "cycle-context-pack",
    created_at: "2026-05-22T03:21:00.000Z"
  });

  assert.equal(result.status, "ready");
  assert.equal(result.phase, "context_pack_cycle");
  assert.equal(result.work_packages.length, 1);
  assert.equal(result.workflow_state.manifest.cycle_id, "cycle-context-pack");
  assert.equal(result.workflow_state.manifest.context_pack.target_project_id, "ai-control-platform");
  assert.equal(result.workflow_state.manifest.work_packages[0].id, "global-goal-context-cycle");
  assert.equal(validateRunManifest(result.workflow_state.manifest).status, "pass");
  assert.equal(result.source_record.workflow_state.manifest.events.at(-1).type, "context_pack_cycle_materialized");
});

test("context pack cycle carries project status for global goal completion across cycles", () => {
  const source = sourceWithProjectStatusContinuation();
  source.project_status = {
    project: "ai-control-platform",
    global_goals: [
      {
        id: "context-cycle",
        title: "Context cycle",
        status: "in_progress"
      }
    ]
  };
  source.manifest.work_packages = [
    {
      id: "global-goal-context-cycle",
      global_goal_id: "context-cycle",
      status: "completed"
    }
  ];

  const result = materializeContextPackCycleFromWorkflowState(source, {
    cycle_id: "cycle-context-pack-preserve-status",
    created_at: "2026-05-24T05:25:00.000Z"
  });

  assert.equal(result.status, "ready");
  assert.equal(result.workflow_state.project_status.project, "ai-control-platform");
  assert.equal(result.workflow_state.project_status.global_goals[0].id, "context-cycle");
  assert.equal(result.workflow_state.project_status.global_goals[0].status, "completed");
  assert.equal(result.workflow_state.global_goals[0].id, "context-cycle");
  assert.equal(result.workflow_state.global_goals[0].status, "completed");
  assert.equal(result.workflow_state.manifest.work_packages[0].id, "global-goal-context-cycle");
});

test("context pack cycle does not complete an open requirement goal from a finished intake package alone", () => {
  const source = sourceWithProjectStatusContinuation();
  source.project_status = {
    project: "ai-control-platform",
    requirement_intake: {
      items: [
        {
          id: "requirement-frontend-refactor",
          title: "前端重构",
          status: "submitted"
        }
      ]
    },
    plan_reviews: {
      "requirement-frontend-refactor": {
        phase: "in_development"
      }
    },
    global_goals: [
      {
        id: "requirement-frontend-refactor",
        title: "前端重构",
        status: "in_progress"
      }
    ]
  };
  source.manifest.work_packages = [
    {
      id: "requirement-frontend-refactor-intake",
      global_goal_id: "requirement-frontend-refactor",
      status: "completed"
    }
  ];

  const result = materializeContextPackCycleFromWorkflowState(source, {
    cycle_id: "cycle-context-pack-open-requirement",
    created_at: "2026-05-24T05:26:00.000Z"
  });

  assert.equal(result.status, "ready");
  assert.equal(result.workflow_state.project_status.global_goals[0].status, "in_progress");
  assert.equal(result.workflow_state.global_goals[0].status, "in_progress");
});

test("context pack cycle blocks without a project status continuation fact", () => {
  const result = materializeContextPackCycleFromWorkflowState(sourceWorkflowState());

  assert.equal(result.status, "blocked");
  assert.ok(result.issues.some((issue) => issue.code === "missing_project_status_continuation"));
});
