const DEFAULT_PROJECTION_URL = "../../docs/examples/current-session-workbench-projection.json";

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
  const fetchImpl = options.fetch || globalThis.fetch;

  return {
    url,
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
    }
  };
}

export { DEFAULT_PROJECTION_URL, isSafeProjectionUrl, projectionUrlFromLocation, validateProjectionShape };
