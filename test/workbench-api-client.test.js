import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchWorkbenchJson,
  WorkbenchApiError
} from "../apps/workbench/lib/api/index.ts";

test("fetchWorkbenchJson preserves structured JSON diagnostics on non-2xx responses", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const issues = [
    { code: "owned_file_violation", path: "owned_files[0]", message: "outside scope" }
  ];
  const projection = {
    projection_version: "workbench.v1",
    status: "human_intervention"
  };
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: "scheduler dispatch rejected",
    phase: "policy_check",
    issues,
    projection
  }), {
    status: 409,
    headers: { "Content-Type": "application/json" }
  });

  await assert.rejects(
    () => fetchWorkbenchJson("/api/workbench/scheduler-dispatch", { method: "POST" }),
    (error) => {
      assert.ok(error instanceof WorkbenchApiError);
      assert.equal(error.name, "WorkbenchApiError");
      assert.equal(error.path, "/api/workbench/scheduler-dispatch");
      assert.equal(error.status, 409);
      assert.equal(error.error, "scheduler dispatch rejected");
      assert.equal(error.phase, "policy_check");
      assert.deepEqual(error.issues, issues);
      assert.deepEqual(error.projection, projection);
      assert.deepEqual(error.body, {
        error: "scheduler dispatch rejected",
        phase: "policy_check",
        issues,
        projection
      });
      assert.match(error.message, /workbench api \/api\/workbench\/scheduler-dispatch failed: 409/);
      assert.match(error.message, /scheduler dispatch rejected/);
      return true;
    }
  );
});

test("fetchWorkbenchJson still reports status when the error body is not JSON", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => new Response("upstream unavailable", {
    status: 502,
    headers: { "Content-Type": "text/plain" }
  });

  await assert.rejects(
    () => fetchWorkbenchJson("/api/workbench/projection"),
    (error) => {
      assert.ok(error instanceof WorkbenchApiError);
      assert.equal(error.path, "/api/workbench/projection");
      assert.equal(error.status, 502);
      assert.equal(error.body, null);
      assert.equal(error.issues, undefined);
      assert.equal(error.projection, undefined);
      assert.match(error.message, /workbench api \/api\/workbench\/projection failed: 502$/);
      return true;
    }
  );
});

test("fetchWorkbenchJson preserves partial JSON diagnostics without inventing fields", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => new Response(JSON.stringify({
    error: "provider unavailable",
    phase: "provider_preflight"
  }), {
    status: 503,
    headers: { "Content-Type": "application/json" }
  });

  await assert.rejects(
    () => fetchWorkbenchJson("/api/workbench/reviewer-provider-health", { method: "POST" }),
    (error) => {
      assert.ok(error instanceof WorkbenchApiError);
      assert.equal(error.status, 503);
      assert.equal(error.error, "provider unavailable");
      assert.equal(error.phase, "provider_preflight");
      assert.equal(error.issues, undefined);
      assert.equal(error.projection, undefined);
      assert.deepEqual(error.body, {
        error: "provider unavailable",
        phase: "provider_preflight"
      });
      return true;
    }
  );
});
