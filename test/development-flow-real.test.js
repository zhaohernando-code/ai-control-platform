import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  runContextProviderC2CGovernance,
  runDevelopmentFlowCliChain,
  runDevelopmentFlowRealAcceptance,
  writeDevelopmentFlowC2CGovernance
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
  assert.equal(artifact.c2c_governance.status, "pass");
  assert.equal(artifact.c2c_governance.context_provider_dispatch.same_chain_entrypoint, "runContextWorkPackages");
  assert.equal(artifact.c2c_governance.context_provider_dispatch.executor_provenance.timeout_seconds, 7200);
  assert.equal(artifact.c2c_governance.context_provider_dispatch.executor_provenance.idle_timeout_seconds, 1800);
  assert.ok(!artifact.c2c_governance.context_provider_dispatch.command.args.includes("--max-budget-usd"));
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

test("development flow provider C2C governance catches live 120s timeout override", () => {
  const dir = mkdtempSync(join(tmpdir(), "development-flow-provider-c2c-test-"));
  const liveScript = join(dir, "start-workbench-live.sh");
  writeFileSync(liveScript, "export AI_CONTROL_WORKBENCH_CONTEXT_PROVIDER_TIMEOUT_SECONDS=\"${AI_CONTROL_WORKBENCH_CONTEXT_PROVIDER_TIMEOUT_SECONDS:-120}\"\n");

  const governance = runContextProviderC2CGovernance({
    root_dir: dir,
    stateStore: governedAgentStateStore(),
    live_start_script_path: liveScript
  });

  assert.equal(governance.status, "fail");
  assert.equal(governance.checks.live_startup_timeout_policy, "fail");
  assert.ok(governance.issues.some((entry) => entry.code === "provider_c2c_live_timeout_override_120"));
});

test("development flow low-cost closeout mode runs provider C2C without dual CLI model calls", () => {
  const dir = mkdtempSync(join(tmpdir(), "development-flow-provider-c2c-write-test-"));
  const outputPath = join(dir, "provider-c2c.json");
  const result = writeDevelopmentFlowC2CGovernance({
    root_dir: dir,
    output_path: outputPath,
    stateStore: governedAgentStateStore()
  });

  assert.equal(result.status, "pass");
  assert.equal(result.artifact.status, "pass");
  assert.equal(result.artifact.checks.context_provider_dispatch_chain, "pass");
  assert.equal(result.artifact.context_provider_dispatch.executor_provenance.command_runner_kind, "external_provider_command_runner");
});
