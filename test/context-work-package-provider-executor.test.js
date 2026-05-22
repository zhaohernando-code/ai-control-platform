import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { VERIFIED_PROVIDER_MULTI_AGENT_PROFILE } from "../src/workflow/context-work-package-execution-adapter.js";
import {
  createClaudeDeepSeekContextWorkPackageProviderExecutor,
  createClaudeDeepSeekProviderCommand,
  parseProviderExecutorOutput
} from "../src/workflow/context-work-package-provider-executor.js";
import { runContextWorkPackages } from "../src/workflow/context-work-package-runner.js";

function workflowState() {
  const contextPack = {
    requirement_summary: "Wire a bounded provider executor behind verified provider multi-agent execution.",
    host: "platform_core",
    target_project_id: "ai-control-platform",
    non_goals: ["Do not modify managed business projects"],
    forbidden_actions: ["Do not bypass fixed development mode"],
    owned_files: [
      "src/workflow/context-work-package-provider-executor.js",
      "test/context-work-package-provider-executor.test.js"
    ],
    acceptance_gates: ["node --test test/context-work-package-provider-executor.test.js"],
    rollback_conditions: ["provider executor writes unverified completion"],
    subtasks: [
      {
        id: "provider-runtime",
        title: "Provider runtime",
        owned_files: ["src/workflow/context-work-package-provider-executor.js"],
        risk: "high",
        budget_tier: "high"
      },
      {
        id: "provider-tests",
        title: "Provider tests",
        owned_files: ["test/context-work-package-provider-executor.test.js"],
        depends_on: ["provider-runtime"]
      }
    ]
  };
  const workPackages = contextPack.subtasks.map((subtask) => ({
    ...subtask,
    status: "pending"
  }));

  return {
    manifest: {
      run_id: "run-provider-executor",
      cycle_id: "cycle-provider-executor",
      goal: "provider routed context work package execution",
      context_pack: contextPack,
      work_packages: workPackages,
      events: [],
      artifacts: [],
      gate_results: [],
      review_findings: [],
      recovery_attempts: []
    },
    artifact_ledger: {
      run_id: "run-provider-executor",
      cycle_id: "cycle-provider-executor",
      artifacts: []
    },
    task_dag: workPackages
  };
}

function providerPassJson(workPackageId = "provider-runtime") {
  return JSON.stringify({
    status: "pass",
    completion_evidence: {
      kind: "provider_execution",
      summary: "fake command runner produced a structured provider pass for unit coverage"
    },
    package_results: [
      {
        work_package_id: workPackageId,
        status: "pass",
        result: "pass",
        completion_evidence: {
          kind: "package_completion",
          summary: "package completion evidence from structured provider output"
        }
      }
    ]
  });
}

test("provider command records bounded audit fields", () => {
  const command = createClaudeDeepSeekProviderCommand({
    cwd: process.cwd(),
    prompt_file: "/tmp/provider-prompt.md",
    timeout_seconds: 45,
    model: "deepseek-v4-pro[1m]",
    tools: ["Read", "Edit"],
    effort: "high",
    max_budget_usd: "0.50"
  });

  assert.equal(command.command, "python3");
  assert.equal(command.timeout_seconds, 45);
  assert.equal(command.model, "deepseek-v4-pro[1m]");
  assert.equal(command.tools, "Read,Edit");
  assert.ok(command.args.includes("--prompt-file"));
  assert.ok(command.args.includes("/tmp/provider-prompt.md"));
  assert.ok(command.args.includes("--timeout-seconds"));
  assert.ok(command.args.includes("45"));
  assert.ok(command.args.includes("--max-budget-usd"));
  assert.ok(command.args.includes("0.50"));
});

test("provider output parser requires structured JSON object", () => {
  assert.deepEqual(parseProviderExecutorOutput(`noise\n\`\`\`json\n${providerPassJson()}\n\`\`\``), JSON.parse(providerPassJson()));
  assert.equal(parseProviderExecutorOutput("plain provider prose without json"), null);
  assert.equal(parseProviderExecutorOutput("[1,2,3]"), null);
});

test("fake command runner output is structured but cannot complete work packages", () => {
  const calls = [];
  const executor = createClaudeDeepSeekContextWorkPackageProviderExecutor({
    cwd: process.cwd(),
    timeout_seconds: 60,
    no_tools: true,
    command_runner_kind: "fake_test_command_runner",
    commandRunner: (command, args, options) => {
      calls.push({ command, args, options });
      return {
        status: 0,
        stdout: providerPassJson(),
        stderr: "fake_test_command_runner"
      };
    }
  });

  const result = runContextWorkPackages(workflowState(), {
    max_package_count: 1,
    execution_mode: "provider_model_routed",
    execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    created_at: "2026-05-22T06:00:00.000Z",
    provider_executor: executor
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.workflow_state, undefined);
  assert.equal(result.artifact, undefined);
  assert.equal(result.executor_provenance.executor_kind, "claude_deepseek_provider_executor");
  assert.equal(result.executor_provenance.external_calls, 1);
  assert.equal(result.executor_provenance.command_runner_kind, "fake_test_command_runner");
  assert.equal(result.package_results[0].status, "pass");
  assert.equal(result.package_results[0].allows_work_package_completion, false);
  assert.ok(result.issues.some((issue) => issue.code === "non_external_command_runner_provenance_not_allowed"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.timeout, 65000);
});

test("external provider command runner provenance can complete with structured evidence", () => {
  const executor = createClaudeDeepSeekContextWorkPackageProviderExecutor({
    cwd: process.cwd(),
    timeout_seconds: 60,
    no_tools: true,
    command_runner_kind: "external_provider_command_runner",
    commandRunner: () => ({
      status: 0,
      stdout: providerPassJson(),
      stderr: "external_provider_command_runner"
    })
  });

  const result = runContextWorkPackages(workflowState(), {
    max_package_count: 1,
    execution_mode: "provider_model_routed",
    execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    created_at: "2026-05-22T06:02:00.000Z",
    provider_executor: executor
  });

  assert.equal(result.status, "pass");
  assert.equal(result.executed_count, 1);
  assert.equal(result.workflow_state.manifest.work_packages.find((item) => item.id === "provider-runtime").status, "completed");
  assert.equal(result.artifact.metadata.execution_profile, VERIFIED_PROVIDER_MULTI_AGENT_PROFILE);
  assert.equal(result.artifact.metadata.executor_provenance.executor_kind, "claude_deepseek_provider_executor");
  assert.equal(result.artifact.metadata.executor_provenance.external_calls, 1);
  assert.equal(result.artifact.metadata.executor_provenance.command_runner_kind, "external_provider_command_runner");
  assert.equal(result.artifact.metadata.executor_provenance.no_tools, true);
  assert.equal(result.artifact.metadata.completion_authority.allows_work_package_completion, true);
});

test("provider executor fails closed on command failure, timeout, or non-structured output", () => {
  const cases = [
    {
      name: "command failure",
      runnerResult: { status: 2, stdout: "", stderr: "provider failed" },
      expectedFinding: "provider_executor_command_failed"
    },
    {
      name: "timeout",
      runnerResult: { status: 124, stdout: "", stderr: "CLAUDE_DEEPSEEK_TIMEOUT" },
      expectedFinding: "provider_executor_timeout"
    },
    {
      name: "unstructured success",
      runnerResult: { status: 0, stdout: "completed, trust me", stderr: "" },
      expectedFinding: "provider_executor_unstructured_output"
    }
  ];

  for (const item of cases) {
    const executor = createClaudeDeepSeekContextWorkPackageProviderExecutor({
      cwd: process.cwd(),
      timeout_seconds: 30,
      command_runner_kind: "fake_test_command_runner",
      commandRunner: () => item.runnerResult
    });
    const result = runContextWorkPackages(workflowState(), {
      max_package_count: 1,
      execution_mode: "provider_model_routed",
      execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
      created_at: "2026-05-22T06:05:00.000Z",
      provider_executor: executor
    });

    assert.equal(result.status, "blocked", item.name);
    assert.equal(result.workflow_state, undefined, item.name);
    assert.equal(result.package_results[0].status, "fail", item.name);
    assert.equal(result.package_results[0].completion_authority.allows_work_package_completion, false, item.name);
    assert.ok(result.issues.some((issue) => issue.code === "provider_executor_result_not_pass"), item.name);
    assert.equal(result.package_results[0].completion_evidence.evidence.issue_code, item.expectedFinding, item.name);
  }
});

test("provider trial CLI writes fake-test provenance without HTTP/body executor injection", () => {
  const dir = mkdtempSync(join(tmpdir(), "context-provider-trial-"));
  const inputPath = join(dir, "workflow-state.json");
  const outputPath = join(dir, "provider-trial.json");
  const workflowOutputPath = join(dir, "workflow-output.json");
  writeFileSync(inputPath, `${JSON.stringify(workflowState(), null, 2)}\n`);

  const result = spawnSync(process.execPath, [
    "tools/run-context-work-package-provider-trial.mjs",
    "--input",
    inputPath,
    "--output",
    outputPath,
    "--workflow-output",
    workflowOutputPath,
    "--created-at",
    "2026-05-22T06:10:00.000Z",
    "--no-tools"
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: "test",
      AI_CONTROL_PLATFORM_PROVIDER_TRIAL_FAKE_STDOUT_JSON: providerPassJson()
    }
  });

  assert.notEqual(result.status, 0);
  const artifact = JSON.parse(readFileSync(outputPath, "utf8"));

  assert.equal(artifact.version, "context-work-package-provider-trial.v1");
  assert.equal(artifact.status, "blocked");
  assert.equal(artifact.runner_options.provider_executor_injection, "runner_options");
  assert.equal(artifact.runner_options.command_runner_kind, "fake_test_command_runner");
  assert.equal(artifact.result.executor_provenance.command_runner_kind, "fake_test_command_runner");
  assert.equal(artifact.result.executor_provenance.no_tools, true);
  assert.equal(artifact.result.completion_authority.allows_work_package_completion, false);
  assert.ok(artifact.result.issues.some((issue) => issue.code === "non_external_command_runner_provenance_not_allowed"));
  assert.equal(artifact.workflow_output_path, null);
  assert.equal(existsSync(workflowOutputPath), false);
});
