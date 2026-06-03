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

test("workbench server returns projection history index", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/projections`);
    const history = response.json();

    assert.equal(response.status, 200);
    assert.equal(history.version, "projection-history.v1");
    const expectedHistory = currentProjectionHistory();
    assert.equal(history.latest, expectedHistory.latest);
    assert.equal(history.items.length, expectedHistory.items.length);
  });
});

test("workbench server returns selected historical projection", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/projection?id=bootstrap`);
    const projection = response.json();

    assert.equal(response.status, 200);
    assert.equal(projection.run_id, "run-20260521-platform-bootstrap");
    assert.equal(projection.status, "pass");
  });
});

test("workbench server prefers input snapshot over static projection path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-history-"));
  const historyPath = join(dir, "projection-history.json");
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "diverged",
    items: [
      {
        id: "diverged",
        label: "Diverged",
        input_path: "docs/examples/current-session-workbench-input.json",
        projection_path: "docs/examples/bootstrap-workbench-projection.json"
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/projection`);
    const projection = response.json();

    assert.equal(response.status, 200);
    assert.equal(projection.run_id, "run-20260521-platform-self-trial");
    assert.equal(projection.operator_events.status, "pass");
  }, { historyPath });
});

test("workbench server rejects projection history paths outside examples", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-history-"));
  const historyPath = join(dir, "projection-history.json");
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "escape",
    items: [
      {
        id: "escape",
        label: "Escape",
        input_path: "../package.json",
        projection_path: "docs/examples/current-session-workbench-projection.json"
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/projection`);
    const body = response.json();

    assert.equal(response.status, 400);
    assert.match(body.error, /input_path must stay under allowed workbench history roots/);
  }, { historyPath });
});

test("workbench server persists workflow state snapshots and updates history", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-snapshots-"));
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-history-"));
  const historyPath = join(dir, "projection-history.json");
  writeFileSync(historyPath, JSON.stringify({ version: "projection-history.v1", latest: null, items: [] }));
  const workflowState = currentSessionWorkflowState();

  await withServer(async (baseUrl) => {
    const createResponse = await request(`${baseUrl}/api/workbench/snapshots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "posted-snapshot",
        label: "Posted snapshot",
        input: workflowState,
        created_at: "2026-05-21T09:00:00.000Z"
      })
    });
    const created = createResponse.json();
    const history = (await request(`${baseUrl}/api/workbench/projections`)).json();
    const projection = (await request(`${baseUrl}/api/workbench/projection?id=posted-snapshot`)).json();
    const snapshot = (await request(`${baseUrl}/api/workbench/snapshot?id=posted-snapshot`)).json();

    assert.equal(createResponse.status, 201);
    assert.equal(created.status, "created");
    assert.equal(created.item.id, "posted-snapshot");
    assert.match(created.item.input_path, /^tmp\/workbench-server-snapshots-/);
    assert.equal(history.latest, "posted-snapshot");
    assert.equal(projection.run_id, "run-20260521-platform-self-trial");
    assert.equal(projection.operator_events.status, "pass");
    assert.equal(snapshot.manifest.run_id, "run-20260521-platform-self-trial");
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server records reviewer provider health into workflow state input", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-provider-health-"));
  const inputPath = join(snapshotsRoot, "provider-health-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  workflowState.manifest.events = workflowState.manifest.events.filter((event) => event.type !== "reviewer_provider_health");
  workflowState.manifest.artifacts = workflowState.manifest.artifacts.filter((artifact) => artifact.metadata?.type !== "reviewer_provider_health");
  workflowState.artifact_ledger.artifacts = workflowState.artifact_ledger.artifacts.filter((artifact) => artifact.metadata?.type !== "reviewer_provider_health");
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "provider-health",
    items: [
      {
        id: "provider-health",
        label: "Provider health",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/reviewer-provider-health`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        smoke_status: "timeout",
        tools: ["Read", "Grep"],
        created_at: "2026-05-21T12:20:00.000Z"
      })
    });
    const created = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.status, "created");
    assert.equal(created.fact.provider_health, "unhealthy");
    assert.equal(created.fact.scheduled_actions[0], "fallback_model_or_defer_external_review");
    assert.equal(created.projection.reviewer_provider_health.provider_health, "unhealthy");
    assert.equal(state.manifest.events.at(-1).type, "reviewer_provider_health");
    assert.equal(state.artifact_ledger.artifacts.at(-1).metadata.provider_health, "unhealthy");
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server rejects provider health recording without workflow state input", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/reviewer-provider-health?id=bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ smoke_status: "pass" })
    });
    const rejected = response.json();

    assert.equal(response.status, 400);
    assert.match(rejected.error, /workflow state input not found/);
  });
});

test("workbench server records reviewer shard results into workflow state input", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-shard-result-"));
  const inputPath = join(snapshotsRoot, "shard-result-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "shard-result",
    items: [
      {
        id: "shard-result",
        label: "Shard result",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const first = await request(`${baseUrl}/api/workbench/reviewer-shard-result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shard_id: "reviewer-scope-shard-001",
        status: "pass",
        created_at: "2026-05-21T12:30:00.000Z"
      })
    });
    const second = await request(`${baseUrl}/api/workbench/reviewer-shard-result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shard_id: "reviewer-scope-shard-002",
        findings: [
          {
            id: "api-shard-finding",
            status: "fail",
            severity: "medium",
            category: "reviewer",
            message: "api shard finding"
          }
        ],
        aggregate: true,
        created_at: "2026-05-21T12:31:00.000Z"
      })
    });
    const created = second.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(created.aggregate.status, "fail");
    assert.equal(created.projection.reviewer_shard_review.completed_shards, 2);
    assert.equal(created.projection.reviewer_shard_review.failed_finding_count, 1);
    assert.equal(state.manifest.events.at(-1).type, "reviewer_shard_aggregate");
    assert.ok(state.manifest.review_findings.some((finding) => finding.finding_id === "api-shard-finding"));
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});
