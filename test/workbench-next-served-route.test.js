import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(path) {
  return readFileSync(path, "utf8");
}

test("Next served-route gate is wired as a first-class Workbench check", () => {
  const pkg = JSON.parse(read("package.json"));
  const gate = read("tools/check-workbench-next-served-route.mjs");

  assert.equal(
    pkg.scripts["check:workbench:next-served-route"],
    "node tools/run-with-node18.mjs tools/check-workbench-next-served-route.mjs"
  );
  assert.match(gate, /workbench-next-served-route-check\.v1/);
  assert.match(gate, /WORKBENCH_MOUNT_PREFIX = "\/projects\/ai-control-platform"/);
  assert.match(gate, /route_family: "nextjs_app_router"/);
  assert.match(gate, /legacy_static_shell_allowed: false/);
  assert.match(gate, /next_route_legacy_static_shell_detected/);
  assert.match(gate, /\/projects\/ai-control-platform\/api\/workbench\/projection/);
  assert.match(gate, /\{ label: "requirements", path: "\/requirements" \}/);
  assert.match(gate, /\{ label: "runs", path: "\/runs" \}/);
  assert.doesNotMatch(gate, /serveLegacyStatic:\s*true/);
});

test("Next served-route evidence is durable and does not over-close legacy static retirement", () => {
  const inventory = JSON.parse(read("docs/governance/legacy-static-workbench-inventory.json"));
  const evidence = JSON.parse(read("docs/examples/workbench-next-served-route-evidence-20260602.json"));
  const gates = inventory.next_served_route_replacement_gates || [];
  const nextGate = gates.find((item) => item.file === "tools/check-workbench-next-served-route.mjs");

  assert.equal(evidence.version, "workbench-next-served-route-check.v1");
  assert.equal(evidence.status, "pass");
  assert.equal(evidence.route_family, "nextjs_app_router");
  assert.equal(evidence.legacy_static_shell_allowed, false);
  assert.equal(evidence.blocking_count, 0);
  assert.deepEqual(
    evidence.route_results.map((route) => route.path),
    ["/", "/requirements", "/projects", "/flow", "/agents", "/risks", "/governance", "/runs"]
  );
  assert.ok(evidence.route_results.every((route) => route.http_status === 200));
  assert.ok(evidence.route_results.every((route) => route.legacy_data_bind_count === 0));
  assert.equal(nextGate?.status, "pass");
  assert.equal(nextGate?.evidence, "docs/examples/workbench-next-served-route-evidence-20260602.json");
  assert.match(nextGate?.replaces_requirement || "", /Next\.js Workbench served route verified/);
  assert.ok(nextGate?.does_not_replace?.includes("tools/check-workbench-browser-events.mjs legacy operator-event interaction scenarios"));
  assert.equal(inventory.status, "retirement_blocked");
  assert.equal(inventory.retirement.decision, "do_not_delete_in_p6_2");
  assert.match(inventory.retirement.reason, /legacy assets remain acceptance-gate/);
  assert.doesNotMatch(inventory.retirement.required_evidence_before_delete.join("\n"), /Next\.js Workbench served route verified/);
});

test("public browser route gate is a Next route check, not a legacy static consumer", () => {
  const publicBrowserGate = read("tools/check-workbench-public-browser-route.mjs");

  assert.match(publicBrowserGate, /locator\("\.ant-layout"\)\.first\(\)\.waitFor/);
  assert.match(publicBrowserGate, /browser_desktop_shell_detected/);
  assert.match(publicBrowserGate, /mounted_next_script_count/);
  assert.doesNotMatch(publicBrowserGate, /desktop\.html/);
  assert.doesNotMatch(publicBrowserGate, /serveLegacyStatic:\s*true/);
});
