import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CHILD_WORKER_ROLE,
  HEADLESS_MAIN_ORCHESTRATOR_ROLE,
  createHeadlessProviderExecutor,
  evaluateHeadlessChildWorkerOutput,
  headlessChildWorkerPrompt,
  parseHeadlessChildWorkerOutput,
  runHeadlessCliMainOrchestrator,
  runHeadlessCliMainOrchestratorLoop
} from "../src/workflow/headless-cli-orchestrator.js";
import {
  governedAgentStateStore,
  materializedWorkflowStateWithCompletedFirstPackage,
  projectStatus,
  sourceWorkflowState
} from "./helpers/headless-cli-orchestrator.js";

test("headless CLI orchestrator can execute a real child command runner and parse structured output", () => {
  const calls = [];
  const result = runHeadlessCliMainOrchestrator({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState()
  }, {
    cycle_id: "cycle-headless-real-child",
    created_at: "2026-05-23T00:01:30.000Z",
    max_package_count: 1,
    command_runner_kind: "agent_invocation_child_process",
    child_worker_runner: ({ prompt_file, work_package, timeout_ms }) => {
      // Capture the prompt CONTENTS during the run — the scratch dir is cleaned up after
      // dispatch (P2-9), so reading prompt_file afterward is no longer valid.
      calls.push({ prompt_file, prompt: readFileSync(prompt_file, "utf8"), work_package, timeout_ms });
      return {
        status: 0,
        stdout: JSON.stringify({
          status: "pass",
          role: CHILD_WORKER_ROLE,
          host: "platform_core",
          changed_files: ["src/workflow/headless-cli-orchestrator.js"],
          test_results: [{ command: "node --test test/headless-cli-orchestrator.test.js", status: "pass" }],
          durable_state_updated: true,
          process_hardening: { required: false, status: "not_required" },
          continuation_readiness: { ready: true },
          self_evaluation: { aligned: true, drifted: false, evidence_sufficient: true }
        }),
        stderr: ""
      };
    }
  });

  assert.equal(result.status, "pass");
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /"role": "child_worker"/);
  assert.equal(result.child_run.artifact.metadata.executor_provenance.command_runner_kind, "agent_invocation_child_process");
  assert.equal(result.child_run.artifact.metadata.package_results[0].completion_evidence.child_output.command_evidence.exit_code, 0);
});

test("headless child prompt minimizes high-risk routing keywords for external CLI providers", () => {
  const workflowState = sourceWorkflowState();
  workflowState.manifest.goal = "Run self-governance scanner through autonomous-continuation dispatch and code-review-coverage dispatch.";
  workflowState.manifest.context_pack.requirement_summary = workflowState.manifest.goal;
  workflowState.manifest.context_pack.forbidden_actions = [
    "Do not skip self-governance scanner evidence",
    "Do not bypass autonomous-continuation dispatch"
  ];
  const prompt = headlessChildWorkerPrompt(workflowState, {
    id: "self-governance-scanner-autonomous-continuation-dispatch",
    title: "Self-governance scanner autonomous-continuation dispatch",
    action: "run_self_governance_scanner_dispatch",
    owned_files: [
      "src/workflow/self-governance-scanner.js",
      "src/workflow/autonomous-continuation.js",
      "src/workflow/code-review-coverage-dispatch.js"
    ],
    acceptance_gates: ["npm run check:code-review-coverage"]
  });

  assert.match(prompt, /internal project-management and quality-operations platform/);
  assert.match(prompt, /Do not create, switch to, or delegate into another worktree/);
  assert.match(prompt, /Do not create \.claude\/worktrees or run claude --worktree/);
  assert.match(prompt, /src\/workflow\/self-governance-scanner\.js/);
  assert.doesNotMatch(prompt, /Self-governance scanner autonomous-continuation dispatch/);
  assert.doesNotMatch(prompt, /run_self_governance_scanner_dispatch/);
  assert.doesNotMatch(prompt, /docs\/contracts\/AUTONOMOUS_DEVELOPMENT_FLOW_CN\.md/);
  assert.doesNotMatch(prompt, /"Context Pack"/);
});

test("headless child prompt includes selected requirement plan step context", () => {
  const workflowState = sourceWorkflowState();
  workflowState.manifest.context_pack.subtasks = [
    {
      id: "requirement-plan-step-01",
      title: "前端重构：实施步骤 01 / 2",
      action: "execute_requirement_plan_step",
      owned_files: ["."],
      source: {
        requirement_id: "requirement-front",
        plan_step_index: 1,
        plan_step_total: 2,
        implementation_step: "盘点现有前端入口和接口调用",
        acceptance_gates: ["现状盘点清单已产出并入库"]
      }
    },
    {
      id: "requirement-plan-step-02",
      title: "前端重构：实施步骤 02 / 2",
      action: "execute_requirement_plan_step",
      owned_files: ["."],
      source: {
        requirement_id: "requirement-front",
        plan_step_index: 2,
        plan_step_total: 2,
        implementation_step: "建立后续页面迁移",
        acceptance_gates: ["后续页面迁移通过"]
      }
    }
  ];
  workflowState.manifest.context_pack.acceptance_gates = [
    "现状盘点清单已产出并入库",
    "后续页面迁移通过"
  ];
  const workPackage = {
    ...workflowState.manifest.context_pack.subtasks[0],
    status: "pending"
  };
  const prompt = headlessChildWorkerPrompt(workflowState, workPackage);

  assert.match(prompt, /盘点现有前端入口和接口调用/);
  assert.match(prompt, /现状盘点清单已产出并入库/);
  assert.doesNotMatch(prompt, /建立后续页面迁移/);
  assert.doesNotMatch(prompt, /后续页面迁移通过/);
  assert.doesNotMatch(prompt, /Internal metadata is intentionally omitted/);
});

test("headless child prompt defers parent-owned release gates outside isolated worker execution", () => {
  const workflowState = sourceWorkflowState();
  workflowState.manifest.context_pack.acceptance_gates = [
    "npm run check:workbench:browser-events",
    "npm run check:closeout"
  ];
  const workPackage = {
    id: "requirement-plan-step-03",
    title: "前端重构：实施步骤 03 / 7",
    action: "execute_requirement_plan_step",
    owned_files: ["."],
    acceptance_gates: [
      "npm run check:workbench:browser-events",
      "npm run check:closeout",
      "发布链路在 canonical checkout 上完成一次端到端 publish 演练并可回滚。",
      "PROJECT_RULES.md 与 DECISIONS.md 的规范条款合入 main。",
      "完成已审核实施步骤 3：固化 antd + Next.js 约束"
    ],
    source: {
      requirement_id: "requirement-front",
      plan_step_index: 3,
      plan_step_total: 7,
      implementation_step: "固化 antd + Next.js 约束",
      acceptance_gates: [
        "npm run check:workbench:browser-events",
        "npm run check:closeout",
        "发布链路在 canonical checkout 上完成一次端到端 publish 演练并可回滚。",
        "PROJECT_RULES.md 与 DECISIONS.md 的规范条款合入 main。",
        "完成已审核实施步骤 3：固化 antd + Next.js 约束"
      ]
    }
  };
  const prompt = headlessChildWorkerPrompt(workflowState, workPackage);
  const childOwnedPrompt = prompt.split("Deferred parent-owned release gates:")[0];

  assert.match(prompt, /Child acceptance gates:/);
  assert.match(prompt, /npm run check:workbench:browser-events/);
  assert.match(prompt, /完成已审核实施步骤 3/);
  assert.match(prompt, /Deferred parent-owned release gates:[\s\S]*npm run check:closeout/);
  assert.match(prompt, /Deferred parent-owned release gates:[\s\S]*发布链路在 canonical checkout/);
  assert.match(prompt, /Deferred parent-owned release gates:[\s\S]*PROJECT_RULES\.md 与 DECISIONS\.md/);
  assert.doesNotMatch(childOwnedPrompt, /npm run check:closeout/);
  assert.doesNotMatch(childOwnedPrompt, /发布链路在 canonical checkout/);
  assert.doesNotMatch(childOwnedPrompt, /PROJECT_RULES\.md 与 DECISIONS\.md/);
  assert.match(prompt, /Do not run deferred parent-owned release gates from the isolated worker branch/);
  assert.match(prompt, /Deferred parent-owned release gates are not your failure criteria/);
  assert.match(prompt, /Do not set process_hardening\.status="pending"/);
});

test("headless CLI orchestrator can use governed agent retry and split policy", () => {
  const calls = [];
  const result = runHeadlessCliMainOrchestrator({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState()
  }, {
    cycle_id: "cycle-headless-default-provider",
    created_at: "2026-05-23T01:40:00.000Z",
    max_package_count: 1,
    agent_invocation_retry_policy: { max_attempts: 2, split_retry: true },
    child_worker_runner: ({ attempt, split_retry }) => {
      calls.push({ attempt, split_retry });
      if (attempt === 1) {
        return {
          status: 124,
          stdout: "",
          stderr: "child worker timeout"
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          status: "pass",
          role: CHILD_WORKER_ROLE,
          host: "platform_core",
          changed_files: ["src/workflow/headless-cli-orchestrator.js"],
          test_results: [{ command: "node --test test/headless-cli-orchestrator.test.js", status: "pass" }],
          durable_state_updated: true,
          process_hardening: { required: false, status: "not_required" },
          continuation_readiness: { ready: true },
          self_evaluation: { aligned: true, drifted: false, evidence_sufficient: true }
        }),
        stderr: ""
      };
    }
  });
  const childOutput = result.child_run.artifact.metadata.package_results[0].completion_evidence.child_output;
  const provenance = result.child_run.artifact.metadata.executor_provenance;

  assert.equal(result.status, "pass");
  assert.deepEqual(calls, [
    { attempt: 1, split_retry: false },
    { attempt: 2, split_retry: true }
  ]);
  assert.equal(provenance.provider, "agent_invocation");
  assert.equal(provenance.retry_policy.max_attempts, 2);
  assert.equal(provenance.retry_policy.split_retry, true);
  assert.equal(childOutput.command_evidence.attempts.length, 2);
  assert.equal(childOutput.command_evidence.attempts[1].split_retry, true);
});
