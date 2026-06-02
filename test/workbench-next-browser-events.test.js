import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  validateWorkbenchBrowserEventsArtifact
} from "../src/workflow/closeout-validation.js";

function read(path) {
  return readFileSync(path, "utf8");
}

test("Workbench keeps closeout browser-events on legacy gate and adds a separate Next writeback probe", () => {
  const pkg = JSON.parse(read("package.json"));
  const closeout = read("tools/check-closeout.mjs");
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
  assert.match(replacement?.replaces_requirement || "", /Next browser-events mounted runtime and API writeback probe/);
  assert.ok(legacyGateFiles.has("tools/check-workbench-browser-events.mjs"));
  assert.match(requiredBeforeDelete, /Browser-events gate migrated/);
  assert.match(requiredBeforeDelete, /Frontend-acceptance gate migrated/);
  assert.match(requiredBeforeDelete, /Scheduler dispatch writeback browser verification no longer depends/);
  assert.equal(inventory.status, "retirement_blocked");
  assert.equal(inventory.retirement.decision, "do_not_delete_in_p6_2");
});
