import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  extractBackendRoutes,
  extractFrontendEndpoints,
  validateApiRouteContract,
  BACKEND_ONLY_ALLOWLIST,
  PARAMETRIZED_ROUTES
} from "../src/workflow/api-route-contract.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const read = (rel) => readFileSync(resolve(root, rel), "utf8");

const BACKEND_ROUTE_SOURCES = [
  "tools/workbench-server.mjs",
  "tools/workbench-agent-key-routes.mjs",
  "tools/workbench-basic-routes.mjs",
  "tools/workbench-requirement-routes.mjs",
  "tools/workbench-scheduler-dispatch-routes.mjs",
  "tools/workbench-scheduler-loop-routes.mjs"
];
const FRONTEND = "apps/workbench/lib/api/index.ts";
const readBackendRouteSources = () => BACKEND_ROUTE_SOURCES.map(read);

// T1 — the live contract: real backend routes and real frontend declarations must agree.
// This is the gate that turns red the moment someone adds/renames a route on one side only.
test("api route contract: frontend declarations match backend routes (live)", () => {
  const validation = validateApiRouteContract({
    backendRoutes: extractBackendRoutes(readBackendRouteSources()),
    frontendEndpoints: extractFrontendEndpoints(read(FRONTEND)),
    allowlist: BACKEND_ONLY_ALLOWLIST
  });
  assert.equal(validation.status, "pass", `drift detected:\n${JSON.stringify(validation.issues, null, 2)}`);
});

// T2 — extractor self-check: a parser that silently returns nothing must be caught HERE, so a
// future change to the routing/declaration style cannot make the contract vacuously pass.
test("api route contract: extractors find the expected real shapes (no silent empties)", () => {
  const backend = extractBackendRoutes(readBackendRouteSources());
  assert.ok(backend.static.length >= 28, `expected >=28 static backend routes, got ${backend.static.length}`);
  assert.equal(backend.dynamic.length, PARAMETRIZED_ROUTES.length, "all parametrized routes must be detected in server source");
  const frontend = extractFrontendEndpoints(read(FRONTEND));
  assert.ok(frontend.length >= 27, `expected >=27 frontend endpoints, got ${frontend.length}`);
});

// T3 — injected drift (pure synthetic strings, no real file touched): proves the gate actually
// catches both drift directions.
test("api route contract: a backend-only route (not allowlisted) fails as backend_only_route", () => {
  const backendRoutes = {
    static: [
      { method: "GET", path: "/api/workbench/projection" },
      { method: "POST", path: "/api/workbench/__phantom__" } // exists on backend only
    ],
    dynamic: []
  };
  const frontendEndpoints = [{ method: "GET", path: "/api/workbench/projection" }];
  const v = validateApiRouteContract({ backendRoutes, frontendEndpoints, allowlist: [] });
  assert.equal(v.status, "fail");
  const codes = v.issues.map((i) => i.code);
  assert.ok(codes.includes("backend_only_route"), "phantom backend route must be flagged");
  assert.ok(v.issues.some((i) => i.path === "POST /api/workbench/__phantom__"));
});

test("api route contract: a frontend-only route fails as frontend_only_route", () => {
  const backendRoutes = { static: [{ method: "GET", path: "/api/workbench/projection" }], dynamic: [] };
  const frontendEndpoints = [
    { method: "GET", path: "/api/workbench/projection" },
    { method: "POST", path: "/api/workbench/__ghost__" } // declared by frontend, no backend route
  ];
  const v = validateApiRouteContract({ backendRoutes, frontendEndpoints, allowlist: [] });
  assert.equal(v.status, "fail");
  assert.ok(v.issues.some((i) => i.code === "frontend_only_route" && i.path === "POST /api/workbench/__ghost__"));
});

// T2b — empty-extraction guard: zero routes is a failure, never a pass.
test("api route contract: empty extraction is a failure, not a vacuous pass", () => {
  const v1 = validateApiRouteContract({ backendRoutes: { static: [], dynamic: [] }, frontendEndpoints: [{ method: "GET", path: "/x" }] });
  assert.equal(v1.status, "fail");
  assert.ok(v1.issues.some((i) => i.code === "backend_extraction_empty"));

  const v2 = validateApiRouteContract({ backendRoutes: { static: [{ method: "GET", path: "/x" }], dynamic: [] }, frontendEndpoints: [] });
  assert.equal(v2.status, "fail");
  assert.ok(v2.issues.some((i) => i.code === "frontend_extraction_empty"));
});

// T4 — allowlist asymmetry is explicit and guarded: the intentional backend-only route passes
// only because it is allowlisted; removing it from the allowlist must surface it as drift. This
// stops the allowlist from quietly growing to mask future accidental backend-only routes.
test("api route contract: backend-only allowlist is load-bearing and audited", () => {
  const backendRoutes = extractBackendRoutes(readBackendRouteSources());
  const frontendEndpoints = extractFrontendEndpoints(read(FRONTEND));

  const withAllow = validateApiRouteContract({ backendRoutes, frontendEndpoints, allowlist: BACKEND_ONLY_ALLOWLIST });
  assert.equal(withAllow.status, "pass", "real contract passes with the documented allowlist");

  const withoutAllow = validateApiRouteContract({ backendRoutes, frontendEndpoints, allowlist: [] });
  assert.equal(withoutAllow.status, "fail", "removing the allowlist must expose the intentional backend-only route");
  assert.ok(
    withoutAllow.issues.some((i) => i.code === "backend_only_route" && i.path.includes("governance-audit-skill-trial")),
    "the allowlisted route is exactly governance-audit-skill-trial"
  );
});
