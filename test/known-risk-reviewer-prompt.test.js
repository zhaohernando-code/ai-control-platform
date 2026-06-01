import assert from "node:assert/strict";
import test from "node:test";

import { reviewerPromptForRisk } from "../tools/known-risk-reviewer-prompt.mjs";

function ledger() {
  return {
    version: "known-risk-ledger.v1",
    risks: [{
      id: "risk-test-reviewer",
      title: "Reviewer prompt risk",
      source: "unit-test",
      status: "fixed",
      severity: "high",
      scope: ["tools/example.mjs"],
      owned_files: ["tools/example.mjs"],
      acceptance_gates: ["node --test test/example.test.js"],
      evidence: [{ type: "test", summary: "targeted tests passed" }]
    }]
  };
}

test("reviewer prompt is read-only and bound to a single risk", () => {
  const prompt = reviewerPromptForRisk(ledger(), "risk-test-reviewer", {
    changedFiles: ["tools/example.mjs"],
    diffSummary: "Split route handler from server entrypoint."
  });

  assert.match(prompt, /read-only reviewer/);
  assert.match(prompt, /Do not edit files/);
  assert.match(prompt, /risk-test-reviewer/);
  assert.match(prompt, /docs\/governance\/ai-reviewer-verdict.schema.json/);
  assert.match(prompt, /tools\/example\.mjs/);
  assert.match(prompt, /verdict inconclusive/);
});

test("reviewer prompt rejects unknown risk ids", () => {
  assert.throws(
    () => reviewerPromptForRisk(ledger(), "risk-missing"),
    /risk not found: risk-missing/
  );
});
