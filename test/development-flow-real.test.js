import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  runDevelopmentFlowRealAcceptance
} from "../src/workflow/development-flow-real.js";

function fakeRealCliRunner({ fixture_dir }) {
  writeFileSync(join(fixture_dir, "src", "math.js"), [
    "export function sum(a, b) {",
    "  return a + b;",
    "}",
    ""
  ].join("\n"));
  return {
    status: 0,
    stdout: JSON.stringify({
      status: "pass",
      changed_files: ["src/math.js"],
      test_results: [{ command: "node --test test/math.test.js", status: "pass" }],
      completion_evidence: { summary: "fake injected command runner completed the fixture" },
      self_evaluation: { aligned: true, skipped_steps: [] }
    }),
    stderr: ""
  };
}

test("development flow real harness validates both CLI chains with injected command runner", () => {
  const artifact = runDevelopmentFlowRealAcceptance({
    root_dir: mkdtempSync(join(tmpdir(), "development-flow-real-test-")),
    commandRunner: fakeRealCliRunner,
    timeout_ms: 10000
  });

  assert.equal(artifact.status, "pass");
  assert.equal(artifact.runs.codex_cli.status, "pass");
  assert.equal(artifact.runs.claude_cli.status, "pass");
  assert.equal(artifact.runs.codex_cli.model_provenance.runner, "codex");
  assert.equal(artifact.runs.claude_cli.model_provenance.runner, "claude");
  assert.ok(artifact.runs.codex_cli.diff_summary.changed_files.includes("src/math.js"));
  assert.ok(artifact.runs.claude_cli.diff_summary.changed_files.includes("src/math.js"));
});

test("development flow real harness records output contract failure from CLI chain", () => {
  const artifact = runDevelopmentFlowRealAcceptance({
    root_dir: mkdtempSync(join(tmpdir(), "development-flow-real-fail-test-")),
    commandRunner: () => ({ status: 0, stdout: "not json", stderr: "" }),
    timeout_ms: 10000
  });

  assert.equal(artifact.status, "fail");
  assert.equal(artifact.runs.codex_cli.status, "fail");
  assert.ok(artifact.runs.codex_cli.issues.some((entry) => entry.code === "codex_output_contract_failed"));
  assert.ok(artifact.evaluation.issues.some((entry) => entry.code === "output_contract_not_passed"));
});
