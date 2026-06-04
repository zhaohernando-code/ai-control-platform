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

test("headless child worker acceptance checks host, owned files, tests, durable state, hardening, and continuation", () => {
  const evaluation = evaluateHeadlessChildWorkerOutput({
    id: "wp",
    owned_files: ["src/workflow/headless-cli-orchestrator.js"]
  }, {
    status: "pass",
    host: "platform_core",
    changed_files: ["src/workflow/headless-cli-orchestrator.js"],
    test_results: [{ command: "node --test test/headless-cli-orchestrator.test.js", status: "pass" }],
    durable_state_updated: true,
    process_hardening: { required: false },
    continuation_readiness: { ready: true },
    self_evaluation: { aligned: true, drifted: false }
  });

  assert.equal(evaluation.status, "pass");
  assert.equal(evaluation.checked.host_boundary, "platform_core");
});

test("headless child worker acceptance allows changed files under owned directories", () => {
  const evaluation = evaluateHeadlessChildWorkerOutput({
    id: "global-goal-platform-boundary-and-state-foundation",
    owned_files: [
      "PROJECT_STATUS.json",
      "docs/contracts",
      "docs/examples/process-hardening-current.json"
    ]
  }, {
    status: "pass",
    host: "platform_core",
    changed_files: [
      "PROJECT_STATUS.json",
      "docs/contracts/CODEX_PROXY_HANDOFF_CN.md",
      "docs/examples/process-hardening-current.json"
    ],
    test_results: [{ command: "npm run check:process-hardening", status: "pass" }],
    durable_state_updated: true,
    process_hardening: { required: true, status: "completed" },
    continuation_readiness: { ready: true },
    self_evaluation: { aligned: true, drifted: false }
  });

  assert.equal(evaluation.status, "pass");
  assert.equal(evaluation.issues.length, 0);
});

test("headless child worker acceptance allows project root owned scope", () => {
  const evaluation = evaluateHeadlessChildWorkerOutput({
    id: "project-wide-worker",
    owned_files: ["."]
  }, {
    status: "pass",
    host: "platform_core",
    changed_files: [
      "package.json",
      "apps/workbench/web/app/page.tsx",
      "test/workbench-web-skeleton.test.js"
    ],
    test_results: [{ command: "node --test test/workbench-web-skeleton.test.js", status: "pass" }],
    durable_state_updated: true,
    process_hardening: { required: false },
    continuation_readiness: { ready: true },
    self_evaluation: { aligned: true, drifted: false }
  });

  assert.equal(evaluation.status, "pass");
  assert.equal(evaluation.issues.length, 0);
});

test("headless child worker project root scope rejects files outside the project", () => {
  const evaluation = evaluateHeadlessChildWorkerOutput({
    id: "project-wide-worker",
    owned_files: ["."]
  }, {
    status: "pass",
    host: "platform_core",
    changed_files: ["../stock_dashboard/src/page.tsx", "/tmp/outside.js"],
    test_results: [{ command: "node --test test/headless-cli-orchestrator.test.js", status: "pass" }],
    durable_state_updated: true,
    process_hardening: { required: false },
    continuation_readiness: { ready: true },
    self_evaluation: { aligned: true, drifted: false }
  });

  assert.equal(evaluation.status, "fail");
  assert.equal(
    evaluation.issues.filter((item) => item.code === "child_worker_owned_file_violation").length,
    2
  );
});

test("headless child worker acceptance includes touched files when checking owned scope", () => {
  const evaluation = evaluateHeadlessChildWorkerOutput({
    id: "worker-runtime-readiness-gate",
    owned_files: [
      "src/workflow/worker-runtime-readiness.js",
      "tools/check-worker-runtime-readiness.mjs",
      "test/worker-runtime-readiness.test.js",
      "package.json",
      "docs/examples/process-hardening-current.json"
    ]
  }, {
    status: "pass",
    host: "platform_core",
    touched_files: [
      "src/workflow/worker-runtime-readiness.js",
      "tools/check-worker-runtime-readiness.mjs",
      "test/worker-runtime-readiness.test.js",
      "package.json",
      "docs/examples/process-hardening-current.json"
    ],
    test_results: [{ command: "node --test test/worker-runtime-readiness.test.js", status: "pass" }],
    durable_state_updated: true,
    process_hardening: { required: true, status: "completed" },
    continuation_readiness: { ready: true },
    self_evaluation: { aligned: true, drifted: false }
  });

  assert.equal(evaluation.status, "pass");
  assert.deepEqual(evaluation.checked.owned_files, [
    "src/workflow/worker-runtime-readiness.js",
    "tools/check-worker-runtime-readiness.mjs",
    "test/worker-runtime-readiness.test.js",
    "package.json",
    "docs/examples/process-hardening-current.json"
  ]);
});

test("headless child worker acceptance rejects touched files outside owned scope", () => {
  const evaluation = evaluateHeadlessChildWorkerOutput({
    id: "worker-runtime-readiness-gate",
    owned_files: ["tools/check-worker-runtime-readiness.mjs"]
  }, {
    host: "platform_core",
    touched_files: [
      "tools/check-worker-runtime-readiness.mjs",
      "src/workflow/worker-runtime-readiness.js"
    ],
    test_results: [{ command: "node --test test/worker-runtime-readiness.test.js", status: "pass" }],
    durable_state_updated: true,
    process_hardening: { required: true, status: "completed" },
    continuation_readiness: { ready: true },
    self_evaluation: { aligned: true, drifted: false }
  });

  assert.equal(evaluation.status, "fail");
  assert.ok(evaluation.issues.some((item) => item.code === "child_worker_owned_file_violation"));
});

test("headless child worker acceptance rejects sibling paths outside owned directories", () => {
  const evaluation = evaluateHeadlessChildWorkerOutput({
    id: "global-goal-platform-boundary-and-state-foundation",
    owned_files: ["docs/contracts"]
  }, {
    host: "platform_core",
    changed_files: ["docs/contracts-extra/drift.md"],
    test_results: [{ command: "npm run check:process-hardening", status: "pass" }],
    durable_state_updated: true,
    process_hardening: { required: false },
    continuation_readiness: { ready: true },
    self_evaluation: { aligned: true, drifted: false }
  });

  assert.equal(evaluation.status, "fail");
  assert.ok(evaluation.issues.some((item) => item.code === "child_worker_owned_file_violation"));
});

test("headless child worker acceptance rejects failed status, failed command, and missing required integration", () => {
  const workPackage = {
    id: "integration-gated-package",
    owned_files: ["src/workflow/headless-cli-orchestrator.js"]
  };
  const baseOutput = {
    status: "pass",
    role: CHILD_WORKER_ROLE,
    host: "platform_core",
    changed_files: ["src/workflow/headless-cli-orchestrator.js"],
    test_results: [{ command: "node --test test/headless-cli-orchestrator.test.js", status: "pass" }],
    durable_state_updated: true,
    process_hardening: { required: false, status: "not_required" },
    continuation_readiness: { ready: true },
    self_evaluation: { aligned: true, drifted: false, evidence_sufficient: true }
  };

  const failedStatus = evaluateHeadlessChildWorkerOutput(workPackage, {
    ...baseOutput,
    status: "fail"
  });
  assert.ok(failedStatus.issues.some((item) => item.code === "child_worker_status_not_pass"));

  const failedCommand = evaluateHeadlessChildWorkerOutput(workPackage, {
    ...baseOutput,
    command_evidence: { exit_code: 1 }
  });
  assert.ok(failedCommand.issues.some((item) => item.code === "child_worker_command_failed"));

  const missingIntegration = evaluateHeadlessChildWorkerOutput(workPackage, {
    ...baseOutput,
    command_evidence: {
      exit_code: 0,
      child_worker_integration: { required: true, status: "fail" }
    }
  });
  assert.ok(missingIntegration.issues.some((item) => item.code === "child_worker_mainline_integration_missing"));
});

test("headless CLI orchestrator passes configured output path into child prompt and parses file output", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-child-output-path-"));
  const outputPattern = join(dir, "child-{work_package_id}-{run_id}-{cycle_id}.json");
  const calls = [];
  const result = runHeadlessCliMainOrchestrator({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState()
  }, {
    cycle_id: "cycle-headless-output-path",
    created_at: "2026-05-23T00:01:35.000Z",
    max_package_count: 1,
    command_runner_kind: "agent_invocation_child_process",
    child_worker_output_path: outputPattern,
    child_worker_runner: ({ prompt_file, output_path }) => {
      calls.push({ prompt_file, prompt: readFileSync(prompt_file, "utf8"), output_path });
      writeFileSync(output_path, JSON.stringify({
        status: "pass",
        role: CHILD_WORKER_ROLE,
        host: "platform_core",
        changed_files: ["src/workflow/headless-cli-orchestrator.js"],
        test_results: [{ command: "node --test test/headless-cli-orchestrator.test.js", status: "pass" }],
        durable_state_updated: true,
        process_hardening: { required: false, status: "not_required" },
        continuation_readiness: { ready: true },
        self_evaluation: { aligned: true, drifted: false, evidence_sufficient: true }
      }));
      return {
        status: 0,
        stdout: "",
        stderr: ""
      };
    }
  });
  const prompt = calls[0].prompt;
  const childOutput = result.child_run.artifact.metadata.package_results[0].completion_evidence.child_output;

  assert.equal(result.status, "pass");
  assert.equal(calls.length, 1);
  assert.match(calls[0].output_path, /child-headless-cli-orchestrator-adapter-run-headless-cli-cycle-headless-output-path\.json$/);
  assert.match(prompt, /Final response protocol:/);
  assert.match(prompt, /Write exactly one JSON object to child_worker_output_path:/);
  assert.match(prompt, /Also print exactly the same JSON object as the final stdout content/);
  assert.equal(childOutput.command_evidence.output_path, calls[0].output_path);
  assert.equal(childOutput.command_evidence.stdout_present, false);
});
