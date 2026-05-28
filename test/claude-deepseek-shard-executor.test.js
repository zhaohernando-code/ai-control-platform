import assert from "node:assert/strict";
import test from "node:test";

import {
  createAgentReviewerShardCommand,
  createAgentReviewerShardExecutor,
  parseAgentReviewerFindings
} from "../src/workflow/agent-reviewer-shard-executor.js";

function shard(overrides = {}) {
  return {
    id: "reviewer-scope-shard-001",
    model: "deepseek-v4-pro[1m]",
    allowed_tools: [],
    timeout_seconds: 180,
    ...overrides
  };
}

test("agent reviewer shard command uses governed profile and shard limits", () => {
  const command = createAgentReviewerShardCommand({
    shard: shard({ allowed_tools: ["Read", "Grep"], timeout_seconds: 300 }),
    prompt: "review this shard",
    cwd: "/repo"
  });

  assert.equal(command.command, "claude");
  assert.equal(command.profile_id, "reviewer_shard");
  assert.ok(command.args.includes("--allowedTools"));
  assert.ok(command.args.includes("Read,Grep"));
  assert.ok(command.args.includes("--add-dir"));
  assert.ok(command.args.includes("/repo"));
  assert.equal(command.timeout_seconds, 300);
});

test("agent reviewer finding parser accepts arrays, objects, and fenced json", () => {
  assert.deepEqual(parseAgentReviewerFindings('[{"id":"a","status":"pass"}]'), [{ id: "a", status: "pass" }]);
  assert.deepEqual(parseAgentReviewerFindings('```json\n{"findings":[{"id":"b","status":"fail"}]}\n```'), [{ id: "b", status: "fail" }]);
  assert.deepEqual(parseAgentReviewerFindings("plain text"), []);
});

test("agent reviewer shard executor returns structured findings from stdout", async () => {
  const calls = [];
  const executor = createAgentReviewerShardExecutor({
    cwd: "/repo",
    commandRunner: (command, args, options) => {
      calls.push({ command, args, options });
      return {
        status: 0,
        stdout: JSON.stringify([{ id: "ds-finding", status: "fail", severity: "medium", category: "reviewer", message: "issue" }]),
        stderr: ""
      };
    }
  });

  const result = await executor({ shard: shard(), prompt: "review this shard" });

  assert.equal(result.status, "fail");
  assert.equal(result.findings[0].id, "ds-finding");
  assert.equal(result.provenance.executor_kind, "agent_invocation");
  assert.equal(result.provenance.model, "deepseek-v4-pro[1m]");
  assert.equal(result.provenance.external_call_budget_used, 1);
  assert.equal(calls[0].command, "claude");
  assert.equal(calls[0].options.cwd, "/repo");
});

test("agent reviewer shard executor converts timeouts into reviewer timeout findings", async () => {
  const executor = createAgentReviewerShardExecutor({
    commandRunner: () => ({
      status: null,
      stdout: "",
      stderr: "",
      error: { code: "ETIMEDOUT", message: "timed out" }
    })
  });

  const result = await executor({ shard: shard({ timeout_seconds: 45 }), prompt: "review this shard" });

  assert.equal(result.status, "fail");
  assert.equal(result.findings[0].category, "reviewer_timeout");
  assert.equal(result.provenance.timeout_seconds, 45);
  assert.match(result.findings[0].message, /45s/);
});

test("agent reviewer shard executor treats unstructured success as evidence gap failure", async () => {
  const executor = createAgentReviewerShardExecutor({
    commandRunner: () => ({
      status: 0,
      stdout: "没有发现问题",
      stderr: ""
    })
  });

  const result = await executor({ shard: shard(), prompt: "review this shard" });

  assert.equal(result.status, "fail");
  assert.equal(result.findings[0].status, "fail");
  assert.equal(result.findings[0].category, "evidence_gap");
  assert.match(result.findings[0].message, /structured findings are required/);
});
