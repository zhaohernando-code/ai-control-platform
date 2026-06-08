import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

function read(path) {
  return readFileSync(path, "utf8");
}

function inventory() {
  return JSON.parse(read("docs/governance/legacy-static-workbench-inventory.json"));
}

function workbenchServerTestSources() {
  const shardPaths = Array.from({ length: 11 }, (_, index) => {
    return `test/workbench-server-shard-${String(index + 1).padStart(2, "0")}.test.js`;
  });
  return ["test/workbench-server.test.js", ...shardPaths]
    .map((path) => read(path))
    .join("\n");
}

test("legacy static Workbench inventory records deleted assets and manifest retirement", () => {
  const report = inventory();
  const manifest = JSON.parse(read(".largefile-manifest.json"));
  const fileStates = new Map(report.legacy_static_files.map((item) => [item.path, item]));

  assert.equal(report.version, "legacy-static-workbench-inventory.v1");
  assert.equal(report.status, "retired");
  assert.equal(report.retirement.decision, "deleted_in_p6_4");
  assert.deepEqual(report.retirement.blocked_p6_items, []);
  assert.deepEqual(report.retirement.required_evidence_before_delete, []);

  for (const path of [
    "apps/workbench/desktop.html",
    "apps/workbench/mobile.html",
    "apps/workbench/workbench.js",
    "apps/workbench/styles.css",
    "apps/workbench/projection-source.js",
    "apps/workbench/favicon.svg"
  ]) {
    assert.equal(existsSync(path), false, `${path} should be deleted from the current runtime tree`);
    assert.equal(fileStates.get(path)?.state, "deleted");
  }

  assert.equal(manifest.files["apps/workbench/workbench.js"], undefined);
  assert.equal(manifest.files["apps/workbench/styles.css"], undefined);
});

test("legacy static Workbench serving is retired and cannot be opt-in enabled", () => {
  const report = inventory();
  const server = read("tools/workbench-server.mjs");
  const serverCli = read("tools/workbench-server-cli.mjs");
  const staticRoutes = read("tools/workbench-static-routes.mjs");
  const serverTests = workbenchServerTestSources();
  const pkg = JSON.parse(read("package.json"));

  assert.equal(report.runtime_routes["tools/workbench-server.mjs"].default_static_page_behavior, "api_only_404");
  assert.deepEqual(report.runtime_routes["tools/workbench-server.mjs"].legacy_static_enabled_by, []);
  assert.deepEqual(report.runtime_routes["tools/workbench-server.mjs"].rejected_legacy_static_inputs, [
    "--serve-legacy-static",
    "AI_CONTROL_WORKBENCH_SERVE_LEGACY_STATIC=1",
    "server constructor legacy-static option"
  ]);
  assert.match(`${server}\n${serverCli}`, /LEGACY_STATIC_WORKBENCH_RETIRED/);
  assert.match(`${server}\n${serverCli}`, /legacy static Workbench serving has been retired/);
  assert.doesNotMatch(server, /serveLegacyStatic:\s*args\.includes/);
  assert.match(staticRoutes, /workbench pages are served by Next\.js/);
  assert.doesNotMatch(staticRoutes, /sendStaticFile|readFileSync|apps\/workbench\/desktop\.html/);
  assert.match(serverTests, /workbench server is API-only for page routes and rejects retired legacy static opt-in/);
  assert.equal(pkg.scripts["check:workbench:legacy-frontend-acceptance"], undefined);
});

test("current acceptance gates use Next runtime and legacy CLI is fail-closed", () => {
  const report = inventory();
  const browserEvents = read("tools/check-workbench-browser-events.mjs");
  const browserEventsRuntime = read("tools/workbench-browser-events-runtime.mjs");
  const nextBrowserEvents = read("tools/check-workbench-next-browser-events.mjs");
  const nextFrontendAcceptance = read("tools/check-workbench-next-frontend-acceptance.mjs");
  const frontendAcceptance = read("tools/check-workbench-frontend-acceptance.mjs");
  const frontendAcceptanceTests = read("test/frontend-acceptance.test.js");
  const frontendAcceptanceResourceTests = read("test/frontend-acceptance-resource-readiness.test.js");
  const schedulerWriteback = read("tools/check-scheduler-dispatch-writeback.mjs");
  const shellTests = read("test/workbench-shell.test.js");
  const gateFiles = new Set(report.acceptance_gate_dependencies.map((item) => item.file));

  assert.ok(gateFiles.has("tools/check-workbench-browser-events.mjs"));
  assert.ok(gateFiles.has("tools/check-workbench-next-frontend-acceptance.mjs"));
  assert.ok(gateFiles.has("tools/check-workbench-frontend-acceptance.mjs"));
  assert.ok(gateFiles.has("test/frontend-acceptance.test.js"));
  assert.ok(gateFiles.has("test/frontend-acceptance-resource-readiness.test.js"));
  assert.ok(gateFiles.has("tools/check-scheduler-dispatch-writeback.mjs"));
  assert.ok(gateFiles.has("test/workbench-shell.test.js"));

  assert.match(browserEvents, /nextjs_app_router/);
  assert.match(browserEvents, /legacy_interactions_replayed:\s*true/);
  assert.doesNotMatch(browserEvents, /WORKBENCH_MOUNT_PREFIX/);
  assert.match(browserEventsRuntime, /WORKBENCH_MOUNT_PREFIX/);
  assert.doesNotMatch(browserEvents, /serveLegacyStatic:\s*true/);
  assert.doesNotMatch(browserEvents, /page\.goto\([^)]*desktop\.html/);
  assert.doesNotMatch(browserEvents, /page\.goto\([^)]*mobile\.html/);
  assert.match(nextBrowserEvents, /nextjs_app_router/);
  assert.match(nextBrowserEvents, /partial_next_runtime_writeback_only/);
  assert.doesNotMatch(nextBrowserEvents, /serveLegacyStatic:\s*true/);
  assert.match(nextFrontendAcceptance, /nextjs_app_router/);
  assert.match(nextFrontendAcceptance, /validateFrontendAcceptanceRunArtifact/);
  assert.doesNotMatch(nextFrontendAcceptance, /serveLegacyStatic:\s*true/);
  assert.doesNotMatch(nextFrontendAcceptance, /desktop\.html/);
  assert.doesNotMatch(nextFrontendAcceptance, /mobile\.html/);
  assert.match(frontendAcceptance, /status:\s*"retired"/);
  assert.match(frontendAcceptance, /check-workbench-next-frontend-acceptance\.mjs/);
  assert.doesNotMatch(frontendAcceptance, /serveLegacyStatic:\s*true/);
  assert.doesNotMatch(frontendAcceptanceTests, /projects\/ai-control-platform\/apps\/workbench\/desktop\.html/);
  assert.doesNotMatch(frontendAcceptanceTests, /projects\/ai-control-platform\/apps\/workbench\/mobile\.html/);
  assert.match(frontendAcceptanceResourceTests, /mounted_safe_favicon_count/);
  assert.match(schedulerWriteback, /nextjs_app_router/);
  assert.match(schedulerWriteback, /WORKBENCH_MOUNT_PREFIX/);
  assert.doesNotMatch(schedulerWriteback, /serveLegacyStatic:\s*true/);
  assert.match(shellTests, /Next workbench shell owns the mounted desktop and mobile route surface/);
  assert.match(shellTests, /data-next-readout="scheduler_dispatch_status"/);
  assert.match(shellTests, /tools\/check-workbench-next-served-route\.mjs/);
});

test("legacy static Workbench retirement evidence is complete", () => {
  const report = inventory();
  const requiredEvidence = report.retirement.completed_evidence.join("\n");
  const nextGates = report.next_served_route_replacement_gates || [];

  assert.equal(report.retirement.decision, "deleted_in_p6_4");
  assert.ok(nextGates.some((item) => item.file === "tools/check-workbench-next-served-route.mjs" && item.status === "pass"));
  assert.ok(nextGates.some((item) => item.file === "tools/check-workbench-browser-events.mjs" && item.status === "pass"));
  assert.ok(nextGates.some((item) => item.file === "tools/check-workbench-next-frontend-acceptance.mjs" && item.status === "pass"));
  assert.ok(nextGates.some((item) => item.file === "tools/check-scheduler-dispatch-writeback.mjs" && item.status === "pass"));
  assert.ok(nextGates.some((item) => item.file === "test/workbench-shell.test.js" && item.status === "pass"));
  assert.match(requiredEvidence, /FRONTEND_REFACTOR_CONSTRAINTS\.md/);
  assert.match(requiredEvidence, /FRONTEND_MIGRATION_INVENTORY\.md/);
  assert.match(requiredEvidence, /legacy frontend-acceptance CLI retired/);
  assert.match(requiredEvidence, /legacy static serving rejected/);
});
