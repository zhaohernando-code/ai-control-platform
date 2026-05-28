import assert from "node:assert/strict";
import test from "node:test";

import {
  DEVELOPMENT_FLOW_EVALUATION_VERSION,
  DEVELOPMENT_FLOW_RUNS,
  REQUIRED_DEVELOPMENT_FLOW_PHASES,
  evaluateDevelopmentFlowArtifact
} from "../src/workflow/development-flow-evaluation.js";

function phaseTrace() {
  return REQUIRED_DEVELOPMENT_FLOW_PHASES.map((phase) => ({
    phase,
    status: "pass",
    evidence_id: `evidence:${phase}`
  }));
}

function validRun(runId) {
  const runner = runId === "codex_cli" ? "codex" : "claude";
  return {
    status: "pass",
    phase_trace: phaseTrace(),
    agent_selection: { agent_id: runner, runner, model: runId === "codex_cli" ? "gpt-5.3-codex-spark" : "deepseek-v4-flash" },
    model_provenance: {
      runner,
      model: runId === "codex_cli" ? "gpt-5.3-codex-spark" : "deepseek-v4-flash",
      real_model_call: true,
      external_calls: 1
    },
    output_contract: { status: "pass", issues: [] },
    diff_summary: { has_diff: true, changed_files: ["src/math.js"] },
    test_results: [{ command: "node --test test/math.test.js", status: "pass" }],
    review_guard: { status: "pass", issues: [] },
    closeout: { status: "pass" },
    projection: { status: "pass" }
  };
}

function validArtifact() {
  return {
    version: DEVELOPMENT_FLOW_EVALUATION_VERSION,
    runs: Object.fromEntries(DEVELOPMENT_FLOW_RUNS.map((runId) => [runId, validRun(runId)]))
  };
}

test("development flow evaluator passes complete dual CLI artifact", () => {
  const result = evaluateDevelopmentFlowArtifact(validArtifact());

  assert.equal(result.status, "pass");
  assert.deepEqual(result.issues, []);
});

test("development flow evaluator fails when either CLI run is missing", () => {
  const artifact = validArtifact();
  delete artifact.runs.claude_cli;
  const result = evaluateDevelopmentFlowArtifact(artifact);

  assert.equal(result.status, "fail");
  assert.ok(result.issues.some((entry) => entry.code === "missing_development_flow_run" && entry.path === "runs.claude_cli"));
});

test("development flow evaluator fails missing and out-of-order phases", () => {
  const missing = validArtifact();
  missing.runs.codex_cli.phase_trace = missing.runs.codex_cli.phase_trace.filter((phase) => phase.phase !== "review_guard_checked");
  const missingResult = evaluateDevelopmentFlowArtifact(missing);

  assert.equal(missingResult.status, "fail");
  assert.ok(missingResult.issues.some((entry) => entry.code === "missing_development_flow_phase"));

  const outOfOrder = validArtifact();
  const trace = outOfOrder.runs.codex_cli.phase_trace;
  const approval = trace.findIndex((phase) => phase.phase === "plan_approved");
  const executed = trace.findIndex((phase) => phase.phase === "cli_child_worker_executed");
  [trace[approval], trace[executed]] = [trace[executed], trace[approval]];
  const outOfOrderResult = evaluateDevelopmentFlowArtifact(outOfOrder);

  assert.equal(outOfOrderResult.status, "fail");
  assert.ok(outOfOrderResult.issues.some((entry) => entry.code === "development_flow_phase_out_of_order"));
  assert.ok(outOfOrderResult.issues.some((entry) => entry.code === "unapproved_plan_execution"));
});

test("development flow evaluator requires real model provenance", () => {
  const artifact = validArtifact();
  artifact.runs.codex_cli.model_provenance.real_model_call = false;
  artifact.runs.codex_cli.model_provenance.external_calls = 0;
  const result = evaluateDevelopmentFlowArtifact(artifact);

  assert.equal(result.status, "fail");
  assert.ok(result.issues.some((entry) => entry.code === "missing_real_model_call_provenance"));
  assert.ok(result.issues.some((entry) => entry.code === "missing_external_call_count"));
});

test("development flow evaluator requires acceptance, guard, closeout, and projection evidence", () => {
  const artifact = validArtifact();
  artifact.runs.claude_cli.test_results = [];
  artifact.runs.claude_cli.review_guard.status = "fail";
  artifact.runs.claude_cli.closeout.status = "fail";
  artifact.runs.claude_cli.projection.status = "fail";
  const result = evaluateDevelopmentFlowArtifact(artifact);

  assert.equal(result.status, "fail");
  assert.ok(result.issues.some((entry) => entry.code === "missing_acceptance_test_pass"));
  assert.ok(result.issues.some((entry) => entry.code === "missing_review_guard_pass"));
  assert.ok(result.issues.some((entry) => entry.code === "missing_closeout_pass"));
  assert.ok(result.issues.some((entry) => entry.code === "missing_projection_pass"));
});

test("development flow evaluator rejects raw secrets in artifacts", () => {
  const artifact = validArtifact();
  artifact.runs.codex_cli.evidence = { leaked: "sk-abcdefghijklmnopqrstuvwxyz123456" };
  const result = evaluateDevelopmentFlowArtifact(artifact);

  assert.equal(result.status, "fail");
  assert.ok(result.issues.some((entry) => entry.code === "raw_secret_in_development_flow_artifact"));
});
