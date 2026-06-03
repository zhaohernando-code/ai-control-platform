import assert from "node:assert/strict";
import test from "node:test";

import {
  currentSessionWithoutRequirementPlanReview,
  join,
  mkdirSync,
  mkdtempSync,
  once,
  relative,
  request,
  runNode,
  spawn,
  waitForOutput,
  writeFileSync
} from "./helpers/workbench-server.js";

test("workbench server CLI can seed SQLite from isolated history and snapshot roots", async () => {
  const dir = mkdtempSync(join(process.cwd(), "tmp/workbench-server-cli-isolated-"));
  const snapshotsRoot = join(dir, "snapshots");
  const eventsPath = join(dir, "operator-events.json");
  const stateDbPath = join(dir, "workbench-state.sqlite");
  const inputPath = join(snapshotsRoot, "input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWithoutRequirementPlanReview();
  mkdirSync(snapshotsRoot, { recursive: true });
  writeFileSync(eventsPath, JSON.stringify({ version: "operator-events.v1", events: [] }));
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "isolated",
    items: [{
      id: "isolated",
      label: "Isolated",
      input_path: relative(process.cwd(), inputPath)
    }]
  }, null, 2));

  const child = spawn(process.execPath, [
    "tools/workbench-server.mjs",
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
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    const ready = await waitForOutput(child, /Workbench server listening on http:\/\/127\.0\.0\.1:\d+/);
    const port = ready.match(/:(\d+)/)?.[1];
    const response = await request(`http://127.0.0.1:${port}/api/workbench/projection?id=isolated`);
    assert.equal(response.status, 200);
    assert.equal(response.json().run_id, workflowState.manifest.run_id);
  } finally {
    child.kill();
    await once(child, "close").catch(() => {});
  }
});

test("workbench server CLI accepts explicit host and port flags", async () => {
  const child = spawn(process.execPath, [
    "tools/workbench-server.mjs",
    "--host",
    "127.0.0.1",
    "--port",
    "0"
  ], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    const ready = await waitForOutput(child, /Workbench server listening on http:\/\/127\.0\.0\.1:\d+/);
    const port = Number(ready.match(/:(\d+)/)?.[1]);
    assert.ok(port > 0);
  } finally {
    child.kill();
    await once(child, "close").catch(() => {});
  }
});

test("workbench server CLI fails closed for invalid port", async () => {
  const result = await runNode([
    "tools/workbench-server.mjs",
    "--host",
    "127.0.0.1",
    "--port",
    "not-a-port"
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid workbench server port: not-a-port/);
  assert.doesNotMatch(result.stderr, /ERR_SOCKET_BAD_PORT/);
  assert.equal(result.stdout, "");
});
