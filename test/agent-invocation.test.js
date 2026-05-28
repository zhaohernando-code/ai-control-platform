import assert from "node:assert/strict";
import test from "node:test";

import {
  createAgentInvocationPlan,
  loadAgentInvocationConfig,
  redactInvocationText,
  runAgentInvocation
} from "../src/workflow/agent-invocation.js";

test("agent invocation config exposes project-owned channels and profiles", () => {
  const config = loadAgentInvocationConfig();

  assert.ok(config.channels.some((channel) => channel.id === "deepseek"));
  assert.ok(config.channels.some((channel) => channel.id === "codex-account"));
  assert.ok(config.profiles.requirement_plan_generation);
  assert.ok(config.profiles.reviewer_shard);
  assert.ok(config.profiles.context_work_package_provider);
});

test("requirement plan invocation builds direct claude command without wrapper scripts", () => {
  const plan = createAgentInvocationPlan({
    profile_id: "requirement_plan_generation",
    prompt: "Return a plan.",
    candidate_index: 1
  });

  assert.equal(plan.status, "pass");
  assert.equal(plan.invocation.command, "claude");
  assert.equal(plan.invocation.agent_id, "deepseek");
  assert.equal(plan.invocation.model, "deepseek-v4-pro[1m]");
  assert.ok(plan.invocation.args.includes("--bare"));
  assert.ok(plan.invocation.args.includes("--output-format"));
  assert.ok(plan.invocation.args.includes("json"));
  assert.ok(!plan.invocation.args.join(" ").includes("claude-role-proxy"));
  assert.ok(!plan.invocation.args.join(" ").includes("run_claude"));
});

test("codex account invocation uses codex exec profile without API key acquisition", () => {
  const stateStore = {
    acquireAgentKeyForRole() {
      throw new Error("codex account should not acquire API key");
    }
  };
  const plan = createAgentInvocationPlan({
    profile_id: "development_flow_codex",
    prompt: "Fix fixture.",
    cwd: process.cwd(),
    output_schema: "/tmp/schema.json",
    output_path: "/tmp/output.json"
  }, { stateStore });

  assert.equal(plan.status, "pass");
  assert.equal(plan.invocation.command, "codex");
  assert.equal(plan.invocation.runner, "codex");
  assert.equal(plan.invocation.agent_id, "codex-account");
  assert.ok(plan.invocation.args.includes("exec"));
  assert.ok(!plan.invocation.args.includes("--ephemeral"));
  assert.ok(plan.invocation.args.includes("--output-schema"));
});

test("agent invocation acquires preferred agent key and redacts secret output", () => {
  const stateStore = {
    acquireAgentKeyForRole(role, options) {
      assert.equal(role, "acceptance_check");
      assert.equal(options.agent_id, "deepseek");
      return {
        status: "acquired",
        key: {
          id: "key-1",
          secret: "sk-secret-value",
          lock: { lock_owner: options.lock_owner }
        }
      };
    },
    releaseAgentKeyLock(keyId, owner) {
      assert.equal(keyId, "key-1");
      assert.ok(owner);
      return { status: "released" };
    }
  };
  const result = runAgentInvocation({
    profile_id: "reviewer_shard",
    prompt: "Return findings.",
    invocation_id: "reviewer-test",
    candidate_index: 0
  }, {
    stateStore,
    commandRunner: () => ({
      status: 0,
      stdout: JSON.stringify([{ id: "a", status: "pass", evidence: "sk-secret-value" }]),
      stderr: "sk-secret-value"
    })
  });

  assert.equal(result.status, "pass");
  assert.equal(result.invocation.key.secret, undefined);
  assert.equal(result.stdout.includes("sk-secret-value"), false);
  assert.equal(result.stderr.includes("sk-secret-value"), false);
  assert.match(result.stdout, /REDACTED/);
});

test("redactInvocationText removes API secrets from arbitrary text", () => {
  assert.equal(
    redactInvocationText("before token after", { key: { secret: "token" } }),
    "before [REDACTED] after"
  );
});
