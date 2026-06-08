import assert from "node:assert/strict";
import test from "node:test";

import { selectGovernanceGates } from "../tools/select-governance-gates.mjs";

function commandIds(plan) {
  return plan.commands.map((item) => item.id);
}

test("governance gate selector keeps docs-only changes at L0", () => {
  const plan = selectGovernanceGates(["docs/governance/GATED_CLOSEOUT_POLICY.md"]);

  assert.equal(plan.level, "L0");
  assert.equal(plan.full_closeout_required, false);
  assert.ok(!commandIds(plan).includes("npm-test"));
  assert.ok(!commandIds(plan).includes("check-closeout"));
  assert.ok(commandIds(plan).includes("diff-check"));
});

test("governance gate selector treats test-only changes as L1 targeted gates", () => {
  const plan = selectGovernanceGates(["test/frontend-acceptance.test.js"]);

  assert.equal(plan.level, "L1");
  assert.equal(plan.full_closeout_required, false);
  assert.ok(commandIds(plan).includes("test-affected"));
  assert.ok(commandIds(plan).includes("check-large-files"));
  assert.ok(!commandIds(plan).includes("check-closeout"));
});

test("governance gate selector treats generic tool helpers as L2", () => {
  const plan = selectGovernanceGates(["tools/workbench-live-route-http.mjs"]);

  assert.equal(plan.level, "L2");
  assert.ok(commandIds(plan).includes("node-check:tools/workbench-live-route-http.mjs"));
  assert.ok(commandIds(plan).includes("test-affected"));
  assert.ok(!commandIds(plan).includes("check-closeout"));
});

test("governance gate selector escalates workflow and server logic to L3", () => {
  for (const file of ["src/workflow/workbench-projection.js", "tools/workbench-server.mjs"]) {
    const plan = selectGovernanceGates([file]);

    assert.equal(plan.level, "L3", `${file} should be L3`);
    assert.ok(commandIds(plan).includes("test-affected"));
    assert.ok(commandIds(plan).includes("check-large-files"));
    assert.ok(!commandIds(plan).includes("check-closeout"));
  }
});

test("governance gate selector requires full closeout for L4 runtime and gate entrypoints", () => {
  for (const file of ["apps/workbench/app/page.tsx", "package.json", "tools/check-closeout.mjs"]) {
    const plan = selectGovernanceGates([file]);

    assert.equal(plan.level, "L4", `${file} should be L4`);
    assert.equal(plan.full_closeout_required, true);
    assert.ok(commandIds(plan).includes("npm-test"));
    assert.ok(commandIds(plan).includes("check-closeout"));
  }
});

test("governance gate selector escalates mixed changes to the highest risk level", () => {
  const plan = selectGovernanceGates([
    "docs/governance/GATED_CLOSEOUT_POLICY.md",
    "test/frontend-acceptance.test.js",
    "apps/workbench/app/page.tsx"
  ]);

  assert.equal(plan.level, "L4");
  assert.equal(plan.full_closeout_required, true);
});
