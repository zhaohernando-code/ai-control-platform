import assert from "node:assert/strict";
import test from "node:test";

import {
  currentSessionWithoutRequirementPlanReview,
  generatedRequirementPlan,
  join,
  mkdtempSync,
  readFileSync,
  relative,
  request,
  waitForCondition,
  withServer,
  writeFileSync
} from "./helpers/workbench-server.js";

test("workbench server falls back to a governed requirement plan model after timeout", async () => {
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-requirement-fallback-"));
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const inputPath = join(snapshotsRoot, "requirement-fallback-input.json");
  const projectStatusPath = join(snapshotsRoot, "PROJECT_STATUS.json");
  const workflowState = currentSessionWithoutRequirementPlanReview();
  workflowState.manifest.events = [];
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(projectStatusPath, JSON.stringify({
    project: "ai-control-platform",
    status: "in_progress",
    blockers: [],
    next_step: "",
    global_goals: []
  }, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "requirement-fallback",
    items: [
      {
        id: "requirement-fallback",
        label: "Requirement fallback",
        status: "pass",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }, null, 2));
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/requirements?id=requirement-fallback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "完成项目 tab",
        project_id: "ai-control-platform",
        problem_statement: "项目 tab 需要接入项目治理。",
        plan_review_requested: true,
        generate_plan: true,
        wait_for_plan_generation: true,
        requirement_plan_timeout_ms: 50,
        created_at: "2026-05-25T10:00:00.000Z",
        requirement_id: "requirement-project-tab"
      })
    });
    const payload = response.json();
    const generator = payload.plan_review.generator;
    assert.equal(response.status, 201);
    assert.equal(payload.plan_review.phase, "ready_for_review");
    assert.equal(generator.model, "claude-haiku-4-5-20251001");
    assert.equal(generator.fallback_from_model, "claude-sonnet-4-6");
    assert.equal(generator.attempts[0].timed_out, true);
    assert.equal(generator.attempts[1].attempt, "candidate_fallback");
  }, {
    historyPath,
    snapshotsRoot,
    projectStatusPath,
    requirementPlanGenerator: async () => ({
      status: "pass",
      generated_plan: generatedRequirementPlan(),
      generator: {
        kind: "agent_invocation_requirement_plan",
        model: "claude-haiku-4-5-20251001",
        timed_out: false,
        attempt: "candidate_fallback",
        fallback_from_model: "claude-sonnet-4-6",
        attempts: [
          { model: "claude-sonnet-4-6", timed_out: true, attempt: "primary" },
          { model: "claude-haiku-4-5-20251001", timed_out: false, attempt: "candidate_fallback" }
        ]
      }
    })
  });
});

test("workbench server can apply a supplied plan when retrying failed plan generation", async () => {
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-requirement-supplied-plan-"));
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const inputPath = join(snapshotsRoot, "requirement-supplied-plan-input.json");
  const projectStatusPath = join(snapshotsRoot, "PROJECT_STATUS.json");
  const workflowState = currentSessionWithoutRequirementPlanReview();
  workflowState.manifest.events = [];
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(projectStatusPath, JSON.stringify({
    project: "ai-control-platform",
    status: "in_progress",
    blockers: [],
    next_step: "",
    global_goals: []
  }, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "requirement-supplied-plan",
    items: [
      {
        id: "requirement-supplied-plan",
        label: "Requirement supplied plan",
        status: "pass",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }, null, 2));

  await withServer(async (baseUrl) => {
    const submitted = await request(`${baseUrl}/api/workbench/requirements?id=requirement-supplied-plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "完成项目 tab",
        project_id: "ai-control-platform",
        problem_statement: "项目 tab 需要接入项目治理。",
        plan_review_requested: true,
        generate_plan: true,
        created_at: "2026-05-25T10:00:00.000Z",
        requirement_id: "requirement-project-tab"
      })
    });
    assert.equal(submitted.status, 201);
    await waitForCondition(() => {
      const currentProjectStatus = JSON.parse(readFileSync(projectStatusPath, "utf8"));
      return currentProjectStatus.plan_reviews["requirement-project-tab"].phase === "plan_generation_failed";
    }, "initial failed plan generation");

    const retry = await request(`${baseUrl}/api/workbench/requirements/retry-plan?id=requirement-supplied-plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requirement_id: "requirement-project-tab",
        generated_plan: generatedRequirementPlan(),
        created_at: "2026-05-25T10:05:00.000Z"
      })
    });
    const payload = retry.json();
    assert.equal(retry.status, 201);
    assert.equal(payload.status, "generated");
    assert.equal(payload.plan_review.phase, "ready_for_review");
    assert.equal(payload.plan_review.generator.kind, "operator_supplied_requirement_plan");
    assert.equal(payload.auto_advance.status, "waiting_for_plan_review");
  }, {
    historyPath,
    snapshotsRoot,
    projectStatusPath,
    requirementPlanGenerator: async () => ({ status: "fail", stderr: "simulated model timeout" })
  });
});
