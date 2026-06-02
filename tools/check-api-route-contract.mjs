#!/usr/bin/env node
// Closeout gate: asserts the frontend's declared HTTP endpoints (WORKBENCH_API_ENDPOINTS in
// apps/workbench/lib/api/index.ts) match the routes Workbench backend route modules actually serve.
// Pure source-text extraction — no backend mutation. See src/workflow/api-route-contract.js.
// Exit 0 = contract holds; exit 1 = drift; exit 2 = usage/read error.

import { readFileSync } from "node:fs";
import {
  extractBackendRoutes,
  extractFrontendEndpoints,
  validateApiRouteContract,
  BACKEND_ONLY_ALLOWLIST
} from "../src/workflow/api-route-contract.js";

const BACKEND_ROUTE_SOURCE_PATHS = [
  "tools/workbench-server.mjs",
  "tools/workbench-agent-key-routes.mjs"
];
const FRONTEND_PATH = "apps/workbench/lib/api/index.ts";

function read(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    process.stderr.write(`✗ cannot read ${path}: ${error.message}\n`);
    process.exit(2);
  }
}

const validation = validateApiRouteContract({
  backendRoutes: extractBackendRoutes(BACKEND_ROUTE_SOURCE_PATHS.map(read)),
  frontendEndpoints: extractFrontendEndpoints(read(FRONTEND_PATH)),
  allowlist: BACKEND_ONLY_ALLOWLIST
});

console.log(JSON.stringify(validation, null, 2));
if (validation.status !== "pass") process.exit(1);
