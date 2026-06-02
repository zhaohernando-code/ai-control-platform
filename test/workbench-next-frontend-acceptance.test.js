import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  validateFrontendAcceptanceRunArtifact
} from "../src/workflow/frontend-acceptance.js";

function read(path) {
  return readFileSync(path, "utf8");
}

test("Next frontend-acceptance is wired as the primary closeout gate", () => {
  const pkg = JSON.parse(read("package.json"));
  const closeout = read("tools/check-closeout.mjs");
  const scan = read("tools/run-self-governance-scan.mjs");
  const gate = read("tools/check-workbench-next-frontend-acceptance.mjs");

  assert.equal(
    pkg.scripts["check:workbench:frontend-acceptance"],
    "node tools/run-with-node18.mjs tools/check-workbench-next-frontend-acceptance.mjs"
  );
  assert.equal(
    pkg.scripts["check:workbench:legacy-frontend-acceptance"],
    "node tools/run-with-node18.mjs tools/check-workbench-frontend-acceptance.mjs"
  );
  assert.match(closeout, /check-workbench-next-frontend-acceptance\.mjs/);
  assert.match(closeout, /report-large-files\.mjs", "--fail-on-issues"/);
  assert.doesNotMatch(closeout, /check-workbench-frontend-acceptance\.mjs", "--output"/);
  assert.match(scan, /check-workbench-next-frontend-acceptance\.mjs/);
  assert.match(gate, /nextjs_app_router/);
  assert.match(gate, /validateFrontendAcceptanceRunArtifact/);
  assert.match(gate, /requireDurableReleaseEvidence:\s*true/);
  assert.match(gate, /WORKBENCH_MOUNT_PREFIX/);
  assert.doesNotMatch(gate, /serveLegacyStatic:\s*true/);
  assert.doesNotMatch(gate, /desktop\.html/);
  assert.doesNotMatch(gate, /mobile\.html/);
});

test("Next frontend-acceptance evidence is durable and fully validated", () => {
  const evidence = JSON.parse(read("docs/examples/workbench-next-frontend-acceptance-evidence-20260603.json"));
  const validation = validateFrontendAcceptanceRunArtifact(evidence, {
    requireDurableReleaseEvidence: true
  });

  assert.equal(evidence.version, "frontend-acceptance-run.v1");
  assert.equal(evidence.status, "pass");
  assert.equal(evidence.route_family, "nextjs_app_router");
  assert.equal(evidence.legacy_static_shell_used, false);
  assert.equal(evidence.blocking_count, 0);
  assert.equal(validation.status, "pass");
  assert.ok(evidence.content_completion_results.every((result) => result.status === "pass"));
  assert.ok(evidence.project_management_semantic_results.every((result) => result.status === "pass"));
  assert.ok(evidence.navigation_results.every((result) => result.changed && !result.active_only));
  assert.equal(evidence.durable_evidence?.status, "pass");
  assert.match(evidence.durable_evidence?.artifact_id || "", /^frontend-acceptance-run-/);
  assert.match(evidence.durable_evidence?.event_id || "", /^event-frontend-acceptance-run-/);
  assert.ok(evidence.durable_evidence?.workflow_state);
});

test("legacy static inventory records frontend-acceptance migration without unblocking deletion", () => {
  const inventory = JSON.parse(read("docs/governance/legacy-static-workbench-inventory.json"));
  const legacyGateFiles = new Set(inventory.acceptance_gate_dependencies.map((item) => item.file));
  const replacement = inventory.next_served_route_replacement_gates.find((item) => item.file === "tools/check-workbench-next-frontend-acceptance.mjs");
  const requiredBeforeDelete = inventory.retirement.required_evidence_before_delete.join("\n");

  assert.equal(replacement?.status, "pass");
  assert.equal(replacement?.evidence, "docs/examples/workbench-next-frontend-acceptance-evidence-20260603.json");
  assert.match(replacement?.replaces_requirement || "", /Primary frontend-acceptance closeout gate migrated/);
  assert.ok(legacyGateFiles.has("tools/check-workbench-next-frontend-acceptance.mjs"));
  assert.ok(legacyGateFiles.has("tools/check-workbench-frontend-acceptance.mjs"));
  assert.doesNotMatch(requiredBeforeDelete, /Frontend-acceptance gate migrated/);
  assert.doesNotMatch(requiredBeforeDelete, /Browser-events gate migrated/);
  assert.match(requiredBeforeDelete, /Scheduler dispatch writeback browser verification no longer depends/);
  assert.equal(inventory.status, "retirement_blocked");
  assert.equal(inventory.retirement.decision, "do_not_delete_in_p6_3_partial");
});
