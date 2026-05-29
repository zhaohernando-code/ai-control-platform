import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createMobileWorkbenchProjection } from "../src/workflow/workbench-projection.js";
import {
  assertWorkbenchProjectionSchema,
  validateWorkbenchProjectionSchema
} from "../src/workflow/workbench-projection-schema.js";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("validates current PC workbench projection fixture", () => {
  const projection = readJson("docs/examples/current-session-workbench-projection.json");
  const validation = assertWorkbenchProjectionSchema(projection);

  assert.equal(validation.status, "pass");
});

test("validates mobile projection schema", () => {
  const input = readJson("docs/examples/current-session-workbench-input.json");
  const mobileProjection = createMobileWorkbenchProjection(input);
  const validation = validateWorkbenchProjectionSchema(mobileProjection);

  assert.equal(validation.status, "pass");
});

test("rejects projection with missing durable sections", () => {
  const projection = {
    projection_version: "workbench.v1",
    run_id: "run",
    cycle_id: "cycle",
    goal: "goal",
    status: "pass",
    decision: "pass",
    generated_at: "2026-05-21T00:00:00.000Z",
    reasons: [],
    blockers: []
  };
  const validation = validateWorkbenchProjectionSchema(projection);

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some((issue) => issue.code === "missing_object_field" && issue.path === "manifest"));
  assert.ok(validation.issues.some((issue) => issue.code === "missing_object_field" && issue.path === "model_routing"));
});

test("rejects unknown status and projection version", () => {
  const validation = validateWorkbenchProjectionSchema({
    projection_version: "workbench.v9",
    status: "unknown"
  });

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some((issue) => issue.code === "invalid_projection_version"));
  assert.ok(validation.issues.some((issue) => issue.code === "invalid_projection_status"));
});

test("rejects projections missing lifecycle heartbeat and timeout readout", () => {
  const projection = readJson("docs/examples/current-session-workbench-projection.json");
  const mobileProjection = createMobileWorkbenchProjection(readJson("docs/examples/current-session-workbench-input.json"));
  delete projection.agent_lifecycle_pool.timed_out;
  delete mobileProjection.agent_lifecycle_pool.heartbeat_count;

  const pcValidation = validateWorkbenchProjectionSchema(projection);
  const mobileValidation = validateWorkbenchProjectionSchema(mobileProjection);

  assert.equal(pcValidation.status, "fail");
  assert.ok(pcValidation.issues.some((issue) => issue.code === "missing_required_field" && issue.path === "agent_lifecycle_pool.timed_out"));
  assert.equal(mobileValidation.status, "fail");
  assert.ok(mobileValidation.issues.some((issue) => issue.code === "missing_required_field" && issue.path === "agent_lifecycle_pool.heartbeat_count"));
});

test("rejects projections missing headless orchestrator evidence sections", () => {
  const projection = readJson("docs/examples/current-session-workbench-projection.json");
  const mobileProjection = createMobileWorkbenchProjection(readJson("docs/examples/current-session-workbench-input.json"));
  delete projection.headless_child_provider;
  delete mobileProjection.projected_action_progress;

  const pcValidation = validateWorkbenchProjectionSchema(projection);
  const mobileValidation = validateWorkbenchProjectionSchema(mobileProjection);

  assert.equal(pcValidation.status, "fail");
  assert.ok(pcValidation.issues.some((issue) => issue.code === "missing_object_field" && issue.path === "headless_child_provider"));
  assert.equal(mobileValidation.status, "fail");
  assert.ok(mobileValidation.issues.some((issue) => issue.code === "missing_object_field" && issue.path === "projected_action_progress"));
});

test("rejects projections missing frontend acceptance evidence", () => {
  const projection = readJson("docs/examples/current-session-workbench-projection.json");
  const mobileProjection = createMobileWorkbenchProjection(readJson("docs/examples/current-session-workbench-input.json"));
  delete projection.frontend_acceptance;
  delete mobileProjection.frontend_acceptance;

  const pcValidation = validateWorkbenchProjectionSchema(projection);
  const mobileValidation = validateWorkbenchProjectionSchema(mobileProjection);

  assert.equal(pcValidation.status, "fail");
  assert.ok(pcValidation.issues.some((issue) => issue.code === "missing_object_field" && issue.path === "frontend_acceptance"));
  assert.equal(mobileValidation.status, "fail");
  assert.ok(mobileValidation.issues.some((issue) => issue.code === "missing_object_field" && issue.path === "frontend_acceptance"));
});

test("rejects projections missing project-management readout", () => {
  const projection = readJson("docs/examples/current-session-workbench-projection.json");
  const mobileProjection = createMobileWorkbenchProjection(readJson("docs/examples/current-session-workbench-input.json"));
  delete projection.project_management;
  mobileProjection.project_management.projects = [];

  const pcValidation = validateWorkbenchProjectionSchema(projection);
  const mobileValidation = validateWorkbenchProjectionSchema(mobileProjection);

  assert.equal(pcValidation.status, "fail");
  assert.ok(pcValidation.issues.some((issue) => issue.code === "missing_object_field" && issue.path === "project_management"));
  assert.equal(mobileValidation.status, "fail");
  assert.ok(mobileValidation.issues.some((issue) => issue.code === "missing_project_management_projects"));
  assert.ok(mobileValidation.issues.some((issue) => issue.code === "missing_platform_project"));
});

test("validates task latest dispatch shape", () => {
  const projection = readJson("docs/examples/current-session-workbench-projection.json");
  projection.project_management.task_items = [
    {
      task_id: "requirement-project-tab",
      title: "完成项目 tab",
      latest_dispatch: {
        dispatch_run_id: "dispatch-001",
        dispatch_failed_at: "2026-05-29T02:38:58.623Z",
        issue_codes: ["provider_executor_timeout"],
        attempt_count: 2,
        latest_attempt: {
          model: "deepseek-v4-flash",
          issue: "provider_executor_timeout",
          timed_out: true,
          exit_code: 1
        }
      }
    }
  ];
  assert.equal(validateWorkbenchProjectionSchema(projection).status, "pass");

  projection.project_management.task_items[0].latest_dispatch = {
    dispatch_run_id: "",
    issue_codes: "provider_executor_timeout"
  };
  const validation = validateWorkbenchProjectionSchema(projection);
  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some((issue) => issue.code === "missing_task_latest_dispatch_run_id"));
  assert.ok(validation.issues.some((issue) => issue.code === "missing_task_latest_dispatch_timestamp"));
  assert.ok(validation.issues.some((issue) => issue.code === "invalid_task_latest_dispatch_issue_codes"));
});

test("rejects projections missing terminal next-action evidence", () => {
  const projection = readJson("docs/examples/current-session-workbench-projection.json");
  const mobileProjection = createMobileWorkbenchProjection(readJson("docs/examples/current-session-workbench-input.json"));
  delete projection.next_action_terminal;
  delete mobileProjection.next_action_terminal.terminal_reason;

  const pcValidation = validateWorkbenchProjectionSchema(projection);
  const mobileValidation = validateWorkbenchProjectionSchema(mobileProjection);

  assert.equal(pcValidation.status, "fail");
  assert.ok(pcValidation.issues.some((issue) => issue.code === "missing_object_field" && issue.path === "next_action_terminal"));
  assert.equal(mobileValidation.status, "fail");
  assert.ok(mobileValidation.issues.some((issue) => issue.code === "missing_required_field" && issue.path === "next_action_terminal.terminal_reason"));
});

test("rejects projections missing self-governance readout", () => {
  const projection = readJson("docs/examples/current-session-workbench-projection.json");
  const mobileProjection = createMobileWorkbenchProjection(readJson("docs/examples/current-session-workbench-input.json"));
  delete projection.self_governance;
  delete mobileProjection.self_governance.user_decision_count;

  const pcValidation = validateWorkbenchProjectionSchema(projection);
  const mobileValidation = validateWorkbenchProjectionSchema(mobileProjection);

  assert.equal(pcValidation.status, "fail");
  assert.ok(pcValidation.issues.some((issue) => issue.code === "missing_object_field" && issue.path === "self_governance"));
  assert.equal(mobileValidation.status, "fail");
  assert.ok(mobileValidation.issues.some((issue) => issue.code === "missing_required_field" && issue.path === "self_governance.user_decision_count"));
});
