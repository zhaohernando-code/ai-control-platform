import assert from "node:assert/strict";
import test from "node:test";

import {
  currentSessionWithoutRequirementPlanReview,
  join,
  mkdtempSync,
  relative,
  request,
  withServer,
  WORKBENCH_SERVER_TEST_FILES,
  writeFileSync
} from "./helpers/workbench-server.js";

test("workbench server stages resume execution in background without blocking projection API", async () => {
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-background-resume-"));
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const inputPath = join(snapshotsRoot, "background-resume-input.json");
  const projectStatusPath = join(snapshotsRoot, "PROJECT_STATUS.json");
  const stateDbPath = join(snapshotsRoot, "workbench-state.sqlite");
  const requirementId = "requirement-background-resume";
  const workPackage = {
    id: "requirement-background-resume-plan-step-01",
    title: "后台恢复执行步骤 01",
    action: "execute_requirement_plan_step",
    status: "pending",
    owned_files: ["apps/workbench/app/projects/page.tsx"],
    acceptance_gates: [`node --test ${WORKBENCH_SERVER_TEST_FILES.join(" ")}`],
    global_goal_id: requirementId,
    source: {
      requirement_id: requirementId,
      plan_step_index: 1,
      implementation_step: "恢复执行应后台派发，API 继续可用。",
      execution_governance: {
        version: "work-package-execution-governance.v1",
        granularity: "single_step",
        decomposition: {
          required: false,
          status: "not_required"
        },
        verification: {
          required: true,
          status: "defined",
          gate_count: 1
        }
      }
    }
  };
  const workflowState = currentSessionWithoutRequirementPlanReview();
  workflowState.manifest.events = [];
  workflowState.manifest.work_packages = [workPackage];
  workflowState.manifest.context_pack = {
    requirement_summary: "后台恢复执行",
    host: "platform_core",
    target_project_id: "ai-control-platform",
    owned_files: ["apps/workbench/app/projects/page.tsx", "tools/workbench-server.mjs"],
    acceptance_gates: [`node --test ${WORKBENCH_SERVER_TEST_FILES.join(" ")}`],
    non_goals: ["不阻塞 API"],
    forbidden_actions: ["不得同步长耗时 provider"],
    rollback_conditions: ["API 恢复执行后不可用"],
    subtasks: [workPackage]
  };
  workflowState.task_dag = [workPackage];
  workflowState.project_status = {
    project: "ai-control-platform",
    status: "in_progress",
    blockers: [],
    requirement_intake: {
      items: [{
        id: requirementId,
        title: "后台恢复执行",
        project_id: "ai-control-platform",
        status: "submitted",
        submitted_at: "2026-05-28T13:30:00.000Z",
        problem_statement: "恢复执行不能让 API 失效。"
      }]
    },
    plan_reviews: {
      [requirementId]: {
        id: `plan-review-${requirementId}`,
        phase: "in_development",
        status: "in_development",
        reviewed_at: "2026-05-28T13:31:00.000Z"
      }
    },
    next_work_packages: [workPackage]
  };
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(projectStatusPath, JSON.stringify(workflowState.project_status, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "background-resume",
    items: [
      {
        id: "background-resume",
        label: "Background resume",
        status: "pass",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }, null, 2));

  let launched = null;
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/context-work-packages-run?id=background-resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_package_count: 1,
        background: true,
        dispatch_mode: "background",
        created_at: "2026-05-28T13:32:00.000Z"
      })
    });
    const payload = response.json();
    const projectionResponse = await request(`${baseUrl}/api/workbench/projection?id=background-resume`);
    const projection = projectionResponse.json();
    const task = projection.project_management.task_items[0];

    assert.equal(response.status, 202);
    assert.equal(payload.status, "accepted");
    assert.equal(payload.phase, "context_work_packages_dispatch_started");
    assert.deepEqual(payload.selected_work_package_ids, [workPackage.id]);
    assert.equal(payload.projection.project_management.task_items[0].status, "running");
    assert.equal(projectionResponse.status, 200);
    assert.equal(task.status, "running");
    assert.equal(task.status_label, "运行中");
    assert.equal(task.work_packages[0].status, "running");
    assert.equal(launched.selected_work_package_ids[0], workPackage.id);
    assert.equal(launched.snapshot_id, "background-resume");
  }, {
    historyPath,
    snapshotsRoot,
    projectStatusPath,
    stateDbPath,
    contextWorkPackageBackgroundLauncher: (input) => {
      launched = input;
      return {
        status: "started",
        pid: 12345,
        output_path: input.output_path
      };
    }
  });
});
