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

test("workbench server rejects operator events without ownership fields", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-events-"));
  const eventsPath = join(dir, "operator-events.json");
  writeFileSync(eventsPath, JSON.stringify({ version: "operator-events.v1", events: [] }));

  await withServer(async (baseUrl) => {
    const createResponse = await request(`${baseUrl}/api/workbench/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "validate" })
    });
    const rejected = createResponse.json();
    const listResponse = await request(`${baseUrl}/api/workbench/events`);
    const ledger = listResponse.json();

    assert.equal(createResponse.status, 400);
    assert.equal(rejected.error, "invalid operator event");
    assert.deepEqual(rejected.issues, ["run_id is required", "cycle_id is required"]);
    assert.equal(ledger.events.length, 0);
  }, { eventsPath });
});

test("workbench server rejects malformed operator event json", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-events-"));
  const eventsPath = join(dir, "operator-events.json");
  writeFileSync(eventsPath, JSON.stringify({ version: "operator-events.v1", events: [] }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{"
    });

    assert.equal(response.status, 400);
    assert.equal(response.json().error, "invalid json");
  }, { eventsPath });
});

test("workbench server rejects oversized json bodies before parsing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-events-"));
  const eventsPath = join(dir, "operator-events.json");
  writeFileSync(eventsPath, JSON.stringify({ version: "operator-events.v1", events: [] }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "x".repeat(128) })
    });
    const payload = response.json();

    assert.equal(response.status, 413);
    assert.equal(payload.error, "request body too large");
    assert.equal(payload.max_bytes, 64);
  }, { eventsPath, jsonBodyLimitBytes: 64 });
});

test("workbench server CLI honors isolated history snapshots and events paths", async () => {
  const dir = mkdtempSync(join(process.cwd(), "tmp/workbench-server-cli-isolated-"));
  const historyPath = join(dir, "projection-history.json");
  const snapshotsRoot = join(dir, "snapshots");
  const eventsPath = join(dir, "operator-events.json");
  const stateDbPath = join(dir, "workbench-state.sqlite");
  const defaultHistoryBefore = readFileSync("docs/examples/projection-history.json", "utf8");
  const defaultEventsBefore = readFileSync("docs/examples/operator-events.json", "utf8");

  mkdirSync(snapshotsRoot, { recursive: true });
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "cli-isolated",
    items: [
      {
        id: "cli-isolated",
        label: "CLI isolated",
        input_path: "docs/examples/current-session-workbench-input.json"
      }
    ]
  }, null, 2));
  writeFileSync(eventsPath, JSON.stringify({ version: "operator-events.v1", events: [] }, null, 2));

  const server = spawn(process.execPath, [
    "tools/workbench-server.mjs",
    "--port",
    "0",
    "--history-path",
    historyPath,
    "--snapshots-root",
    snapshotsRoot,
    "--events-path",
    eventsPath,
    "--state-db",
    stateDbPath
  ], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  server.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const baseUrl = await new Promise((resolveUrl, rejectUrl) => {
    server.stdout.on("data", (chunk) => {
      const line = chunk.toString().split(/\r?\n/).find((entry) => entry.includes("http://"));
      if (line) resolveUrl(line.match(/http:\/\/[^\s]+/)?.[0]);
    });
    server.once("exit", (code) => rejectUrl(new Error(`workbench server exited before listening: ${code}\n${stderr}`)));
    server.once("error", rejectUrl);
  });

  try {
    const eventResponse = await request(`${baseUrl}/api/workbench/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "validate",
        run_id: "run-cli-isolated",
        cycle_id: "cycle-cli-isolated",
        created_at: "2026-05-23T10:30:00.000Z"
      })
    });
    const snapshotResponse = await request(`${baseUrl}/api/workbench/snapshots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "cli-isolated-snapshot",
        input: currentSessionWorkflowState(),
        label: "CLI isolated snapshot"
      })
    });
    const isolatedEvents = (await request(`${baseUrl}/api/workbench/events`)).json();
    const isolatedHistory = (await request(`${baseUrl}/api/workbench/projections`)).json();

    assert.equal(eventResponse.status, 201);
    assert.equal(snapshotResponse.status, 201);
    assert.equal(isolatedEvents.events.length, 1);
    assert.equal(isolatedHistory.latest, "cli-isolated-snapshot");
    assert.equal(JSON.parse(readFileSync(eventsPath, "utf8")).events.length, 0);
    assert.equal(JSON.parse(readFileSync(historyPath, "utf8")).latest, "cli-isolated");
    assert.equal(readFileSync("docs/examples/projection-history.json", "utf8"), defaultHistoryBefore);
    assert.equal(readFileSync("docs/examples/operator-events.json", "utf8"), defaultEventsBefore);
  } finally {
    if (server.exitCode === null) {
      server.kill();
      await once(server, "exit");
    }
  }
});
