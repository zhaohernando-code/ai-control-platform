import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import test from "node:test";

import { createWorkbenchServer } from "../tools/workbench-server.mjs";

mkdirSync("tmp", { recursive: true });

function writeManualAgentConfig(dir) {
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
      }
    ]
  }, null, 2)}\n`);
  return configPath;
}

async function withServer(fn, options = {}) {
  const server = createWorkbenchServer({ allowFixtureFileState: true, ...options });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();

  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, {
      method: options.method || "GET",
      headers: options.headers || {}
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: body,
          json: () => JSON.parse(body)
        });
      });
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test("workbench server manages agent keys without returning raw secrets", async () => {
  mkdirSync("tmp", { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), "tmp/workbench-agent-api-"));
  const previousManualConfig = process.env.MANUAL_AGENT_CONFIG;
  process.env.MANUAL_AGENT_CONFIG = writeManualAgentConfig(dir);
  try {
    await withServer(async (baseUrl) => {
      const initial = await request(`${baseUrl}/api/workbench/agents`);
      const initialJson = initial.json();
      assert.equal(initial.status, 200);
      assert.equal(initialJson.agents.find((agent) => agent.id === "codex-account").account_login, true);
      assert.equal(initialJson.agents.find((agent) => agent.id === "codex-account").keys.length, 0);
      assert.equal(initialJson.agents.find((agent) => agent.id === "codex-account").account_health.status, "unknown");

      const created = await request(`${baseUrl}/api/workbench/agent-keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "key-server-main",
          agent_id: "codex-token",
          alias: "server-main",
          key: "sk-server-secret-1234567890",
          competitive: false,
          created_at: "2026-05-28T02:00:00.000Z"
        })
      });
      const createdBody = created.json();
      assert.equal(created.status, 201);
      assert.equal(JSON.stringify(createdBody).includes("sk-server-secret-1234567890"), false);
      assert.equal(createdBody.registry.agents.find((agent) => agent.id === "codex-token").key_counts.total, 1);

      const health = await request(`${baseUrl}/api/workbench/agent-keys/key-server-main/health-check`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ checked_at: "2026-05-28T02:01:00.000Z" })
      });
      assert.equal(health.status, 201);
      assert.equal(health.json().checked[0].status, "success");

      const accountHealth = await request(`${baseUrl}/api/workbench/agents/codex-account/health-check`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ checked_at: "2026-05-28T02:01:30.000Z" })
      });
      assert.equal(accountHealth.status, 201);
      assert.equal(accountHealth.json().checked[0].kind, "account");

      const afterHealth = (await request(`${baseUrl}/api/workbench/agents`)).json();
      const codexToken = afterHealth.agents.find((agent) => agent.id === "codex-token");
      const codexAccount = afterHealth.agents.find((agent) => agent.id === "codex-account");
      assert.equal(codexToken.status, "success");
      assert.equal(codexAccount.status, "success");
      assert.equal(codexToken.key_counts.available, 1);
      assert.equal(codexAccount.key_counts.total, 0);
      assert.equal(JSON.stringify(afterHealth).includes("sk-server-secret-1234567890"), false);

      const roles = await request(`${baseUrl}/api/workbench/agents/codex-token/roles`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          roles: {
            plan_generation: true,
            task_scheduling: false,
            code_implementation: true,
            acceptance_check: false,
            recovery_locator: true
          }
        })
      });
      assert.equal(roles.status, 200);
      assert.equal(roles.json().registry.agents.find((agent) => agent.id === "codex-token").roles.task_scheduling, false);

      const deleted = await request(`${baseUrl}/api/workbench/agent-keys/key-server-main`, { method: "DELETE" });
      assert.equal(deleted.status, 200);
      assert.equal(deleted.json().registry.agents.find((agent) => agent.id === "codex-token").key_counts.total, 0);
    }, {
      stateDbPath: join(dir, "workbench-state.sqlite"),
      agentHealthFetch: async () => ({ ok: true, status: 200, text: async () => "{}" }),
      agentAccountHealthRunner: async () => ({ exitCode: 0, stdout: "{}", stderr: "", latency_ms: 6 }),
      disableAgentHealthTimer: true
    });
  } finally {
    if (previousManualConfig === undefined) {
      delete process.env.MANUAL_AGENT_CONFIG;
    } else {
      process.env.MANUAL_AGENT_CONFIG = previousManualConfig;
    }
  }
});

test("workbench server agent key routes fail closed without SQLite state", async () => {
  await withServer(async (baseUrl) => {
    const agents = await request(`${baseUrl}/api/workbench/agents`);
    assert.equal(agents.status, 503);
    assert.equal(agents.json().error, "agent key store requires SQLite workbench state");

    const createKey = await request(`${baseUrl}/api/workbench/agent-keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "key", agent_id: "codex-token", key: "sk-test" })
    });
    assert.equal(createKey.status, 503);
    assert.equal(createKey.json().error, "agent key store requires SQLite workbench state");
  }, {
    stateStore: null,
    stateDbPath: null,
    disableAgentHealthTimer: true
  });
});
