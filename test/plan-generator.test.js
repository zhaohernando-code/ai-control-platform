import assert from "node:assert/strict";
import test from "node:test";
import { generateRequirementPlan, generatePlanMock } from "../src/workflow/plan-generator.js";

// plan-generator.js had ZERO coverage (never loaded by any test). It is mostly a thin shell
// around a real `claude code generate-plan` subprocess (execSync), which cannot be honestly
// unit-tested here without the real CLI installed. These tests cover the behaviors that ARE
// honestly reachable: the provider-dispatch guard and the pure mock generator. The live
// claude-code subprocess path (generateWithClaudeCode) is intentionally NOT exercised — it
// requires the external CLI and belongs to integration, not unit, scope.

test("generateRequirementPlan: unsupported provider throws a clear error", async () => {
  await assert.rejects(
    () => generateRequirementPlan({ title: "x" }, { modelProvider: "nonexistent-provider" }),
    /Unsupported model provider: nonexistent-provider/
  );
});

test("generatePlanMock: returns a pass result with a structured 7-step plan", () => {
  const result = generatePlanMock({ title: "frontend migration" });
  assert.equal(result.status, "pass");
  assert.ok(Array.isArray(result.plan.steps));
  assert.equal(result.plan.steps.length, 7);
  // every step has the id/title/description shape the workflow consumes
  for (const step of result.plan.steps) {
    assert.match(step.id, /^step-\d+$/);
    assert.equal(typeof step.title, "string");
    assert.equal(typeof step.description, "string");
    assert.ok(step.title.length > 0);
  }
});

test("generatePlanMock: is deterministic and independent of input", () => {
  const a = generatePlanMock({ title: "one" });
  const b = generatePlanMock({ title: "two" });
  assert.deepEqual(a, b);
});
