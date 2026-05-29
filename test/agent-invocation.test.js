import assert from "node:assert/strict";
import { dirname } from "node:path";
import test from "node:test";

import {
  createAgentInvocationPlan,
  loadAgentInvocationConfig,
  redactInvocationText,
  runCommandWithIdleTimeout,
  runAgentInvocation
} from "../src/workflow/agent-invocation.js";

function availableAgentStateStore() {
  return {
    acquireAgentKeyForRole(role, options) {
      return {
        status: "acquired",
        key: {
          id: `key-${options.agent_id}`,
          secret: `secret-${options.agent_id}-${role}`,
          lock: { lock_owner: options.lock_owner }
        }
      };
    },
    releaseAgentKeyLock() {
      return { status: "released" };
    },
    listAgents() {
      return {
        agents: [
          {
            id: "codex-account",
            status: "success",
            account_login: true,
            account_health: { status: "success" }
          }
        ]
      };
    }
  };
}

test("agent invocation config exposes project-owned channels and profiles", () => {
  const config = loadAgentInvocationConfig();

  assert.ok(config.channels.some((channel) => channel.id === "deepseek"));
  assert.ok(config.channels.some((channel) => channel.id === "codex-account"));
  assert.ok(config.profiles.requirement_plan_generation);
  assert.ok(config.profiles.reviewer_shard);
  assert.ok(config.profiles.context_work_package_provider);
  assert.equal(config.profiles.context_work_package_provider.max_budget_usd, undefined);
  assert.equal(config.profiles.development_flow_codex.candidates[0].model, "gpt-5.5");
  assert.equal(config.profiles.governance_audit_skill_trial.max_budget_usd, undefined);
  assert.equal(config.profiles.governance_audit_skill_trial.candidates[0].agent_id, "deepseek");
});

test("requirement plan invocation builds direct claude command without wrapper scripts", () => {
  const plan = createAgentInvocationPlan({
    profile_id: "requirement_plan_generation",
    prompt: "Return a plan.",
    candidate_index: 1
  }, {
    stateStore: availableAgentStateStore()
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

test("agent invocation blocks every configured agent without governed credential state", () => {
  const cases = [
    { profile_id: "development_flow_codex", agent_id: "codex-account" },
    { profile_id: "development_flow_codex", agent_id: "codex-token" },
    { profile_id: "requirement_plan_generation", agent_id: "claude" },
    { profile_id: "requirement_plan_generation", agent_id: "deepseek" },
    { profile_id: "requirement_plan_generation", agent_id: "xiaomi-mimo" }
  ];

  for (const item of cases) {
    const plan = createAgentInvocationPlan({
      profile_id: item.profile_id,
      agent_id: item.agent_id,
      prompt: "Return ok."
    });
    assert.equal(plan.status, "blocked", item.agent_id);
    assert.ok(plan.issues.some((issue) => issue.code === "agent_state_store_required"), item.agent_id);
  }
});

test("all configured available agents use the same governed credential chain", () => {
  const cases = [
    { profile_id: "development_flow_codex", agent_id: "codex-account", expected_env: null },
    { profile_id: "development_flow_codex", agent_id: "codex-token", expected_env: "OPENAI_API_KEY" },
    { profile_id: "requirement_plan_generation", agent_id: "claude", expected_env: "ANTHROPIC_API_KEY" },
    { profile_id: "requirement_plan_generation", agent_id: "deepseek", expected_env: "ANTHROPIC_API_KEY" },
    { profile_id: "requirement_plan_generation", agent_id: "xiaomi-mimo", expected_env: "ANTHROPIC_API_KEY" }
  ];

  for (const item of cases) {
    const plan = createAgentInvocationPlan({
      profile_id: item.profile_id,
      agent_id: item.agent_id,
      prompt: "Return ok.",
      invocation_id: `agent-${item.agent_id}`
    }, {
      stateStore: availableAgentStateStore()
    });
    assert.equal(plan.status, "pass", item.agent_id);
    assert.equal(plan.invocation.agent_id, item.agent_id);
    if (item.expected_env) {
      assert.match(plan.invocation.env[item.expected_env], new RegExp(`secret-${item.agent_id}`), item.agent_id);
    } else {
      assert.equal(plan.invocation.env.ANTHROPIC_API_KEY, undefined, item.agent_id);
      assert.equal(plan.invocation.env.OPENAI_API_KEY, undefined, item.agent_id);
    }
  }
});

test("explicit model selection resolves to a channel that supports that model", () => {
  const plan = createAgentInvocationPlan({
    profile_id: "context_work_package_provider",
    model: "deepseek-v4-flash",
    prompt: "Return ok."
  }, {
    stateStore: availableAgentStateStore()
  });

  assert.equal(plan.status, "pass");
  assert.equal(plan.invocation.agent_id, "deepseek");
  assert.equal(plan.invocation.model, "deepseek-v4-flash");
});

test("context work package provider invocation has no local max budget cap", () => {
  const plan = createAgentInvocationPlan({
    profile_id: "context_work_package_provider",
    prompt: "Return ok.",
    candidate_index: 0
  }, {
    stateStore: availableAgentStateStore()
  });

  assert.equal(plan.status, "pass");
  assert.ok(!plan.invocation.args.includes("--max-budget-usd"));
});

test("codex account invocation uses codex exec profile without API key acquisition", () => {
  const stateStore = {
    acquireAgentKeyForRole() {
      throw new Error("codex account should not acquire API key");
    },
    listAgents() {
      return {
        agents: [
          {
            id: "codex-account",
            status: "success",
            account_login: true,
            account_health: { status: "success" }
          }
        ]
      };
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
  assert.ok(plan.invocation.env.PATH.includes(dirname(process.execPath)));
  assert.ok(plan.invocation.env.PATH.includes(`${process.env.HOME}/.nvm/versions/node/v22.16.0/bin`));
  assert.ok(plan.invocation.env.PATH.includes("/Applications/Codex.app/Contents/Resources"));
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

test("idle-aware runner allows long-running commands that keep producing output", () => {
  const result = runCommandWithIdleTimeout(process.execPath, [
    "-e",
    "let n=0; const t=setInterval(()=>{ console.log('tick '+(++n)); if(n===3){ clearInterval(t); } }, 80);"
  ], {
    cwd: process.cwd(),
    env: process.env,
    timeout: 1000,
    idle_timeout_ms: 180
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /tick 3/);
  assert.equal(result.timed_out, false);
});

test("idle-aware runner times out commands that produce no intermediate output", () => {
  const result = runCommandWithIdleTimeout(process.execPath, [
    "-e",
    "setTimeout(()=>console.log('late'), 500);"
  ], {
    cwd: process.cwd(),
    env: process.env,
    timeout: 2000,
    idle_timeout_ms: 120
  });

  assert.equal(result.status, 1);
  assert.equal(result.error?.code, "ETIMEDOUT");
  assert.equal(result.timed_out, true);
  assert.doesNotMatch(result.stdout, /late/);
});
