import assert from "node:assert/strict";
import { once } from "node:events";
import { get } from "node:http";
import test from "node:test";

import { createWorkbenchServer } from "../tools/workbench-server.mjs";

async function withServer(fn) {
  const server = createWorkbenchServer();
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

function request(url) {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
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
    }).on("error", reject);
  });
}

test("workbench server returns latest projection", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/projection`);
    const projection = response.json();

    assert.equal(response.status, 200);
    assert.equal(projection.projection_version, "workbench.v1");
    assert.equal(projection.run_id, "run-20260521-platform-self-trial");
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
