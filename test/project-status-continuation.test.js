import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  createContinuationInputFromProjectStatus,
  prepareContinuationFromProjectStatus,
  recordProjectStatusContinuationPrepared
} from "../src/workflow/project-status-continuation.js";

function projectStatus(overrides = {}) {
  return {
    project: "ai-control-platform",
    status: "in_progress",
    blockers: [],
    next_step: "Continue from repository status.",
    global_goals: [
      {
        id: "platform-foundation",
        title: "Platform foundation",
        status: "in_progress",
        next_step: "Harden durable platform state."
      }
    ],
    ...overrides
  };
}

test("project status continuation keeps next step and global goals in durable input", () => {
  const input = createContinuationInputFromProjectStatus(projectStatus());

  assert.equal(input.project_status.project, "ai-control-platform");
  assert.equal(input.project_status.next_step, "Continue from repository status.");
  assert.deepEqual(input.project_status.next_work_packages, []);
  assert.equal(input.project_status.global_goals.length, 1);
  assert.equal(input.run_evaluation.source, "PROJECT_STATUS.json");
});

test("project status continuation is ready while global goals are pending", () => {
  const result = prepareContinuationFromProjectStatus(projectStatus({ next_step: "" }));

  assert.equal(result.status, "ready");
  assert.equal(result.should_continue, true);
  assert.equal(result.global_goal_completion.status, "in_progress");
  assert.equal(result.decision.next_work_packages[0].global_goal_id, "platform-foundation");
});

test("project status continuation preserves approved requirement plans for work package splitting", () => {
  const result = prepareContinuationFromProjectStatus(projectStatus({
    next_step: "",
    requirement_intake: {
      items: [
        {
          id: "requirement-frontend-refactor",
          title: "前端重构",
          status: "submitted",
          owned_files: ["."]
        }
      ]
    },
    plan_reviews: {
      "requirement-frontend-refactor": {
        phase: "in_development",
        implementation_outline: ["盘点现状", "建立 Next.js + antd 骨架"],
        acceptance_gates: ["Next.js build passes"]
      }
    },
    next_work_packages: [
      {
        id: "requirement-frontend-refactor-intake",
        action: "continue_requirement_intake",
        global_goal_id: "requirement-frontend-refactor",
        owned_files: ["."]
      }
    ]
  }));

  assert.equal(result.status, "ready");
  assert.equal(result.decision.next_work_packages.length, 2);
  assert.equal(result.decision.next_work_packages[0].action, "execute_requirement_plan_step");
  assert.equal(result.decision.context_pack_seed.subtasks[0].id, "requirement-frontend-refactor-plan-step-01");
});

test("project status continuation completes only when configured goals are complete", () => {
  const result = prepareContinuationFromProjectStatus(projectStatus({
    next_step: "",
    global_goals: [{ id: "done", title: "Done", status: "completed" }]
  }));

  assert.equal(result.status, "complete");
  assert.equal(result.should_continue, false);
  assert.equal(result.decision.action, "complete");
});

test("project status continuation blocks wrong project", () => {
  const result = prepareContinuationFromProjectStatus(projectStatus({ project: "stock_dashboard" }));

  assert.equal(result.status, "blocked");
  assert.ok(result.issues.some((issue) => issue.code === "project_status_mismatch"));
});

test("project status continuation records durable workflow facts", () => {
  const workflowState = JSON.parse(readFileSync("docs/examples/current-session-workbench-input.json", "utf8"));
  workflowState.manifest.events = [];
  const prepared = prepareContinuationFromProjectStatus(projectStatus({ next_step: "" }), {
    workflow_state: workflowState
  });
  const recorded = recordProjectStatusContinuationPrepared(workflowState, prepared, {
    created_at: "2026-05-22T02:00:00.000Z"
  });

  assert.equal(recorded.status, "pass");
  assert.equal(recorded.fact.type, "project_status_continuation");
  assert.equal(recorded.fact.status, "ready");
  assert.equal(recorded.fact.next_work_package_count, 1);
  assert.equal(recorded.fact.context_pack_seed.target_project_id, "ai-control-platform");
  assert.equal(recorded.workflow_state.manifest.events.at(-1).type, "project_status_continuation");
  assert.equal(recorded.workflow_state.artifact_ledger.artifacts.at(-1).metadata.next_goal.id, "platform-foundation");
});

test("prepare-project-status-continuation CLI writes continuation input", () => {
  const dir = mkdtempSync(join(tmpdir(), "project-status-continuation-"));
  const projectStatusPath = join(dir, "PROJECT_STATUS.json");
  const outputPath = join(dir, "continuation-input.json");
  writeFileSync(projectStatusPath, `${JSON.stringify(projectStatus(), null, 2)}\n`);

  const result = spawnSync(process.execPath, [
    "tools/prepare-project-status-continuation.mjs",
    "--project-status",
    projectStatusPath,
    "--output",
    outputPath
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(readFileSync(outputPath, "utf8"));
  assert.equal(output.project_status.project, "ai-control-platform");
  assert.equal(output.project_status.global_goals[0].id, "platform-foundation");
});
