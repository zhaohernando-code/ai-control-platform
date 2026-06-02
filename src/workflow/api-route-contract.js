// API route contract (門禁治理 phase 3): keeps the frontend's declared HTTP endpoint list
// (apps/workbench/lib/api/index.ts -> WORKBENCH_API_ENDPOINTS) in lockstep with the routes the
// backend Workbench route modules actually serve. Drift here is the classic agent-dev
// failure: an upstream route is added/renamed/removed and the consumer silently breaks because
// nothing asserts the two sides agree. This module is the executable contract.
//
// Design: ZERO backend mutation. We extract both sides from source text (the backend routing
// lives across the server entrypoint and extracted route handlers whose handlers are closures
// over server state — refactoring them into a route table is exactly the regression-prone churn
// we are trying to avoid). Source-text extraction is guarded: if either extractor finds nothing, that is a
// FAILURE (the source style changed -> fix the extractor), never a silent pass.
//
// Validator shape mirrors the rest of the codebase: { status: "pass"|"fail",
// issues: [{code, message, path}] }, like src/workflow/workbench-projection-schema.js.

function issue(code, message, path) {
  return { code, message, path };
}

// Backend-only routes that are intentionally NOT called from the browser UI. Each entry must
// cite why it is server-only so the allowlist stays auditable and cannot silently grow to mask
// real drift (test T4 locks this).
//   - POST /api/workbench/governance-audit-skill-trial: ingested by the closeout tool
//     tools/run-governance-audit-skill-trial.mjs via check-closeout.mjs --record-workbench-url;
//     zero references under apps/. It records a governance-audit artifact, not a UI action.
export const BACKEND_ONLY_ALLOWLIST = Object.freeze([
  "POST /api/workbench/governance-audit-skill-trial"
]);

// Parametrized (:id) routes the backend serves via url.pathname.match(...). The frontend calls
// these from apps/workbench/lib/api/agents.ts with interpolated ids, but does NOT enumerate them
// in WORKBENCH_API_ENDPOINTS (which only lists static paths). They are real contract members, so
// we credit both sides with them rather than forcing template-literal paths into the static list.
// Keyed by the exact regex source in the backend route modules so a new/removed dynamic route is a
// deliberate edit here, not a silent gap.
export const PARAMETRIZED_ROUTES = Object.freeze([
  { method: "POST", path: "/api/workbench/agents/:id/health-check", source: "/^\\/api\\/workbench\\/agents\\/([^/]+)\\/health-check$/" },
  { method: "DELETE", path: "/api/workbench/agent-keys/:id", source: "/^\\/api\\/workbench\\/agent-keys\\/([^/]+)$/" },
  { method: "POST", path: "/api/workbench/agent-keys/:id/health-check", source: "/^\\/api\\/workbench\\/agent-keys\\/([^/]+)\\/health-check$/" },
  { method: "PUT", path: "/api/workbench/agents/:id/roles", source: "/^\\/api\\/workbench\\/agents\\/([^/]+)\\/roles$/" }
]);

const STATIC_ROUTE_RE = /url\.pathname === "(\/api\/workbench\/[^"]+)"(?:\s*&&\s*req\.method === "([A-Z]+)")?/g;
// Each dynamic route's presence is detected by its exact regex source appearing in the file,
// then attributed the method recorded above (the method guard sits on the following `if`).
const DYNAMIC_ROUTE_SOURCES = PARAMETRIZED_ROUTES.map((route) => ({
  ...route,
  // The regex literal as it appears in source, e.g. /^\/api\/workbench\/agents\/([^/]+)\/health-check$/
  literal: route.source
}));

// Extract the routes the backend actually serves from backend route module source text.
// Returns { static: [{method, path}], dynamic: [{method, path}] }.
export function extractBackendRoutes(serverSource) {
  const source = Array.isArray(serverSource)
    ? serverSource.map((item) => String(item || "")).join("\n")
    : String(serverSource || "");
  const staticRoutes = [];
  const seen = new Set();
  let match;
  STATIC_ROUTE_RE.lastIndex = 0;
  while ((match = STATIC_ROUTE_RE.exec(source))) {
    const path = match[1];
    // Routes written without an explicit `&& req.method === "X"` accept GET in practice
    // (e.g. /api/workbench/projection, /api/workbench/projections). Normalize to GET.
    const method = match[2] || "GET";
    const key = `${method} ${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    staticRoutes.push({ method, path });
  }

  const dynamic = [];
  for (const route of DYNAMIC_ROUTE_SOURCES) {
    if (source.includes(route.literal)) {
      dynamic.push({ method: route.method, path: route.path });
    }
  }

  return { static: staticRoutes, dynamic };
}

// Extract the frontend's declared endpoints from apps/workbench/lib/api/index.ts source text.
// Returns [{method, path}].
export function extractFrontendEndpoints(tsSource) {
  const source = String(tsSource || "");
  // Scope to the WORKBENCH_API_ENDPOINTS array literal so we never pick up stray strings.
  const start = source.indexOf("WORKBENCH_API_ENDPOINTS");
  const endpoints = [];
  if (start === -1) return endpoints;
  const open = source.indexOf("[", start);
  const close = source.indexOf("];", open);
  if (open === -1 || close === -1) return endpoints;
  const region = source.slice(open, close);
  const entryRe = /method:\s*"(GET|POST|PUT|DELETE)"[\s\S]*?path:\s*"([^"]+)"/g;
  let match;
  while ((match = entryRe.exec(region))) {
    endpoints.push({ method: match[1], path: match[2] });
  }
  return endpoints;
}

function toKeySet(routes) {
  return new Set(routes.map((r) => `${r.method} ${r.path}`));
}

// Compare the two sides and return the standard { status, issues } validation result.
export function validateApiRouteContract({ backendRoutes, frontendEndpoints, allowlist = BACKEND_ONLY_ALLOWLIST } = {}) {
  const issues = [];

  const staticRoutes = backendRoutes?.static || [];
  const dynamicRoutes = backendRoutes?.dynamic || [];

  // Empty-extraction guards: a parser that silently returns nothing must FAIL, not pass.
  if (staticRoutes.length === 0) {
    issues.push(issue("backend_extraction_empty", "extracted zero backend static routes — workbench-server routing style likely changed; fix the extractor", "tools/workbench-server.mjs"));
  }
  if (!Array.isArray(frontendEndpoints) || frontendEndpoints.length === 0) {
    issues.push(issue("frontend_extraction_empty", "extracted zero frontend endpoints — WORKBENCH_API_ENDPOINTS shape likely changed; fix the extractor", "apps/workbench/lib/api/index.ts"));
  }
  if (issues.length) {
    return { status: "fail", issues };
  }

  const allowSet = new Set(allowlist);
  const parametrizedSet = toKeySet(PARAMETRIZED_ROUTES);

  // Backend set = static + dynamic, minus the intentional backend-only allowlist.
  const backendSet = new Set([...toKeySet(staticRoutes), ...toKeySet(dynamicRoutes)]);
  for (const key of allowSet) backendSet.delete(key);

  // Frontend set = declared static endpoints + the parametrized routes it genuinely calls.
  const frontendSet = new Set([...toKeySet(frontendEndpoints), ...parametrizedSet]);

  for (const key of backendSet) {
    if (!frontendSet.has(key)) {
      issues.push(issue("backend_only_route", `backend serves ${key} but the frontend does not declare or call it (add to WORKBENCH_API_ENDPOINTS, or to BACKEND_ONLY_ALLOWLIST with a reason)`, key));
    }
  }
  for (const key of frontendSet) {
    if (!backendSet.has(key) && !parametrizedSet.has(key)) {
      issues.push(issue("frontend_only_route", `frontend declares ${key} but the backend serves no such route`, key));
    }
  }

  return { status: issues.length ? "fail" : "pass", issues };
}

export function assertApiRouteContract(input) {
  const validation = validateApiRouteContract(input);
  if (validation.status !== "pass") {
    const error = new Error("api route contract validation failed");
    error.code = "API_ROUTE_CONTRACT_INVALID";
    error.validation = validation;
    throw error;
  }
  return validation;
}
