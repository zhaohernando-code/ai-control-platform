import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultHeadlessChildWorkerOutput,
  evaluateHeadlessChildWorkerOutput,
  missingHeadlessChildWorkerOutput,
  parseHeadlessChildWorkerOutput
} from "../src/workflow/headless-child-acceptance.js";

test("defaultHeadlessChildWorkerOutput produces acceptable bounded evidence", () => {
  const workPackage = { id: "pkg-a", owned_files: ["src/workflow"] };
  const output = defaultHeadlessChildWorkerOutput(workPackage, {
    acceptance_gates: ["node --test test/headless-cli-orchestrator.test.js"]
  });
  const evaluation = evaluateHeadlessChildWorkerOutput(workPackage, output);

  assert.equal(evaluation.status, "pass");
  assert.deepEqual(output.changed_files, ["src/workflow"]);
});

test("missingHeadlessChildWorkerOutput fails closed", () => {
  const output = missingHeadlessChildWorkerOutput({ id: "pkg-a" });
  const evaluation = evaluateHeadlessChildWorkerOutput({
    id: "pkg-a",
    owned_files: ["src/workflow"]
  }, output);

  assert.equal(evaluation.status, "fail");
  assert.ok(evaluation.issues.some((issue) => issue.code === "child_worker_status_not_pass"));
  assert.ok(evaluation.issues.some((issue) => issue.code === "child_worker_no_diff"));
  assert.equal(output.command_evidence.reason, "headless main orchestrator must not use implicit mock child output");
});

test("parseHeadlessChildWorkerOutput accepts raw objects, fenced json, and embedded json only", () => {
  const raw = { status: "pass" };

  assert.equal(parseHeadlessChildWorkerOutput(raw), raw);
  assert.equal(parseHeadlessChildWorkerOutput("plain prose"), null);
  assert.deepEqual(parseHeadlessChildWorkerOutput("```json\n{\"status\":\"pass\"}\n```"), { status: "pass" });
  assert.deepEqual(parseHeadlessChildWorkerOutput("result: {\"status\":\"pass\"} ok"), { status: "pass" });
});

test("no-diff output passes only with mainline integration evidence", () => {
  const workPackage = { id: "pkg-a", owned_files: ["."] };
  const baseOutput = {
    status: "pass",
    host: "platform_core",
    no_diff: true,
    changed_files: [],
    test_results: [{ command: "node --test test/headless-cli-orchestrator.test.js", status: "pass" }],
    durable_state_updated: true,
    process_hardening: { required: false, status: "not_required" },
    continuation_readiness: { ready: true },
    self_evaluation: { aligned: true, drifted: false },
    command_evidence: {
      exit_code: 0,
      child_worker_integration: {
        required: true,
        status: "pass",
        message: "primary worktree already satisfying requested package"
      }
    }
  };

  assert.equal(evaluateHeadlessChildWorkerOutput(workPackage, baseOutput).status, "pass");

  const rejected = evaluateHeadlessChildWorkerOutput(workPackage, {
    ...baseOutput,
    command_evidence: { exit_code: 0 }
  });
  assert.equal(rejected.status, "fail");
  assert.ok(rejected.issues.some((issue) => issue.code === "child_worker_no_diff"));
});
