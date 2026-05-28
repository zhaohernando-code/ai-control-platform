import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { checkAgentKeyHealth, runAgentHealthCheck } from "../src/workflow/agent-health-checker.js";
import { createAgentKeyStore, maskSecret } from "../src/workflow/agent-key-store.js";

function tempStore() {
  mkdirSync("tmp", { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), "tmp/agent-key-store-"));
  const configPath = join(dir, "manual_agent_config.json");
  writeFileSync(configPath, `${JSON.stringify({
    version: 1,
    channels: [
      {
        id: "codex-account",
        label: "Codex account login",
        runner: "codex",
        default_model: "gpt-5.5",
        auth: { type: "codex_account" }
      },
      {
        id: "codex-token",
        label: "Codex token proxy API",
        runner: "codex",
        base_url: "https://proxy.example.test",
        default_model: "gpt-5.5",
        auth: { type: "openai_api_key" }
      },
      {
        id: "deepseek",
        label: "Claude Code via DeepSeek",
        runner: "claude",
        base_url: "https://api.deepseek.example/anthropic",
        default_model: "deepseek-v4-pro[1m]",
        auth: { type: "anthropic_api_key" }
      }
    ]
  }, null, 2)}\n`);
  return createAgentKeyStore({
    dbPath: join(dir, "workbench-state.sqlite"),
    manualAgentConfigPath: configPath
  });
}

test("masks secrets and never imports manual config tokens as API keys", () => {
  const store = tempStore();
  const registry = store.listAgents();

  assert.equal(maskSecret("sk-1234567890abcdef"), "sk-1...cdef");
  assert.equal(registry.agents.find((agent) => agent.id === "codex-account").account_login, true);
  assert.equal(registry.agents.find((agent) => agent.id === "codex-account").keys.length, 0);
  assert.equal(registry.agents.find((agent) => agent.id === "codex-token").keys.length, 0);
});

test("adds, soft-deletes, and aggregates agent key health without exposing secret", () => {
  const store = tempStore();
  const added = store.addAgentKey({
    id: "key-codex-token-main",
    agent_id: "codex-token",
    alias: "main",
    key: "sk-test-secret-1234567890",
    competitive: true
  }, "2026-05-28T01:00:00.000Z");

  assert.equal(added.status, "created");
  assert.equal(added.key.masked_secret, "sk-tes...7890");
  assert.equal(Object.prototype.hasOwnProperty.call(added.key, "secret"), false);

  let registry = store.listAgents();
  let agent = registry.agents.find((entry) => entry.id === "codex-token");
  assert.equal(agent.status, "unknown");
  assert.equal(agent.key_counts.total, 1);
  assert.equal(agent.keys[0].masked_secret, "sk-tes...7890");
  assert.equal(Object.prototype.hasOwnProperty.call(agent.keys[0], "secret"), false);

  const health = store.recordAgentKeyHealth({
    key_id: "key-codex-token-main",
    status: "success",
    latency_ms: 42
  }, "2026-05-28T01:01:00.000Z");
  assert.equal(health.status, "recorded");

  registry = store.listAgents();
  agent = registry.agents.find((entry) => entry.id === "codex-token");
  assert.equal(agent.status, "success");
  assert.equal(agent.key_counts.available, 1);

  const deleted = store.deleteAgentKey("key-codex-token-main", "2026-05-28T01:02:00.000Z");
  assert.equal(deleted.status, "deleted");
  assert.equal(store.listAgents().agents.find((entry) => entry.id === "codex-token").key_counts.total, 0);
});

test("aggregates partial and failed agent health", () => {
  const store = tempStore();
  store.addAgentKey({ id: "key-ok", agent_id: "deepseek", alias: "ok", key: "sk-ok", competitive: true }, "2026-05-28T01:00:00.000Z");
  store.addAgentKey({ id: "key-bad", agent_id: "deepseek", alias: "bad", key: "sk-bad", competitive: true }, "2026-05-28T01:00:01.000Z");
  store.recordAgentKeyHealth({ key_id: "key-ok", status: "success" }, "2026-05-28T01:01:00.000Z");
  store.recordAgentKeyHealth({ key_id: "key-bad", status: "error", error_summary: "401" }, "2026-05-28T01:01:01.000Z");

  const deepseek = store.listAgents().agents.find((agent) => agent.id === "deepseek");
  assert.equal(deepseek.status, "warning");
  assert.equal(deepseek.key_counts.available, 1);

  store.recordAgentKeyHealth({ key_id: "key-ok", status: "error", error_summary: "401" }, "2026-05-28T01:02:00.000Z");
  assert.equal(store.listAgents().agents.find((agent) => agent.id === "deepseek").status, "error");
});

test("role-based acquisition skips unhealthy keys and locks non-competitive keys", () => {
  const store = tempStore();
  store.addAgentKey({ id: "key-unhealthy", agent_id: "codex-token", alias: "bad", key: "sk-bad", competitive: true }, "2026-05-28T01:00:00.000Z");
  store.addAgentKey({ id: "key-locked", agent_id: "codex-token", alias: "locked", key: "sk-good", competitive: false }, "2026-05-28T01:00:01.000Z");
  store.updateAgentRoles("codex-token", {
    plan_generation: true,
    task_scheduling: false,
    code_implementation: false,
    acceptance_check: false,
    recovery_locator: false
  });
  store.recordAgentKeyHealth({ key_id: "key-unhealthy", status: "error" }, "2026-05-28T01:01:00.000Z");
  store.recordAgentKeyHealth({ key_id: "key-locked", status: "success" }, "2026-05-28T01:01:01.000Z");

  const acquired = store.acquireAgentKeyForRole("plan_generation", {
    lock_owner: "task-1",
    now: "2026-05-28T01:02:00.000Z",
    ttl_ms: 600000
  });
  assert.equal(acquired.status, "acquired");
  assert.equal(acquired.key.id, "key-locked");
  assert.equal(acquired.key.secret, "sk-good");

  const second = store.acquireAgentKeyForRole("plan_generation", {
    lock_owner: "task-2",
    now: "2026-05-28T01:03:00.000Z",
    ttl_ms: 600000
  });
  assert.equal(second.status, "blocked");

  store.releaseAgentKeyLock("key-locked", "task-1");
  assert.equal(store.acquireAgentKeyForRole("plan_generation", {
    lock_owner: "task-3",
    now: "2026-05-28T01:04:00.000Z"
  }).status, "acquired");
});

test("health checker uses provider-specific lightweight requests and redacts failures", async () => {
  const calls = [];
  const openai = await checkAgentKeyHealth({
    provider: "openai",
    base_url: "https://proxy.example.test",
    secret: "sk-secret-openai"
  }, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => "{}" };
    }
  });
  assert.equal(openai.status, "success");
  assert.equal(calls[0].url, "https://proxy.example.test/v1/models");
  assert.equal(calls[0].init.method, "GET");

  const anthropic = await checkAgentKeyHealth({
    provider: "anthropic",
    base_url: "https://api.deepseek.example/anthropic",
    secret: "sk-secret-anthropic",
    default_model: "deepseek-v4-pro[1m]"
  }, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: false, status: 401, text: async () => "bad sk-secret-anthropic" };
    }
  });
  assert.equal(anthropic.status, "error");
  assert.equal(calls[1].url, "https://api.deepseek.example/anthropic/v1/messages");
  assert.equal(calls[1].init.method, "POST");
  assert.equal(anthropic.error_summary.includes("sk-secret-anthropic"), false);
});

test("runAgentHealthCheck records full registry refresh", async () => {
  const store = tempStore();
  store.addAgentKey({ id: "key-run", agent_id: "codex-token", alias: "run", key: "sk-run", competitive: true }, "2026-05-28T01:00:00.000Z");

  const result = await runAgentHealthCheck(store, {
    checked_at: "2026-05-28T01:05:00.000Z"
  }, {
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => "{}" })
  });

  assert.equal(result.status, "completed");
  assert.equal(result.checked.length, 1);
  assert.equal(result.registry.last_refresh_at, "2026-05-28T01:05:00.000Z");
  assert.equal(result.registry.agents.find((agent) => agent.id === "codex-token").status, "success");
});
