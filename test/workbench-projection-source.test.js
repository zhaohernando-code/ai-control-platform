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

test("projection source records operator events", async () => {
  const calls = [];
  const source = createProjectionSource({
    url: "/api/workbench/projection",
    eventsUrl: "/api/workbench/events",
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      return {
        ok: true,
        async json() {
          return { status: "created", count: 1 };
        }
      };
    }
  });

  const result = await source.recordEvent({ action: "validate", run_id: "run" });

  assert.equal(result.status, "created");
  assert.equal(calls[0].url, "/api/workbench/events");
  assert.equal(calls[0].options.method, "POST");
  assert.match(calls[0].options.body, /validate/);
});

test("projection source records reviewer provider health", async () => {
  const calls = [];
  const source = createProjectionSource({
    providerHealthUrl: "/api/workbench/reviewer-provider-health",
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      return {
        ok: true,
        async json() {
          return { status: "created", fact: { provider_health: "healthy" } };
        }
      };
    }
  });

  const result = await source.recordProviderHealth({ smoke_status: "pass", tools: ["Read"] });

  assert.equal(result.status, "created");
  assert.equal(source.providerHealthUrl, "/api/workbench/reviewer-provider-health");
  assert.equal(calls[0].options.method, "POST");
  assert.match(calls[0].options.body, /smoke_status/);
});

test("projection source records reviewer shard results", async () => {
  const calls = [];
  const source = createProjectionSource({
    shardResultUrl: "/api/workbench/reviewer-shard-result",
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      return {
        ok: true,
        async json() {
          return { status: "created", fact: { shard_id: "reviewer-scope-shard-001" } };
        }
      };
    }
  });

  const result = await source.recordReviewerShardResult({
    shard_id: "reviewer-scope-shard-001",
    status: "pass"
  });

  assert.equal(result.status, "created");
  assert.equal(source.shardResultUrl, "/api/workbench/reviewer-shard-result");
  assert.equal(calls[0].options.method, "POST");
  assert.match(calls[0].options.body, /reviewer-scope-shard-001/);
});

test("projection source records scheduler dispatch runs", async () => {
  const calls = [];
  const source = createProjectionSource({
    schedulerDispatchRunUrl: "/api/workbench/scheduler-dispatch-run",
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      return {
        ok: true,
        async json() {
          return { status: "created", projection: validProjection() };
        }
      };
    }
  });

  const result = await source.recordSchedulerDispatchRun({
    artifact: {
      version: "scheduler-dispatch-run.v1",
      status: "pass",
      result: { steps: [] }
    }
  });

  assert.equal(result.status, "created");
  assert.equal(source.schedulerDispatchRunUrl, "/api/workbench/scheduler-dispatch-run");
  assert.equal(calls[0].options.method, "POST");
  assert.match(calls[0].options.body, /scheduler-dispatch-run\.v1/);
});

test("projection source creates scheduler dispatch plans", async () => {
  const calls = [];
  const source = createProjectionSource({
    schedulerDispatchPlanUrl: "/api/workbench/scheduler-dispatch-plan",
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      return {
        ok: true,
        async json() {
          return { status: "created", plan: { writeback: { mode: "service" } } };
        }
      };
    }
  });

  const result = await source.createSchedulerDispatchPlan({ reviewer_mock_status: "pass" });

  assert.equal(result.status, "created");
  assert.equal(source.schedulerDispatchPlanUrl, "/api/workbench/scheduler-dispatch-plan");
  assert.equal(calls[0].options.method, "POST");
  assert.match(calls[0].options.body, /reviewer_mock_status/);
});

test("projection source rejects failed scheduler dispatch plan creation", async () => {
  const source = createProjectionSource({
    schedulerDispatchPlanUrl: "/api/workbench/scheduler-dispatch-plan",
    fetch: async () => ({
      ok: false,
      status: 400,
      async json() {
        return { error: "scheduler plan failed" };
      }
    })
  });

  await assert.rejects(
    source.createSchedulerDispatchPlan({}),
    /Scheduler dispatch plan create failed: 400/
  );
});

test("projection source rejects failed scheduler dispatch run writes", async () => {
  const source = createProjectionSource({
    schedulerDispatchRunUrl: "/api/workbench/scheduler-dispatch-run",
    fetch: async () => ({
      ok: false,
      status: 400,
      async json() {
        return { error: "scheduler dispatch failed" };
      }
    })
  });

  await assert.rejects(
    source.recordSchedulerDispatchRun({ artifact: {} }),
    /Scheduler dispatch run write failed: 400/
  );
});

test("projection source rejects failed provider health writes", async () => {
  const source = createProjectionSource({
    providerHealthUrl: "/api/workbench/reviewer-provider-health",
    fetch: async () => ({
      ok: false,
      status: 400,
      async json() {
        return { error: "provider health failed" };
      }
    })
  });

  await assert.rejects(
    source.recordProviderHealth({ smoke_status: "timeout" }),
    /Provider health write failed: 400/
  );
});

test("projection source rejects failed reviewer shard result writes", async () => {
  const source = createProjectionSource({
    shardResultUrl: "/api/workbench/reviewer-shard-result",
    fetch: async () => ({
      ok: false,
      status: 400,
      async json() {
        return { error: "reviewer shard failed" };
      }
    })
  });

  await assert.rejects(
    source.recordReviewerShardResult({ shard_id: "reviewer-scope-shard-001" }),
    /Reviewer shard result write failed: 400/
  );
});

test("projection source rejects failed operator event writes", async () => {
  const source = createProjectionSource({
    eventsUrl: "/api/workbench/events",
    fetch: async () => ({
      ok: false,
      status: 400,
      async json() {
        return { error: "invalid operator event" };
      }
    })
  });

  await assert.rejects(
    source.recordEvent({ action: "validate" }),
    /Operator event write failed: 400/
  );
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
