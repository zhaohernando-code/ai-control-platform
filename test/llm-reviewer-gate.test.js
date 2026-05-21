import assert from "node:assert/strict";
import test from "node:test";

import {
  createReviewerTimeoutFinding,
  createReviewerGateRequest,
  normalizeReviewerFindings,
  summarizeReviewerGate,
  validateReviewerGateRequest
} from "../src/workflow/llm-reviewer-gate.js";
import { decideNextAction, RERUN } from "../src/workflow/autonomous-run.js";

function validRequest(overrides = {}) {
  return createReviewerGateRequest({
    run_id: "run-review",
    cycle_id: "cycle-20260521",
    provider: {
      provider: "claude-code",
      model: "deepseek-v4-pro",
      cost_tier: "medium",
      accuracy_tier: "high",
      tooling: "read-only"
    },
    scope: "Review AI Control Platform workflow gates for drift risks.",
    files: [
      "src/workflow/run-manifest.js",
      "src/workflow/task-dag.js",
      "src/workflow/goal-guard.js"
    ],
    questions: [
      "是否存在平台需求写入业务项目的漏洞？",
      "review findings 是否能进入 autonomous-run？"
    ],
    forbidden_actions: ["no edits", "no write-capable tools", "no destructive commands"],
    ...overrides
  });
}

test("creates a valid Claude Code and DeepSeek reviewer gate request", () => {
  const request = validRequest();
  const validation = validateReviewerGateRequest(request);

  assert.equal(validation.status, "pass");
  assert.equal(request.provider.provider, "claude-code");
  assert.equal(request.provider.model, "deepseek-v4-pro");
  assert.equal(request.read_only, true);
  assert.deepEqual(request.allowed_tools, ["read", "grep", "glob"]);
});

test("reviewer gate request fails without scope files or questions", () => {
  const validation = validateReviewerGateRequest(
    validRequest({
      scope: "",
      files: [],
      questions: []
    })
  );

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some((issue) => issue.code === "missing_required_field" && issue.path === "scope"));
  assert.ok(validation.issues.some((issue) => issue.code === "missing_files"));
  assert.ok(validation.issues.some((issue) => issue.code === "missing_questions"));
});

test("reviewer gate rejects write-capable tooling", () => {
  const validation = validateReviewerGateRequest(
    validRequest({
      read_only: false,
      allowed_tools: ["Read", "Edit"]
    })
  );

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some((issue) => issue.code === "reviewer_not_read_only"));
  assert.ok(validation.issues.some((issue) => issue.code === "write_capable_tooling_forbidden"));
});

test("critical reviewer finding normalizes to rollback signal", () => {
  const findings = normalizeReviewerFindings(
    [
      {
        id: "host-drift",
        status: "fail",
        category: "host_boundary",
        severity: "critical",
        message: "Platform work can still land in stock_dashboard."
      }
    ],
    validRequest()
  );

  assert.equal(findings[0].finding_id, "host-drift");
  assert.equal(findings[0].requires_rollback, true);
  assert.equal(findings[0].requires_human, false);
});

test("credentials reviewer finding normalizes to human intervention signal", () => {
  const findings = normalizeReviewerFindings(
    [
      {
        id: "missing-token",
        status: "fail",
        category: "credentials",
        severity: "high",
        message: "Reviewer cannot access required credentials."
      }
    ],
    validRequest()
  );

  assert.equal(findings[0].requires_human, true);
});

test("reviewer gate summary is suitable for workbench projection", () => {
  const summary = summarizeReviewerGate({
    request: validRequest(),
    findings: [
      { id: "minor", status: "fail", category: "reviewer", severity: "medium", message: "Add one focused test." },
      { id: "ok", status: "pass", category: "reviewer", severity: "info", message: "Host boundary looks aligned." }
    ]
  });

  assert.equal(summary.provider, "claude-code");
  assert.equal(summary.model, "deepseek-v4-pro");
  assert.equal(summary.status, "fail");
  assert.equal(summary.counts.total, 2);
  assert.equal(summary.counts.failed, 1);
  assert.equal(summary.max_severity, "medium");
  assert.equal(summary.recommended_decision_signal, "rerun");
});

test("reviewer timeout becomes a recoverable autonomous-run finding", () => {
  const finding = createReviewerTimeoutFinding(validRequest(), 120);
  const decision = decideNextAction({
    run_id: "run-review",
    cycle_id: "cycle-20260521",
    work_packages: [{ id: "reviewer-gate", status: "completed" }],
    artifacts: [],
    gate_results: [],
    review_findings: [finding],
    recovery_attempts: []
  });

  assert.equal(finding.status, "fail");
  assert.equal(finding.category, "reviewer_timeout");
  assert.equal(finding.requires_rollback, false);
  assert.equal(finding.requires_human, false);
  assert.equal(decision.status, RERUN);
});
