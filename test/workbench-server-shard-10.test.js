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

test("workbench server rejects scheduler dispatch plan creation with unsafe host", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-scheduler-plan-host-"));
  const inputPath = join(snapshotsRoot, "scheduler-plan-host-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "scheduler-plan-host",
    items: [
      {
        id: "scheduler-plan-host",
        label: "Scheduler plan host",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-dispatch-plan`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "bad/host"
      },
      body: JSON.stringify({})
    });
    const rejected = response.json();

    assert.equal(response.status, 400);
    assert.match(rejected.error, /request host is required/);
  }, { historyPath, snapshotsRoot });
});

test("workbench server rejects scheduler dispatch run identity drift", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-scheduler-drift-"));
  const inputPath = join(snapshotsRoot, "scheduler-drift-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "scheduler-drift",
    items: [
      {
        id: "scheduler-drift",
        label: "Scheduler drift",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-dispatch-run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        artifact: {
          version: "scheduler-dispatch-run.v1",
          run_id: "wrong-run",
          status: "pass",
          result: { steps: [] }
        }
      })
    });
    const rejected = response.json();

    assert.equal(response.status, 400);
    assert.equal(rejected.error, "scheduler dispatch run record failed");
    assert.ok(rejected.issues.some((entry) => entry.code === "scheduler_dispatch_identity_mismatch"));
  }, { historyPath, snapshotsRoot });
});

test("workbench server rejects unsafe workflow state snapshot ids", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-history-"));
  const historyPath = join(dir, "projection-history.json");
  writeFileSync(historyPath, JSON.stringify({ version: "projection-history.v1", latest: null, items: [] }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/snapshots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "../escape", input: {} })
    });
    const rejected = response.json();

    assert.equal(response.status, 400);
    assert.equal(rejected.error, "invalid workflow state snapshot");
    assert.ok(rejected.issues.includes("id must be a safe snapshot id"));
  }, { historyPath });
});

test("workbench server rejects non-string workflow state snapshot ids", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-history-"));
  const historyPath = join(dir, "projection-history.json");
  writeFileSync(historyPath, JSON.stringify({ version: "projection-history.v1", latest: null, items: [] }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/snapshots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 123, input: {} })
    });
    const rejected = response.json();

    assert.equal(response.status, 400);
    assert.equal(rejected.error, "invalid workflow state snapshot");
    assert.ok(rejected.issues.includes("id must be a safe snapshot id"));
  }, { historyPath });
});

test("workbench server rejects workflow state snapshots that are not projection-ready", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-history-"));
  const historyPath = join(dir, "projection-history.json");
  writeFileSync(historyPath, JSON.stringify({ version: "projection-history.v1", latest: null, items: [] }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/snapshots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "not-ready",
        input: {
          manifest: { run_id: "not-ready", cycle_id: "cycle-not-ready" },
          artifact_ledger: { artifacts: [] }
        }
      })
    });
    const rejected = response.json();
    const history = (await request(`${baseUrl}/api/workbench/projections`)).json();

    assert.equal(response.status, 400);
    assert.equal(rejected.error, "workflow state snapshot publish failed");
    assert.ok(rejected.issues.includes("projection input validation must pass before snapshot publish"));
    assert.equal(history.latest, null);
  }, { historyPath });
});

test("workbench server rejects workflow state snapshots without operator event facts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-history-"));
  const historyPath = join(dir, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  delete workflowState.operator_event_ledger;
  writeFileSync(historyPath, JSON.stringify({ version: "projection-history.v1", latest: null, items: [] }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/snapshots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "missing-operator-events",
        input: workflowState
      })
    });
    const rejected = response.json();
    const history = (await request(`${baseUrl}/api/workbench/projections`)).json();

    assert.equal(response.status, 400);
    assert.equal(rejected.error, "workflow state snapshot publish failed");
    assert.ok(rejected.issues.includes("operator events must apply before snapshot publish"));
    assert.equal(history.latest, null);
  }, { historyPath });
});

test("workbench server is API-only for page routes and rejects retired legacy static opt-in", async () => {
  assert.throws(
    // workbench-state-boundary-allow fixture-file-state: verifies retired legacy static option fails before serving.
    () => createWorkbenchServer({ allowFixtureFileState: true, serveLegacyStatic: true }),
    /legacy static Workbench serving has been retired/
  );

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/apps/workbench/desktop.html`);
    const mountedRoot = await request(`${baseUrl}/projects/ai-control-platform/`);
    const mountedAsset = await request(`${baseUrl}/projects/ai-control-platform/apps/workbench/workbench.js`);
    const body = response.json();

    assert.equal(response.status, 404);
    assert.match(body.error, /served by Next\.js/);
    assert.equal(mountedRoot.status, 404);
    assert.match(mountedRoot.json().error, /served by Next\.js/);
    assert.equal(mountedAsset.status, 404);
    assert.match(mountedAsset.json().error, /served by Next\.js/);
  });
});

test("workbench server exposes mounted workbench APIs", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/projects/ai-control-platform/api/workbench/projection?id=current-session`);
    const projection = response.json();

    assert.equal(response.status, 200);
    assert.equal(projection.projection_version, "workbench.v1");
    assert.equal(projection.run_id, "run-20260521-platform-self-trial");
  });
});

test("workbench server rejects unknown projection ids", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/projection?id=missing`);
    const body = response.json();

    assert.equal(response.status, 404);
    assert.match(body.error, /projection not found/);
  });
});

test("workbench server persists operator events", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-events-"));
  const eventsPath = join(dir, "operator-events.json");
  writeFileSync(eventsPath, JSON.stringify({ version: "operator-events.v1", events: [] }));

  await withServer(async (baseUrl) => {
    const createResponse = await request(`${baseUrl}/api/workbench/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "validate", run_id: "run-1", cycle_id: "cycle-1" })
    });
    const created = createResponse.json();
    const listResponse = await request(`${baseUrl}/api/workbench/events`);
    const ledger = listResponse.json();

    assert.equal(createResponse.status, 201);
    assert.equal(created.status, "created");
    assert.equal(ledger.events.length, 1);
    assert.equal(ledger.events[0].action, "validate");
    assert.equal(ledger.events[0].run_id, "run-1");
  }, { eventsPath });
});
