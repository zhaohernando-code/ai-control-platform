import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(path) {
  return readFileSync(path, "utf8");
}

function inventory() {
  return JSON.parse(read("docs/governance/legacy-static-workbench-inventory.json"));
}

function inventoryFile(path) {
  return inventory().legacy_static_files.find((item) => item.path === path);
}

test("legacy static workbench inventory matches current asset dependency graph", () => {
  const report = inventory();
  const desktop = read("apps/workbench/desktop.html");
  const mobile = read("apps/workbench/mobile.html");
  const workbenchScript = read("apps/workbench/workbench.js");

  assert.equal(report.version, "legacy-static-workbench-inventory.v1");
  assert.equal(report.status, "retirement_blocked");
  assert.equal(report.retirement.decision, "do_not_delete_in_p6_3_partial");
  assert.ok(report.retirement.blocked_p6_items.includes("LFG-P6.3"));
  assert.ok(report.retirement.blocked_p6_items.includes("LFG-P6.4"));

  for (const path of [
    "apps/workbench/desktop.html",
    "apps/workbench/mobile.html",
    "apps/workbench/workbench.js",
    "apps/workbench/styles.css",
    "apps/workbench/projection-source.js",
    "apps/workbench/favicon.svg"
  ]) {
    assert.ok(inventoryFile(path), `${path} should be inventoried`);
  }

  assert.match(desktop, /<link rel="stylesheet" href="\.\/styles\.css" \/>/);
  assert.match(desktop, /<script type="module" src="\.\/workbench\.js"><\/script>/);
  assert.match(mobile, /<link rel="stylesheet" href="\.\/styles\.css" \/>/);
  assert.match(mobile, /<script type="module" src="\.\/workbench\.js"><\/script>/);
  assert.match(workbenchScript, /import \{ createProjectionSource \} from "\.\/projection-source\.js"/);

  assert.deepEqual(inventoryFile("apps/workbench/workbench.js").depends_on, [
    "apps/workbench/projection-source.js"
  ]);
  assert.equal(inventoryFile("apps/workbench/workbench.js").manifest_large_file_status, "planned_refactor");
  assert.equal(inventoryFile("apps/workbench/styles.css").manifest_large_file_status, "planned_refactor");
});

test("legacy static workbench inventory records server route posture and opt-in consumers", () => {
  const report = inventory();
  const server = read("tools/workbench-server.mjs");
  const staticRoutes = read("tools/workbench-static-routes.mjs");
  const serverTests = read("test/workbench-server.test.js");

  assert.equal(report.runtime_routes["tools/workbench-server.mjs"].default_static_page_behavior, "api_only_404");
  assert.ok(report.runtime_routes["tools/workbench-server.mjs"].legacy_static_enabled_by.includes("--serve-legacy-static"));
  assert.ok(report.runtime_routes["tools/workbench-server.mjs"].legacy_static_enabled_by.includes("AI_CONTROL_WORKBENCH_SERVE_LEGACY_STATIC=1"));
  assert.match(server, /--serve-legacy-static/);
  assert.match(server, /AI_CONTROL_WORKBENCH_SERVE_LEGACY_STATIC/);
  assert.match(server, /serveLegacyStatic:\s*args\.includes\("--serve-legacy-static"\)/);
  assert.match(staticRoutes, /workbench pages are served by Next\.js/);
  assert.match(staticRoutes, /apps\/workbench\/desktop\.html/);
  assert.match(serverTests, /workbench server is API-only by default for page routes/);
  assert.match(serverTests, /workbench server can serve legacy static shell only when explicitly enabled/);
});

test("legacy static workbench inventory records current acceptance-gate dependencies", () => {
  const report = inventory();
  const browserEvents = read("tools/check-workbench-browser-events.mjs");
  const nextBrowserEvents = read("tools/check-workbench-next-browser-events.mjs");
  const nextFrontendAcceptance = read("tools/check-workbench-next-frontend-acceptance.mjs");
  const frontendAcceptance = read("tools/check-workbench-frontend-acceptance.mjs");
  const frontendAcceptanceTests = read("test/frontend-acceptance.test.js");
  const schedulerWriteback = read("tools/check-scheduler-dispatch-writeback.mjs");
  const shellTests = read("test/workbench-shell.test.js");
  const gateFiles = new Set(report.acceptance_gate_dependencies.map((item) => item.file));

  assert.ok(gateFiles.has("tools/check-workbench-browser-events.mjs"));
  assert.ok(gateFiles.has("tools/check-workbench-next-frontend-acceptance.mjs"));
  assert.ok(gateFiles.has("tools/check-workbench-frontend-acceptance.mjs"));
  assert.ok(gateFiles.has("test/frontend-acceptance.test.js"));
  assert.ok(gateFiles.has("tools/check-scheduler-dispatch-writeback.mjs"));
  assert.ok(gateFiles.has("test/workbench-shell.test.js"));

  assert.match(browserEvents, /nextjs_app_router/);
  assert.match(browserEvents, /legacy_interactions_replayed:\s*true/);
  assert.match(browserEvents, /WORKBENCH_MOUNT_PREFIX/);
  assert.doesNotMatch(browserEvents, /serveLegacyStatic:\s*true/);
  assert.doesNotMatch(browserEvents, /page\.goto\([^)]*desktop\.html/);
  assert.doesNotMatch(browserEvents, /page\.goto\([^)]*mobile\.html/);
  assert.match(nextBrowserEvents, /nextjs_app_router/);
  assert.match(nextBrowserEvents, /partial_next_runtime_writeback_only/);
  assert.doesNotMatch(nextBrowserEvents, /next_app_router_browser_events_equivalence/);
  assert.doesNotMatch(nextBrowserEvents, /serveLegacyStatic:\s*true/);
  assert.doesNotMatch(nextBrowserEvents, /page\.goto\([^)]*desktop\.html/);
  assert.doesNotMatch(nextBrowserEvents, /page\.goto\([^)]*mobile\.html/);
  assert.match(nextFrontendAcceptance, /nextjs_app_router/);
  assert.match(nextFrontendAcceptance, /validateFrontendAcceptanceRunArtifact/);
  assert.doesNotMatch(nextFrontendAcceptance, /serveLegacyStatic:\s*true/);
  assert.doesNotMatch(nextFrontendAcceptance, /desktop\.html/);
  assert.doesNotMatch(nextFrontendAcceptance, /mobile\.html/);
  assert.match(frontendAcceptance, /serveLegacyStatic:\s*true/);
  assert.match(frontendAcceptance, /desktop\.html/);
  assert.match(frontendAcceptance, /mobile\.html/);
  assert.match(frontendAcceptanceTests, /apps\/workbench\/desktop\.html/);
  assert.match(frontendAcceptanceTests, /apps\/workbench\/mobile\.html/);
  assert.match(frontendAcceptanceTests, /mounted_safe_favicon_count/);
  assert.match(schedulerWriteback, /nextjs_app_router/);
  assert.match(schedulerWriteback, /WORKBENCH_MOUNT_PREFIX/);
  assert.doesNotMatch(schedulerWriteback, /serveLegacyStatic:\s*true/);
  assert.doesNotMatch(schedulerWriteback, /page\.goto\([^)]*desktop\.html/);
  assert.doesNotMatch(schedulerWriteback, /page\.goto\([^)]*mobile\.html/);
  assert.match(shellTests, /apps\/workbench\/workbench\.js/);
  assert.match(shellTests, /apps\/workbench\/styles\.css/);
});

test("legacy static workbench retirement remains blocked until Next served-route gates replace fallback gates", () => {
  const report = inventory();
  const requiredEvidence = report.retirement.required_evidence_before_delete.join("\n");
  const nextGates = report.next_served_route_replacement_gates || [];
  const nextGate = nextGates.find((item) => item.file === "tools/check-workbench-next-served-route.mjs");

  assert.equal(report.retirement.decision, "do_not_delete_in_p6_3_partial");
  assert.equal(nextGate?.status, "pass");
  assert.equal(nextGate?.evidence, "docs/examples/workbench-next-served-route-evidence-20260602.json");
  assert.match(nextGate?.replaces_requirement || "", /Next\.js Workbench served route verified/);
  assert.ok(nextGates.some((item) => item.file === "tools/check-workbench-next-browser-events.mjs" && item.status === "pass"));
  assert.ok(nextGates.some((item) => item.file === "tools/check-workbench-next-frontend-acceptance.mjs" && item.status === "pass"));
  assert.doesNotMatch(requiredEvidence, /Next\.js Workbench served route verified/);
  assert.doesNotMatch(requiredEvidence, /Browser-events gate migrated/);
  assert.doesNotMatch(requiredEvidence, /Frontend-acceptance gate migrated/);
  assert.doesNotMatch(requiredEvidence, /Scheduler dispatch writeback browser verification no longer depends/);
  assert.match(requiredEvidence, /FRONTEND_REFACTOR_CONSTRAINTS\.md/);
  assert.match(requiredEvidence, /FRONTEND_MIGRATION_INVENTORY\.md/);
  assert.match(requiredEvidence, /test\/workbench-shell\.test\.js/);
});
