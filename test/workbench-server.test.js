import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import {
  createSchedulerDispatchRunArtifact,
  runSchedulerDispatchPlan
} from "../src/workflow/scheduler-dispatch-runner.js";
import { createSchedulerDispatchPlan } from "../src/workflow/scheduler-dispatch-plan.js";
import { createRunManifest } from "../src/workflow/run-manifest.js";
import { VERIFIED_PROVIDER_MULTI_AGENT_PROFILE } from "../src/workflow/context-work-package-execution-adapter.js";
import { assertWorkbenchProjectionSchema } from "../src/workflow/workbench-projection-schema.js";
import { createWorkbenchServer } from "../tools/workbench-server.mjs";
import { currentSessionWorkflowState } from "./helpers/current-session-workflow-state.js";

mkdirSync("tmp", { recursive: true });

function currentProjectionHistory() {
  return JSON.parse(readFileSync("docs/examples/projection-history.json", "utf8"));
}

function currentSessionWithoutRequirementPlanReview() {
  const workflowState = currentSessionWorkflowState();
  if (workflowState.project_status) {
    delete workflowState.project_status.plan_reviews;
    delete workflowState.project_status.requirement_intake;
  }
  if (workflowState.manifest) {
    workflowState.manifest.events = (workflowState.manifest.events || [])
      .filter((event) => event.type !== "requirement_intake_submitted");
    workflowState.manifest.artifacts = (workflowState.manifest.artifacts || [])
      .filter((artifact) => artifact.metadata?.type !== "requirement_intake_submitted");
  }
  if (workflowState.artifact_ledger) {
    workflowState.artifact_ledger.artifacts = (workflowState.artifact_ledger.artifacts || [])
      .filter((artifact) => artifact.metadata?.type !== "requirement_intake_submitted");
  }
  return workflowState;
}

function currentSessionWithoutSchedulerLoop() {
  const workflowState = currentSessionWithoutRequirementPlanReview();
  const schedulerEventTypes = new Set(["autonomous_scheduler_loop_run", "scheduler_loop_resume_attempt"]);
  workflowState.manifest.events = (workflowState.manifest.events || [])
    .filter((event) => !schedulerEventTypes.has(event.type));
  workflowState.manifest.artifacts = (workflowState.manifest.artifacts || [])
    .filter((artifact) => !schedulerEventTypes.has(artifact.metadata?.type));
  workflowState.artifact_ledger.artifacts = (workflowState.artifact_ledger.artifacts || [])
    .filter((artifact) => !schedulerEventTypes.has(artifact.metadata?.type));
  return workflowState;
}

function generatedRequirementPlan(overrides = {}) {
  return {
    assessment_summary: "模型评估认为该需求需要先完成方案审核，再进入受控开发。",
    proposed_acceptance_plan: "## 目标\n形成可审核方案。\n## 验收\n方案通过前不自动开发；通过后进入受控任务执行。",
    implementation_outline: ["生成方案", "等待审核", "审核通过后派发"],
    acceptance_gates: ["node --test test/workbench-server.test.js"],
    risks: ["模型方案必须结构化保存"],
    ...overrides
  };
}

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

function runNode(args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

function waitForOutput(child, pattern) {
  return new Promise((resolveWait, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      reject(new Error(`timed out waiting for ${pattern}: ${stdout}${stderr}`));
    }, 5000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (pattern.test(stdout)) {
        clearTimeout(timeout);
        resolveWait(stdout);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (status) => {
      if (status !== null && !pattern.test(stdout)) {
        clearTimeout(timeout);
        reject(new Error(`server exited before readiness: ${status} ${stdout}${stderr}`));
      }
    });
  });
}

async function waitForCondition(predicate, description, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`timed out waiting for ${description}`);
}

function providerContextWorkPackageWorkflowState() {
  const workPackages = [
    {
      id: "provider-runtime",
      title: "Provider runtime",
      status: "pending",
      owned_files: ["src/workflow/context-work-package-execution-adapter.js"]
    }
  ];
  return {
    manifest: {
      run_id: "run-workbench-provider",
      cycle_id: "cycle-workbench-provider",
      goal: "verify provider-routed workbench execution",
      context_pack: {
        requirement_summary: "中台工作台 provider adapter seam",
        host: "platform_core",
        target_project_id: "ai-control-platform",
        non_goals: ["不修改业务项目"],
        forbidden_actions: ["不得从 HTTP body 注入 executor"],
        owned_files: ["src/workflow/context-work-package-execution-adapter.js"],
        acceptance_gates: ["node --test test/workbench-server.test.js"],
        rollback_conditions: ["provider executor provenance invalid"],
        subtasks: [
          {
            id: "provider-runtime",
            title: "Provider runtime",
            owned_files: ["src/workflow/context-work-package-execution-adapter.js"]
          }
        ]
      },
      work_packages: workPackages,
      events: [
        {
          id: "event-provider-context-cycle",
          type: "context_pack_cycle_materialized",
          status: "pass",
          message: "provider context cycle materialized",
          created_at: "2026-05-22T05:19:00.000Z"
        }
      ],
      artifacts: [],
      gate_results: [],
      review_findings: [],
      recovery_attempts: []
    },
    artifact_ledger: {
      run_id: "run-workbench-provider",
      cycle_id: "cycle-workbench-provider",
      artifacts: []
    },
    task_dag: workPackages
  };
}

function retryAgentWorkerWorkflowState() {
  const contextPack = {
    requirement_summary: "Retry timed-out child worker through context package execution.",
    host: "platform_core",
    target_project_id: "ai-control-platform",
    non_goals: ["Do not modify managed business projects"],
    forbidden_actions: ["Do not skip main-process evaluation gates"],
    owned_files: ["src/workflow/context-work-package-runner.js"],
    acceptance_gates: ["node --test test/workbench-server.test.js"],
    rollback_conditions: ["retry facts are missing"],
    subtasks: [
      {
        id: "agent-worker-retry-pool-server-child-1",
        title: "Retry timed-out child worker",
        action: "retry_agent_worker",
        owned_files: ["src/workflow/context-work-package-runner.js"],
        source: {
          pool_id: "pool-server",
          worker_id: "child-1",
          retry_worker: { pool_id: "pool-server", worker_id: "child-1" },
          timed_out_workers: [{ worker_id: "child-1" }]
        }
      }
    ]
  };
  const manifest = createRunManifest({
    run_id: "run-server-retry-agent",
    cycle_id: "cycle-server-retry-agent",
    goal: contextPack.requirement_summary,
    context_pack: contextPack,
    events: [
      {
        id: "event-server-retry-context-cycle",
        type: "context_pack_cycle_materialized",
        status: "pass",
        message: "retry agent context cycle materialized",
        created_at: "2026-05-22T09:20:00.000Z"
      }
    ],
    artifacts: [],
    gate_results: [],
    review_findings: [],
    recovery_attempts: [],
    created_at: "2026-05-22T09:20:00.000Z"
  });

  return {
    manifest,
    artifact_ledger: {
      run_id: manifest.run_id,
      cycle_id: manifest.cycle_id,
      artifacts: []
    },
    task_dag: manifest.work_packages
  };
}

test("workbench server returns latest projection", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/projection?id=current-session`);
    const projection = response.json();

    assert.equal(response.status, 200);
    assert.equal(projection.projection_version, "workbench.v1");
    assert.equal(projection.run_id, "run-20260521-platform-self-trial");
    assert.equal(projection.operator_events.status, "pass");
    assert.equal(projection.operator_events.applied_artifacts, 1);
    assert.ok(projection.manifest.event_count >= 8);
    assert.ok(projection.artifacts.total >= 8);
    assert.equal(projection.reviewer_provider_health.provider_health, "healthy");
    assert.equal(projection.reviewer_scope_split.shard_count, 2);
  });
});

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

test("workbench server CLI can seed SQLite from isolated history and snapshot roots", async () => {
  const dir = mkdtempSync(join(process.cwd(), "tmp/workbench-server-cli-isolated-"));
  const snapshotsRoot = join(dir, "snapshots");
  const eventsPath = join(dir, "operator-events.json");
  const stateDbPath = join(dir, "workbench-state.sqlite");
  const inputPath = join(snapshotsRoot, "input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWithoutRequirementPlanReview();
  mkdirSync(snapshotsRoot, { recursive: true });
  writeFileSync(eventsPath, JSON.stringify({ version: "operator-events.v1", events: [] }));
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "isolated",
    items: [{
      id: "isolated",
      label: "Isolated",
      input_path: relative(process.cwd(), inputPath)
    }]
  }, null, 2));

  const child = spawn(process.execPath, [
    "tools/workbench-server.mjs",
    "0",
    "--history-path",
    historyPath,
    "--snapshots-root",
    snapshotsRoot,
    "--events-path",
    eventsPath,
    "--state-db",
    stateDbPath
  ], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    const ready = await waitForOutput(child, /Workbench server listening on http:\/\/127\.0\.0\.1:\d+/);
    const port = ready.match(/:(\d+)/)?.[1];
    const response = await request(`http://127.0.0.1:${port}/api/workbench/projection?id=isolated`);
    assert.equal(response.status, 200);
    assert.equal(response.json().run_id, workflowState.manifest.run_id);
  } finally {
    child.kill();
    await once(child, "close").catch(() => {});
  }
});

test("workbench server CLI accepts explicit host and port flags", async () => {
  const child = spawn(process.execPath, [
    "tools/workbench-server.mjs",
    "--host",
    "127.0.0.1",
    "--port",
    "0"
  ], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    const ready = await waitForOutput(child, /Workbench server listening on http:\/\/127\.0\.0\.1:\d+/);
    const port = Number(ready.match(/:(\d+)/)?.[1]);
    assert.ok(port > 0);
  } finally {
    child.kill();
    await once(child, "close").catch(() => {});
  }
});

test("workbench server CLI fails closed for invalid port", async () => {
  const result = await runNode([
    "tools/workbench-server.mjs",
    "--host",
    "127.0.0.1",
    "--port",
    "not-a-port"
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid workbench server port: not-a-port/);
  assert.doesNotMatch(result.stderr, /ERR_SOCKET_BAD_PORT/);
  assert.equal(result.stdout, "");
});

test("workbench server builds latest projection from workflow state input", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/projection?id=current-session`);
    const projection = response.json();

    assert.equal(response.status, 200);
    assert.equal(projection.operator_events.event_count, 1);
    assert.ok(projection.artifacts.by_type.evaluation >= 3);
    assert.ok(projection.autonomous_run.summaries.artifacts.total >= 8);
    assert.equal(projection.reviewer_provider_health.next_action, "rerun_without_tools");
    assert.equal(projection.reviewer_scope_split.next_shard, "reviewer-scope-shard-001");
  });
});

test("workbench server overlays repository PROJECT_STATUS into workflow projections", async () => {
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-project-status-"));
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const inputPath = join(snapshotsRoot, "project-status-input.json");
  const projectStatusPath = join(snapshotsRoot, "PROJECT_STATUS.json");
  const workflowState = currentSessionWithoutRequirementPlanReview();
  workflowState.project_status = {
    project: "ai-control-platform",
    next_step: "",
    global_goals: [{ id: "stale", title: "Stale input goal", status: "completed" }]
  };
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(projectStatusPath, JSON.stringify({
    project: "ai-control-platform",
    status: "in_progress",
    blockers: [],
    next_step: "Continue from repository PROJECT_STATUS.",
    global_goals: [
      {
        id: "repo-goal",
        title: "Repository status goal",
        status: "in_progress",
        next_step: "Use repo-level goal state."
      }
    ]
  }, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "project-status",
    items: [
      {
        id: "project-status",
        label: "Project status",
        status: "pass",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }, null, 2));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/projection`);
    const projection = response.json();

    assert.equal(response.status, 200);
    assert.equal(projection.global_goal_completion.status, "in_progress");
    assert.equal(projection.global_goal_completion.next_goal.id, "repo-goal");
    assert.equal(projection.global_goal_completion.next_goal.title, "Repository status goal");
    assert.equal(projection.one_screen.counters.global_goals_pending, 1);
  }, { historyPath, snapshotsRoot, projectStatusPath });
});

test("workbench server executes project status continuation next action", async () => {
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-project-status-next-action-"));
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const inputPath = join(snapshotsRoot, "project-status-next-action-input.json");
  const projectStatusPath = join(snapshotsRoot, "PROJECT_STATUS.json");
  const workflowState = currentSessionWithoutRequirementPlanReview();
  workflowState.manifest.events = [];
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(projectStatusPath, JSON.stringify({
    project: "ai-control-platform",
    status: "in_progress",
    blockers: [],
    next_step: "",
    global_goals: [
      {
        id: "repo-goal",
        title: "Repository status goal",
        status: "in_progress",
        next_step: "Prepare the next global-goal cycle.",
        owned_files: ["src/workflow/context-pack-cycle.js", "test/context-pack-cycle.test.js"]
      }
    ]
  }, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "project-status-next-action",
    items: [
      {
        id: "project-status-next-action",
        label: "Project status next action",
        status: "pass",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }, null, 2));

  await withServer(async (baseUrl) => {
    const before = await request(`${baseUrl}/api/workbench/projection`);
    assert.equal(before.json().next_action_readout.action, "prepare_project_status_continuation");

    const response = await request(`${baseUrl}/api/workbench/next-action?id=project-status-next-action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "prepare_project_status_continuation",
        created_at: "2026-05-22T03:10:00.000Z"
      })
    });
    const payload = response.json();
    const saved = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(payload.status, "executed");
    assert.equal(payload.action, "prepare_project_status_continuation");
    assert.equal(payload.result.status, "created");
    assert.equal(payload.result.artifact.metadata.next_goal.id, "repo-goal");
    assert.equal(saved.manifest.events.at(-1).type, "project_status_continuation");
    assert.equal(payload.result.projection.next_action_readout.action, "create_context_pack_from_seed");

    const cycle = await request(`${baseUrl}/api/workbench/next-action?id=project-status-next-action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "create_context_pack_from_seed",
        snapshot_id: "project-status-context-cycle",
        cycle_id: "cycle-project-status-context",
        label: "Project status context cycle",
        created_at: "2026-05-22T03:11:00.000Z"
      })
    });
    const created = cycle.json();
    const sourceAfterCycle = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(cycle.status, 201);
    assert.equal(created.action, "create_context_pack_from_seed");
    assert.equal(created.result.next_item.id, "project-status-context-cycle");
    assert.equal(created.result.projection.cycle_id, "cycle-project-status-context");
    assert.equal(created.result.projection.manifest.work_package_count, 1);
    assert.equal(created.result.projection.next_action_readout.action, "run_context_work_packages");
    assert.equal(sourceAfterCycle.manifest.events.at(-1).type, "context_pack_cycle_materialized");

    const cycleHistory = JSON.parse(readFileSync(historyPath, "utf8"));
    const cycleItem = cycleHistory.items.find((entry) => entry.id === "project-status-context-cycle");
    const cycleInputPath = join(process.cwd(), cycleItem.input_path);
    const cycleState = JSON.parse(readFileSync(cycleInputPath, "utf8"));
    const scopedPackage = {
      ...cycleState.manifest.work_packages[0],
      id: "project-status-scoped-next-step",
      action: "continue_next_step",
      global_goal_id: ""
    };
    cycleState.manifest.work_packages = [scopedPackage];
    cycleState.manifest.context_pack.subtasks = [scopedPackage];
    cycleState.task_dag = [scopedPackage];
    writeFileSync(cycleInputPath, `${JSON.stringify(cycleState, null, 2)}\n`);

    const rejectedRun = await request(`${baseUrl}/api/workbench/next-action?id=project-status-context-cycle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "run_context_work_packages",
        max_package_count: 1,
        execution_mode: "provider_model_routed",
        execution_profile: "real_provider_not_registered",
        created_at: "2026-05-22T03:11:30.000Z"
      })
    });
    const rejected = rejectedRun.json();
    const stateAfterRejectedRun = JSON.parse(readFileSync(cycleInputPath, "utf8"));

    assert.equal(rejectedRun.status, 409);
    assert.equal(rejected.error, "context work package run failed");
    assert.ok(rejected.issues.some((issue) => issue.code === "unsupported_execution_profile"));
    assert.notEqual(stateAfterRejectedRun.manifest.work_packages[0].status, "completed");

    const profileOnlyRun = await request(`${baseUrl}/api/workbench/context-work-packages-run?id=project-status-context-cycle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_package_count: 1,
        execution_profile: "real_provider_not_registered",
        created_at: "2026-05-22T03:11:40.000Z"
      })
    });
    const profileOnly = profileOnlyRun.json();
    const stateAfterProfileOnlyRun = JSON.parse(readFileSync(cycleInputPath, "utf8"));

    assert.equal(profileOnlyRun.status, 409);
    assert.equal(profileOnly.error, "context work package run failed");
    assert.ok(profileOnly.issues.some((issue) => issue.code === "unsupported_execution_profile"));
    assert.notEqual(stateAfterProfileOnlyRun.manifest.work_packages[0].status, "completed");

    const deterministicKindRun = await request(`${baseUrl}/api/workbench/context-work-packages-run?id=project-status-context-cycle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_package_count: 1,
        executor_kind: "deterministic_mock_multi_agent",
        created_at: "2026-05-22T03:11:45.000Z"
      })
    });
    const deterministicKind = deterministicKindRun.json();
    const stateAfterDeterministicKindRun = JSON.parse(readFileSync(cycleInputPath, "utf8"));

    assert.equal(deterministicKindRun.status, 409);
    assert.equal(deterministicKind.error, "context work package run failed");
    assert.ok(deterministicKind.issues.some((issue) => issue.code === "unsupported_execution_profile"));
    assert.notEqual(stateAfterDeterministicKindRun.manifest.work_packages[0].status, "completed");

    const adapterProfileRun = await request(`${baseUrl}/api/workbench/context-work-packages-run?id=project-status-context-cycle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_package_count: 1,
        adapter_profile: "bounded_mock_multi_agent",
        risk: "high",
        budget_tier: "high",
        codex_plan_pressure: true,
        created_at: "2026-05-22T03:11:50.000Z"
      })
    });
    const adapterProfile = adapterProfileRun.json();
    const stateAfterAdapterProfileRun = JSON.parse(readFileSync(cycleInputPath, "utf8"));

    assert.equal(adapterProfileRun.status, 409);
    assert.equal(adapterProfile.status, "validated");
    assert.equal(adapterProfile.error, "context work package run validated without completion authority");
    assert.equal(adapterProfile.executor_provenance.executor_kind, "deterministic_mock_multi_agent");
    assert.notEqual(stateAfterAdapterProfileRun.manifest.work_packages[0].status, "completed");
    assert.equal(stateAfterAdapterProfileRun.artifact_ledger.artifacts.some((artifact) => artifact.metadata?.execution_profile === "bounded_mock_multi_agent"), false);

    const directMockRun = await request(`${baseUrl}/api/workbench/context-work-packages-run?id=project-status-context-cycle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_package_count: 1,
        execution_mode: "provider_model_routed",
        execution_profile: "bounded_mock_multi_agent",
        risk: "high",
        budget_tier: "high",
        codex_plan_pressure: true,
        tags: ["boundary_sensitive"],
        stage: "implementation",
        created_at: "2026-05-22T03:12:00.000Z"
      })
    });
    const directMock = directMockRun.json();
    const stateAfterDirectMockRun = JSON.parse(readFileSync(cycleInputPath, "utf8"));

    assert.equal(directMockRun.status, 409);
    assert.equal(directMock.status, "validated");
    assert.equal(directMock.error, "context work package run validated without completion authority");
    assert.equal(directMock.allows_work_package_completion, false);
    assert.equal(directMock.completion_authority.allows_work_package_completion, false);
    assert.equal(directMock.executor_provenance.executor_kind, "deterministic_mock_multi_agent");
    assert.equal(directMock.package_results[0].status, "validated");
    assert.equal(directMock.package_results[0].allows_work_package_completion, false);
    assert.equal(directMock.execution_plan.model_routing.strategy, "per_work_package_buildModelCollaborationPlan");
    assert.ok(directMock.execution_plan.model_routing.package_plans[0].roles.some((role) => role.role === "process_guard"));
    assert.notEqual(stateAfterDirectMockRun.manifest.work_packages[0].status, "completed");
    assert.equal(stateAfterDirectMockRun.artifact_ledger.artifacts.some((artifact) => artifact.metadata?.execution_profile === "bounded_mock_multi_agent"), false);

    const nextActionMockRun = await request(`${baseUrl}/api/workbench/next-action?id=project-status-context-cycle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "run_context_work_packages",
        max_package_count: 1,
        execution_mode: "provider_model_routed",
        execution_profile: "bounded_mock_multi_agent",
        risk: "high",
        budget_tier: "high",
        codex_plan_pressure: true,
        tags: ["boundary_sensitive"],
        stage: "implementation",
        created_at: "2026-05-22T03:12:30.000Z"
      })
    });
    const nextActionMock = nextActionMockRun.json();
    const stateAfterNextActionMockRun = JSON.parse(readFileSync(cycleInputPath, "utf8"));

    assert.equal(nextActionMockRun.status, 409);
    assert.equal(nextActionMock.error, "context work package run validated without completion authority");
    assert.equal(nextActionMock.result.status, "validated");
    assert.equal(nextActionMock.result.allows_work_package_completion, false);
    assert.equal(nextActionMock.result.executor_provenance.executor_kind, "deterministic_mock_multi_agent");
    assert.equal(nextActionMock.result.package_results[0].status, "validated");
    assert.notEqual(stateAfterNextActionMockRun.manifest.work_packages[0].status, "completed");
    assert.equal(stateAfterNextActionMockRun.artifact_ledger.artifacts.some((artifact) => artifact.metadata?.execution_profile === "bounded_mock_multi_agent"), false);

    const localRun = await request(`${baseUrl}/api/workbench/context-work-packages-run?id=project-status-context-cycle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_package_count: 1,
        created_at: "2026-05-22T03:13:00.000Z"
      })
    });
    const local = localRun.json();
    const stateAfterLocalRun = JSON.parse(readFileSync(cycleInputPath, "utf8"));

    assert.equal(localRun.status, 201);
    assert.equal(local.status, "created");
    assert.equal(local.executed_count, 1);
    assert.equal(stateAfterLocalRun.manifest.work_packages[0].status, "completed");
    const localContextRunArtifact = stateAfterLocalRun.artifact_ledger.artifacts
      .find((artifact) => artifact.metadata?.type === "context_work_packages_run");
    assert.equal(localContextRunArtifact.metadata.execution_profile, "local_bounded");
  }, { historyPath, snapshotsRoot, projectStatusPath });
});

test("workbench server accepts frontend requirements into autonomous continuation flow", async () => {
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-requirement-intake-"));
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const inputPath = join(snapshotsRoot, "requirement-intake-input.json");
  const projectStatusPath = join(snapshotsRoot, "PROJECT_STATUS.json");
  const workflowState = currentSessionWithoutRequirementPlanReview();
  workflowState.manifest.events = [];
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(projectStatusPath, JSON.stringify({
    project: "ai-control-platform",
    status: "in_progress",
    blockers: [],
    next_step: "",
    global_goals: []
  }, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "requirement-intake",
    items: [
      {
        id: "requirement-intake",
        label: "Requirement intake",
        status: "pass",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }, null, 2));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/requirements?id=requirement-intake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "提需求模块更新",
        project_id: "ai-control-platform",
        surface_area: "workbench_frontend",
        problem_statement: "看板提需求页面需要改成新建任务，并由后端生成方案等待用户审核，不只是前端展示。",
        constraints: "不能绕过自动开发、验收和门禁流程。",
        plan_review_requested: true,
        generate_plan: true,
        wait_for_plan_generation: true,
        created_at: "2026-05-25T09:00:00.000Z",
        requirement_id: "requirement-from-workbench"
      })
    });
    const payload = response.json();
    const savedProjectStatus = JSON.parse(readFileSync(projectStatusPath, "utf8"));
    const savedWorkflowState = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(payload.status, "created");
    assert.equal(payload.requirement.id, "requirement-from-workbench");
    assert.equal(payload.plan_review.phase, "ready_for_review");
    assert.equal(payload.submitted_projection.next_action_readout.action, "review_requirement_plan");
    assert.equal(payload.submitted_projection.next_action_readout.source_type, "plan_review");
    assert.equal(payload.submitted_projection.next_action_readout.requires_operator, true);
    assert.equal(payload.auto_advance.status, "waiting_for_plan_review");
    assert.equal(payload.auto_advance.result, null);
    assert.equal(payload.projection.next_action_readout.action, "review_requirement_plan");
    assert.equal(payload.projection.project_management.task_items[0].task_id, "requirement-from-workbench");
    assert.equal(payload.projection.project_management.task_items[0].status, "pending_review");
    assert.equal(payload.projection.project_management.task_items[0].reviewable, true);
    assert.equal(savedProjectStatus.requirement_intake.latest_requirement_id, "requirement-from-workbench");
    assert.equal(savedProjectStatus.plan_reviews["requirement-from-workbench"].phase, "ready_for_review");
    assert.equal(savedProjectStatus.next_work_packages[0].action, "continue_requirement_intake");
    assert.ok(savedProjectStatus.next_work_packages[0].owned_files.includes("apps/workbench"));
    assert.ok(savedProjectStatus.next_work_packages[0].owned_files.includes("tools/workbench-server.mjs"));
    assert.match(savedProjectStatus.plan_reviews["requirement-from-workbench"].proposed_acceptance_plan, /形成可审核方案/);
    assert.ok(savedWorkflowState.manifest.events.some((event) => event.type === "requirement_intake_submitted"));
    assert.equal(savedWorkflowState.project_status.next_work_packages[0].action, "continue_requirement_intake");
    assert.equal(savedWorkflowState.manifest.events.some((event) => event.type === "context_work_packages_run"), false);
    assert.equal(savedWorkflowState.manifest.events.at(-1).type, "requirement_intake_submitted");
  }, {
    historyPath,
    snapshotsRoot,
    projectStatusPath,
    requirementPlanGenerator: async () => ({
      status: "pass",
      generated_plan: generatedRequirementPlan(),
      generator: { kind: "test_plan_model" }
    })
  });
});

test("workbench server persists frontend requirement before model plan generation", async () => {
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-requirement-pending-"));
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const inputPath = join(snapshotsRoot, "requirement-pending-input.json");
  const projectStatusPath = join(snapshotsRoot, "PROJECT_STATUS.json");
  const workflowState = currentSessionWithoutRequirementPlanReview();
  workflowState.manifest.events = [];
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(projectStatusPath, JSON.stringify({
    project: "ai-control-platform",
    status: "in_progress",
    blockers: [],
    next_step: "",
    global_goals: []
  }, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "requirement-pending",
    items: [
      {
        id: "requirement-pending",
        label: "Requirement pending",
        status: "pass",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }, null, 2));

  let observedPendingWrite = false;
  let releaseGenerator;
  const generatorMayFinish = new Promise((resolve) => {
    releaseGenerator = resolve;
  });
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/requirements?id=requirement-pending`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "前端重构",
        project_id: "ai-control-platform",
        surface_area: "workbench_frontend",
        problem_statement: "基于 PC 和移动端视觉稿重构 Ops Workbench 首页。",
        plan_review_requested: true,
        generate_plan: true,
        created_at: "2026-05-25T10:00:00.000Z",
        requirement_id: "requirement-frontend-refactor"
      })
    });
    const payload = response.json();
    const savedProjectStatus = JSON.parse(readFileSync(projectStatusPath, "utf8"));
    const savedWorkflowState = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(payload.plan_generation.status, "scheduled");
    assert.equal(payload.plan_review.phase, "pending_plan_generation");
    assert.equal(payload.auto_advance.status, "waiting_for_plan_generation");
    assert.equal(payload.projection.next_action_readout.action, "generate_requirement_plan");
    assert.equal(payload.projection.project_management.plan_review.requirement_id, "requirement-frontend-refactor");
    assert.equal(savedProjectStatus.requirement_intake.latest_requirement_id, "requirement-frontend-refactor");
    assert.equal(savedProjectStatus.plan_reviews["requirement-frontend-refactor"].phase, "pending_plan_generation");
    assert.equal(savedWorkflowState.project_status.requirement_intake.latest_requirement_id, "requirement-frontend-refactor");
    assert.equal(savedWorkflowState.project_status.plan_reviews["requirement-frontend-refactor"].phase, "pending_plan_generation");
    assert.ok(savedWorkflowState.manifest.events.some((event) => event.type === "requirement_intake_submitted"));
    await waitForCondition(() => observedPendingWrite, "background generator sees pending write");
    releaseGenerator();
    await waitForCondition(() => {
      const currentProjectStatus = JSON.parse(readFileSync(projectStatusPath, "utf8"));
      return currentProjectStatus.plan_reviews["requirement-frontend-refactor"].phase === "plan_generation_failed";
    }, "background plan generation failure writeback");
    const failedProjectStatus = JSON.parse(readFileSync(projectStatusPath, "utf8"));
    const failedWorkflowState = JSON.parse(readFileSync(inputPath, "utf8"));
    assert.match(failedProjectStatus.plan_reviews["requirement-frontend-refactor"].generation_error.stderr, /simulated model timeout/);
    assert.equal(failedWorkflowState.project_status.plan_reviews["requirement-frontend-refactor"].phase, "plan_generation_failed");
  }, {
    historyPath,
    snapshotsRoot,
    projectStatusPath,
    requirementPlanGenerator: async () => {
      const pendingProjectStatus = JSON.parse(readFileSync(projectStatusPath, "utf8"));
      const pendingWorkflowState = JSON.parse(readFileSync(inputPath, "utf8"));
      observedPendingWrite =
        pendingProjectStatus.requirement_intake.latest_requirement_id === "requirement-frontend-refactor" &&
        pendingProjectStatus.plan_reviews["requirement-frontend-refactor"].phase === "pending_plan_generation" &&
        pendingWorkflowState.project_status.requirement_intake.latest_requirement_id === "requirement-frontend-refactor";
      await generatorMayFinish;
      return {
        status: "fail",
        stderr: "simulated model timeout"
      };
    }
  });
});

test("workbench server retries and closes failed requirement plan generation", async () => {
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-requirement-retry-close-"));
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const inputPath = join(snapshotsRoot, "requirement-retry-close-input.json");
  const projectStatusPath = join(snapshotsRoot, "PROJECT_STATUS.json");
  const workflowState = currentSessionWithoutRequirementPlanReview();
  workflowState.manifest.events = [];
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(projectStatusPath, JSON.stringify({
    project: "ai-control-platform",
    status: "in_progress",
    blockers: [],
    next_step: "",
    global_goals: []
  }, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "requirement-retry-close",
    items: [
      {
        id: "requirement-retry-close",
        label: "Requirement retry close",
        status: "pass",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }, null, 2));

  let generatorMode = "fail";
  await withServer(async (baseUrl) => {
    const submitted = await request(`${baseUrl}/api/workbench/requirements?id=requirement-retry-close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "完成项目 tab",
        project_id: "ai-control-platform",
        problem_statement: "项目 tab 需要接入项目治理。",
        plan_review_requested: true,
        generate_plan: true,
        created_at: "2026-05-25T10:00:00.000Z",
        requirement_id: "requirement-project-tab"
      })
    });
    assert.equal(submitted.status, 201);
    await waitForCondition(() => {
      const currentProjectStatus = JSON.parse(readFileSync(projectStatusPath, "utf8"));
      return currentProjectStatus.plan_reviews["requirement-project-tab"].phase === "plan_generation_failed";
    }, "initial failed plan generation");

    generatorMode = "pass";
    const retry = await request(`${baseUrl}/api/workbench/requirements/retry-plan?id=requirement-retry-close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requirement_id: "requirement-project-tab",
        created_at: "2026-05-25T10:05:00.000Z"
      })
    });
    const retryPayload = retry.json();
    assert.equal(retry.status, 202);
    assert.equal(retryPayload.plan_review.phase, "pending_plan_generation");
    assert.equal(retryPayload.plan_generation.status, "scheduled");
    await waitForCondition(() => {
      const currentProjectStatus = JSON.parse(readFileSync(projectStatusPath, "utf8"));
      return currentProjectStatus.plan_reviews["requirement-project-tab"].phase === "ready_for_review";
    }, "retried plan generation");

    const close = await request(`${baseUrl}/api/workbench/requirements/close?id=requirement-retry-close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requirement_id: "requirement-project-tab",
        note: "operator closed failed task",
        created_at: "2026-05-25T10:10:00.000Z"
      })
    });
    const closePayload = close.json();
    assert.equal(close.status, 201);
    assert.equal(closePayload.plan_review.phase, "closed_failed");
    assert.equal(closePayload.projection.project_management.task_items[0].status, "closed");
    assert.equal(closePayload.projection.project_management.active_tasks, 0);
    assert.equal(closePayload.projection.global_goal_completion.pending, 0);
  }, {
    historyPath,
    snapshotsRoot,
    projectStatusPath,
    requirementPlanGenerator: async () => (
      generatorMode === "pass"
        ? { status: "pass", generated_plan: generatedRequirementPlan(), generator: { kind: "test_model_plan" } }
        : { status: "fail", stderr: "simulated model timeout", generator: { kind: "test_model_plan", timed_out: true } }
    )
  });
});

test("workbench server falls back to a governed requirement plan model after timeout", async () => {
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-requirement-fallback-"));
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const inputPath = join(snapshotsRoot, "requirement-fallback-input.json");
  const projectStatusPath = join(snapshotsRoot, "PROJECT_STATUS.json");
  const commandPath = join(snapshotsRoot, "plan-generator.sh");
  const workflowState = currentSessionWithoutRequirementPlanReview();
  workflowState.manifest.events = [];
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(projectStatusPath, JSON.stringify({
    project: "ai-control-platform",
    status: "in_progress",
    blockers: [],
    next_step: "",
    global_goals: []
  }, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "requirement-fallback",
    items: [
      {
        id: "requirement-fallback",
        label: "Requirement fallback",
        status: "pass",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }, null, 2));
  writeFileSync(commandPath, [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "if [[ \" $* \" == *\" claude-sonnet-4-6 \"* ]]; then",
    "  sleep 2",
    "  exit 143",
    "fi",
    "cat <<'JSON'",
    JSON.stringify(generatedRequirementPlan()),
    "JSON",
    ""
  ].join("\n"));
  chmodSync(commandPath, 0o755);

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/requirements?id=requirement-fallback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "完成项目 tab",
        project_id: "ai-control-platform",
        problem_statement: "项目 tab 需要接入项目治理。",
        plan_review_requested: true,
        generate_plan: true,
        wait_for_plan_generation: true,
        requirement_plan_command: commandPath,
        requirement_plan_model: "claude-sonnet-4-6",
        requirement_plan_fallback_model: "claude-haiku-4-5-20251001",
        requirement_plan_timeout_ms: 50,
        created_at: "2026-05-25T10:00:00.000Z",
        requirement_id: "requirement-project-tab"
      })
    });
    const payload = response.json();
    const generator = payload.plan_review.generator;
    assert.equal(response.status, 201);
    assert.equal(payload.plan_review.phase, "ready_for_review");
    assert.equal(generator.model, "claude-haiku-4-5-20251001");
    assert.equal(generator.fallback_from_model, "claude-sonnet-4-6");
    assert.equal(generator.attempts[0].timed_out, true);
    assert.equal(generator.attempts[1].attempt, "timeout_fallback");
  }, {
    historyPath,
    snapshotsRoot,
    projectStatusPath
  });
});

test("workbench server can apply a supplied plan when retrying failed plan generation", async () => {
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-requirement-supplied-plan-"));
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const inputPath = join(snapshotsRoot, "requirement-supplied-plan-input.json");
  const projectStatusPath = join(snapshotsRoot, "PROJECT_STATUS.json");
  const workflowState = currentSessionWithoutRequirementPlanReview();
  workflowState.manifest.events = [];
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(projectStatusPath, JSON.stringify({
    project: "ai-control-platform",
    status: "in_progress",
    blockers: [],
    next_step: "",
    global_goals: []
  }, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "requirement-supplied-plan",
    items: [
      {
        id: "requirement-supplied-plan",
        label: "Requirement supplied plan",
        status: "pass",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }, null, 2));

  await withServer(async (baseUrl) => {
    const submitted = await request(`${baseUrl}/api/workbench/requirements?id=requirement-supplied-plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "完成项目 tab",
        project_id: "ai-control-platform",
        problem_statement: "项目 tab 需要接入项目治理。",
        plan_review_requested: true,
        generate_plan: true,
        created_at: "2026-05-25T10:00:00.000Z",
        requirement_id: "requirement-project-tab"
      })
    });
    assert.equal(submitted.status, 201);
    await waitForCondition(() => {
      const currentProjectStatus = JSON.parse(readFileSync(projectStatusPath, "utf8"));
      return currentProjectStatus.plan_reviews["requirement-project-tab"].phase === "plan_generation_failed";
    }, "initial failed plan generation");

    const retry = await request(`${baseUrl}/api/workbench/requirements/retry-plan?id=requirement-supplied-plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requirement_id: "requirement-project-tab",
        generated_plan: generatedRequirementPlan(),
        created_at: "2026-05-25T10:05:00.000Z"
      })
    });
    const payload = retry.json();
    assert.equal(retry.status, 201);
    assert.equal(payload.status, "generated");
    assert.equal(payload.plan_review.phase, "ready_for_review");
    assert.equal(payload.plan_review.generator.kind, "operator_supplied_requirement_plan");
    assert.equal(payload.auto_advance.status, "waiting_for_plan_review");
  }, {
    historyPath,
    snapshotsRoot,
    projectStatusPath,
    requirementPlanGenerator: async () => ({ status: "fail", stderr: "simulated model timeout" })
  });
});

test("workbench server records plan review decisions", async () => {
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-plan-review-"));
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const inputPath = join(snapshotsRoot, "plan-review-input.json");
  const projectStatusPath = join(snapshotsRoot, "PROJECT_STATUS.json");
  const workflowState = currentSessionWithoutRequirementPlanReview();
  workflowState.manifest.events = [];
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(projectStatusPath, JSON.stringify({
    project: "ai-control-platform",
    status: "in_progress",
    blockers: [],
    next_step: "",
    global_goals: []
  }, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "plan-review",
    items: [
      {
        id: "plan-review",
        label: "Plan review",
        status: "pass",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }, null, 2));

  await withServer(async (baseUrl) => {
    const submitted = await request(`${baseUrl}/api/workbench/requirements?id=plan-review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "提需求模块更新",
        project_id: "ai-control-platform",
        problem_statement: "提需求页面需要先生成方案并等待用户审核。",
        plan_review_requested: true,
        generated_plan: generatedRequirementPlan(),
        auto_advance: false,
        created_at: "2026-05-25T09:00:00.000Z",
        requirement_id: "requirement-plan-review-server"
      })
    });
    const response = await request(`${baseUrl}/api/workbench/plan-reviews?id=plan-review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requirement_id: "requirement-plan-review-server",
        action: "approve",
        auto_advance: false,
        created_at: "2026-05-25T09:05:00.000Z"
      })
    });
    const payload = response.json();
    const savedProjectStatus = JSON.parse(readFileSync(projectStatusPath, "utf8"));
    const savedWorkflowState = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(submitted.status, 201);
    assert.equal(response.status, 201);
    assert.equal(payload.status, "updated");
    assert.equal(payload.plan_review.phase, "in_development");
    assert.equal(payload.projection.project_management.plan_review.phase, "in_development");
    assert.equal(payload.projection.project_management.plan_review.action_status, "开发中");
    assert.equal(payload.projection.project_management.task_items[0].status, "running");
    assert.equal(payload.projection.project_management.task_items[0].phase_label, "开发执行");
    assert.equal(savedProjectStatus.plan_reviews["requirement-plan-review-server"].phase, "in_development");
    assert.equal(savedWorkflowState.project_status.plan_reviews["requirement-plan-review-server"].phase, "in_development");
  }, { historyPath, snapshotsRoot, projectStatusPath });
});

test("workbench server starts development automatically after plan review approval", async () => {
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-plan-review-auto-dev-"));
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const inputPath = join(snapshotsRoot, "plan-review-auto-dev-input.json");
  const projectStatusPath = join(snapshotsRoot, "PROJECT_STATUS.json");
  const workflowState = currentSessionWithoutRequirementPlanReview();
  workflowState.manifest.events = [];
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(projectStatusPath, JSON.stringify({
    project: "ai-control-platform",
    status: "in_progress",
    blockers: [],
    next_step: "",
    global_goals: []
  }, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "plan-review-auto-dev",
    items: [
      {
        id: "plan-review-auto-dev",
        label: "Plan review auto dev",
        status: "pass",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }, null, 2));

  await withServer(async (baseUrl) => {
    const submitted = await request(`${baseUrl}/api/workbench/requirements?id=plan-review-auto-dev`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "审批后直接进入开发",
        project_id: "ai-control-platform",
        problem_statement: "用户同意方案后不应该再点一次开始开发。",
        plan_review_requested: true,
        generated_plan: generatedRequirementPlan(),
        auto_advance: false,
        created_at: "2026-05-25T09:10:00.000Z",
        requirement_id: "requirement-plan-review-auto-dev"
      })
    });
    const response = await request(`${baseUrl}/api/workbench/plan-reviews?id=plan-review-auto-dev`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requirement_id: "requirement-plan-review-auto-dev",
        action: "approve",
        created_at: "2026-05-25T09:15:00.000Z"
      })
    });
    const payload = response.json();
    const savedHistory = JSON.parse(readFileSync(historyPath, "utf8"));
    const latestHistoryItem = savedHistory.items.find((entry) => entry.id === savedHistory.latest);
    const latestWorkflowState = JSON.parse(readFileSync(join(process.cwd(), latestHistoryItem.input_path), "utf8"));
    const eventTypes = latestWorkflowState.manifest.events.map((event) => event.type);
    const contextRunArtifact = latestWorkflowState.artifact_ledger.artifacts
      .find((artifact) => artifact.metadata?.type === "context_work_packages_run");

    assert.equal(submitted.status, 201);
    assert.equal(response.status, 201);
    assert.equal(payload.plan_review.phase, "in_development");
    assert.equal(payload.projection.project_management.plan_review.action_status, "开发中");
    assert.equal(payload.auto_advance.status, "created");
    assert.equal(payload.auto_advance.requirement_completion.status, "not_completed");
    assert.equal(payload.auto_advance.result.status, "pass");
    assert.ok(payload.auto_advance.result.iterations.some((iteration) => iteration.projected_action === "run_context_work_packages"));
    assert.equal(payload.projection.next_action_readout.action, "run_context_work_packages");
    assert.ok(eventTypes.includes("context_work_packages_run"));
    assert.equal(latestWorkflowState.manifest.work_packages[0].status, "completed");
    assert.equal(contextRunArtifact.metadata.execution_profile, VERIFIED_PROVIDER_MULTI_AGENT_PROFILE);
  }, {
    historyPath,
    snapshotsRoot,
    projectStatusPath,
    contextWorkPackageProviderExecutor: ({ selected_work_packages }) => ({
      status: "pass",
      completion_evidence: {
        kind: "provider_execution",
        summary: "verified provider started and completed the approved development package"
      },
      package_results: selected_work_packages.map((workPackage) => ({
        work_package_id: workPackage.id,
        status: "pass",
        result: "pass",
        allows_work_package_completion: true,
        completion_authority: {
          allows_work_package_completion: true,
          authority: "verified_provider_executor",
          evidence_kind: "provider_execution",
          reason: "configured workbench provider executor completed approved development package"
        },
        completion_evidence: {
          kind: "package_completion",
          artifact_id: `plan-review-auto-dev-${workPackage.id}`
        }
      })),
      executor_provenance: {
        executor_kind: "configured_workbench_provider_executor",
        provider: "multi_provider",
        execution_mode: "provider_model_routed",
        execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
        external_calls: 2,
        deterministic: false
      }
    })
  });
});

test("workbench server completes requirement intake only with verified provider completion authority", async () => {
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-requirement-provider-"));
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const inputPath = join(snapshotsRoot, "requirement-provider-input.json");
  const projectStatusPath = join(snapshotsRoot, "PROJECT_STATUS.json");
  const workflowState = currentSessionWithoutRequirementPlanReview();
  workflowState.manifest.events = [];
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(projectStatusPath, JSON.stringify({
    project: "ai-control-platform",
    status: "in_progress",
    blockers: [],
    next_step: "",
    global_goals: []
  }, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "requirement-provider",
    items: [
      {
        id: "requirement-provider",
        label: "Requirement provider",
        status: "pass",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }, null, 2));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/requirements?id=requirement-provider`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "需求链路使用 verified provider",
        surface_area: "workbench_frontend",
        problem_statement: "需求提交后的实现包必须由具备完成权限的执行器完成。",
        acceptance_criteria: "配置 verified provider executor 时，auto advance 可以完成 context work package。",
        constraints: "不能让 local bounded runner 写 completed。",
        generated_plan: generatedRequirementPlan(),
        auto_advance_after_plan_review: true,
        created_at: "2026-05-25T09:30:00.000Z",
        requirement_id: "requirement-provider-authorized"
      })
    });
    const payload = response.json();
    const savedHistory = JSON.parse(readFileSync(historyPath, "utf8"));
    const latestHistoryItem = savedHistory.items.find((entry) => entry.id === savedHistory.latest);
    const latestWorkflowState = JSON.parse(readFileSync(join(process.cwd(), latestHistoryItem.input_path), "utf8"));
    const contextRunArtifact = latestWorkflowState.artifact_ledger.artifacts
      .find((artifact) => artifact.metadata?.type === "context_work_packages_run");

    assert.equal(response.status, 201);
    assert.equal(payload.auto_advance.status, "created");
    assert.equal(payload.auto_advance.requirement_completion.status, "not_completed");
    assert.equal(payload.auto_advance.result.status, "pass");
    assert.equal(payload.auto_advance.result.phase, "iteration_limit_reached");
    assert.equal(payload.projection.next_action_readout.action, "run_context_work_packages");
    assert.equal(latestWorkflowState.manifest.work_packages[0].action, "execute_requirement_plan_step");
    assert.equal(latestWorkflowState.manifest.work_packages[0].status, "completed");
    assert.equal(contextRunArtifact.metadata.execution_profile, VERIFIED_PROVIDER_MULTI_AGENT_PROFILE);
    assert.equal(contextRunArtifact.metadata.completion_authority.allows_work_package_completion, true);
  }, {
    historyPath,
    snapshotsRoot,
    projectStatusPath,
    contextWorkPackageProviderExecutor: ({ selected_work_packages }) => ({
      status: "pass",
      completion_evidence: {
        kind: "provider_execution",
        summary: "verified provider completed requirement intake package"
      },
      package_results: selected_work_packages.map((workPackage) => ({
        work_package_id: workPackage.id,
        status: "pass",
        result: "pass",
        allows_work_package_completion: true,
        completion_authority: {
          allows_work_package_completion: true,
          authority: "verified_provider_executor",
          evidence_kind: "provider_execution",
          reason: "configured workbench provider executor completed requirement intake package"
        },
        completion_evidence: {
          kind: "package_completion",
          artifact_id: `requirement-provider-${workPackage.id}`
        }
      })),
      executor_provenance: {
        executor_kind: "configured_workbench_provider_executor",
        provider: "multi_provider",
        execution_mode: "provider_model_routed",
        execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
        external_calls: 2,
        deterministic: false
      }
    })
  });
});

test("workbench server closes requirement when all approved implementation packages finish", async () => {
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-requirement-closeout-"));
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const inputPath = join(snapshotsRoot, "requirement-closeout-input.json");
  const projectStatusPath = join(snapshotsRoot, "PROJECT_STATUS.json");
  const workflowState = currentSessionWithoutRequirementPlanReview();
  workflowState.manifest.events = [];
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(projectStatusPath, JSON.stringify({
    project: "ai-control-platform",
    status: "in_progress",
    blockers: [],
    next_step: "",
    global_goals: []
  }, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "requirement-closeout",
    items: [
      {
        id: "requirement-closeout",
        label: "Requirement closeout",
        status: "pass",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }, null, 2));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/requirements?id=requirement-closeout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "单步需求自动收口",
        surface_area: "workbench_frontend",
        problem_statement: "所有实施包完成后，任务流应自动显示完成。",
        generated_plan: generatedRequirementPlan({
          implementation_outline: ["完成实现并通过验证"]
        }),
        auto_advance_after_plan_review: true,
        created_at: "2026-05-25T10:00:00.000Z",
        requirement_id: "requirement-auto-closeout"
      })
    });
    const payload = response.json();
    const savedHistory = JSON.parse(readFileSync(historyPath, "utf8"));
    const latestHistoryItem = savedHistory.items.find((entry) => entry.id === savedHistory.latest);
    const latestWorkflowState = JSON.parse(readFileSync(join(process.cwd(), latestHistoryItem.input_path), "utf8"));

    assert.equal(response.status, 201);
    assert.equal(payload.auto_advance.status, "created");
    assert.equal(payload.auto_advance.requirement_completion.status, "completed");
    assert.equal(payload.plan_review.phase, "completed");
    assert.equal(payload.projection.project_management.task_items[0].status, "completed");
    assert.equal(payload.projection.project_management.active_tasks, 0);
    assert.equal(latestWorkflowState.project_status.requirement_intake.items[0].status, "completed");
    assert.equal(latestWorkflowState.project_status.plan_reviews["requirement-auto-closeout"].phase, "completed");
    assert.equal(latestWorkflowState.project_status.requirement_intake.open_count, 0);
  }, {
    historyPath,
    snapshotsRoot,
    projectStatusPath,
    contextWorkPackageProviderExecutor: ({ selected_work_packages }) => ({
      status: "pass",
      completion_evidence: {
        kind: "provider_execution",
        summary: "verified provider completed the only approved package"
      },
      package_results: selected_work_packages.map((workPackage) => ({
        work_package_id: workPackage.id,
        status: "pass",
        result: "pass",
        allows_work_package_completion: true,
        completion_authority: {
          allows_work_package_completion: true,
          authority: "verified_provider_executor",
          evidence_kind: "provider_execution",
          reason: "configured workbench provider executor completed approved development package"
        },
        completion_evidence: {
          kind: "package_completion",
          artifact_id: `requirement-closeout-${workPackage.id}`
        }
      })),
      executor_provenance: {
        executor_kind: "configured_workbench_provider_executor",
        provider: "multi_provider",
        execution_mode: "provider_model_routed",
        execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
        external_calls: 1,
        deterministic: false
      }
    })
  });
});

test("workbench server can complete requirement intake through configured headless child command", async () => {
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-requirement-child-command-"));
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const inputPath = join(snapshotsRoot, "requirement-child-command-input.json");
  const projectStatusPath = join(snapshotsRoot, "PROJECT_STATUS.json");
  const childScriptPath = join(snapshotsRoot, "child-worker.js");
  const workflowState = currentSessionWithoutRequirementPlanReview();
  workflowState.manifest.events = [];
  writeFileSync(childScriptPath, `
console.log(JSON.stringify({
  status: "pass",
  role: "child_worker",
  host: "platform_core",
  changed_files: ["apps/workbench/workbench.js"],
  test_results: [{ command: "node --test test/workbench-server.test.js", status: "pass" }],
  durable_state_updated: true,
  process_hardening: { required: false, status: "not_required" },
  continuation_readiness: { ready: true },
  self_evaluation: { aligned: true, drifted: false, evidence_sufficient: true }
}));
`);
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(projectStatusPath, JSON.stringify({
    project: "ai-control-platform",
    status: "in_progress",
    blockers: [],
    next_step: "",
    global_goals: []
  }, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "requirement-child-command",
    items: [
      {
        id: "requirement-child-command",
        label: "Requirement child command",
        status: "pass",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }, null, 2));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/requirements?id=requirement-child-command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "需求链路使用 headless child command",
        surface_area: "workbench_frontend",
        problem_statement: "需求提交后的实现包必须由受控子进程完成。",
        acceptance_criteria: "配置 child command 时，auto advance 可以完成 context work package。",
        constraints: "不能让 local bounded runner 写 completed。",
        generated_plan: generatedRequirementPlan(),
        auto_advance_after_plan_review: true,
        created_at: "2026-05-25T09:45:00.000Z",
        requirement_id: "requirement-child-command-authorized"
      })
    });
    const payload = response.json();
    const savedHistory = JSON.parse(readFileSync(historyPath, "utf8"));
    const latestHistoryItem = savedHistory.items.find((entry) => entry.id === savedHistory.latest);
    const latestWorkflowState = JSON.parse(readFileSync(join(process.cwd(), latestHistoryItem.input_path), "utf8"));
    const contextRunArtifact = latestWorkflowState.artifact_ledger.artifacts
      .find((artifact) => artifact.metadata?.type === "context_work_packages_run");

    assert.equal(response.status, 201);
    assert.equal(payload.auto_advance.status, "created");
    assert.equal(payload.auto_advance.requirement_completion.status, "not_completed");
    assert.equal(payload.auto_advance.result.status, "pass");
    assert.equal(latestWorkflowState.manifest.work_packages[0].status, "completed");
    assert.equal(contextRunArtifact.metadata.execution_profile, VERIFIED_PROVIDER_MULTI_AGENT_PROFILE);
    assert.equal(contextRunArtifact.metadata.executor_provenance.command_runner_kind, "codex_proxy_child_process");
    assert.equal(
      contextRunArtifact.metadata.package_results[0].completion_evidence.child_output.command_evidence.exit_code,
      0
    );
  }, {
    historyPath,
    snapshotsRoot,
    projectStatusPath,
    childWorkerCommand: process.execPath,
    childWorkerArgs: [childScriptPath],
    childWorkerTimeoutMs: 5000
  });
});

test("workbench server truncates generated context pack snapshot ids for long projection ids", async () => {
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-long-context-id-"));
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const inputPath = join(snapshotsRoot, "long-context-id-input.json");
  const projectStatusPath = join(snapshotsRoot, "PROJECT_STATUS.json");
  const longProjectionId = "headless-continuation-third-cycle-20260521-autonomous-platform-headless-01-headl";
  const workflowState = currentSessionWithoutRequirementPlanReview();
  workflowState.manifest.events = [];
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(projectStatusPath, JSON.stringify({
    project: "ai-control-platform",
    status: "in_progress",
    blockers: [],
    next_step: "",
    global_goals: [
      {
        id: "repo-goal",
        title: "Repository status goal",
        status: "in_progress",
        next_step: "Prepare the next global-goal cycle.",
        owned_files: ["src/workflow/context-pack-cycle.js", "test/context-pack-cycle.test.js"]
      }
    ]
  }, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: longProjectionId,
    items: [
      {
        id: longProjectionId,
        label: "Long projection id",
        status: "pass",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }, null, 2));

  await withServer(async (baseUrl) => {
    await request(`${baseUrl}/api/workbench/next-action?id=${longProjectionId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "prepare_project_status_continuation",
        created_at: "2026-05-22T03:20:00.000Z"
      })
    });

    const cycle = await request(`${baseUrl}/api/workbench/next-action?id=${longProjectionId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "create_context_pack_from_seed",
        cycle_id: "cycle-long-context-id",
        created_at: "2026-05-22T03:21:00.000Z"
      })
    });
    const created = cycle.json();

    assert.equal(cycle.status, 201);
    assert.equal(created.action, "create_context_pack_from_seed");
    assert.ok(created.result.next_item.id.startsWith("context-pack-cycle-"));
    assert.ok(created.result.next_item.id.length <= 80);
    assert.equal(created.result.projection.next_action_readout.action, "run_context_work_packages");
  }, { historyPath, snapshotsRoot, projectStatusPath });
});

test("workbench server only completes verified provider profile with configured executor", async () => {
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-provider-context-"));
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const inputPath = join(snapshotsRoot, "provider-context-input.json");
  writeFileSync(inputPath, JSON.stringify(providerContextWorkPackageWorkflowState(), null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "provider-context",
    items: [
      {
        id: "provider-context",
        label: "Provider context",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }, null, 2));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/context-work-packages-run?id=provider-context`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_package_count: 1,
        execution_mode: "provider_model_routed",
        execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
        provider_executor: "http-body-must-not-be-used",
        created_at: "2026-05-22T05:20:00.000Z"
      })
    });
    const rejected = response.json();
    const stateAfterRejected = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 409);
    assert.equal(rejected.error, "context work package run failed");
    assert.ok(rejected.issues.some((issue) => issue.code === "missing_provider_executor"));
    assert.notEqual(stateAfterRejected.manifest.work_packages[0].status, "completed");
    assert.equal(stateAfterRejected.artifact_ledger.artifacts.length, 0);
  }, { historyPath, snapshotsRoot, projectStatusPath: null });

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/next-action?id=provider-context`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "run_context_work_packages",
        max_package_count: 1,
        execution_mode: "provider_model_routed",
        execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
        created_at: "2026-05-22T05:21:00.000Z"
      })
    });
    const created = response.json();
    const stateAfterCreated = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.status, "executed");
    assert.equal(created.result.status, "created");
    assert.equal(stateAfterCreated.manifest.work_packages[0].status, "completed");
    const contextRunArtifact = stateAfterCreated.artifact_ledger.artifacts
      .find((artifact) => artifact.metadata?.type === "context_work_packages_run");
    assert.equal(contextRunArtifact.metadata.execution_profile, VERIFIED_PROVIDER_MULTI_AGENT_PROFILE);
    assert.equal(contextRunArtifact.metadata.executor_provenance.external_calls, 2);
    assert.equal(contextRunArtifact.metadata.completion_authority.allows_work_package_completion, true);
  }, {
    historyPath,
    snapshotsRoot,
    projectStatusPath: null,
    contextWorkPackageProviderExecutor: ({ selected_work_packages }) => ({
      status: "pass",
      completion_evidence: {
        kind: "provider_execution",
        summary: "configured workbench executor completed provider context package"
      },
      package_results: selected_work_packages.map((workPackage) => ({
        work_package_id: workPackage.id,
        status: "pass",
        result: "pass",
        completion_evidence: {
          kind: "package_completion",
          artifact_id: `workbench-provider-${workPackage.id}`
        }
      })),
      executor_provenance: {
        executor_kind: "configured_workbench_provider_executor",
        provider: "multi_provider",
        execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
        external_calls: 2,
        deterministic: false
      }
    })
  });
});

test("workbench next action defaults requirement implementation packages to verified provider execution", async () => {
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-provider-default-"));
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const inputPath = join(snapshotsRoot, "provider-default-input.json");
  const workflowState = providerContextWorkPackageWorkflowState();
  workflowState.manifest.context_pack.subtasks[0].action = "continue_requirement_intake";
  workflowState.manifest.work_packages[0].action = "continue_requirement_intake";
  workflowState.task_dag[0].action = "continue_requirement_intake";
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "provider-default",
    items: [
      {
        id: "provider-default",
        label: "Provider default",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }, null, 2));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/next-action?id=provider-default`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "run_context_work_packages",
        max_package_count: 1,
        created_at: "2026-05-22T05:22:00.000Z"
      })
    });
    const created = response.json();
    const stateAfterCreated = JSON.parse(readFileSync(inputPath, "utf8"));
    const contextRunArtifact = stateAfterCreated.artifact_ledger.artifacts
      .find((artifact) => artifact.metadata?.type === "context_work_packages_run");

    assert.equal(response.status, 201);
    assert.equal(created.status, "executed");
    assert.equal(created.result.status, "created");
    assert.equal(contextRunArtifact.metadata.execution_mode, "provider_model_routed");
    assert.equal(contextRunArtifact.metadata.execution_profile, VERIFIED_PROVIDER_MULTI_AGENT_PROFILE);
    assert.equal(stateAfterCreated.manifest.work_packages[0].status, "completed");
  }, {
    historyPath,
    snapshotsRoot,
    projectStatusPath: null,
    contextWorkPackageProviderExecutor: ({ selected_work_packages }) => ({
      status: "pass",
      completion_evidence: {
        kind: "provider_execution",
        summary: "provider default completed broad requirement implementation package"
      },
      package_results: selected_work_packages.map((workPackage) => ({
        work_package_id: workPackage.id,
        status: "pass",
        result: "pass",
        completion_evidence: {
          kind: "package_completion",
          artifact_id: `provider-default-${workPackage.id}`
        }
      })),
      executor_provenance: {
        executor_kind: "configured_workbench_provider_executor",
        provider: "multi_provider",
        execution_mode: "provider_model_routed",
        execution_profile: VERIFIED_PROVIDER_MULTI_AGENT_PROFILE,
        external_calls: 2,
        deterministic: false
      }
    })
  });
});

test("workbench server returns projection history index", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/projections`);
    const history = response.json();

    assert.equal(response.status, 200);
    assert.equal(history.version, "projection-history.v1");
    const expectedHistory = currentProjectionHistory();
    assert.equal(history.latest, expectedHistory.latest);
    assert.equal(history.items.length, expectedHistory.items.length);
  });
});

test("workbench server returns selected historical projection", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/projection?id=bootstrap`);
    const projection = response.json();

    assert.equal(response.status, 200);
    assert.equal(projection.run_id, "run-20260521-platform-bootstrap");
    assert.equal(projection.status, "pass");
  });
});

test("workbench server prefers input snapshot over static projection path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-history-"));
  const historyPath = join(dir, "projection-history.json");
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "diverged",
    items: [
      {
        id: "diverged",
        label: "Diverged",
        input_path: "docs/examples/current-session-workbench-input.json",
        projection_path: "docs/examples/bootstrap-workbench-projection.json"
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/projection`);
    const projection = response.json();

    assert.equal(response.status, 200);
    assert.equal(projection.run_id, "run-20260521-platform-self-trial");
    assert.equal(projection.operator_events.status, "pass");
  }, { historyPath });
});

test("workbench server rejects projection history paths outside examples", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-history-"));
  const historyPath = join(dir, "projection-history.json");
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "escape",
    items: [
      {
        id: "escape",
        label: "Escape",
        input_path: "../package.json",
        projection_path: "docs/examples/current-session-workbench-projection.json"
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/projection`);
    const body = response.json();

    assert.equal(response.status, 400);
    assert.match(body.error, /input_path must stay under allowed workbench history roots/);
  }, { historyPath });
});

test("workbench server persists workflow state snapshots and updates history", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-snapshots-"));
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-history-"));
  const historyPath = join(dir, "projection-history.json");
  writeFileSync(historyPath, JSON.stringify({ version: "projection-history.v1", latest: null, items: [] }));
  const workflowState = currentSessionWorkflowState();

  await withServer(async (baseUrl) => {
    const createResponse = await request(`${baseUrl}/api/workbench/snapshots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "posted-snapshot",
        label: "Posted snapshot",
        input: workflowState,
        created_at: "2026-05-21T09:00:00.000Z"
      })
    });
    const created = createResponse.json();
    const history = (await request(`${baseUrl}/api/workbench/projections`)).json();
    const projection = (await request(`${baseUrl}/api/workbench/projection?id=posted-snapshot`)).json();
    const snapshot = (await request(`${baseUrl}/api/workbench/snapshot?id=posted-snapshot`)).json();

    assert.equal(createResponse.status, 201);
    assert.equal(created.status, "created");
    assert.equal(created.item.id, "posted-snapshot");
    assert.match(created.item.input_path, /^tmp\/workbench-server-snapshots-/);
    assert.equal(history.latest, "posted-snapshot");
    assert.equal(projection.run_id, "run-20260521-platform-self-trial");
    assert.equal(projection.operator_events.status, "pass");
    assert.equal(snapshot.manifest.run_id, "run-20260521-platform-self-trial");
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server records reviewer provider health into workflow state input", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-provider-health-"));
  const inputPath = join(snapshotsRoot, "provider-health-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  workflowState.manifest.events = workflowState.manifest.events.filter((event) => event.type !== "reviewer_provider_health");
  workflowState.manifest.artifacts = workflowState.manifest.artifacts.filter((artifact) => artifact.metadata?.type !== "reviewer_provider_health");
  workflowState.artifact_ledger.artifacts = workflowState.artifact_ledger.artifacts.filter((artifact) => artifact.metadata?.type !== "reviewer_provider_health");
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "provider-health",
    items: [
      {
        id: "provider-health",
        label: "Provider health",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/reviewer-provider-health`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        smoke_status: "timeout",
        tools: ["Read", "Grep"],
        created_at: "2026-05-21T12:20:00.000Z"
      })
    });
    const created = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.status, "created");
    assert.equal(created.fact.provider_health, "unhealthy");
    assert.equal(created.fact.scheduled_actions[0], "fallback_model_or_defer_external_review");
    assert.equal(created.projection.reviewer_provider_health.provider_health, "unhealthy");
    assert.equal(state.manifest.events.at(-1).type, "reviewer_provider_health");
    assert.equal(state.artifact_ledger.artifacts.at(-1).metadata.provider_health, "unhealthy");
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server rejects provider health recording without workflow state input", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/reviewer-provider-health?id=bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ smoke_status: "pass" })
    });
    const rejected = response.json();

    assert.equal(response.status, 400);
    assert.match(rejected.error, /workflow state input not found/);
  });
});

test("workbench server records reviewer shard results into workflow state input", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-shard-result-"));
  const inputPath = join(snapshotsRoot, "shard-result-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "shard-result",
    items: [
      {
        id: "shard-result",
        label: "Shard result",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const first = await request(`${baseUrl}/api/workbench/reviewer-shard-result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shard_id: "reviewer-scope-shard-001",
        status: "pass",
        created_at: "2026-05-21T12:30:00.000Z"
      })
    });
    const second = await request(`${baseUrl}/api/workbench/reviewer-shard-result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shard_id: "reviewer-scope-shard-002",
        findings: [
          {
            id: "api-shard-finding",
            status: "fail",
            severity: "medium",
            category: "reviewer",
            message: "api shard finding"
          }
        ],
        aggregate: true,
        created_at: "2026-05-21T12:31:00.000Z"
      })
    });
    const created = second.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(created.aggregate.status, "fail");
    assert.equal(created.projection.reviewer_shard_review.completed_shards, 2);
    assert.equal(created.projection.reviewer_shard_review.failed_finding_count, 1);
    assert.equal(state.manifest.events.at(-1).type, "reviewer_shard_aggregate");
    assert.ok(state.manifest.review_findings.some((finding) => finding.finding_id === "api-shard-finding"));
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server records agent lifecycle cleanup into workflow state input", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-agent-lifecycle-"));
  const inputPath = join(snapshotsRoot, "agent-lifecycle-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  workflowState.manifest.events = workflowState.manifest.events.filter((event) => ![
    "WorkerSpawned",
    "WorkerCompleted",
    "WorkerEvaluation",
    "WorkerClosed",
    "PoolIterationClosed"
  ].includes(event.type));
  workflowState.manifest.artifacts = workflowState.manifest.artifacts.filter((artifact) => artifact.metadata?.type !== "agent_lifecycle_pool");
  workflowState.artifact_ledger.artifacts = workflowState.artifact_ledger.artifacts.filter((artifact) => artifact.metadata?.type !== "agent_lifecycle_pool");
  workflowState.manifest.events.push(
    {
      id: "worker-spawned-api",
      type: "WorkerSpawned",
      status: "pass",
      created_at: "2026-05-22T08:15:00.000Z",
      metadata: { pool_id: "pool-api", worker_id: "worker-api" }
    },
    {
      id: "worker-completed-api",
      type: "WorkerCompleted",
      status: "pass",
      created_at: "2026-05-22T08:16:00.000Z",
      metadata: { pool_id: "pool-api", worker_id: "worker-api" }
    }
  );
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "agent-lifecycle",
    items: [
      {
        id: "agent-lifecycle",
        label: "Agent lifecycle",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/agent-lifecycle-pool`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cleanup_latest_pool: true,
        created_at: "2026-05-22T08:17:00.000Z"
      })
    });
    const created = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.status, "created");
    assert.equal(created.after.status, "pass");
    assert.equal(created.projection.agent_lifecycle_pool.status, "pass");
    assert.notEqual(created.projection.next_action_readout.action, "cleanup_agent_lifecycle_pool");
    assert.deepEqual(created.facts.map((fact) => fact.event_type), [
      "WorkerEvaluation",
      "WorkerClosed",
      "PoolIterationClosed"
    ]);
    assert.equal(state.manifest.events.at(-1).type, "PoolIterationClosed");
    assert.equal(state.artifact_ledger.artifacts.at(-1).metadata.lifecycle_event, "PoolIterationClosed");
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server rejects agent lifecycle recording without workflow state input", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/agent-lifecycle-pool?id=bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cleanup_latest_pool: true })
    });
    const rejected = response.json();

    assert.equal(response.status, 400);
    assert.match(rejected.error, /workflow state input not found/);
  });
});

test("workbench server records workbench browser event run artifacts", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-browser-events-"));
  const inputPath = join(snapshotsRoot, "browser-events-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "browser-events",
    items: [
      {
        id: "browser-events",
        label: "Browser events",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/workbench-browser-events-run?id=browser-events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: "workbench-browser-events-run.v1",
        status: "pass",
        created_at: "2026-05-22T06:45:00.000Z",
        scenario_count: 1,
        scenarios: [
          {
            scenario: "projected_real_partial_shard_readout",
            shard_review_next: "reviewer-scope-shard-002",
            next_action_readout: "run_reviewer_scope_shard",
            dimensions: { width: 1440, scrollWidth: 1440 }
          }
        ]
      })
    });
    const created = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.status, "created");
    assert.equal(created.projection.workbench_browser_events.status, "pass");
    assert.equal(created.projection.workbench_browser_events.partial_shard_ready, true);
    assert.equal(state.manifest.events.at(-1).type, "workbench_browser_events_run");
    assert.equal(state.artifact_ledger.artifacts.at(-1).metadata.version, "workbench-browser-events-run.v1");
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server creates scheduler dispatch plans from projection history input", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-scheduler-plan-"));
  const inputPath = join(snapshotsRoot, "scheduler-plan-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWithoutRequirementPlanReview();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "scheduler-plan",
    items: [
      {
        id: "scheduler-plan",
        label: "Scheduler plan",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-dispatch-plan?id=scheduler-plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        next_step: "Continue from generated scheduler plan.",
        reviewer_mock_status: "pass"
      })
    });
    const created = response.json();

    assert.equal(response.status, 201);
    assert.equal(created.status, "created");
    assert.equal(created.plan.status, "pass");
    assert.equal(created.plan.writeback.mode, "service");
    assert.equal(created.plan.writeback.base_url, baseUrl);
    assert.equal(created.plan.writeback.projection_id, "scheduler-plan");
    assert.ok(created.plan.steps[0].args.includes(relative(process.cwd(), inputPath)));
    assert.ok(created.plan.steps[0].args.includes("--mock-status"));
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server runs guarded scheduler dispatch dry-run from projection history input", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-scheduler-control-"));
  const inputPath = join(snapshotsRoot, "scheduler-control-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "scheduler-control",
    items: [
      {
        id: "scheduler-control",
        label: "Scheduler control",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-dispatch?id=scheduler-control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dry_run: true })
    });
    const created = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.status, "created");
    assert.equal(created.policy.execution_mode, "dry_run");
    assert.equal(created.result.status, "pass");
    assert.equal(created.projection.scheduler_dispatch.status, "pass");
    assert.equal(created.projection.scheduler_dispatch.policy_status, "pass");
    assert.equal(created.projection.scheduler_dispatch.policy_execution_mode, "dry_run");
    assert.equal(created.projection.scheduler_dispatch.step_count, 3);
    assert.equal(state.manifest.events.at(-2).type, "scheduler_dispatch_policy");
    assert.equal(state.manifest.events.at(-1).type, "scheduler_dispatch_run");
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server runs approved mocked non-dry-run scheduler dispatch from profile", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-scheduler-approved-mock-"));
  const inputPath = join(snapshotsRoot, "scheduler-approved-mock-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "scheduler-approved-mock",
    items: [
      {
        id: "scheduler-approved-mock",
        label: "Scheduler approved mock",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-dispatch?id=scheduler-approved-mock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        execution_profile: "approved_mock_non_dry_run",
        created_at: "2026-05-22T00:10:00.000Z"
      })
    });
    const created = response.json();
    const historyReady = (await request(`${baseUrl}/api/workbench/projections`)).json();
    const readyItem = historyReady.items.find((entry) => entry.id === "scheduler-approved-mock");
    const nextCycle = await request(`${baseUrl}/api/workbench/scheduler-next-cycle?id=scheduler-approved-mock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        snapshot_id: "scheduler-approved-mock-next",
        label: "Scheduler approved mock next",
        created_at: "2026-05-22T00:11:00.000Z"
      })
    });
    const queued = nextCycle.json();
    const historyQueued = (await request(`${baseUrl}/api/workbench/projections`)).json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.control.input.execution_profile, "approved_mock_non_dry_run");
    assert.equal(created.policy.execution_mode, "execute");
    assert.equal(created.policy.controls.max_external_reviewer_calls, 0);
    assert.equal(created.result.status, "pass");
    assert.equal(created.projection.scheduler_dispatch.dry_run, false);
    assert.equal(created.projection.scheduler_dispatch.policy_execution_mode, "execute");
    assert.equal(created.projection.scheduler_dispatch.next_continuation_action, "continue");
    assert.equal(created.projection.scheduler_dispatch.next_work_package_count, 1);
    assert.equal(created.projection.scheduler_continuation.ready, true);
    assert.equal(created.projection.scheduler_continuation.next_work_package_count, 1);
    assert.equal(readyItem.scheduler_dispatch.continuation_ready, true);
    assert.equal(readyItem.scheduler_dispatch.enqueue_available, true);
    assert.equal(readyItem.scheduler_dispatch.next_work_package_count, 1);
    assert.equal(nextCycle.status, 201);
    assert.equal(queued.status, "queued");
    assert.equal(queued.next_item.id, "scheduler-approved-mock-next");
    assert.equal(queued.projection.scheduler_continuation.status, "not_configured");
    assert.equal(queued.current_projection.scheduler_continuation.enqueue_status, "queued");
    assert.equal(historyQueued.latest, "scheduler-approved-mock-next");
    assert.equal(state.manifest.events.at(-4).type, "scheduler_dispatch_policy");
    assert.equal(state.manifest.events.at(-3).type, "scheduler_dispatch_run");
    assert.equal(state.manifest.events.at(-2).type, "scheduler_dispatch_continuation");
    assert.equal(state.manifest.events.at(-1).type, "scheduler_next_cycle_enqueue");
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server runs approved non-dry-run scheduler dispatch for lifecycle cleanup without continuation", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-scheduler-cleanup-"));
  const inputPath = join(snapshotsRoot, "scheduler-cleanup-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  workflowState.manifest.events = workflowState.manifest.events.filter((event) => ![
    "WorkerSpawned",
    "WorkerCompleted",
    "WorkerEvaluation",
    "WorkerClosed",
    "PoolIterationClosed",
    "reviewer_provider_health",
    "reviewer_scope_split",
    "reviewer_shard_result",
    "reviewer_shard_aggregate"
  ].includes(event.type));
  workflowState.manifest.artifacts = workflowState.manifest.artifacts.filter((artifact) => artifact.metadata?.type !== "agent_lifecycle_pool");
  workflowState.artifact_ledger.artifacts = workflowState.artifact_ledger.artifacts.filter((artifact) => artifact.metadata?.type !== "agent_lifecycle_pool");
  workflowState.manifest.events.push(
    {
      id: "worker-spawned-cleanup",
      type: "WorkerSpawned",
      status: "pass",
      created_at: "2026-05-22T08:20:00.000Z",
      metadata: { pool_id: "pool-scheduler-cleanup", worker_id: "worker-cleanup" }
    },
    {
      id: "worker-completed-cleanup",
      type: "WorkerCompleted",
      status: "pass",
      created_at: "2026-05-22T08:21:00.000Z",
      metadata: { pool_id: "pool-scheduler-cleanup", worker_id: "worker-cleanup" }
    }
  );
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "scheduler-cleanup",
    items: [
      {
        id: "scheduler-cleanup",
        label: "Scheduler cleanup",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-dispatch?id=scheduler-cleanup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        execution_profile: "approved_mock_non_dry_run",
        created_at: "2026-05-22T08:22:00.000Z"
      })
    });
    const created = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.plan.dispatch_kind, "agent_lifecycle_cleanup");
    assert.equal(created.plan.continuation_output.mode, "none");
    assert.equal(created.result.status, "pass");
    assert.equal(created.result.steps.length, 1);
    assert.equal(created.continuation, null);
    assert.equal(created.projection.agent_lifecycle_pool.status, "pass");
    assert.equal(created.projection.scheduler_dispatch.step_count, 1);
    assert.equal(created.projection.scheduler_continuation.ready, false);
    assert.ok(state.manifest.events.some((event) => event.type === "WorkerEvaluation"));
    assert.ok(state.manifest.events.some((event) => event.type === "WorkerClosed"));
    assert.ok(state.manifest.events.some((event) => event.type === "PoolIterationClosed"));
    assert.equal(state.manifest.events.at(-1).type, "scheduler_dispatch_run");
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server rejects scheduler next-cycle without workflow state input", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-next-cycle?id=bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    const rejected = response.json();

    assert.equal(response.status, 400);
    assert.match(rejected.error, /workflow state input not found/);
  });
});

test("workbench server rejects scheduler next-cycle without dispatch run artifact", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-next-cycle-missing-"));
  const inputPath = join(snapshotsRoot, "next-cycle-missing-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "next-cycle-missing",
    items: [
      {
        id: "next-cycle-missing",
        label: "Next cycle missing",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-next-cycle?id=next-cycle-missing`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ snapshot_id: "next-cycle-missing-output" })
    });
    const rejected = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 400);
    assert.equal(rejected.error, "scheduler dispatch run artifact not found");
    assert.equal(state.manifest.events.length, workflowState.manifest.events.length);
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server executes allowlisted projected next actions", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-next-action-"));
  const inputPath = join(snapshotsRoot, "next-action-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWithoutRequirementPlanReview();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "next-action-source",
    items: [
      {
        id: "next-action-source",
        label: "Next action source",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const dispatch = await request(`${baseUrl}/api/workbench/scheduler-dispatch?id=next-action-source`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        execution_profile: "approved_mock_non_dry_run",
        created_at: "2026-05-22T02:50:00.000Z"
      })
    });
    assert.equal(dispatch.status, 201);

    const enqueue = await request(`${baseUrl}/api/workbench/next-action?id=next-action-source`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "enqueue_scheduler_next_cycle",
        snapshot_id: "next-action-queued",
        label: "Next action queued",
        created_at: "2026-05-22T02:51:00.000Z"
      })
    });
    const queued = enqueue.json();
    const sourceAfterEnqueue = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(enqueue.status, 201);
    assert.equal(queued.status, "executed");
    assert.equal(queued.action, "enqueue_scheduler_next_cycle");
    assert.equal(queued.next_action_readout.action, "enqueue_scheduler_next_cycle");
    assert.equal(queued.result.status, "queued");
    assert.equal(queued.result.next_item.id, "next-action-queued");
    assert.equal(sourceAfterEnqueue.manifest.events.at(-1).type, "scheduler_next_cycle_enqueue");

    const loop = await request(`${baseUrl}/api/workbench/next-action?id=next-action-source`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "run_autonomous_scheduler_loop",
        max_iterations: 1,
        snapshot_prefix: "next-action-loop",
        created_at: "2026-05-22T02:52:00.000Z"
      })
    });
    const looped = loop.json();
    const sourceAfterLoop = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(loop.status, 201);
    assert.equal(looped.status, "executed");
    assert.equal(looped.action, "run_autonomous_scheduler_loop");
    assert.equal(looped.next_action_readout.action, "run_autonomous_scheduler_loop");
    assert.equal(looped.result.status, "created");
    assert.equal(looped.result.result.phase, "iteration_limit_reached");
    assert.equal(sourceAfterLoop.manifest.events.at(-1).type, "autonomous_scheduler_loop_run");
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server advances from completed context work packages to project status continuation", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-context-work-packages-next-action-"));
  const inputPath = join(snapshotsRoot, "context-work-packages-next-action-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWithoutRequirementPlanReview();
  workflowState.project_status = {
    project: "ai-control-platform",
    next_step: "",
    global_goals: [
      { id: "foundation", title: "Foundation", status: "completed" },
      {
        id: "completion-loop",
        title: "Completion loop",
        status: "in_progress",
        next_step: "Continue detecting unfinished platform goals."
      }
    ]
  };
  workflowState.task_dag = [
    {
      id: "runtime",
      title: "Runtime",
      status: "completed",
      owned_files: ["src/workflow/context-work-package-runner.js"]
    }
  ];
  workflowState.manifest.events = [
    ...workflowState.manifest.events,
    {
      id: "event-context-work-packages-run",
      type: "context_work_packages_run",
      status: "pass",
      created_at: "2026-05-22T03:10:00.000Z",
      metadata: {
        type: "context_work_packages_run",
        status: "pass",
        executed_count: 1
      }
    }
  ];
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "context-work-packages-next-action",
    items: [
      {
        id: "context-work-packages-next-action",
        label: "Context work packages next action",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const projection = await request(`${baseUrl}/api/workbench/projection?id=context-work-packages-next-action`);
    assert.equal(projection.json().next_action_readout.action, "prepare_project_status_continuation");

    const response = await request(`${baseUrl}/api/workbench/next-action?id=context-work-packages-next-action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "prepare_project_status_continuation",
        created_at: "2026-05-22T03:11:00.000Z"
      })
    });
    const executed = response.json();

    assert.equal(response.status, 201);
    assert.equal(executed.status, "executed");
    assert.equal(executed.action, "prepare_project_status_continuation");
    assert.equal(executed.next_action_readout.action, "prepare_project_status_continuation");
    assert.equal(executed.result.status, "created");
    assert.equal(executed.result.projection.next_action_readout.action, "create_context_pack_from_seed");
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server runs reviewer shard through projected next action", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-next-action-reviewer-"));
  const inputPath = join(snapshotsRoot, "next-action-reviewer-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWithoutSchedulerLoop();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "next-action-reviewer",
    items: [
      {
        id: "next-action-reviewer",
        label: "Next action reviewer",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/next-action?id=next-action-reviewer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "run_reviewer_scope_shard",
        reviewer_mock_status: "pass",
        created_at: "2026-05-22T02:53:00.000Z"
      })
    });
    const created = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.status, "executed");
    assert.equal(created.action, "run_reviewer_scope_shard");
    assert.equal(created.result.status, "created");
    assert.equal(created.result.phase, "shard_recorded");
    assert.equal(created.projection.reviewer_shard_review.completed_shards, 1);
    assert.equal(state.manifest.events.at(-1).type, "reviewer_shard_result");
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server continues after reviewer aggregate through projected next action", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-next-action-reviewer-aggregate-"));
  const inputPath = join(snapshotsRoot, "next-action-reviewer-aggregate-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWithoutSchedulerLoop();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "next-action-reviewer-aggregate",
    items: [
      {
        id: "next-action-reviewer-aggregate",
        label: "Next action reviewer aggregate",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    for (const createdAt of ["2026-05-22T02:53:00.000Z", "2026-05-22T02:53:20.000Z"]) {
      const shard = await request(`${baseUrl}/api/workbench/next-action?id=next-action-reviewer-aggregate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expected_action: "run_reviewer_scope_shard",
          reviewer_mock_status: "pass",
          created_at: createdAt
        })
      });
      assert.equal(shard.status, 201);
    }

    const before = await request(`${baseUrl}/api/workbench/projection?id=next-action-reviewer-aggregate`);
    assert.equal(before.json().next_action_readout.action, "continue_after_reviewer_aggregate");

    const response = await request(`${baseUrl}/api/workbench/next-action?id=next-action-reviewer-aggregate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "continue_after_reviewer_aggregate",
        created_at: "2026-05-22T02:53:40.000Z"
      })
    });
    const created = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.status, "executed");
    assert.equal(created.action, "continue_after_reviewer_aggregate");
    assert.equal(created.result.status, "created");
    assert.equal(created.result.projection.next_action_readout.action, "create_context_pack_from_seed");
    assert.equal(created.projection.next_action_readout.action, "create_context_pack_from_seed");
    assert.equal(state.manifest.events.at(-2).type, "reviewer_shard_aggregate");
    assert.equal(state.manifest.events.at(-1).type, "project_status_continuation");
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server executes retry_agent_worker through context work package next action", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-next-action-retry-agent-"));
  const inputPath = join(snapshotsRoot, "next-action-retry-agent-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = retryAgentWorkerWorkflowState();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "next-action-retry-agent",
    items: [
      {
        id: "next-action-retry-agent",
        label: "Next action retry agent",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const before = await request(`${baseUrl}/api/workbench/projection?id=next-action-retry-agent`);
    assert.equal(before.json().next_action_readout.action, "run_context_work_packages");

    const response = await request(`${baseUrl}/api/workbench/next-action?id=next-action-retry-agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "run_context_work_packages",
        created_at: "2026-05-22T09:21:00.000Z"
      })
    });
    const created = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));
    const eventTypes = state.manifest.events.map((event) => event.type);

    assert.equal(response.status, 201);
    assert.equal(created.status, "executed");
    assert.equal(created.action, "run_context_work_packages");
    assert.equal(created.result.status, "created");
    assert.ok(eventTypes.includes("WorkerSpawned"));
    assert.ok(eventTypes.includes("WorkerHeartbeat"));
    assert.equal(created.projection.agent_lifecycle_pool.pool_id, "pool-server");
    assert.equal(created.projection.agent_lifecycle_pool.heartbeat_count, 1);
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server blocks reviewer shard execution when mock profile has no mock output", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-reviewer-policy-block-"));
  const inputPath = join(snapshotsRoot, "reviewer-policy-block-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWithoutRequirementPlanReview();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "reviewer-policy-block",
    items: [
      {
        id: "reviewer-policy-block",
        label: "Reviewer policy block",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/reviewer-shard-run?id=reviewer-policy-block`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        execution_profile: "approved_mock_non_dry_run",
        created_at: "2026-05-22T04:40:00.000Z"
      })
    });
    const rejected = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 400);
    assert.equal(rejected.error, "reviewer execution policy rejected");
    assert.ok(rejected.issues.some((entry) => entry.code === "missing_mock_reviewer_output"));
    assert.equal(state.manifest.events.length, workflowState.manifest.events.length);
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server runs bounded real reviewer profile only with explicit budget", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-real-reviewer-policy-"));
  const inputPath = join(snapshotsRoot, "real-reviewer-policy-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  workflowState.manifest.events.push({
    id: "event-real-reviewer-health",
    type: "reviewer_provider_health",
    status: "retry",
    created_at: "2026-05-22T04:40:00.000Z",
    metadata: {
      type: "reviewer_provider_health",
      provider_health: "healthy",
      recovery_status: "retry",
      retry_strategy: "rerun_without_tools_or_split_scope",
      provider: "deepseek",
      model: "deepseek-v4-pro"
    }
  });
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "real-reviewer-policy",
    items: [
      {
        id: "real-reviewer-policy",
        label: "Real reviewer policy",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  const calls = [];
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/reviewer-shard-run?id=real-reviewer-policy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        execution_profile: "approved_bounded_real_reviewer",
        max_external_reviewer_calls: 1,
        provider_cost_mode: "bounded",
        timeout_seconds: 90,
        created_at: "2026-05-22T04:41:00.000Z"
      })
    });
    const created = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.status, "created");
    assert.equal(created.reviewer_execution_policy.execution_mode, "bounded_real_reviewer");
    assert.equal(created.result.executor_provenance.executor_kind, "test_real_reviewer");
    assert.equal(calls.length, 1);
    assert.equal(state.manifest.events.at(-1).type, "reviewer_shard_result");
  }, {
    historyPath,
    snapshotsRoot,
    projectStatusPath: null,
    realReviewerExecutor: async ({ shard }) => {
      calls.push(shard.id);
      return {
        status: "pass",
        findings: [],
        provenance: {
          executor_kind: "test_real_reviewer",
          provider: "deepseek",
          model: "deepseek-v4-pro",
          timeout_seconds: 90,
          external_call_budget_used: 1
        }
      };
    }
  });
});

test("workbench server blocks bounded real reviewer profile without healthy provider preflight", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-real-reviewer-preflight-"));
  const inputPath = join(snapshotsRoot, "real-reviewer-preflight-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  workflowState.manifest.events = workflowState.manifest.events.filter((event) => event.type !== "reviewer_provider_health");
  workflowState.manifest.artifacts = workflowState.manifest.artifacts.filter((artifact) => artifact.metadata?.type !== "reviewer_provider_health");
  workflowState.artifact_ledger.artifacts = workflowState.artifact_ledger.artifacts.filter((artifact) => artifact.metadata?.type !== "reviewer_provider_health");
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "real-reviewer-preflight",
    items: [
      {
        id: "real-reviewer-preflight",
        label: "Real reviewer preflight",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/reviewer-shard-run?id=real-reviewer-preflight`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        execution_profile: "approved_bounded_real_reviewer",
        max_external_reviewer_calls: 1,
        provider_cost_mode: "bounded",
        timeout_seconds: 90,
        created_at: "2026-05-22T04:42:00.000Z"
      })
    });
    const rejected = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 400);
    assert.equal(rejected.error, "reviewer execution policy rejected");
    assert.ok(rejected.issues.some((entry) => entry.code === "reviewer_provider_health_preflight_required"));
    assert.equal(state.manifest.events.length, workflowState.manifest.events.length);
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server records direct reviewer shard runs", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-reviewer-shard-run-"));
  const inputPath = join(snapshotsRoot, "reviewer-shard-run-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "reviewer-shard-run",
    items: [
      {
        id: "reviewer-shard-run",
        label: "Reviewer shard run",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/reviewer-shard-run?id=reviewer-shard-run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reviewer_mock_status: "pass",
        created_at: "2026-05-22T02:53:30.000Z"
      })
    });
    const created = response.json();

    assert.equal(response.status, 201);
    assert.equal(created.status, "created");
    assert.equal(created.phase, "shard_recorded");
    assert.equal(created.shard_id, "reviewer-scope-shard-001");
    assert.equal(created.pending_shards, 1);
    assert.equal(created.projection.reviewer_shard_review.completed_shards, 1);
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server resumes scheduler loop through projected next action", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-next-action-resume-"));
  const inputPath = join(snapshotsRoot, "next-action-resume-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWithoutRequirementPlanReview();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "next-action-resume",
    items: [
      {
        id: "next-action-resume",
        label: "Next action resume",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const loop = await request(`${baseUrl}/api/workbench/autonomous-scheduler-loop?id=next-action-resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_iterations: 1,
        snapshot_prefix: "resume-loop",
        created_at: "2026-05-22T02:53:40.000Z"
      })
    });
    assert.equal(loop.status, 201);

    const response = await request(`${baseUrl}/api/workbench/next-action?id=next-action-resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "resume_autonomous_scheduler_loop",
        snapshot_prefix: "next-action-resume",
        created_at: "2026-05-22T02:53:50.000Z"
      })
    });
    const created = response.json();
    const sourceState = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.status, "executed");
    assert.equal(created.action, "resume_autonomous_scheduler_loop");
    assert.equal(created.result.status, "created");
    assert.equal(created.result.recovery.status, "ready");
    assert.equal(sourceState.manifest.events.at(-1).type, "scheduler_loop_resume_attempt");
    assert.equal(sourceState.manifest.events.at(-1).status, "pass");
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server fails closed for unsupported projected next action", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-next-action-unsupported-"));
  const inputPath = join(snapshotsRoot, "next-action-unsupported-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWithoutRequirementPlanReview();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "next-action-unsupported",
    items: [
      {
        id: "next-action-unsupported",
        label: "Next action unsupported",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const first = await request(`${baseUrl}/api/workbench/autonomous-scheduler-loop?id=next-action-unsupported`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_iterations: 1,
        snapshot_prefix: "unsupported-loop",
        created_at: "2026-05-22T02:53:40.000Z"
      })
    });
    assert.equal(first.status, 201);
    const resumed = await request(`${baseUrl}/api/workbench/next-action?id=next-action-unsupported`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "resume_autonomous_scheduler_loop",
        snapshot_prefix: "unsupported-resume",
        created_at: "2026-05-22T02:53:50.000Z"
      })
    });
    assert.equal(resumed.status, 201);

    const response = await request(`${baseUrl}/api/workbench/next-action?id=next-action-unsupported`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "wait_for_new_work",
        created_at: "2026-05-22T02:54:00.000Z"
      })
    });
    const rejected = response.json();

    assert.equal(response.status, 409);
    assert.equal(rejected.next_action_readout.action, "wait_for_new_work");
    assert.equal(rejected.projection.next_action_terminal.status, "idle");
    assert.equal(rejected.projection.next_action_terminal.terminal_action, "wait_for_new_work");
    assert.equal(rejected.projection.next_action_terminal.terminal_reason, "scheduler loop resume completed; wait for new dispatchable work");
    assert.equal(assertWorkbenchProjectionSchema(rejected.projection).status, "pass");
    assert.equal(rejected.issues[0].code, "unsupported_projected_next_action");
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server fails closed when projected next action drifts", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/next-action?id=current-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "enqueue_scheduler_next_cycle",
        created_at: "2026-05-22T02:54:00.000Z"
      })
    });
    const rejected = response.json();

    assert.equal(response.status, 409);
    assert.ok(rejected.next_action_readout.action);
    assert.equal(rejected.issues[0].code, "next_action_drift");
    assert.match(rejected.issues[0].message, /expected enqueue_scheduler_next_cycle/);
  });
});

test("workbench server runs bounded autonomous scheduler loop from projection history input", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-autonomous-loop-"));
  const inputPath = join(snapshotsRoot, "autonomous-loop-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "autonomous-loop",
    items: [
      {
        id: "autonomous-loop",
        label: "Autonomous loop",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/autonomous-scheduler-loop?id=autonomous-loop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_iterations: 1,
        snapshot_prefix: "server-loop",
        created_at: "2026-05-22T00:50:00.000Z"
      })
    });
    const created = response.json();
    const history = (await request(`${baseUrl}/api/workbench/projections`)).json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.status, "created");
    assert.equal(created.result.phase, "iteration_limit_reached");
    assert.equal(created.projection.scheduler_loop.status, "pass");
    assert.equal(created.projection.scheduler_loop.iteration_count, 1);
    assert.equal(created.projection.scheduler_loop.recovery_status, "ready");
    assert.equal(history.latest, "server-loop-autonomous-loop-01");
    const sourceItem = history.items.find((entry) => entry.id === "autonomous-loop");
    assert.equal(sourceItem.scheduler_loop.status, "pass");
    assert.equal(sourceItem.scheduler_loop.recovery_status, "ready");
    assert.equal(sourceItem.scheduler_loop.resume_projection_id, "server-loop-autonomous-loop-01");
    assert.equal(state.manifest.events.at(-1).type, "autonomous_scheduler_loop_run");
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server can run autonomous scheduler loop through projected next actions", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-projected-loop-"));
  const inputPath = join(snapshotsRoot, "projected-loop-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWithoutSchedulerLoop();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "projected-loop",
    items: [
      {
        id: "projected-loop",
        label: "Projected loop",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/autonomous-scheduler-loop?id=projected-loop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_iterations: 2,
        execution_strategy: "projected_next_action",
        reviewer_mock_status: "pass",
        snapshot_prefix: "projected-loop",
        created_at: "2026-05-22T03:45:00.000Z"
      })
    });
    const created = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.status, "created");
    assert.equal(created.result.phase, "iteration_limit_reached");
    assert.equal(created.result.iterations[0].projected_action, "run_reviewer_scope_shard");
    assert.equal(created.result.iterations[1].projected_action, "run_reviewer_scope_shard");
    assert.equal(state.manifest.events.at(-2).type, "reviewer_shard_aggregate");
    assert.equal(state.manifest.events.at(-1).type, "autonomous_scheduler_loop_run");
    assert.equal(created.projection.reviewer_shard_review.pending_shards, 0);
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server can run projected real reviewer loop with injected executor", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-projected-real-loop-"));
  const inputPath = join(snapshotsRoot, "projected-real-loop-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWithoutSchedulerLoop();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "projected-real-loop",
    items: [
      {
        id: "projected-real-loop",
        label: "Projected real loop",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  const calls = [];
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/autonomous-scheduler-loop?id=projected-real-loop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_iterations: 1,
        execution_profile: "approved_bounded_real_reviewer",
        execution_strategy: "projected_next_action",
        max_external_reviewer_calls: 1,
        provider_cost_mode: "bounded",
        timeout_seconds: 90,
        snapshot_prefix: "projected-real-loop",
        created_at: "2026-05-22T05:11:00.000Z"
      })
    });
    const created = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.status, "created");
    assert.equal(created.result.iterations[0].projected_action, "run_reviewer_scope_shard");
    assert.equal(created.projection.reviewer_shard_review.latest_executor_kind, "test_real_reviewer");
    assert.equal(created.projection.reviewer_shard_review.latest_external_call_budget_used, 1);
    assert.equal(created.projection.scheduler_loop.execution_profile, "approved_bounded_real_reviewer");
    assert.equal(calls.length, 1);
    assert.equal(state.manifest.events.at(-1).type, "autonomous_scheduler_loop_run");
  }, {
    historyPath,
    snapshotsRoot,
    projectStatusPath: null,
    realReviewerExecutor: async ({ shard }) => {
      calls.push(shard.id);
      return {
        status: "pass",
        findings: [],
        provenance: {
          executor_kind: "test_real_reviewer",
          provider: "deepseek",
          model: "deepseek-v4-pro",
          timeout_seconds: 90,
          external_call_budget_used: 1
        }
      };
    }
  });
});

test("workbench server continues projected real reviewer loop from durable partial shard state", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-projected-real-resume-"));
  const inputPath = join(snapshotsRoot, "projected-real-resume-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWithoutSchedulerLoop();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "projected-real-resume",
    items: [
      {
        id: "projected-real-resume",
        label: "Projected real resume",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  const calls = [];
  const realReviewerExecutor = async ({ shard }) => {
    calls.push(shard.id);
    return {
      status: "pass",
      findings: [],
      provenance: {
        executor_kind: "test_real_reviewer",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        timeout_seconds: 90,
        external_call_budget_used: 1
      }
    };
  };

  await withServer(async (baseUrl) => {
    const first = await request(`${baseUrl}/api/workbench/autonomous-scheduler-loop?id=projected-real-resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_iterations: 1,
        execution_profile: "approved_bounded_real_reviewer",
        execution_strategy: "projected_next_action",
        max_external_reviewer_calls: 1,
        provider_cost_mode: "bounded",
        timeout_seconds: 90,
        snapshot_prefix: "projected-real-resume",
        created_at: "2026-05-22T05:40:00.000Z"
      })
    });
    const firstCreated = first.json();

    assert.equal(first.status, 201);
    assert.deepEqual(calls, ["reviewer-scope-shard-001"]);
    assert.equal(firstCreated.projection.reviewer_shard_review.completed_shards, 1);
    assert.equal(firstCreated.projection.reviewer_shard_review.next_shard, "reviewer-scope-shard-002");
    assert.equal(firstCreated.projection.next_action_readout.action, "run_reviewer_scope_shard");

    const second = await request(`${baseUrl}/api/workbench/autonomous-scheduler-loop?id=projected-real-resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_iterations: 1,
        execution_profile: "approved_bounded_real_reviewer",
        execution_strategy: "projected_next_action",
        max_external_reviewer_calls: 1,
        provider_cost_mode: "bounded",
        timeout_seconds: 90,
        snapshot_prefix: "projected-real-resume",
        created_at: "2026-05-22T05:41:00.000Z"
      })
    });
    const secondCreated = second.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));
    const shardIds = state.manifest.events
      .filter((event) => event.type === "reviewer_shard_result")
      .map((event) => event.metadata.shard_id);

    assert.equal(second.status, 201);
    assert.deepEqual(calls, ["reviewer-scope-shard-001", "reviewer-scope-shard-002"]);
    assert.deepEqual(shardIds, ["reviewer-scope-shard-001", "reviewer-scope-shard-002"]);
    assert.equal(secondCreated.result.iterations[0].projected_action, "run_reviewer_scope_shard");
    assert.equal(secondCreated.projection.reviewer_shard_review.pending_shards, 0);
    assert.equal(secondCreated.projection.reviewer_shard_review.status, "pass");
    assert.equal(state.manifest.events.at(-2).type, "reviewer_shard_aggregate");
    assert.equal(state.manifest.events.at(-1).type, "autonomous_scheduler_loop_run");
  }, {
    historyPath,
    snapshotsRoot,
    projectStatusPath: null,
    realReviewerExecutor
  });
});

test("workbench server resumes autonomous scheduler loop from registry recovery policy", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-autonomous-loop-resume-"));
  const inputPath = join(snapshotsRoot, "autonomous-loop-resume-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "resume-source",
    items: [
      {
        id: "resume-source",
        label: "Resume source",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const first = await request(`${baseUrl}/api/workbench/autonomous-scheduler-loop?id=resume-source`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_iterations: 1,
        snapshot_prefix: "server-loop",
        created_at: "2026-05-22T01:20:00.000Z"
      })
    });
    assert.equal(first.status, 201);

    const resumed = await request(`${baseUrl}/api/workbench/autonomous-scheduler-loop-resume?id=resume-source`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_iterations: 1,
        snapshot_prefix: "server-resume",
        created_at: "2026-05-22T01:21:00.000Z"
      })
    });
    const created = resumed.json();
    const history = (await request(`${baseUrl}/api/workbench/projections`)).json();
    const targetInputPath = join(snapshotsRoot, "server-loop-resume-source-01.workbench-input.json");
    const targetState = JSON.parse(readFileSync(targetInputPath, "utf8"));
    const sourceState = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(resumed.status, 201);
    assert.equal(created.status, "created");
    assert.equal(created.recovery.status, "ready");
    assert.equal(created.resume_attempt.metadata.status, "pass");
    assert.equal(created.item.id, "server-loop-resume-source-01");
    assert.equal(created.result.phase, "no_dispatchable_scheduler_actions");
    assert.equal(history.latest, "server-loop-resume-source-01");
    assert.equal(sourceState.manifest.events.at(-1).type, "scheduler_loop_resume_attempt");
    assert.equal(sourceState.manifest.events.at(-1).status, "pass");
    assert.equal(targetState.manifest.events.at(-1).type, "autonomous_scheduler_loop_run");
  }, { historyPath, snapshotsRoot });
});

test("workbench server rejects autonomous scheduler loop resume without ready recovery", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-autonomous-loop-resume-blocked-"));
  const inputPath = join(snapshotsRoot, "autonomous-loop-resume-blocked-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWithoutSchedulerLoop();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "resume-blocked",
    items: [
      {
        id: "resume-blocked",
        label: "Resume blocked",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/autonomous-scheduler-loop-resume?id=resume-blocked`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ max_iterations: 1 })
    });
    const rejected = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 409);
    assert.notEqual(rejected.recovery.status, "ready");
    assert.equal(rejected.recovery.resumable, false);
    assert.equal(rejected.resume_attempt.metadata.status, "blocked");
    assert.equal(rejected.projection.scheduler_loop.latest_resume_status, "blocked");
    assert.equal(state.manifest.events.at(-1).type, "scheduler_loop_resume_attempt");
    assert.equal(state.manifest.events.at(-1).status, "blocked");
  }, { historyPath, snapshotsRoot, projectStatusPath: null });
});

test("workbench server rejects autonomous scheduler loop without workflow state input", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/autonomous-scheduler-loop?id=bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ max_iterations: 1 })
    });
    const rejected = response.json();

    assert.equal(response.status, 400);
    assert.match(rejected.error, /workflow state input not found/);
  });
});

test("workbench server records scheduler dispatch runs into workflow state input", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-scheduler-dispatch-"));
  const inputPath = join(snapshotsRoot, "scheduler-dispatch-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  const plan = createSchedulerDispatchPlan({
    project_status: {
      project: "ai-control-platform",
      blockers: [],
      next_step: ""
    },
    run_evaluation: { status: "pass" },
    workflow_state: workflowState
  }, {
    workflow_state_input_path: "tmp/workbench-server-scheduler-dispatch/input.json"
  });
  const artifact = createSchedulerDispatchRunArtifact(
    plan,
    await runSchedulerDispatchPlan(plan, { dry_run: true }),
    { created_at: "2026-05-21T23:01:00.000Z" }
  );
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "scheduler-dispatch",
    items: [
      {
        id: "scheduler-dispatch",
        label: "Scheduler dispatch",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-dispatch-run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ artifact })
    });
    const created = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.status, "created");
    assert.equal(created.artifact.producer, "scheduler-dispatch-runner");
    assert.equal(created.projection.scheduler_dispatch.status, "pass");
    assert.equal(created.projection.scheduler_dispatch.step_count, 3);
    assert.equal(state.manifest.events.at(-1).type, "scheduler_dispatch_run");
    assert.equal(state.artifact_ledger.artifacts.at(-1).metadata.version, "scheduler-dispatch-run.v1");
  }, { historyPath, snapshotsRoot });
});

test("run-scheduler-dispatch-plan CLI records scheduler dispatch run through workbench service", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-scheduler-cli-"));
  const inputPath = join(snapshotsRoot, "scheduler-cli-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const planPath = join(snapshotsRoot, "scheduler-cli-plan.json");
  const outputPath = join(snapshotsRoot, "scheduler-cli-run.json");
  const workflowState = currentSessionWorkflowState();
  const plan = createSchedulerDispatchPlan({
    project_status: {
      project: "ai-control-platform",
      blockers: [],
      next_step: ""
    },
    run_evaluation: { status: "pass" },
    workflow_state: workflowState
  }, {
    workflow_state_input_path: relative(process.cwd(), inputPath)
  });
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(planPath, JSON.stringify(plan, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "scheduler-cli",
    items: [
      {
        id: "scheduler-cli",
        label: "Scheduler CLI",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const result = await runNode([
      "tools/run-scheduler-dispatch-plan.mjs",
      "--plan",
      planPath,
      "--output",
      outputPath,
      "--dry-run",
      "--workbench-base-url",
      baseUrl,
      "--projection-id",
      "scheduler-cli"
    ]);
    const summary = JSON.parse(result.stdout);
    const state = JSON.parse(readFileSync(inputPath, "utf8"));
    const projection = (await request(`${baseUrl}/api/workbench/projection?id=scheduler-cli`)).json();

    assert.equal(result.status, 0, result.stderr);
    assert.equal(summary.status, "pass");
    assert.equal(summary.record_status, "pass");
    assert.equal(summary.projection_scheduler_status, "pass");
    assert.equal(summary.projection_scheduler_steps, 3);
    assert.equal(state.manifest.events.at(-1).type, "scheduler_dispatch_run");
    assert.equal(projection.scheduler_dispatch.status, "pass");
    assert.equal(projection.scheduler_dispatch.step_count, 3);
  }, { historyPath, snapshotsRoot });
});

test("workbench server rejects reviewer shard results without workflow state input", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/reviewer-shard-result?id=bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shard_id: "reviewer-scope-shard-001" })
    });
    const rejected = response.json();

    assert.equal(response.status, 400);
    assert.match(rejected.error, /workflow state input not found/);
  });
});

test("workbench server rejects scheduler dispatch runs without workflow state input", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-dispatch-run?id=bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        artifact: {
          version: "scheduler-dispatch-run.v1",
          status: "pass",
          result: { steps: [] }
        }
      })
    });
    const rejected = response.json();

    assert.equal(response.status, 400);
    assert.match(rejected.error, /workflow state input not found/);
  });
});

test("workbench server rejects scheduler dispatch plans without workflow state input", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-dispatch-plan?id=bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    const rejected = response.json();

    assert.equal(response.status, 400);
    assert.match(rejected.error, /workflow state input not found/);
  });
});

test("workbench server rejects unauthorized non-dry-run scheduler dispatch from workbench control", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-scheduler-control-reject-"));
  const inputPath = join(snapshotsRoot, "scheduler-control-reject-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "scheduler-control-reject",
    items: [
      {
        id: "scheduler-control-reject",
        label: "Scheduler control reject",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dry_run: false })
    });
    const rejected = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 400);
    assert.equal(rejected.error, "scheduler dispatch policy rejected");
    assert.ok(rejected.issues.some((entry) => entry.code === "missing_operator_authorization"));
    assert.equal(rejected.projection.scheduler_dispatch.status, "blocked");
    assert.equal(rejected.projection.scheduler_dispatch.policy_status, "fail");
    assert.equal(rejected.projection.scheduler_dispatch.policy_issue_count, rejected.issues.length);
    assert.equal(state.manifest.events.at(-1).type, "scheduler_dispatch_policy");
  }, { historyPath, snapshotsRoot });
});

test("workbench server rejects unsupported scheduler dispatch execution profiles", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-scheduler-profile-reject-"));
  const inputPath = join(snapshotsRoot, "scheduler-profile-reject-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "scheduler-profile-reject",
    items: [
      {
        id: "scheduler-profile-reject",
        label: "Scheduler profile reject",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ execution_profile: "unbounded_real_model" })
    });
    const rejected = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 400);
    assert.equal(rejected.error, "scheduler dispatch control request rejected");
    assert.ok(rejected.issues.some((entry) => entry.code === "unsupported_scheduler_dispatch_profile"));
    assert.equal(state.manifest.events.length, workflowState.manifest.events.length);
  }, { historyPath, snapshotsRoot });
});

test("workbench server rejects scheduler dispatch plan creation with unsafe host", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-scheduler-plan-host-"));
  const inputPath = join(snapshotsRoot, "scheduler-plan-host-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "scheduler-plan-host",
    items: [
      {
        id: "scheduler-plan-host",
        label: "Scheduler plan host",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-dispatch-plan`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "bad/host"
      },
      body: JSON.stringify({})
    });
    const rejected = response.json();

    assert.equal(response.status, 400);
    assert.match(rejected.error, /request host is required/);
  }, { historyPath, snapshotsRoot });
});

test("workbench server rejects scheduler dispatch run identity drift", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-scheduler-drift-"));
  const inputPath = join(snapshotsRoot, "scheduler-drift-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "scheduler-drift",
    items: [
      {
        id: "scheduler-drift",
        label: "Scheduler drift",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-dispatch-run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        artifact: {
          version: "scheduler-dispatch-run.v1",
          run_id: "wrong-run",
          status: "pass",
          result: { steps: [] }
        }
      })
    });
    const rejected = response.json();

    assert.equal(response.status, 400);
    assert.equal(rejected.error, "scheduler dispatch run record failed");
    assert.ok(rejected.issues.some((entry) => entry.code === "scheduler_dispatch_identity_mismatch"));
  }, { historyPath, snapshotsRoot });
});

test("workbench server rejects unsafe workflow state snapshot ids", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-history-"));
  const historyPath = join(dir, "projection-history.json");
  writeFileSync(historyPath, JSON.stringify({ version: "projection-history.v1", latest: null, items: [] }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/snapshots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "../escape", input: {} })
    });
    const rejected = response.json();

    assert.equal(response.status, 400);
    assert.equal(rejected.error, "invalid workflow state snapshot");
    assert.ok(rejected.issues.includes("id must be a safe snapshot id"));
  }, { historyPath });
});

test("workbench server rejects non-string workflow state snapshot ids", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-history-"));
  const historyPath = join(dir, "projection-history.json");
  writeFileSync(historyPath, JSON.stringify({ version: "projection-history.v1", latest: null, items: [] }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/snapshots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 123, input: {} })
    });
    const rejected = response.json();

    assert.equal(response.status, 400);
    assert.equal(rejected.error, "invalid workflow state snapshot");
    assert.ok(rejected.issues.includes("id must be a safe snapshot id"));
  }, { historyPath });
});

test("workbench server rejects workflow state snapshots that are not projection-ready", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-history-"));
  const historyPath = join(dir, "projection-history.json");
  writeFileSync(historyPath, JSON.stringify({ version: "projection-history.v1", latest: null, items: [] }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/snapshots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "not-ready",
        input: {
          manifest: { run_id: "not-ready", cycle_id: "cycle-not-ready" },
          artifact_ledger: { artifacts: [] }
        }
      })
    });
    const rejected = response.json();
    const history = (await request(`${baseUrl}/api/workbench/projections`)).json();

    assert.equal(response.status, 400);
    assert.equal(rejected.error, "workflow state snapshot publish failed");
    assert.ok(rejected.issues.includes("projection input validation must pass before snapshot publish"));
    assert.equal(history.latest, null);
  }, { historyPath });
});

test("workbench server rejects workflow state snapshots without operator event facts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-history-"));
  const historyPath = join(dir, "projection-history.json");
  const workflowState = currentSessionWorkflowState();
  delete workflowState.operator_event_ledger;
  writeFileSync(historyPath, JSON.stringify({ version: "projection-history.v1", latest: null, items: [] }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/snapshots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "missing-operator-events",
        input: workflowState
      })
    });
    const rejected = response.json();
    const history = (await request(`${baseUrl}/api/workbench/projections`)).json();

    assert.equal(response.status, 400);
    assert.equal(rejected.error, "workflow state snapshot publish failed");
    assert.ok(rejected.issues.includes("operator events must apply before snapshot publish"));
    assert.equal(history.latest, null);
  }, { historyPath });
});

test("workbench server is API-only by default for page routes", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/apps/workbench/desktop.html`);
    const mountedRoot = await request(`${baseUrl}/projects/ai-control-platform/`);
    const body = response.json();

    assert.equal(response.status, 404);
    assert.match(body.error, /served by Next\.js/);
    assert.equal(mountedRoot.status, 404);
    assert.match(mountedRoot.json().error, /served by Next\.js/);
  });
});

test("workbench server can serve legacy static shell only when explicitly enabled", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/apps/workbench/desktop.html`);
    const mountedAsset = await request(`${baseUrl}/projects/ai-control-platform/apps/workbench/workbench.js`);

    assert.equal(response.status, 200);
    assert.match(response.text, /data-view="desktop"/);
    assert.match(response.headers["content-type"], /text\/html/);
    assert.equal(mountedAsset.status, 200);
  }, { serveLegacyStatic: true });
});

test("workbench server exposes mounted workbench APIs", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/projects/ai-control-platform/api/workbench/projection?id=current-session`);
    const projection = response.json();

    assert.equal(response.status, 200);
    assert.equal(projection.projection_version, "workbench.v1");
    assert.equal(projection.run_id, "run-20260521-platform-self-trial");
  });
});

test("workbench server rejects unknown projection ids", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/projection?id=missing`);
    const body = response.json();

    assert.equal(response.status, 404);
    assert.match(body.error, /projection not found/);
  });
});

test("workbench server persists operator events", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-events-"));
  const eventsPath = join(dir, "operator-events.json");
  writeFileSync(eventsPath, JSON.stringify({ version: "operator-events.v1", events: [] }));

  await withServer(async (baseUrl) => {
    const createResponse = await request(`${baseUrl}/api/workbench/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "validate", run_id: "run-1", cycle_id: "cycle-1" })
    });
    const created = createResponse.json();
    const listResponse = await request(`${baseUrl}/api/workbench/events`);
    const ledger = listResponse.json();

    assert.equal(createResponse.status, 201);
    assert.equal(created.status, "created");
    assert.equal(ledger.events.length, 1);
    assert.equal(ledger.events[0].action, "validate");
    assert.equal(ledger.events[0].run_id, "run-1");
  }, { eventsPath });
});

test("workbench server rejects operator events without ownership fields", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-events-"));
  const eventsPath = join(dir, "operator-events.json");
  writeFileSync(eventsPath, JSON.stringify({ version: "operator-events.v1", events: [] }));

  await withServer(async (baseUrl) => {
    const createResponse = await request(`${baseUrl}/api/workbench/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "validate" })
    });
    const rejected = createResponse.json();
    const listResponse = await request(`${baseUrl}/api/workbench/events`);
    const ledger = listResponse.json();

    assert.equal(createResponse.status, 400);
    assert.equal(rejected.error, "invalid operator event");
    assert.deepEqual(rejected.issues, ["run_id is required", "cycle_id is required"]);
    assert.equal(ledger.events.length, 0);
  }, { eventsPath });
});

test("workbench server rejects malformed operator event json", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-events-"));
  const eventsPath = join(dir, "operator-events.json");
  writeFileSync(eventsPath, JSON.stringify({ version: "operator-events.v1", events: [] }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{"
    });

    assert.equal(response.status, 400);
    assert.equal(response.json().error, "invalid json");
  }, { eventsPath });
});

test("workbench server CLI honors isolated history snapshots and events paths", async () => {
  const dir = mkdtempSync(join(process.cwd(), "tmp/workbench-server-cli-isolated-"));
  const historyPath = join(dir, "projection-history.json");
  const snapshotsRoot = join(dir, "snapshots");
  const eventsPath = join(dir, "operator-events.json");
  const stateDbPath = join(dir, "workbench-state.sqlite");
  const defaultHistoryBefore = readFileSync("docs/examples/projection-history.json", "utf8");
  const defaultEventsBefore = readFileSync("docs/examples/operator-events.json", "utf8");

  mkdirSync(snapshotsRoot, { recursive: true });
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "cli-isolated",
    items: [
      {
        id: "cli-isolated",
        label: "CLI isolated",
        input_path: "docs/examples/current-session-workbench-input.json"
      }
    ]
  }, null, 2));
  writeFileSync(eventsPath, JSON.stringify({ version: "operator-events.v1", events: [] }, null, 2));

  const server = spawn(process.execPath, [
    "tools/workbench-server.mjs",
    "--port",
    "0",
    "--history-path",
    historyPath,
    "--snapshots-root",
    snapshotsRoot,
    "--events-path",
    eventsPath,
    "--state-db",
    stateDbPath
  ], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  server.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const baseUrl = await new Promise((resolveUrl, rejectUrl) => {
    server.stdout.on("data", (chunk) => {
      const line = chunk.toString().split(/\r?\n/).find((entry) => entry.includes("http://"));
      if (line) resolveUrl(line.match(/http:\/\/[^\s]+/)?.[0]);
    });
    server.once("exit", (code) => rejectUrl(new Error(`workbench server exited before listening: ${code}\n${stderr}`)));
    server.once("error", rejectUrl);
  });

  try {
    const eventResponse = await request(`${baseUrl}/api/workbench/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "validate",
        run_id: "run-cli-isolated",
        cycle_id: "cycle-cli-isolated",
        created_at: "2026-05-23T10:30:00.000Z"
      })
    });
    const snapshotResponse = await request(`${baseUrl}/api/workbench/snapshots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "cli-isolated-snapshot",
        input: currentSessionWorkflowState(),
        label: "CLI isolated snapshot"
      })
    });
    const isolatedEvents = (await request(`${baseUrl}/api/workbench/events`)).json();
    const isolatedHistory = (await request(`${baseUrl}/api/workbench/projections`)).json();

    assert.equal(eventResponse.status, 201);
    assert.equal(snapshotResponse.status, 201);
    assert.equal(isolatedEvents.events.length, 1);
    assert.equal(isolatedHistory.latest, "cli-isolated-snapshot");
    assert.equal(JSON.parse(readFileSync(eventsPath, "utf8")).events.length, 0);
    assert.equal(JSON.parse(readFileSync(historyPath, "utf8")).latest, "cli-isolated");
    assert.equal(readFileSync("docs/examples/projection-history.json", "utf8"), defaultHistoryBefore);
    assert.equal(readFileSync("docs/examples/operator-events.json", "utf8"), defaultEventsBefore);
  } finally {
    if (server.exitCode === null) {
      server.kill();
      await once(server, "exit");
    }
  }
});
