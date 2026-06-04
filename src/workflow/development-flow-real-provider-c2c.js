import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { VERIFIED_PROVIDER_MULTI_AGENT_PROFILE } from "./context-work-package-execution-adapter.js";
import {
  DEFAULT_HARD_TIMEOUT_SECONDS,
  DEFAULT_IDLE_TIMEOUT_SECONDS,
  createAgentContextWorkPackageProviderExecutor
} from "./context-work-package-provider-executor.js";
import { runContextWorkPackages } from "./context-work-package-runner.js";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function now() {
  return new Date().toISOString();
}

function safeRead(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function issue(code, message, path = "") {
  return { code, message, path };
}

function providerC2cWorkflowState() {
  const workPackage = {
    id: "development-flow-provider-step2-c2c",
    title: "Provider step2 C2C command-contract fixture",
    action: "execute_requirement_plan_step",
    status: "pending",
    owned_files: ["src/workflow/development-flow-real.js"],
    acceptance_gates: ["node --test test/development-flow-real.test.js"],
    source: {
      implementation_step: "Run the same verified provider dispatch chain used by context work package step execution.",
      execution_governance: {
        version: "work-package-execution-governance.v1",
        granularity: "single_step",
        decomposition: { required: false, status: "not_required" },
        verification: { required: true, status: "defined", gate_count: 1 }
      }
    }
  };
  const contextPack = {
    requirement_summary: "C2C regression guard for provider step execution command policy.",
    host: "platform_core",
    target_project_id: "ai-control-platform",
    non_goals: ["Do not rerun the full live step2 task in this regression probe."],
    forbidden_actions: ["Do not write to the canonical checkout or live database from this probe."],
    owned_files: ["src/workflow/development-flow-real.js"],
    acceptance_gates: ["node --test test/development-flow-real.test.js"],
    rollback_conditions: ["provider dispatch command policy regresses"],
    subtasks: [workPackage]
  };
  return {
    manifest: {
      run_id: "development-flow-provider-c2c",
      cycle_id: "development-flow-provider-c2c-cycle",
      goal: "prove the closeout C2C gate exercises provider context work package dispatch",
      context_pack: contextPack,
      work_packages: [workPackage],
      events: [],
      artifacts: [],
      gate_results: [],
      review_findings: [],
      recovery_attempts: []
    },
    artifact_ledger: {
      run_id: "development-flow-provider-c2c",
      cycle_id: "development-flow-provider-c2c-cycle",
      artifacts: []
    },
    task_dag: [workPackage]
  };
}

function providerC2cPassJson(workPackageId = "development-flow-provider-step2-c2c") {
  return JSON.stringify({
    status: "pass",
    completion_evidence: {
      kind: "provider_execution",
      summary: "C2C probe reached the verified provider executor command boundary."
    },
    package_results: [
      {
        work_package_id: workPackageId,
        status: "pass",
        result: "pass",
        completion_evidence: {
          kind: "package_completion",
          summary: "Provider C2C command contract probe completed through the context work package runner."
        }
      }
    ]
  });
}

function commandArgsContain(commandAudit = {}, pattern) {
  return asArray(commandAudit.args).some((arg) => pattern.test(normalizeString(arg)));
}

function evaluateProviderC2cCommandContract(commandAudit = {}, provenance = {}, liveScript = "") {
  const issues = [];
  const args = asArray(commandAudit.args).map(normalizeString);
  if (args.includes("--max-budget-usd") || commandAudit.max_budget_usd !== undefined) {
    issues.push(issue("provider_c2c_budget_cap_present", "provider dispatch command must not include a local max budget cap", "c2c_governance.context_provider_dispatch.command.args"));
  }
  if (Number(provenance.timeout_seconds || commandAudit.timeout_seconds) !== DEFAULT_HARD_TIMEOUT_SECONDS) {
    issues.push(issue("provider_c2c_hard_timeout_regressed", `provider hard timeout must default to ${DEFAULT_HARD_TIMEOUT_SECONDS}s`, "c2c_governance.context_provider_dispatch.executor_provenance.timeout_seconds"));
  }
  if (Number(provenance.idle_timeout_seconds || commandAudit.idle_timeout_seconds) !== DEFAULT_IDLE_TIMEOUT_SECONDS) {
    issues.push(issue("provider_c2c_idle_timeout_missing", `provider idle timeout must default to ${DEFAULT_IDLE_TIMEOUT_SECONDS}s`, "c2c_governance.context_provider_dispatch.executor_provenance.idle_timeout_seconds"));
  }
  if (!commandArgsContain(commandAudit, /^stream-json$/i)) {
    issues.push(issue("provider_c2c_stream_json_missing", "provider dispatch must use stream-json output for activity-aware execution", "c2c_governance.context_provider_dispatch.command.args"));
  }
  if (!args.includes("--include-partial-messages")) {
    issues.push(issue("provider_c2c_partial_messages_missing", "provider dispatch must include partial messages so intermediate activity can reset idle timeout", "c2c_governance.context_provider_dispatch.command.args"));
  }
  if (/AI_CONTROL_WORKBENCH_CONTEXT_PROVIDER_TIMEOUT_SECONDS=.*120/.test(liveScript)) {
    issues.push(issue("provider_c2c_live_timeout_override_120", "live startup must not override provider dispatch back to a 120s hard timeout", "scripts/start-workbench-live.sh"));
  }
  return {
    status: issues.length === 0 ? "pass" : "fail",
    issues
  };
}

export function runContextProviderC2CGovernance(options = {}) {
  const root = options.root_dir || mkdtempSync(join(tmpdir(), "development-flow-provider-c2c-"));
  const providerCwd = resolve(options.provider_c2c_cwd || join(root, "worker-workspaces", "ai-control-platform", "provider-step2-c2c"));
  mkdirSync(providerCwd, { recursive: true });
  const captured = [];
  const executor = createAgentContextWorkPackageProviderExecutor({
    cwd: providerCwd,
    stateStore: options.stateStore || options.state_store,
    channels_path: options.agent_channels_path || options.agentChannelsPath,
    profiles_path: options.agent_profiles_path || options.agentProfilesPath,
    command_runner_kind: "external_provider_command_runner",
    commandRunner: (command, args, runnerOptions) => {
      captured.push({
        command,
        args,
        runner_options: {
          timeout: runnerOptions?.timeout,
          idle_timeout_ms: runnerOptions?.idle_timeout_ms
        }
      });
      return {
        status: 0,
        stdout: providerC2cPassJson("development-flow-provider-step2-c2c"),
        stderr: ""
      };
    }
  });
  const workflowState = providerC2cWorkflowState();
  const result = runContextWorkPackages(workflowState, {
    selected_work_package_ids: ["development-flow-provider-step2-c2c"],
    execution_mode: "provider_model_routed",
    execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
    execution_cwd: providerCwd,
    primary_worktree_path: options.primary_worktree_path || options.primaryWorktreePath || process.cwd(),
    created_at: now(),
    provider_executor: executor
  });
  const provenance = result.artifact?.metadata?.executor_provenance || result.executor_provenance || {};
  const commandAudit = provenance.command || provenance.provider_attempts?.[0]?.command || {};
  const liveScript = safeRead(resolve(options.live_start_script_path || options.liveStartScriptPath || "scripts/start-workbench-live.sh"));
  const contract = evaluateProviderC2cCommandContract(commandAudit, provenance, liveScript);
  const issues = [
    ...(result.status === "pass" ? [] : [issue("provider_c2c_dispatch_chain_failed", "context provider C2C dispatch chain did not pass", "c2c_governance.context_provider_dispatch.result")]),
    ...asArray(result.issues),
    ...contract.issues
  ];
  const executionCwd = normalizeString(provenance.cwd || providerCwd);
  if (!executionCwd.includes("/worker-workspaces/") && !executionCwd.includes("\\worker-workspaces\\")) {
    issues.push(issue("provider_c2c_not_isolated_worktree", "provider C2C code-output dispatch must execute in an isolated worker worktree", "c2c_governance.context_provider_dispatch.executor_provenance.cwd"));
  }
  return {
    version: "development-flow-c2c-governance.v1",
    status: issues.length === 0 ? "pass" : "fail",
    generated_at: now(),
    checks: {
      context_provider_dispatch_chain: result.status === "pass" ? "pass" : "fail",
      provider_command_contract: contract.status,
      live_startup_timeout_policy: /AI_CONTROL_WORKBENCH_CONTEXT_PROVIDER_TIMEOUT_SECONDS=.*120/.test(liveScript) ? "fail" : "pass",
      isolated_worker_worktree: executionCwd.includes("/worker-workspaces/") || executionCwd.includes("\\worker-workspaces\\") ? "pass" : "fail"
    },
    context_provider_dispatch: {
      status: result.status,
      phase: result.phase || "completed",
      same_chain_entrypoint: "runContextWorkPackages",
      execution_mode: "provider_model_routed",
      execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
      selected_work_package_ids: result.selected_work_package_ids || ["development-flow-provider-step2-c2c"],
      executed_count: result.executed_count || 0,
      executor_provenance: {
        executor_kind: provenance.executor_kind,
        profile_id: provenance.profile_id,
        agent_id: provenance.agent_id,
        runner: provenance.runner,
        model: provenance.model,
        cwd: provenance.cwd,
        timeout_seconds: provenance.timeout_seconds,
        idle_timeout_seconds: provenance.idle_timeout_seconds,
        external_calls: provenance.external_calls,
        command_runner_kind: provenance.command_runner_kind
      },
      command: commandAudit,
      captured_runner: captured[0] || null
    },
    issues
  };
}
