const DEFAULT_PROJECTION_URL = "../../docs/examples/current-session-workbench-projection.json";
const DEFAULT_HISTORY_URL = "../../docs/examples/projection-history.json";

function isSafeProjectionUrl(value) {
  if (!value) return false;
  if (value.startsWith("http://") || value.startsWith("https://")) return true;
  if (value.startsWith("/") && !value.startsWith("//")) return true;
  if (value.startsWith("./") || value.startsWith("../")) return true;
  return false;
}

function projectionUrlFromLocation(locationLike = globalThis.location) {
  const params = new URLSearchParams(locationLike?.search || "");
  const requested = params.get("projection");
  return isSafeProjectionUrl(requested) ? requested : DEFAULT_PROJECTION_URL;
}

function historyUrlFromLocation(locationLike = globalThis.location) {
  const params = new URLSearchParams(locationLike?.search || "");
  const requested = params.get("history");
  return isSafeProjectionUrl(requested) ? requested : DEFAULT_HISTORY_URL;
}

function validateProjectionShape(projection) {
  const issues = [];

  if (!projection || typeof projection !== "object" || Array.isArray(projection)) {
    return { status: "fail", issues: [{ code: "invalid_projection", message: "projection must be an object" }] };
  }

  for (const field of ["projection_version", "status", "decision", "run_id", "cycle_id"]) {
    if (!String(projection[field] || "").trim()) {
      issues.push({ code: "missing_projection_field", message: `${field} is required`, path: field });
    }
  }

  if (!projection.one_screen || typeof projection.one_screen !== "object") {
    issues.push({ code: "missing_one_screen", message: "one_screen is required", path: "one_screen" });
  }

  return { status: issues.length ? "fail" : "pass", issues };
}

export function createProjectionSource(options = {}) {
  const url = options.url || projectionUrlFromLocation(options.location);
  const historyUrl = options.historyUrl || historyUrlFromLocation(options.location);
  const eventsUrl = options.eventsUrl || "/api/workbench/events";
  const providerHealthUrl = options.providerHealthUrl || "/api/workbench/reviewer-provider-health";
  const shardResultUrl = options.shardResultUrl || "/api/workbench/reviewer-shard-result";
  const schedulerDispatchPlanUrl = options.schedulerDispatchPlanUrl || "/api/workbench/scheduler-dispatch-plan";
  const schedulerDispatchUrl = options.schedulerDispatchUrl || "/api/workbench/scheduler-dispatch";
  const schedulerDispatchRunUrl = options.schedulerDispatchRunUrl || "/api/workbench/scheduler-dispatch-run";
  const fetchImpl = options.fetch || globalThis.fetch;

  return {
    url,
    historyUrl,
    eventsUrl,
    providerHealthUrl,
    shardResultUrl,
    schedulerDispatchPlanUrl,
    schedulerDispatchUrl,
    schedulerDispatchRunUrl,
    async load() {
      if (!fetchImpl) {
        throw new Error("fetch is not available for projection source");
      }

      const response = await fetchImpl(url, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Projection fetch failed: ${response.status}`);
      }

      const projection = await response.json();
      const validation = validateProjectionShape(projection);
      if (validation.status !== "pass") {
        const error = new Error("Projection shape validation failed");
        error.validation = validation;
        throw error;
      }

      return projection;
    },
    async loadHistory() {
      if (!fetchImpl) {
        throw new Error("fetch is not available for projection source");
      }

      const response = await fetchImpl(historyUrl, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Projection history fetch failed: ${response.status}`);
      }

      const history = await response.json();
      if (!history || !Array.isArray(history.items)) {
        throw new Error("Projection history shape validation failed");
      }

      return history;
    },
    async recordEvent(event) {
      if (!fetchImpl) return { status: "skipped", reason: "fetch unavailable" };

      const response = await fetchImpl(eventsUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event)
      });

      if (!response.ok) {
        throw new Error(`Operator event write failed: ${response.status}`);
      }

      return response.json();
    },
    async recordProviderHealth(input) {
      if (!fetchImpl) return { status: "skipped", reason: "fetch unavailable" };

      const response = await fetchImpl(providerHealthUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input)
      });

      if (!response.ok) {
        throw new Error(`Provider health write failed: ${response.status}`);
      }

      return response.json();
    },
    async recordReviewerShardResult(input) {
      if (!fetchImpl) return { status: "skipped", reason: "fetch unavailable" };

      const response = await fetchImpl(shardResultUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input)
      });

      if (!response.ok) {
        throw new Error(`Reviewer shard result write failed: ${response.status}`);
      }

      return response.json();
    },
    async createSchedulerDispatchPlan(input = {}) {
      if (!fetchImpl) return { status: "skipped", reason: "fetch unavailable" };

      const response = await fetchImpl(schedulerDispatchPlanUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input)
      });

      if (!response.ok) {
        throw new Error(`Scheduler dispatch plan create failed: ${response.status}`);
      }

      return response.json();
    },
    async runSchedulerDispatch(input = {}) {
      if (!fetchImpl) return { status: "skipped", reason: "fetch unavailable" };

      const response = await fetchImpl(schedulerDispatchUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input)
      });

      if (!response.ok) {
        throw new Error(`Scheduler dispatch failed: ${response.status}`);
      }

      return response.json();
    },
    async recordSchedulerDispatchRun(input) {
      if (!fetchImpl) return { status: "skipped", reason: "fetch unavailable" };

      const response = await fetchImpl(schedulerDispatchRunUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input)
      });

      if (!response.ok) {
        throw new Error(`Scheduler dispatch run write failed: ${response.status}`);
      }

      return response.json();
    }
  };
}

export { DEFAULT_HISTORY_URL, DEFAULT_PROJECTION_URL, historyUrlFromLocation, isSafeProjectionUrl, projectionUrlFromLocation, validateProjectionShape };
