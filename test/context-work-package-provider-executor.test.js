import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { VERIFIED_PROVIDER_MULTI_AGENT_PROFILE } from "../src/workflow/context-work-package-execution-adapter.js";
import {
  createAgentContextWorkPackageProviderExecutor,
  createAgentContextWorkPackageProviderCommand,
  parseProviderExecutorOutput,
  promptForProviderExecution
} from "../src/workflow/context-work-package-provider-executor.js";
import {
  latestContextWorkPackagesRunArtifactId,
  withProviderAttemptsInWorkflowState
} from "../src/workflow/context-work-package-provider-trial-artifact.js";
import { runContextWorkPackages } from "../src/workflow/context-work-package-runner.js";
import { createSqliteWorkbenchStateStore } from "../src/workflow/workbench-state-store.js";

function providerStateStore() {
  return {
    acquireAgentKeyForRole(role, options) {
      assert.equal(options.agent_id, "deepseek");
      return {
        status: "acquired",
        key: {
          id: "key-deepseek",
          secret: `sk-provider-${role}`,
          lock: { lock_owner: options.lock_owner }
        }
      };
    },
    releaseAgentKeyLock() {
      return { status: "released" };
    }
  };
}

function providerStateDb(dir) {
  const dbPath = join(dir, "workbench-state.sqlite");
  const store = createSqliteWorkbenchStateStore({ dbPath });
  const created = store.addAgentKey({
    id: "key-deepseek-provider",
    agent_id: "deepseek",
    alias: "test provider",
    key: "sk-provider-test"
  }, "2026-05-22T06:00:00.000Z");
  assert.equal(created.status, "created");
  assert.equal(store.recordAgentKeyHealth({
    key_id: "key-deepseek-provider",
    status: "success"
  }, "2026-05-22T06:00:01.000Z").status, "recorded");
  return dbPath;
}

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

function latestContextRunArtifact(workflowState = {}) {
  return [...(workflowState.manifest?.artifacts || [])]
    .reverse()
    .find((artifact) => artifact?.metadata?.type === "context_work_packages_run");
}

test("provider command records bounded audit fields", () => {
  const command = createAgentContextWorkPackageProviderCommand({
    cwd: process.cwd(),
    stateStore: providerStateStore(),
    prompt: "complete selected work package",
    timeout_seconds: 45,
    model: "deepseek-v4-pro[1m]",
    tools: ["Read", "Edit"],
    effort: "high",
    max_budget_usd: "0.50"
  });

  assert.equal(command.command, "claude");
  assert.equal(command.profile_id, "context_work_package_provider");
  assert.equal(command.timeout_seconds, 45);
  assert.equal(command.model, "deepseek-v4-pro[1m]");
  assert.equal(command.tools, "Read,Edit");
  assert.ok(command.args.includes("--allowedTools"));
  assert.ok(command.args.includes("Read,Edit"));
  assert.ok(command.args.includes("--max-budget-usd"));
  assert.ok(command.args.includes("0.50"));
});

test("provider command no_tools emits real claude tool disablement", () => {
  const command = createAgentContextWorkPackageProviderCommand({
    cwd: process.cwd(),
    stateStore: providerStateStore(),
    prompt: "inspect only",
    timeout_seconds: 45,
    idle_timeout_seconds: 10,
    model: "deepseek-v4-pro[1m]",
    no_tools: true
  });

  assert.equal(command.no_tools, true);
  assert.equal(command.tools, "");
  assert.equal(command.idle_timeout_seconds, 10);
  const toolsIndex = command.args.indexOf("--tools");
  assert.ok(toolsIndex >= 0);
  assert.equal(command.args[toolsIndex + 1], "");
  assert.ok(!command.args.includes("--allowedTools"));
  assert.ok(command.args.includes("--output-format"));
  assert.ok(command.args.includes("stream-json"));
  assert.ok(command.args.includes("--include-partial-messages"));
});

test("provider command preview releases governed key locks before real execution", () => {
  const released = [];
  const stateStore = {
    acquireAgentKeyForRole(role, options) {
      return {
        status: "acquired",
        key: {
          id: "key-preview",
          secret: `sk-${role}`,
          lock: { lock_owner: options.lock_owner }
        }
      };
    },
    releaseAgentKeyLock(keyId, lockOwner) {
      released.push({ keyId, lockOwner });
      return { status: "released" };
    }
  };

  const command = createAgentContextWorkPackageProviderCommand({
    cwd: process.cwd(),
    stateStore,
    prompt: "preview provider command",
    model: "deepseek-v4-pro[1m]"
  });

  assert.equal(command.status, "pass");
  assert.equal(released.length, 1);
  assert.equal(released[0].keyId, "key-preview");
  assert.ok(released[0].lockOwner);
});

test("provider output parser requires structured JSON object", () => {
  assert.deepEqual(parseProviderExecutorOutput(`noise\n\`\`\`json\n${providerPassJson()}\n\`\`\``), JSON.parse(providerPassJson()));
  assert.deepEqual(parseProviderExecutorOutput(JSON.stringify({
    type: "result",
    result: `\`\`\`json\n${providerPassJson()}\n\`\`\``
  })), JSON.parse(providerPassJson()));
  assert.deepEqual(parseProviderExecutorOutput([
    JSON.stringify({ type: "assistant", message: { content: "working" } }),
    JSON.stringify({ type: "result", result: providerPassJson() })
  ].join("\n")), JSON.parse(providerPassJson()));
  assert.equal(parseProviderExecutorOutput("plain provider prose without json"), null);
  assert.equal(parseProviderExecutorOutput("[1,2,3]"), null);
});

test("provider execution prompt uses compact prompt-safe task context", () => {
  const state = workflowState();
  state.manifest.goal = "Run self-governance scanner through autonomous-continuation dispatch and code-review-coverage dispatch.";
  state.manifest.context_pack.requirement_summary = state.manifest.goal;
  const prompt = promptForProviderExecution({
    workflow_state: state,
    selected_work_packages: [
      {
        id: "self-governance-scanner-autonomous-continuation-dispatch",
        title: "Self-governance scanner autonomous-continuation dispatch",
        action: "run_self_governance_scanner_dispatch",
        owned_files: ["src/workflow/self-governance-scanner.js"],
        source: { raw: "omitted" }
      }
    ],
    execution_plan: {
      status: "ready",
      package_plans: [
        {
          routing_request: {
            context_pack: {
              requirement_summary: "raw self-governance scanner autonomous-continuation dispatch",
              acceptance_gates: ["node --test test/self-governance.test.js"]
            }
          }
        }
      ]
    }
  });

  assert.match(prompt, /Selected tasks:/);
  assert.match(prompt, /work_package_id/);
  assert.match(prompt, /self-governance-scanner-autonomous-continuation-dispatch/);
  assert.match(prompt, /Internal metadata is intentionally omitted/);
  assert.match(prompt, /src\/workflow\/self-governance-scanner\.js/);
  assert.doesNotMatch(prompt, /Self-governance scanner autonomous-continuation dispatch/);
  assert.doesNotMatch(prompt, /raw self-governance scanner autonomous-continuation dispatch/);
});

test("provider attempt helper updates ledger artifact when manifest artifact is missing", () => {
  const attempts = [
    {
      model: "deepseek-v4-pro[1m]",
      status: "fail",
      timed_out: true,
      workflow_output_written: false
    },
    {
      model: "deepseek-v4-flash",
      status: "pass",
      timed_out: false,
      workflow_output_written: true
    }
  ];
  const state = {
    manifest: {
      artifacts: []
    },
    artifact_ledger: {
      artifacts: [
        {
          id: "context-work-packages-run-ledger-only",
          metadata: {
            type: "context_work_packages_run",
            executor_provenance: {
              provider_attempts: []
            }
          }
        }
      ]
    }
  };

  assert.equal(latestContextWorkPackagesRunArtifactId(state), "context-work-packages-run-ledger-only");
  const updated = withProviderAttemptsInWorkflowState(state, attempts);

  assert.deepEqual(updated.manifest.artifacts, []);
  assert.deepEqual(
    updated.artifact_ledger.artifacts[0].metadata.executor_provenance.provider_attempts,
    attempts
  );
});

test("fake command runner output is structured but cannot complete work packages", () => {
  const calls = [];
  const executor = createAgentContextWorkPackageProviderExecutor({
    cwd: process.cwd(),
    stateStore: providerStateStore(),
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
  assert.equal(result.executor_provenance.executor_kind, "agent_invocation_provider_executor");
  assert.equal(result.executor_provenance.external_calls, 1);
  assert.equal(result.executor_provenance.command_runner_kind, "fake_test_command_runner");
  assert.equal(result.package_results[0].status, "pass");
  assert.equal(result.package_results[0].allows_work_package_completion, false);
  assert.ok(result.issues.some((issue) => issue.code === "non_external_command_runner_provenance_not_allowed"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.timeout, 60000);
});

test("external provider command runner provenance can complete with structured evidence", () => {
  const executor = createAgentContextWorkPackageProviderExecutor({
    cwd: process.cwd(),
    stateStore: providerStateStore(),
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
  assert.equal(result.artifact.metadata.executor_provenance.executor_kind, "agent_invocation_provider_executor");
  assert.equal(result.artifact.metadata.executor_provenance.external_calls, 1);
  assert.equal(result.artifact.metadata.executor_provenance.command_runner_kind, "external_provider_command_runner");
  assert.equal(result.artifact.metadata.executor_provenance.no_tools, true);
  assert.equal(result.artifact.metadata.completion_authority.allows_work_package_completion, true);
});

test("primary provider timeout falls back to external provider runner and completes with attempt evidence", () => {
  const calls = [];
  const executor = createAgentContextWorkPackageProviderExecutor({
    cwd: process.cwd(),
    stateStore: providerStateStore(),
    timeout_seconds: 60,
    model: "deepseek-v4-pro[1m]",
    fallback_model: "deepseek-v4-flash",
    no_tools: true,
    command_runner_kind: "external_provider_command_runner",
    commandRunner: (command, args) => {
      calls.push({ command, args });
      if (calls.length === 1) {
        return {
          status: 124,
          stdout: "",
          stderr: "CLAUDE_DEEPSEEK_TIMEOUT"
        };
      }
      return {
        status: 0,
        stdout: providerPassJson(),
        stderr: "external_provider_command_runner"
      };
    }
  });

  const result = runContextWorkPackages(workflowState(), {
    max_package_count: 1,
    execution_mode: "provider_model_routed",
    execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    created_at: "2026-05-22T06:03:00.000Z",
    provider_executor: executor
  });

  assert.equal(result.status, "pass");
  assert.equal(result.executed_count, 1);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].args.includes("deepseek-v4-pro[1m]"));
  assert.ok(calls[1].args.includes("deepseek-v4-flash"));
  assert.equal(result.artifact.metadata.executor_provenance.model, "deepseek-v4-flash");
  assert.equal(result.artifact.metadata.executor_provenance.external_calls, 2);
  assert.equal(result.artifact.metadata.executor_provenance.provider_attempts.length, 2);
  assert.deepEqual(result.artifact.metadata.executor_provenance.provider_attempts.map((attempt) => attempt.status), ["fail", "pass"]);
  assert.deepEqual(result.artifact.metadata.executor_provenance.provider_attempts.map((attempt) => attempt.model), [
    "deepseek-v4-pro[1m]",
    "deepseek-v4-flash"
  ]);
  assert.equal(result.artifact.metadata.executor_provenance.provider_attempts[0].timed_out, true);
  assert.equal(result.artifact.metadata.executor_provenance.provider_attempts[0].issue, "provider_executor_timeout");
  assert.equal(result.workflow_state.manifest.work_packages.find((item) => item.id === "provider-runtime").status, "completed");
});

test("primary provider unstructured output falls back to external provider runner and completes with attempt evidence", () => {
  const calls = [];
  const executor = createAgentContextWorkPackageProviderExecutor({
    cwd: process.cwd(),
    stateStore: providerStateStore(),
    timeout_seconds: 60,
    model: "deepseek-v4-pro[1m]",
    fallback_model: "deepseek-v4-flash",
    no_tools: true,
    command_runner_kind: "external_provider_command_runner",
    commandRunner: (command, args) => {
      calls.push({ command, args });
      if (calls.length === 1) {
        return {
          status: 0,
          stdout: "<bash>echo not-json</bash>",
          stderr: ""
        };
      }
      return {
        status: 0,
        stdout: providerPassJson(),
        stderr: "external_provider_command_runner"
      };
    }
  });

  const result = runContextWorkPackages(workflowState(), {
    max_package_count: 1,
    execution_mode: "provider_model_routed",
    execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    created_at: "2026-05-22T06:03:30.000Z",
    provider_executor: executor
  });

  assert.equal(result.status, "pass");
  assert.equal(result.executed_count, 1);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].args.includes("deepseek-v4-pro[1m]"));
  assert.ok(calls[1].args.includes("deepseek-v4-flash"));
  assert.equal(result.artifact.metadata.executor_provenance.model, "deepseek-v4-flash");
  assert.equal(result.artifact.metadata.executor_provenance.external_calls, 2);
  assert.deepEqual(result.artifact.metadata.executor_provenance.provider_attempts.map((attempt) => attempt.status), ["fail", "pass"]);
  assert.deepEqual(result.artifact.metadata.executor_provenance.provider_attempts.map((attempt) => attempt.issue), [
    "provider_executor_unstructured_output",
    null
  ]);
  assert.equal(result.artifact.metadata.executor_provenance.provider_attempts[0].timed_out, false);
  assert.equal(result.workflow_state.manifest.work_packages.find((item) => item.id === "provider-runtime").status, "completed");
});

test("provider fallback model resolves across agent channels after primary output failure", () => {
  const calls = [];
  const executor = createAgentContextWorkPackageProviderExecutor({
    cwd: process.cwd(),
    stateStore: {
      acquireAgentKeyForRole(role, options) {
        return {
          status: "acquired",
          key: {
            id: `key-${options.agent_id}`,
            secret: `sk-${options.agent_id}-${role}`,
            lock: { lock_owner: options.lock_owner }
          }
        };
      },
      releaseAgentKeyLock() {
        return { status: "released" };
      }
    },
    timeout_seconds: 60,
    model: "deepseek-v4-flash",
    fallback_model: "claude-sonnet-4-6",
    no_tools: true,
    commandRunner: (command, args) => {
      calls.push({ command, args });
      return calls.length === 1
        ? { status: 0, stdout: "not json", stderr: "" }
        : { status: 0, stdout: providerPassJson(), stderr: "" };
    }
  });

  const result = runContextWorkPackages(workflowState(), {
    max_package_count: 1,
    execution_mode: "provider_model_routed",
    execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    created_at: "2026-05-22T06:03:45.000Z",
    provider_executor: executor
  });

  assert.equal(result.status, "pass");
  assert.equal(calls.length, 2);
  assert.ok(calls[0].args.includes("deepseek-v4-flash"));
  assert.ok(calls[1].args.includes("claude-sonnet-4-6"));
  assert.equal(result.artifact.metadata.executor_provenance.agent_id, "claude");
  assert.equal(result.artifact.metadata.executor_provenance.model, "claude-sonnet-4-6");
});

test("primary timeout plus fake fallback remains blocked and non-completing", () => {
  const executor = createAgentContextWorkPackageProviderExecutor({
    cwd: process.cwd(),
    stateStore: providerStateStore(),
    timeout_seconds: 60,
    model: "deepseek-v4-pro[1m]",
    fallback_model: "deepseek-v4-flash",
    no_tools: true,
    command_runner_kind: "fake_test_command_runner",
    commandRunner: (() => {
      let calls = 0;
      return () => {
        calls += 1;
        if (calls === 1) {
          return {
            status: 124,
            stdout: "",
            stderr: "CLAUDE_DEEPSEEK_TIMEOUT"
          };
        }
        return {
          status: 0,
          stdout: providerPassJson(),
          stderr: "fake_test_command_runner"
        };
      };
    })()
  });

  const result = runContextWorkPackages(workflowState(), {
    max_package_count: 1,
    execution_mode: "provider_model_routed",
    execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    created_at: "2026-05-22T06:04:00.000Z",
    provider_executor: executor
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.workflow_state, undefined);
  assert.equal(result.artifact, undefined);
  assert.equal(result.executor_provenance.external_calls, 2);
  assert.equal(result.executor_provenance.provider_attempts.length, 2);
  assert.deepEqual(result.executor_provenance.provider_attempts.map((attempt) => attempt.status), ["fail", "pass"]);
  assert.equal(result.executor_provenance.provider_attempts[1].command_runner_kind, "fake_test_command_runner");
  assert.equal(result.package_results[0].status, "pass");
  assert.equal(result.package_results[0].allows_work_package_completion, false);
  assert.ok(result.issues.some((issue) => issue.code === "non_external_command_runner_provenance_not_allowed"));
});

test("primary unstructured output plus fake fallback remains blocked and non-completing", () => {
  const executor = createAgentContextWorkPackageProviderExecutor({
    cwd: process.cwd(),
    stateStore: providerStateStore(),
    timeout_seconds: 60,
    model: "deepseek-v4-pro[1m]",
    fallback_model: "deepseek-v4-flash",
    no_tools: true,
    command_runner_kind: "fake_test_command_runner",
    commandRunner: (() => {
      let calls = 0;
      return () => {
        calls += 1;
        if (calls === 1) {
          return {
            status: 0,
            stdout: "<bash>echo not-json</bash>",
            stderr: ""
          };
        }
        return {
          status: 0,
          stdout: providerPassJson(),
          stderr: "fake_test_command_runner"
        };
      };
    })()
  });

  const result = runContextWorkPackages(workflowState(), {
    max_package_count: 1,
    execution_mode: "provider_model_routed",
    execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    created_at: "2026-05-22T06:04:15.000Z",
    provider_executor: executor
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.workflow_state, undefined);
  assert.equal(result.artifact, undefined);
  assert.equal(result.executor_provenance.external_calls, 2);
  assert.deepEqual(result.executor_provenance.provider_attempts.map((attempt) => attempt.issue), [
    "provider_executor_unstructured_output",
    null
  ]);
  assert.equal(result.package_results[0].status, "pass");
  assert.equal(result.package_results[0].allows_work_package_completion, false);
  assert.ok(result.issues.some((issue) => issue.code === "non_external_command_runner_provenance_not_allowed"));
});

test("all provider attempts fail without workflow output or completion artifact", () => {
  const executor = createAgentContextWorkPackageProviderExecutor({
    cwd: process.cwd(),
    stateStore: providerStateStore(),
    timeout_seconds: 30,
    model: "deepseek-v4-pro[1m]",
    fallback_model: "deepseek-v4-flash",
    command_runner_kind: "external_provider_command_runner",
    commandRunner: (() => {
      let calls = 0;
      return () => {
        calls += 1;
        if (calls === 1) {
          return {
            status: 124,
            stdout: "",
            stderr: "CLAUDE_DEEPSEEK_TIMEOUT"
          };
        }
        return {
          status: 2,
          stdout: "",
          stderr: "provider failed"
        };
      };
    })()
  });

  const result = runContextWorkPackages(workflowState(), {
    max_package_count: 1,
    execution_mode: "provider_model_routed",
    execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    created_at: "2026-05-22T06:04:30.000Z",
    provider_executor: executor
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.workflow_state, undefined);
  assert.equal(result.artifact, undefined);
  assert.equal(result.executor_provenance.external_calls, 2);
  assert.equal(result.executor_provenance.provider_attempts.length, 2);
  assert.deepEqual(result.executor_provenance.provider_attempts.map((attempt) => attempt.issue), [
    "provider_executor_timeout",
    "provider_executor_command_failed"
  ]);
  assert.equal(result.package_results[0].completion_evidence.evidence.issue_code, "provider_executor_command_failed");
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
    const executor = createAgentContextWorkPackageProviderExecutor({
      cwd: process.cwd(),
      stateStore: providerStateStore(),
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
  const stateDbPath = providerStateDb(dir);
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
    "--state-db",
    stateDbPath,
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
  assert.equal(artifact.result.provider_attempts.length, 1);
  assert.equal(artifact.result.provider_attempts[0].model, "deepseek-v4-pro[1m]");
  assert.equal(artifact.result.provider_attempts[0].workflow_output_written, false);
  assert.equal(artifact.result.completion_authority.allows_work_package_completion, false);
  assert.ok(artifact.result.issues.some((issue) => issue.code === "non_external_command_runner_provenance_not_allowed"));
  assert.equal(artifact.workflow_output_path, null);
  assert.equal(existsSync(workflowOutputPath), false);
});

test("provider trial CLI explicit fake opt-in remains blocked without workflow output", () => {
  const dir = mkdtempSync(join(tmpdir(), "context-provider-trial-fake-opt-in-"));
  const inputPath = join(dir, "workflow-state.json");
  const outputPath = join(dir, "provider-trial.json");
  const workflowOutputPath = join(dir, "workflow-output.json");
  const stateDbPath = providerStateDb(dir);
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
    "2026-05-22T06:11:00.000Z",
    "--state-db",
    stateDbPath,
    "--no-tools"
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: "production",
      AI_CONTROL_PLATFORM_ALLOW_FAKE_PROVIDER_TRIAL: "1",
      AI_CONTROL_PLATFORM_PROVIDER_TRIAL_FAKE_STDOUT_JSON: providerPassJson()
    }
  });

  assert.notEqual(result.status, 0);
  const artifact = JSON.parse(readFileSync(outputPath, "utf8"));

  assert.equal(artifact.status, "blocked");
  assert.equal(artifact.runner_options.command_runner_kind, "fake_test_command_runner");
  assert.equal(artifact.result.executor_provenance.command_runner_kind, "fake_test_command_runner");
  assert.ok(artifact.result.issues.some((issue) => issue.code === "non_external_command_runner_provenance_not_allowed"));
  assert.equal(artifact.workflow_output_path, null);
  assert.equal(existsSync(workflowOutputPath), false);
});

test("provider trial CLI fake agent invocation remains blocked without workflow output", () => {
  const dir = mkdtempSync(join(tmpdir(), "context-provider-trial-agent-"));
  const inputPath = join(dir, "workflow-state.json");
  const outputPath = join(dir, "provider-trial.json");
  const workflowOutputPath = join(dir, "workflow-output.json");
  const stateDbPath = providerStateDb(dir);
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
    "2026-05-22T06:12:00.000Z",
    "--state-db",
    stateDbPath,
    "--no-tools",
    "--model",
    "deepseek-v4-pro[1m]"
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: "test",
      AI_CONTROL_PLATFORM_PROVIDER_TRIAL_FAKE_STDOUT_JSON: providerPassJson()
    }
  });

  assert.notEqual(result.status, 0, result.stderr || result.stdout);
  const artifact = JSON.parse(readFileSync(outputPath, "utf8"));

  assert.equal(artifact.status, "blocked");
  assert.equal(artifact.workflow_output_path, null);
  assert.equal(existsSync(workflowOutputPath), false);
  assert.deepEqual(artifact.result.provider_attempts.map((attempt) => attempt.workflow_output_written), [false]);
  assert.equal(artifact.result.provider_attempts[0].model, "deepseek-v4-pro[1m]");
  assert.equal(artifact.result.provider_attempts[0].timed_out, false);
});
