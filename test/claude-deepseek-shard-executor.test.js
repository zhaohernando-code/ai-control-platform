import assert from "node:assert/strict";
import test from "node:test";

import {
  createClaudeDeepSeekShardCommand,
  createClaudeDeepSeekShardExecutor,
  DEFAULT_DEEPSEEK_REVIEW_SCRIPT,
  parseClaudeDeepSeekFindings
} from "../src/workflow/claude-deepseek-shard-executor.js";

function shard(overrides = {}) {
  return {
    id: "reviewer-scope-shard-001",
    model: "deepseek-v4-pro[1m]",
    allowed_tools: [],
    timeout_seconds: 180,
    ...overrides
  };
}

test("claude deepseek shard command uses canonical wrapper script and shard limits", () => {
  const command = createClaudeDeepSeekShardCommand({
    shard: shard({ allowed_tools: ["Read", "Grep"], timeout_seconds: 300 }),
    prompt_file: "/tmp/shard.md",
    cwd: "/repo"
  });

  assert.equal(command.command, "python3");
  assert.equal(command.args[0], DEFAULT_DEEPSEEK_REVIEW_SCRIPT);
  assert.ok(command.args.includes("--prompt-file"));
  assert.ok(command.args.includes("/tmp/shard.md"));
  assert.ok(command.args.includes("--tools"));
  assert.ok(command.args.includes("Read,Grep"));
  assert.ok(command.args.includes("--timeout-seconds"));
  assert.ok(command.args.includes("300"));
  assert.ok(command.args.includes("--add-dir"));
  assert.ok(command.args.includes("/repo"));
});

test("claude deepseek finding parser accepts arrays, objects, and fenced json", () => {
  assert.deepEqual(parseClaudeDeepSeekFindings('[{"id":"a","status":"pass"}]'), [{ id: "a", status: "pass" }]);
  assert.deepEqual(parseClaudeDeepSeekFindings('```json\n{"findings":[{"id":"b","status":"fail"}]}\n```'), [{ id: "b", status: "fail" }]);
  assert.deepEqual(parseClaudeDeepSeekFindings("plain text"), []);
});

test("claude deepseek shard executor returns structured findings from stdout", async () => {
  const calls = [];
  const executor = createClaudeDeepSeekShardExecutor({
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
  assert.equal(calls[0].command, "python3");
  assert.equal(calls[0].options.cwd, "/repo");
});

test("claude deepseek shard executor converts timeouts into reviewer timeout findings", async () => {
  const executor = createClaudeDeepSeekShardExecutor({
    commandRunner: () => ({
      status: 124,
      stdout: "",
      stderr: "CLAUDE_DEEPSEEK_TIMEOUT"
    })
  });

  const result = await executor({ shard: shard({ timeout_seconds: 45 }), prompt: "review this shard" });

  assert.equal(result.status, "fail");
  assert.equal(result.findings[0].category, "reviewer_timeout");
  assert.match(result.findings[0].message, /45s/);
});

test("claude deepseek shard executor treats unstructured success as pass evidence", async () => {
  const executor = createClaudeDeepSeekShardExecutor({
    commandRunner: () => ({
      status: 0,
      stdout: "没有发现问题",
      stderr: ""
    })
  });

  const result = await executor({ shard: shard(), prompt: "review this shard" });

  assert.equal(result.status, "pass");
  assert.equal(result.findings[0].status, "pass");
  assert.match(result.findings[0].message, /没有发现问题/);
});
