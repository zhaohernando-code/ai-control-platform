import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  runDevelopmentFlowCliChain,
  runDevelopmentFlowRealAcceptance
} from "../src/workflow/development-flow-real.js";

function governedAgentStateStore() {
  return {
    acquireAgentKeyForRole(role, options) {
      return {
        status: "acquired",
        key: {
          id: `test-key-${options.agent_id}`,
          secret: `test-secret-${options.agent_id}-${role}`,
          lock: { lock_owner: options.lock_owner }
        }
      };
    },
    releaseAgentKeyLock() {
      return { status: "released" };
    },
    listAgents() {
      return {
        agents: [
          {
            id: "codex-account",
            status: "success",
            account_login: true,
            account_health: { status: "success" }
          }
        ]
      };
    }
  };
}

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
    stateStore: governedAgentStateStore(),
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

test("development flow Claude chain defaults to project agent invocation profile", () => {
  let captured = null;
  const run = runDevelopmentFlowCliChain("claude_cli", {
    root_dir: mkdtempSync(join(tmpdir(), "development-flow-real-proxy-test-")),
    stateStore: governedAgentStateStore(),
    commandRunner: (command) => {
      captured = command;
      return fakeRealCliRunner(command);
    },
    timeout_ms: 10000
  });

  assert.equal(run.status, "pass");
  assert.equal(captured.command, "claude");
  assert.ok(captured.args.includes("--bare"));
  assert.ok(captured.args.includes("--model"));
  assert.ok(captured.args.includes("claude-sonnet-4-6"));
  assert.ok(captured.args.includes("--json-schema"));
});

test("development flow parses structured Claude JSON before fenced result text", () => {
  const run = runDevelopmentFlowCliChain("claude_cli", {
    root_dir: mkdtempSync(join(tmpdir(), "development-flow-real-structured-test-")),
    stateStore: governedAgentStateStore(),
    commandRunner: ({ fixture_dir }) => {
      writeFileSync(join(fixture_dir, "src", "math.js"), [
        "export function sum(a, b) {",
        "  return a + b;",
        "}",
        ""
      ].join("\n"));
      return {
        status: 0,
        stdout: JSON.stringify({
          type: "result",
          result: "```json\n{\"status\":\"pass\"}\n```",
          structured_output: {
            status: "pass",
            changed_files: ["src/math.js"],
            test_results: [{ command: "node --test test/math.test.js", status: "pass" }],
            completion_evidence: { summary: "structured output completed the fixture" },
            self_evaluation: { aligned: true, skipped_steps: [] }
          }
        }),
        stderr: ""
      };
    },
    timeout_ms: 10000
  });

  assert.equal(run.status, "pass");
  assert.equal(run.output_contract.status, "pass");
});

test("development flow real harness records output contract failure from CLI chain", () => {
  const artifact = runDevelopmentFlowRealAcceptance({
    root_dir: mkdtempSync(join(tmpdir(), "development-flow-real-fail-test-")),
    stateStore: governedAgentStateStore(),
    commandRunner: () => ({ status: 0, stdout: "not json", stderr: "" }),
    timeout_ms: 10000
  });

  assert.equal(artifact.status, "fail");
  assert.equal(artifact.runs.codex_cli.status, "fail");
  assert.ok(artifact.runs.codex_cli.issues.some((entry) => entry.code === "codex_output_contract_failed"));
  assert.ok(artifact.evaluation.issues.some((entry) => entry.code === "output_contract_not_passed"));
});
