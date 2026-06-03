import assert from "node:assert/strict";
import test from "node:test";

import {
  assertWorkbenchProjectionSchema,
  chmodSync,
  createSchedulerDispatchPlan,
  createSchedulerDispatchRunArtifact,
  createWorkbenchServer,
  currentProjectionHistory,
  currentSessionWithoutRequirementPlanReview,
  currentSessionWithoutSchedulerLoop,
  currentSessionWorkflowState,
  generatedRequirementPlan,
  isolatedExecutionCwd,
  join,
  mkdirSync,
  mkdtempSync,
  once,
  providerContextWorkPackageWorkflowState,
  readFileSync,
  relative,
  request,
  retryAgentWorkerWorkflowState,
  runNode,
  runSchedulerDispatchPlan,
  spawn,
  tmpdir,
  VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
  waitForCondition,
  waitForOutput,
  withServer,
  writeFileSync
} from "./helpers/workbench-server.js";

test("workbench server records scheduler dispatch runs into workflow state input", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-scheduler-dispatch-"));
  const inputPath = join(snapshotsRoot, "scheduler-dispatch-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  const plan = createSchedulerDispatchPlan({
    project_status: {
      project: "ai-control-platform",
      blockers: [],
      next_step: ""
    },
    run_evaluation: { status: "pass" },
    workflow_state: workflowState
  }, {
    workflow_state_input_path: "tmp/workbench-server-scheduler-dispatch/input.json"
  });
  const artifact = createSchedulerDispatchRunArtifact(
    plan,
    await runSchedulerDispatchPlan(plan, { dry_run: true }),
    { created_at: "2026-05-21T23:01:00.000Z" }
  );
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "scheduler-dispatch",
    items: [
      {
        id: "scheduler-dispatch",
        label: "Scheduler dispatch",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-dispatch-run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ artifact })
    });
    const created = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.status, "created");
    assert.equal(created.artifact.producer, "scheduler-dispatch-runner");
    assert.equal(created.projection.scheduler_dispatch.status, "pass");
    assert.equal(created.projection.scheduler_dispatch.step_count, 3);
    assert.equal(state.manifest.events.at(-1).type, "scheduler_dispatch_run");
    assert.equal(state.artifact_ledger.artifacts.at(-1).metadata.version, "scheduler-dispatch-run.v1");
  }, { historyPath, snapshotsRoot });
});

test("run-scheduler-dispatch-plan CLI records scheduler dispatch run through workbench service", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-scheduler-cli-"));
  const inputPath = join(snapshotsRoot, "scheduler-cli-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const planPath = join(snapshotsRoot, "scheduler-cli-plan.json");
  const outputPath = join(snapshotsRoot, "scheduler-cli-run.json");
  const workflowState = currentSessionWorkflowState();
  const plan = createSchedulerDispatchPlan({
    project_status: {
      project: "ai-control-platform",
      blockers: [],
      next_step: ""
    },
    run_evaluation: { status: "pass" },
    workflow_state: workflowState
  }, {
    workflow_state_input_path: relative(process.cwd(), inputPath)
  });
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(planPath, JSON.stringify(plan, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "scheduler-cli",
    items: [
      {
        id: "scheduler-cli",
        label: "Scheduler CLI",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const result = await runNode([
      "tools/run-scheduler-dispatch-plan.mjs",
      "--plan",
      planPath,
      "--output",
      outputPath,
      "--dry-run",
      "--workbench-base-url",
      baseUrl,
      "--projection-id",
      "scheduler-cli"
    ]);
    const summary = JSON.parse(result.stdout);
    const state = JSON.parse(readFileSync(inputPath, "utf8"));
    const projection = (await request(`${baseUrl}/api/workbench/projection?id=scheduler-cli`)).json();

    assert.equal(result.status, 0, result.stderr);
    assert.equal(summary.status, "pass");
    assert.equal(summary.record_status, "pass");
    assert.equal(summary.projection_scheduler_status, "pass");
    assert.equal(summary.projection_scheduler_steps, 3);
    assert.equal(state.manifest.events.at(-1).type, "scheduler_dispatch_run");
    assert.equal(projection.scheduler_dispatch.status, "pass");
    assert.equal(projection.scheduler_dispatch.step_count, 3);
  }, { historyPath, snapshotsRoot });
});

test("workbench server rejects reviewer shard results without workflow state input", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/reviewer-shard-result?id=bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shard_id: "reviewer-scope-shard-001" })
    });
    const rejected = response.json();

    assert.equal(response.status, 400);
    assert.match(rejected.error, /workflow state input not found/);
  });
});

test("workbench server rejects scheduler dispatch runs without workflow state input", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-dispatch-run?id=bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        artifact: {
          version: "scheduler-dispatch-run.v1",
          status: "pass",
          result: { steps: [] }
        }
      })
    });
    const rejected = response.json();

    assert.equal(response.status, 400);
    assert.match(rejected.error, /workflow state input not found/);
  });
});

test("workbench server rejects scheduler dispatch plans without workflow state input", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-dispatch-plan?id=bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    const rejected = response.json();

    assert.equal(response.status, 400);
    assert.match(rejected.error, /workflow state input not found/);
  });
});

test("workbench server rejects unauthorized non-dry-run scheduler dispatch from workbench control", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-scheduler-control-reject-"));
  const inputPath = join(snapshotsRoot, "scheduler-control-reject-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "scheduler-control-reject",
    items: [
      {
        id: "scheduler-control-reject",
        label: "Scheduler control reject",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dry_run: false })
    });
    const rejected = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 400);
    assert.equal(rejected.error, "scheduler dispatch policy rejected");
    assert.ok(rejected.issues.some((entry) => entry.code === "missing_operator_authorization"));
    assert.equal(rejected.projection.scheduler_dispatch.status, "blocked");
    assert.equal(rejected.projection.scheduler_dispatch.policy_status, "fail");
    assert.equal(rejected.projection.scheduler_dispatch.policy_issue_count, rejected.issues.length);
    assert.equal(state.manifest.events.at(-1).type, "scheduler_dispatch_policy");
  }, { historyPath, snapshotsRoot });
});

test("workbench server rejects unsupported scheduler dispatch execution profiles", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-scheduler-profile-reject-"));
  const inputPath = join(snapshotsRoot, "scheduler-profile-reject-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "scheduler-profile-reject",
    items: [
      {
        id: "scheduler-profile-reject",
        label: "Scheduler profile reject",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ execution_profile: "unbounded_real_model" })
    });
    const rejected = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 400);
    assert.equal(rejected.error, "scheduler dispatch control request rejected");
    assert.ok(rejected.issues.some((entry) => entry.code === "unsupported_scheduler_dispatch_profile"));
    assert.equal(state.manifest.events.length, workflowState.manifest.events.length);
  }, { historyPath, snapshotsRoot });
});
