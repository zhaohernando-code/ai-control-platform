import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createWorkbenchServer } from "../tools/workbench-server.mjs";

async function withServer(fn, options = {}) {
  const server = createWorkbenchServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();

  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, {
      method: options.method || "GET",
      headers: options.headers || {}
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: body,
          json: () => JSON.parse(body)
        });
      });
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test("workbench server returns latest projection", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/projection`);
    const projection = response.json();

    assert.equal(response.status, 200);
    assert.equal(projection.projection_version, "workbench.v1");
    assert.equal(projection.run_id, "run-20260521-platform-self-trial");
    assert.equal(projection.operator_events.status, "pass");
    assert.equal(projection.operator_events.applied_artifacts, 1);
    assert.equal(projection.manifest.event_count, 3);
    assert.equal(projection.artifacts.total, 3);
  });
});

test("workbench server builds latest projection from workflow state input", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/projection`);
    const projection = response.json();

    assert.equal(response.status, 200);
    assert.equal(projection.operator_events.event_count, 1);
    assert.equal(projection.artifacts.by_type.evaluation, 1);
    assert.equal(projection.autonomous_run.summaries.artifacts.total, 3);
  });
});

test("workbench server returns projection history index", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/projections`);
    const history = response.json();

    assert.equal(response.status, 200);
    assert.equal(history.version, "projection-history.v1");
    assert.equal(history.latest, "current-session");
    assert.equal(history.items.length, 2);
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
  const workflowState = JSON.parse(readFileSync("docs/examples/current-session-workbench-input.json", "utf8"));

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

test("workbench server serves desktop app shell", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/apps/workbench/desktop.html`);
    const html = response.text;

    assert.equal(response.status, 200);
    assert.match(html, /data-view="desktop"/);
    assert.match(response.headers["content-type"], /text\/html/);
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
