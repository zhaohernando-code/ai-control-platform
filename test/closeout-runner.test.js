import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  executeSnapshotPublishPlan,
  extractSnapshotPublishPlan,
  runCloseoutPlan,
  snapshotPlanIssues
} from "../src/workflow/closeout-runner.js";
import { createWorkbenchProjection } from "../src/workflow/workbench-projection.js";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function workflowState() {
  return readJson("docs/examples/current-session-workbench-input.json");
}

function snapshotPlan(overrides = {}) {
  return {
    action: "publish_workbench_snapshot",
    endpoint: "/api/workbench/snapshots",
    id: "run-closeout-runner",
    label: "Closeout runner snapshot",
    input: workflowState(),
    ...overrides
  };
}

function platformTempDir(prefix) {
  mkdirSync("tmp", { recursive: true });
  return mkdtempSync(join(process.cwd(), `tmp/${prefix}`));
}

test("extractSnapshotPublishPlan accepts raw plan or continuation decision", () => {
  const plan = snapshotPlan();

  assert.equal(extractSnapshotPublishPlan(plan), plan);
  assert.equal(extractSnapshotPublishPlan({ snapshot_publish_plan: plan }), plan);
});

test("snapshotPlanIssues rejects wrong action and unsafe snapshot input", () => {
  assert.deepEqual(snapshotPlanIssues({ action: "summarize", id: 123, input: {} }), [
    "snapshot_publish_plan.action must be publish_workbench_snapshot",
    "snapshot_publish_plan.endpoint must be /api/workbench/snapshots",
    "id must be a safe snapshot id"
  ]);
});

test("runCloseoutPlan publishes local workbench snapshot from continuation decision", async () => {
  const dir = platformTempDir("ai-control-platform-closeout-");
  const historyPath = join(dir, "projection-history.json");
  const snapshotsRoot = join(dir, "snapshots");
  writeFileSync(historyPath, JSON.stringify({ version: "projection-history.v1", latest: null, items: [] }));

  const result = await runCloseoutPlan({ snapshot_publish_plan: snapshotPlan() }, {
    root: process.cwd(),
    historyPath,
    snapshotsRoot
  });
  const history = readJson(historyPath);
  const snapshot = readJson(result.snapshot_path);

  assert.equal(result.status, "created");
  assert.equal(result.mode, "local");
  assert.equal(history.latest, "run-closeout-runner");
  assert.match(history.items[0].input_path, /^tmp\/ai-control-platform-closeout-/);
  assert.equal(snapshot.manifest.run_id, "run-20260521-platform-self-trial");
});

test("runCloseoutPlan refuses local publishing outside the platform repo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "managed-project-closeout-"));
  const historyPath = join(dir, "projection-history.json");
  const snapshotsRoot = join(dir, "snapshots");
  writeFileSync(historyPath, JSON.stringify({ version: "projection-history.v1", latest: null, items: [] }));

  const result = await runCloseoutPlan({ snapshot_publish_plan: snapshotPlan() }, {
    root: dir,
    historyPath,
    snapshotsRoot
  });

  assert.equal(result.status, "fail");
  assert.deepEqual(result.issues, ["closeout runner root must be ai-control-platform platform repo"]);
});

test("runCloseoutPlan refuses output paths outside the platform repo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "managed-output-closeout-"));
  const historyPath = join(dir, "projection-history.json");
  const snapshotsRoot = join(dir, "snapshots");
  writeFileSync(historyPath, JSON.stringify({ version: "projection-history.v1", latest: null, items: [] }));

  const result = await runCloseoutPlan({ snapshot_publish_plan: snapshotPlan() }, {
    root: process.cwd(),
    historyPath,
    snapshotsRoot
  });

  assert.equal(result.status, "fail");
  assert.deepEqual(result.issues, [
    "closeout history path must stay under the platform repo root",
    "closeout snapshots root must stay under the platform repo root"
  ]);
});

test("runCloseoutPlan rejects invalid projection plans without updating history", async () => {
  const dir = platformTempDir("ai-control-platform-closeout-invalid-");
  const historyPath = join(dir, "projection-history.json");
  const snapshotsRoot = join(dir, "snapshots");
  writeFileSync(historyPath, JSON.stringify({ version: "projection-history.v1", latest: null, items: [] }));

  const result = await runCloseoutPlan({
    snapshot_publish_plan: snapshotPlan({
      id: "invalid-closeout-runner",
      input: {
        manifest: { run_id: "invalid-closeout-runner", cycle_id: "cycle-invalid" },
        artifact_ledger: { artifacts: [] }
      }
    })
  }, {
    root: process.cwd(),
    historyPath,
    snapshotsRoot
  });
  const history = readJson(historyPath);

  assert.equal(result.status, "fail");
  assert.equal(history.latest, null);
  assert.equal(existsSync(join(snapshotsRoot, "invalid-closeout-runner.workbench-input.json")), false);
  assert.ok(result.issues.includes("projection input validation must pass before snapshot publish"));
});

test("runCloseoutPlan fails closed when snapshot plan is missing", async () => {
  const result = await runCloseoutPlan({ run_evaluation: { status: "pass" } });

  assert.equal(result.status, "fail");
  assert.deepEqual(result.issues, ["snapshot_publish_plan is required for autonomous closeout publishing"]);
});

test("executeSnapshotPublishPlan can post to workbench snapshot API", async () => {
  let calledUrl = "";
  let calledBody = null;
  const projection = createWorkbenchProjection(workflowState());
  const result = await executeSnapshotPublishPlan(snapshotPlan(), {
    mode: "http",
    baseUrl: "http://127.0.0.1:4311",
    fetch: async (url, request) => {
      calledUrl = String(url);
      calledBody = JSON.parse(request.body);
      return {
        ok: true,
        status: 201,
        json: async () => ({
          status: "created",
          item: { id: "run-closeout-runner" },
          projection
        })
      };
    }
  });

  assert.equal(calledUrl, "http://127.0.0.1:4311/api/workbench/snapshots");
  assert.equal(calledBody.id, "run-closeout-runner");
  assert.equal(result.status, "created");
  assert.equal(result.mode, "http");
});

test("executeSnapshotPublishPlan accepts trimmed snapshot id from http API response", async () => {
  const projection = createWorkbenchProjection(workflowState());
  const result = await executeSnapshotPublishPlan(snapshotPlan({ id: " run-closeout-runner " }), {
    mode: "http",
    baseUrl: "http://127.0.0.1:4311",
    fetch: async () => ({
      ok: true,
      status: 201,
      json: async () => ({
        status: "created",
        item: { id: "run-closeout-runner" },
        projection
      })
    })
  });

  assert.equal(result.status, "created");
});

test("executeSnapshotPublishPlan rejects malformed successful http responses", async () => {
  const result = await executeSnapshotPublishPlan(snapshotPlan(), {
    mode: "http",
    baseUrl: "http://127.0.0.1:4311",
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({})
    })
  });

  assert.equal(result.status, "fail");
  assert.deepEqual(result.issues, ["snapshot API response must include created status, matching item, and projection"]);
});

test("executeSnapshotPublishPlan rejects schema-invalid http projections", async () => {
  const result = await executeSnapshotPublishPlan(snapshotPlan(), {
    mode: "http",
    baseUrl: "http://127.0.0.1:4311",
    fetch: async () => ({
      ok: true,
      status: 201,
      json: async () => ({
        status: "created",
        item: { id: "run-closeout-runner" },
        projection: { run_id: "run-20260521-platform-self-trial" }
      })
    })
  });

  assert.equal(result.status, "fail");
  assert.deepEqual(result.issues, ["snapshot API response projection must pass workbench projection schema"]);
});

test("executeSnapshotPublishPlan rejects http projections that do not match submitted state", async () => {
  const projection = createWorkbenchProjection(workflowState());
  const result = await executeSnapshotPublishPlan(snapshotPlan(), {
    mode: "http",
    baseUrl: "http://127.0.0.1:4311",
    fetch: async () => ({
      ok: true,
      status: 201,
      json: async () => ({
        status: "created",
        item: { id: "run-closeout-runner" },
        projection: { ...projection, run_id: "other-run" }
      })
    })
  });

  assert.equal(result.status, "fail");
  assert.deepEqual(result.issues, ["snapshot API response projection must match the submitted workflow state"]);
});

test("executeSnapshotPublishPlan rejects http projections with cycle or status drift", async () => {
  const projection = createWorkbenchProjection(workflowState());
  for (const driftedProjection of [
    { ...projection, cycle_id: "other-cycle" },
    { ...projection, status: "pass" }
  ]) {
    const result = await executeSnapshotPublishPlan(snapshotPlan(), {
      mode: "http",
      baseUrl: "http://127.0.0.1:4311",
      fetch: async () => ({
        ok: true,
        status: 201,
        json: async () => ({
          status: "created",
          item: { id: "run-closeout-runner" },
          projection: driftedProjection
        })
      })
    });

    assert.equal(result.status, "fail");
    assert.deepEqual(result.issues, ["snapshot API response projection must match the submitted workflow state"]);
  }
});

test("executeSnapshotPublishPlan rejects unknown modes instead of defaulting to local", async () => {
  const result = await executeSnapshotPublishPlan(snapshotPlan(), { mode: "httpp" });

  assert.equal(result.status, "fail");
  assert.deepEqual(result.issues, ["closeout runner mode must be local or http"]);
});
