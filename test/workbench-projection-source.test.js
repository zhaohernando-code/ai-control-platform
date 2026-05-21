import assert from "node:assert/strict";
import test from "node:test";

import {
  createProjectionSource,
  DEFAULT_HISTORY_URL,
  DEFAULT_PROJECTION_URL,
  historyUrlFromLocation,
  isSafeProjectionUrl,
  projectionUrlFromLocation,
  validateProjectionShape
} from "../apps/workbench/projection-source.js";

function validProjection(overrides = {}) {
  return {
    projection_version: "workbench.v1",
    run_id: "run",
    cycle_id: "cycle",
    status: "pass",
    decision: "pass",
    one_screen: { headline: "ok", counters: {}, next_actions: [] },
    ...overrides
  };
}

test("projection source uses default fixture without query param", () => {
  const url = projectionUrlFromLocation({ search: "" });
  const historyUrl = historyUrlFromLocation({ search: "" });

  assert.equal(url, DEFAULT_PROJECTION_URL);
  assert.equal(historyUrl, DEFAULT_HISTORY_URL);
});

test("projection source accepts safe service and relative URLs", () => {
  assert.equal(isSafeProjectionUrl("/api/workbench/projection"), true);
  assert.equal(isSafeProjectionUrl("./projection.json"), true);
  assert.equal(isSafeProjectionUrl("../projection.json"), true);
  assert.equal(isSafeProjectionUrl("https://example.com/projection.json"), true);
  assert.equal(isSafeProjectionUrl("javascript:alert(1)"), false);
  assert.equal(isSafeProjectionUrl("//example.com/projection.json"), false);
});

test("projection source can load from injected fetch", async () => {
  const source = createProjectionSource({
    url: "/api/workbench/projection",
    fetch: async (url) => ({
      ok: true,
      url,
      async json() {
        return validProjection();
      }
    })
  });

  const projection = await source.load();

  assert.equal(source.url, "/api/workbench/projection");
  assert.equal(projection.status, "pass");
});

test("projection source can load projection history", async () => {
  const source = createProjectionSource({
    url: "/api/workbench/projection",
    historyUrl: "/api/workbench/projections",
    fetch: async (url) => ({
      ok: true,
      url,
      async json() {
        return url.includes("projections")
          ? { version: "projection-history.v1", latest: "current", items: [{ id: "current" }] }
          : validProjection();
      }
    })
  });

  const history = await source.loadHistory();

  assert.equal(source.historyUrl, "/api/workbench/projections");
  assert.equal(history.latest, "current");
  assert.equal(history.items.length, 1);
});

test("projection source rejects malformed projection", async () => {
  const source = createProjectionSource({
    url: "/api/workbench/projection",
    fetch: async () => ({
      ok: true,
      async json() {
        return { status: "pass" };
      }
    })
  });

  await assert.rejects(() => source.load(), /Projection shape validation failed/);
});

test("projection shape validation reports missing one-screen state", () => {
  const validation = validateProjectionShape(validProjection({ one_screen: null }));

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some((issue) => issue.code === "missing_one_screen"));
});
