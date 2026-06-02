import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  validateWorkbenchBrowserEventsArtifact
} from "../src/workflow/closeout-validation.js";

function read(path) {
  return readFileSync(path, "utf8");
}

test("Workbench browser-events closeout runs on Next and keeps a separate writeback probe", () => {
  const pkg = JSON.parse(read("package.json"));
  const closeout = read("tools/check-closeout.mjs");
  const closeoutGate = read("tools/check-workbench-browser-events.mjs");
  const nextGate = read("tools/check-workbench-next-browser-events.mjs");

  assert.equal(
    pkg.scripts["check:workbench:browser-events"],
    "node tools/run-with-node18.mjs tools/check-workbench-browser-events.mjs"
  );
  assert.equal(
    pkg.scripts["check:workbench:next-browser-events"],
    "node tools/run-with-node18.mjs tools/check-workbench-next-browser-events.mjs"
  );
  assert.match(closeout, /check-workbench-browser-events\.mjs/);
  assert.doesNotMatch(closeout, /check-workbench-next-browser-events\.mjs/);
  assert.match(closeoutGate, /nextjs_app_router/);
  assert.match(closeoutGate, /legacy_interactions_replayed:\s*true/);
  assert.match(closeoutGate, /agent_lifecycle_pool_cleanup_click/);
  assert.match(closeoutGate, /agent_lifecycle_pool_cleanup_loop_click/);
  assert.doesNotMatch(closeoutGate, /serveLegacyStatic:\s*true/);
  assert.doesNotMatch(closeoutGate, /page\.goto\([^)]*desktop\.html/);
  assert.doesNotMatch(closeoutGate, /page\.goto\([^)]*mobile\.html/);
  assert.match(nextGate, /workbench-browser-events-run\.v1/);
  assert.match(nextGate, /nextjs_app_router/);
  assert.match(nextGate, /partial_next_runtime_writeback_only/);
  assert.match(nextGate, /legacy_interactions_replayed: false/);
  assert.doesNotMatch(nextGate, /next_app_router_browser_events_equivalence/);
  assert.match(nextGate, /workbench-browser-events-run/);
  assert.match(nextGate, /workbench-browser-events-run\?id=current-session/);
  assert.match(nextGate, /next_app_router_browser_events_writeback/);
  assert.doesNotMatch(nextGate, /agent_lifecycle_pool_cleanup_click/);
  assert.doesNotMatch(nextGate, /agent_lifecycle_pool_cleanup_loop_click/);
  assert.doesNotMatch(nextGate, /serveLegacyStatic:\s*true/);
  assert.doesNotMatch(nextGate, /page\.goto\([^)]*desktop\.html/);
  assert.doesNotMatch(nextGate, /page\.goto\([^)]*mobile\.html/);
});

test("full browser-events evidence now validates against the closeout artifact validator", () => {
  const evidencePath = "docs/examples/workbench-browser-events-evidence-20260603-next-full.json";
  const evidence = JSON.parse(read(evidencePath));

  assert.equal(evidence.version, "workbench-browser-events-run.v1");
  assert.equal(evidence.status, "pass");
  assert.equal(evidence.route_family, "nextjs_app_router");
  assert.equal(evidence.legacy_interactions_replayed, true);
  assert.equal(evidence.legacy_static_shell_used, false);
  assert.equal(evidence.scenario_count, 15);
  assert.ok(evidence.scenarios.some((scenario) => scenario.scenario === "agent_lifecycle_pool_cleanup_click"));
  assert.ok(evidence.scenarios.some((scenario) => scenario.scenario === "agent_lifecycle_pool_cleanup_loop_click"));
  assert.doesNotThrow(() => validateWorkbenchBrowserEventsArtifact(evidencePath));
});

test("Next browser-events evidence records only mounted runtime and API writeback coverage", () => {
  const evidencePath = "docs/examples/workbench-next-browser-events-evidence-20260603.json";
  const evidence = JSON.parse(read(evidencePath));

  assert.equal(evidence.version, "workbench-browser-events-run.v1");
  assert.equal(evidence.status, "pass");
  assert.equal(evidence.route_family, "nextjs_app_router");
  assert.equal(evidence.closeout_coverage, "partial_next_runtime_writeback_only");
  assert.equal(evidence.legacy_interactions_replayed, false);
  assert.equal(evidence.legacy_static_shell_used, false);
  assert.equal(evidence.scenario_count, evidence.scenarios.length);
  assert.equal(evidence.next_runtime_evidence.desktop.legacy_data_bind_count, 0);
  assert.equal(evidence.next_runtime_evidence.mobile.legacy_data_bind_count, 0);
  assert.ok(evidence.scenarios.some((scenario) => scenario.scenario === "next_app_router_browser_events_writeback"));
  assert.ok(!evidence.scenarios.some((scenario) => scenario.scenario === "agent_lifecycle_pool_cleanup_click"));
  assert.throws(
    () => validateWorkbenchBrowserEventsArtifact(evidencePath),
    /lifecycle heartbeat\/timeout readout evidence/
  );
});

test("legacy static inventory records Next browser-events probe while keeping full migration blocked", () => {
  const inventory = JSON.parse(read("docs/governance/legacy-static-workbench-inventory.json"));
  const legacyGateFiles = new Set(inventory.acceptance_gate_dependencies.map((item) => item.file));
  const replacement = inventory.next_served_route_replacement_gates.find((item) => item.file === "tools/check-workbench-next-browser-events.mjs");
  const requiredBeforeDelete = inventory.retirement.required_evidence_before_delete.join("\n");

  assert.equal(replacement?.status, "pass");
  assert.equal(replacement?.evidence, "docs/examples/workbench-next-browser-events-evidence-20260603.json");
  const fullReplacement = inventory.next_served_route_replacement_gates.find((item) => item.file === "tools/check-workbench-browser-events.mjs");

  assert.match(replacement?.replaces_requirement || "", /Next browser-events mounted runtime and API writeback probe/);
  assert.equal(fullReplacement?.status, "pass");
  assert.equal(fullReplacement?.evidence, "docs/examples/workbench-browser-events-evidence-20260603-next-full.json");
  assert.match(fullReplacement?.replaces_requirement || "", /Full browser-events closeout replay migrated/);
  assert.ok(legacyGateFiles.has("tools/check-workbench-browser-events.mjs"));
  assert.ok(legacyGateFiles.has("tools/check-workbench-next-frontend-acceptance.mjs"));
  assert.doesNotMatch(requiredBeforeDelete, /Browser-events gate migrated/);
  assert.doesNotMatch(requiredBeforeDelete, /Frontend-acceptance gate migrated/);
  assert.match(requiredBeforeDelete, /Scheduler dispatch writeback browser verification no longer depends/);
  assert.equal(inventory.status, "retirement_blocked");
  assert.equal(inventory.retirement.decision, "do_not_delete_in_p6_3_partial");
});
