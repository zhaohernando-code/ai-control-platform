#!/usr/bin/env node
// Closeout gate: asserts the frontend's declared HTTP endpoints (WORKBENCH_API_ENDPOINTS in
// apps/workbench/lib/api/index.ts) match the routes tools/workbench-server.mjs actually serves.
// Pure source-text extraction — no backend mutation. See src/workflow/api-route-contract.js.
// Exit 0 = contract holds; exit 1 = drift; exit 2 = usage/read error.

import { readFileSync } from "node:fs";
import {
  extractBackendRoutes,
  extractFrontendEndpoints,
  validateApiRouteContract,
  BACKEND_ONLY_ALLOWLIST
} from "../src/workflow/api-route-contract.js";

const SERVER_PATH = "tools/workbench-server.mjs";
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
  backendRoutes: extractBackendRoutes(read(SERVER_PATH)),
  frontendEndpoints: extractFrontendEndpoints(read(FRONTEND_PATH)),
  allowlist: BACKEND_ONLY_ALLOWLIST
});

console.log(JSON.stringify(validation, null, 2));
if (validation.status !== "pass") process.exit(1);
