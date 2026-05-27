import assert from "node:assert/strict";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

import { createRunManifest } from "../src/workflow/run-manifest.js";
import {
  CHILD_WORKER_ROLE,
  HEADLESS_MAIN_ORCHESTRATOR_ROLE,
  createHeadlessProviderExecutor,
  evaluateHeadlessChildWorkerOutput,
  headlessChildWorkerPrompt,
  parseHeadlessChildWorkerOutput,
  runHeadlessCliMainOrchestrator,
  runHeadlessCliMainOrchestratorLoop
} from "../src/workflow/headless-cli-orchestrator.js";
import { createSqliteWorkbenchStateStore } from "../src/workflow/workbench-state-store.js";
import { currentSessionWorkflowState } from "./helpers/current-session-workflow-state.js";

async function withWorkbenchServer(fn, options = {}) {
  const stateDbPath = options.stateDbPath || join(mkdtempSync(join(tmpdir(), "headless-workbench-state-")), "workbench-state.sqlite");
  const serverOptions = { ...options, stateDbPath };
  const script = [
    "import { createWorkbenchServer } from './tools/workbench-server.mjs';",
    "const options = JSON.parse(process.argv[1] || '{}');",
    "const server = createWorkbenchServer(options);",
    "server.listen(0, '127.0.0.1');",
    "server.on('listening', () => {",
    "  const address = server.address();",
    "  console.log(`http://127.0.0.1:${address.port}`);",
    "});"
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(serverOptions)], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const baseUrl = await new Promise((resolveUrl, rejectUrl) => {
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString().trim();
      const line = text.split(/\r?\n/).find((entry) => entry.startsWith("http://"));
      if (line) resolveUrl(line);
    });
    child.once("exit", (code) => {
      rejectUrl(new Error(`workbench server exited before listening: ${code}\n${stderr}`));
    });
    child.once("error", rejectUrl);
  });

  try {
    await fn(baseUrl, serverOptions);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await once(child, "exit");
    }
  }
}

function projectStatus(overrides = {}) {
  return {
    project: "ai-control-platform",
    status: "in_progress",
    blockers: [],
    next_step: "Implement the next headless CLI orchestrator slice.",
    global_goals: [
      {
        id: "autonomous-scheduler-and-reviewer-loop",
        title: "任务拆解、调度、multi-LLM reviewer、自恢复和持续运行闭环",
        status: "in_progress",
        next_step: "Wire a headless CLI main orchestrator adapter.",
        next_work_packages: [
          {
            id: "headless-cli-orchestrator-adapter",
            title: "Headless CLI orchestrator adapter",
            action: "implement_headless_cli_orchestrator",
            owned_files: [
              "src/workflow/headless-cli-orchestrator.js",
              "tools/run-headless-cli-orchestrator.mjs",
              "test/headless-cli-orchestrator.test.js",
              "docs/examples/process-hardening-current.json"
            ]
          }
        ],
        owned_files: [
          "src/workflow/headless-cli-orchestrator.js",
          "tools/run-headless-cli-orchestrator.mjs",
          "test/headless-cli-orchestrator.test.js",
          "docs/examples/process-hardening-current.json"
        ]
      }
    ],
    ...overrides
  };
}

function sourceWorkflowState() {
  const contextPack = {
    requirement_summary: "Source workflow state for headless CLI orchestrator.",
    host: "platform_core",
    target_project_id: "ai-control-platform",
    non_goals: ["Do not modify managed projects"],
    forbidden_actions: ["Do not skip main-process evaluation"],
    owned_files: ["src/workflow/headless-cli-orchestrator.js"],
    acceptance_gates: ["node --test test/headless-cli-orchestrator.test.js"],
    rollback_conditions: ["host boundary violation"],
    subtasks: [
      {
        id: "source",
        title: "Source",
        owned_files: ["src/workflow/headless-cli-orchestrator.js"]
      }
    ]
  };
  const manifest = createRunManifest({
    run_id: "run-headless-cli",
    cycle_id: "cycle-source",
    goal: contextPack.requirement_summary,
    context_pack: contextPack,
    events: [],
    artifacts: [],
    gate_results: [],
    review_findings: [],
    recovery_attempts: [],
    created_at: "2026-05-23T00:00:00.000Z"
  });

  return {
    generated_at: "2026-05-23T00:00:00.000Z",
    project_status: projectStatus(),
    manifest,
    artifact_ledger: {
      run_id: manifest.run_id,
      cycle_id: manifest.cycle_id,
      artifacts: []
    },
    model_plan: { selected_model: "gpt-5.5", routes: [] },
    reviewer_gate: { findings: [] },
    task_dag: manifest.work_packages
  };
}

function materializedWorkflowStateWithCompletedFirstPackage() {
  const state = sourceWorkflowState();
  const secondPackage = {
    id: "pc-mobile-workbench",
    title: "PC/mobile workbench",
    action: "continue_global_goal",
    global_goal_id: "pc-mobile-autonomous-workbench",
    owned_files: ["apps/workbench"]
  };
  state.manifest.context_pack.owned_files = [
    ...state.manifest.context_pack.owned_files,
    "apps/workbench"
  ];
  state.manifest.context_pack.subtasks = [
    {
      ...state.manifest.work_packages[0],
      status: "completed",
      result: "pass",
      completed_at: "2026-05-24T04:24:00.000Z"
    },
    secondPackage
  ];
  state.manifest.work_packages = state.manifest.context_pack.subtasks;
  state.task_dag = state.manifest.work_packages;
  state.manifest.events.push({
    id: "context-pack-cycle-created-existing",
    type: "context_pack_cycle_created",
    status: "ready",
    created_at: "2026-05-24T04:20:00.000Z",
    metadata: { work_package_count: 2 }
  });
  return state;
}

test("headless CLI orchestrator runs one main_orchestrator cycle with bounded child lifecycle facts", () => {
  const result = runHeadlessCliMainOrchestrator({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState(),
    projection_history: { version: "projection-history.v1", latest: "current-session", items: [] }
  }, {
    cycle_id: "cycle-headless-cli",
    created_at: "2026-05-23T00:01:00.000Z",
    max_package_count: 1,
    allow_mock_child_worker: true
  });
  const eventTypes = result.workflow_state.manifest.events.map((event) => event.type);

  assert.equal(result.status, "pass");
  assert.equal(result.role, HEADLESS_MAIN_ORCHESTRATOR_ROLE);
  assert.equal(result.child_role, CHILD_WORKER_ROLE);
  assert.equal(result.context_pack.host, "platform_core");
  assert.equal(result.context_pack.target_project_id, "ai-control-platform");
  assert.equal(result.child_run.status, "pass");
  assert.equal(result.child_run.artifact.metadata.executor_provenance.role, CHILD_WORKER_ROLE);
  assert.equal(result.steps[0].phase, "project_status_continuation");
  assert.equal(result.steps[0].status, "ready");
  assert.ok(eventTypes.includes("context_pack_cycle_created"));
  assert.ok(eventTypes.includes("WorkerSpawned"));
  assert.ok(eventTypes.includes("WorkerHeartbeat"));
  assert.ok(eventTypes.includes("WorkerCompleted"));
  assert.ok(eventTypes.includes("WorkerEvaluation"));
  assert.ok(eventTypes.includes("WorkerClosed"));
  assert.ok(eventTypes.includes("PoolIterationClosed"));
  assert.equal(result.lifecycle_cleanup.after.status, "pass");
  assert.equal(result.projection.agent_lifecycle_pool.status, "pass");
  assert.equal(result.continuation.should_continue, true);
  assert.equal(result.must_continue, true);
});

test("headless CLI orchestrator continues existing context cycle without rematerializing completed packages", () => {
  const result = runHeadlessCliMainOrchestrator({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: materializedWorkflowStateWithCompletedFirstPackage()
  }, {
    created_at: "2026-05-24T04:36:00.000Z",
    max_package_count: 1,
    child_worker_outputs: [
      {
        work_package_id: "pc-mobile-workbench",
        status: "pass",
        host: "platform_core",
        changed_files: ["apps/workbench/workbench.js"],
        test_results: [{ command: "npm run check:workbench:browser-events", status: "pass" }],
        durable_state_updated: true,
        process_hardening: { required: false },
        continuation_readiness: { ready: true },
        self_evaluation: { aligned: true, drifted: false }
      }
    ]
  });

  assert.equal(result.status, "pass");
  assert.equal(result.steps[1].phase, "context_pack_cycle");
  assert.equal(result.steps[1].status, "existing");
  assert.equal(result.child_run.executed_work_packages[0].id, "pc-mobile-workbench");
  assert.equal(result.workflow_state.manifest.work_packages[0].status, "completed");
  assert.equal(result.workflow_state.manifest.work_packages[1].status, "completed");
});

test("headless child worker commands receive sanitized workbench child-worker environment", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "headless-child-env-"));
  const workerScript = join(tempDir, "worker.mjs");
  writeFileSync(workerScript, [
    "const leaked = Object.keys(process.env).filter((name) => name.startsWith('AI_CONTROL_WORKBENCH_CHILD_WORKER_'));",
    "const pass = leaked.length === 0;",
    "console.log(JSON.stringify({",
    "  status: pass ? 'pass' : 'fail',",
    "  role: 'bounded_child_worker',",
    "  host: 'platform_core',",
    "  changed_files: ['src/workflow/headless-cli-orchestrator.js'],",
    "  test_results: [{ command: 'child worker env isolation', status: pass ? 'pass' : 'fail' }],",
    "  durable_state_updated: true,",
    "  process_hardening: { required: false, status: 'not_required' },",
    "  continuation_readiness: { ready: true },",
    "  self_evaluation: { aligned: true, drifted: false, evidence_sufficient: true },",
    "  blocker: pass ? null : `leaked ${leaked.join(',')}`",
    "}));"
  ].join("\n"));

  const previousCommand = process.env.AI_CONTROL_WORKBENCH_CHILD_WORKER_COMMAND;
  const previousOutputPath = process.env.AI_CONTROL_WORKBENCH_CHILD_WORKER_OUTPUT_PATH;
  process.env.AI_CONTROL_WORKBENCH_CHILD_WORKER_COMMAND = "would-recursively-spawn";
  process.env.AI_CONTROL_WORKBENCH_CHILD_WORKER_OUTPUT_PATH = "would-recursively-write";
  try {
    const executor = createHeadlessProviderExecutor({
      child_worker_command: process.execPath,
      child_worker_args: [workerScript],
      child_worker_timeout_ms: 10000,
      child_worker_max_attempts: 1
    });
    const result = executor({
      workflow_state: sourceWorkflowState(),
      selected_work_packages: [
        {
          id: "child-env-isolation",
          title: "Child environment isolation",
          action: "continue_global_goal",
          owned_files: ["src/workflow/headless-cli-orchestrator.js"]
        }
      ],
      execution_plan: { package_plans: [] }
    });

    assert.equal(result.status, "pass");
    assert.equal(result.package_results[0].status, "pass");
  } finally {
    if (previousCommand === undefined) {
      delete process.env.AI_CONTROL_WORKBENCH_CHILD_WORKER_COMMAND;
    } else {
      process.env.AI_CONTROL_WORKBENCH_CHILD_WORKER_COMMAND = previousCommand;
    }
    if (previousOutputPath === undefined) {
      delete process.env.AI_CONTROL_WORKBENCH_CHILD_WORKER_OUTPUT_PATH;
    } else {
      process.env.AI_CONTROL_WORKBENCH_CHILD_WORKER_OUTPUT_PATH = previousOutputPath;
    }
  }
});

test("Claude child worker runs in bare mode without workflow hook inheritance", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-child-worker-"));
  const promptFile = join(tempDir, "prompt.md");
  const captureFile = join(tempDir, "args.txt");
  const fakeProxy = join(tempDir, "claude-proxy.sh");
  writeFileSync(promptFile, "Return JSON.");
  writeFileSync(fakeProxy, [
    "#!/usr/bin/env bash",
    "printf '%s\\n' \"$@\" > \"$CAPTURE_ARGS\"",
    "printf '{\"status\":\"pass\"}\\n'"
  ].join("\n"));
  chmodSync(fakeProxy, 0o755);

  const result = spawnSync("bash", ["scripts/run-claude-child-worker.sh", promptFile], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      AI_CONTROL_WORKBENCH_CLAUDE_PROXY: fakeProxy,
      AI_CONTROL_WORKBENCH_CLAUDE_MODEL: "claude-haiku-4-5-20251001",
      AI_CONTROL_WORKBENCH_CHILD_WORKER_USE_WORKTREE: "0",
      CAPTURE_ARGS: captureFile
    }
  });

  assert.equal(result.status, 0);
  const args = readFileSync(captureFile, "utf8").trim().split("\n");
  assert.deepEqual(args.slice(0, 2), ["-m", "claude-haiku-4-5-20251001"]);
  assert.ok(args.includes("--role"));
  assert.ok(args.includes("developer"));
  assert.ok(args.includes("--bare"));
  assert.ok(args.includes("--permission-mode"));
  assert.ok(args.includes("bypassPermissions"));
  assert.ok(args.includes("--no-session-persistence"));
  assert.ok(args.includes("--tools"));
  assert.ok(args.includes("default"));
  assert.ok(args.includes("--add-dir"));
});

test("Claude DeepSeek child worker omits role flag for canonical DeepSeek launcher", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-deepseek-child-worker-"));
  const promptFile = join(tempDir, "prompt.md");
  const captureFile = join(tempDir, "args.txt");
  const fakeProxy = join(tempDir, "claude-deepseek-launcher.sh");
  writeFileSync(promptFile, "Return JSON.");
  writeFileSync(fakeProxy, [
    "#!/usr/bin/env bash",
    "{",
    "  printf 'MODEL=%s\\n' \"$AI_CONTROL_WORKBENCH_CLAUDE_MODEL\"",
    "  printf '%s\\n' \"$@\"",
    "} > \"$CAPTURE_ARGS\"",
    "printf '{\"status\":\"pass\"}\\n'"
  ].join("\n"));
  chmodSync(fakeProxy, 0o755);

  const result = spawnSync("bash", ["scripts/run-claude-deepseek-child-worker.sh", promptFile], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      AI_CONTROL_WORKBENCH_CLAUDE_PROXY: fakeProxy,
      AI_CONTROL_WORKBENCH_CHILD_WORKER_USE_WORKTREE: "0",
      CAPTURE_ARGS: captureFile
    }
  });

  assert.equal(result.status, 0);
  const args = readFileSync(captureFile, "utf8").trim().split("\n");
  assert.equal(args[0], "MODEL=deepseek-v4-pro[1m]");
  assert.equal(args.includes("-m"), false);
  assert.equal(args.includes("deepseek-v4-pro[1m]"), false);
  assert.equal(args.includes("--role"), false);
  assert.ok(args.includes("--bare"));
  assert.ok(args.includes("--permission-mode"));
  assert.ok(args.includes("bypassPermissions"));
  assert.ok(args.includes("--no-session-persistence"));
  assert.ok(args.includes("--tools"));
  assert.ok(args.includes("default"));
});

test("Claude child worker runs in an isolated worker worktree by default", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-child-worktree-"));
  const workerRoot = join(tempDir, "worker-workspaces");
  const promptFile = join(tempDir, "prompt.md");
  const captureFile = join(tempDir, "capture.txt");
  const fakeProxy = join(tempDir, "claude-proxy.sh");
  writeFileSync(promptFile, "Return JSON.");
  writeFileSync(fakeProxy, [
    "#!/usr/bin/env bash",
    "{",
    "  pwd",
    "  printf '%s\\n' \"$@\"",
    "} > \"$CAPTURE_ARGS\"",
    "printf '{\"status\":\"pass\"}\\n'"
  ].join("\n"));
  chmodSync(fakeProxy, 0o755);

  let workerCwd = "";
  try {
    const result = spawnSync("bash", ["scripts/run-claude-child-worker.sh", promptFile], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        AI_CONTROL_WORKBENCH_CLAUDE_PROXY: fakeProxy,
        AI_CONTROL_WORKBENCH_CLAUDE_MODEL: "claude-haiku-4-5-20251001",
        AI_CONTROL_WORKBENCH_WORKER_WORKSPACES_ROOT: workerRoot,
        CAPTURE_ARGS: captureFile
      }
    });

    assert.equal(result.status, 0, result.stderr);
    const captured = readFileSync(captureFile, "utf8").trim().split("\n");
    workerCwd = captured[0];
    assert.ok(workerCwd.startsWith(join(workerRoot, "ai-control-platform")));
    const primaryHead = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8"
    }).stdout.trim();
    const workerHead = spawnSync("git", ["-C", workerCwd, "rev-parse", "HEAD"], {
      encoding: "utf8"
    }).stdout.trim();
    assert.equal(workerHead, primaryHead);
    const addDirIndex = captured.indexOf("--add-dir");
    assert.ok(addDirIndex >= 0);
    assert.equal(captured[addDirIndex + 1], workerCwd);
  } finally {
    if (workerCwd) {
      const branch = spawnSync("git", ["-C", workerCwd, "branch", "--show-current"], {
        encoding: "utf8"
      }).stdout.trim();
      spawnSync("git", ["worktree", "remove", "--force", workerCwd], { encoding: "utf8" });
      if (branch) spawnSync("git", ["branch", "-D", branch], { encoding: "utf8" });
    }
  }
});

test("Claude child worker blocks mainline integration when child test results failed", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-child-failed-tests-"));
  const workerRoot = join(tempDir, "worker-workspaces");
  const promptFile = join(tempDir, "prompt.md");
  const outputPath = join(tempDir, "child-output.json");
  const captureFile = join(tempDir, "worker-cwd.txt");
  const fakeProxy = join(tempDir, "claude-proxy.sh");
  const sentinelFile = "child-worker-integration-sentinel.txt";
  writeFileSync(promptFile, "Return JSON.");
  writeFileSync(fakeProxy, [
    "#!/usr/bin/env bash",
    "pwd > \"$CAPTURE_CWD\"",
    `printf 'should not merge\\n' > ${sentinelFile}`,
    `git add ${sentinelFile}`,
    "git -c user.name='AI Control Test' -c user.email='ai-control-test@example.local' commit -m 'test failed child output' >/dev/null",
    "cat > \"$TEST_CHILD_OUTPUT\" <<'JSON'",
    JSON.stringify({
      status: "pass",
      role: CHILD_WORKER_ROLE,
      host: "platform_core",
      changed_files: [sentinelFile],
      test_results: [
        { command: "node --test test/headless-cli-orchestrator.test.js", status: "pass" },
        { command: "npm run check:closeout", status: "fail" }
      ],
      durable_state_updated: true,
      process_hardening: { required: false, status: "not_required" },
      continuation_readiness: { ready: true },
      self_evaluation: { aligned: true, drifted: false, evidence_sufficient: true }
    }),
    "JSON",
    "cat \"$TEST_CHILD_OUTPUT\""
  ].join("\n"));
  chmodSync(fakeProxy, 0o755);

  let workerCwd = "";
  try {
    const result = spawnSync("bash", ["scripts/run-claude-child-worker.sh", promptFile, outputPath], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        AI_CONTROL_WORKBENCH_CLAUDE_PROXY: fakeProxy,
        AI_CONTROL_WORKBENCH_CLAUDE_MODEL: "claude-haiku-4-5-20251001",
        AI_CONTROL_WORKBENCH_WORKER_WORKSPACES_ROOT: workerRoot,
        CAPTURE_CWD: captureFile,
        TEST_CHILD_OUTPUT: outputPath
      }
    });

    assert.equal(result.status, 1, result.stderr);
    workerCwd = readFileSync(captureFile, "utf8").trim();
    const output = JSON.parse(readFileSync(outputPath, "utf8"));
    assert.equal(output.status, "fail");
    assert.match(output.blocker, /child output test failed: npm run check:closeout/);
    assert.equal(output.command_evidence.child_worker_integration.status, "fail");
    assert.equal(existsSync(sentinelFile), false);
  } finally {
    if (workerCwd) {
      const branch = spawnSync("git", ["-C", workerCwd, "branch", "--show-current"], {
        encoding: "utf8"
      }).stdout.trim();
      spawnSync("git", ["worktree", "remove", "--force", workerCwd], { encoding: "utf8" });
      if (branch) spawnSync("git", ["branch", "-D", branch], { encoding: "utf8" });
    }
  }
});

test("Claude child worker accepts already-satisfied package despite undeclared package-lock side effect", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-child-no-delta-"));
  const workerRoot = join(tempDir, "worker-workspaces");
  const promptFile = join(tempDir, "prompt.md");
  const outputPath = join(tempDir, "child-output.json");
  const captureFile = join(tempDir, "worker-cwd.txt");
  const fakeProxy = join(tempDir, "claude-proxy.sh");
  writeFileSync(promptFile, "Return JSON.");
  writeFileSync(fakeProxy, [
    "#!/usr/bin/env bash",
    "pwd > \"$CAPTURE_CWD\"",
    "node --input-type=module <<'NODE'",
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));",
    "lock.packages[''].engines = { node: '>=18', npm: '>=9' };",
    "writeFileSync('package-lock.json', `${JSON.stringify(lock, null, 2)}\\n`);",
    "NODE",
    "cat > \"$TEST_CHILD_OUTPUT\" <<'JSON'",
    JSON.stringify({
      status: "pass",
      role: CHILD_WORKER_ROLE,
      host: "platform_core",
      changed_files: [],
      no_diff: true,
      test_results: [
        { command: "node --test test/headless-cli-orchestrator.test.js", status: "pass" }
      ],
      deferred_parent_gates: ["npm run check:closeout"],
      durable_state_updated: true,
      process_hardening: { required: false, status: "not_required" },
      continuation_readiness: { ready: true },
      self_evaluation: { aligned: true, drifted: false, evidence_sufficient: true }
    }),
    "JSON",
    "cat \"$TEST_CHILD_OUTPUT\""
  ].join("\n"));
  chmodSync(fakeProxy, 0o755);

  let workerCwd = "";
  try {
    const result = spawnSync("bash", ["scripts/run-claude-child-worker.sh", promptFile, outputPath], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        AI_CONTROL_WORKBENCH_CLAUDE_PROXY: fakeProxy,
        AI_CONTROL_WORKBENCH_CLAUDE_MODEL: "claude-haiku-4-5-20251001",
        AI_CONTROL_WORKBENCH_WORKER_WORKSPACES_ROOT: workerRoot,
        CAPTURE_CWD: captureFile,
        TEST_CHILD_OUTPUT: outputPath
      }
    });

    assert.equal(result.status, 0, result.stderr);
    workerCwd = readFileSync(captureFile, "utf8").trim();
    const output = JSON.parse(readFileSync(outputPath, "utf8"));
    assert.equal(output.status, "pass");
    assert.equal(output.no_diff, true);
    assert.equal(output.command_evidence.child_worker_integration.status, "pass");
    assert.match(output.command_evidence.child_worker_integration.message, /already satisfying/);
    assert.equal(output.command_evidence.child_worker_integration.integrated_commit, output.command_evidence.child_worker_integration.base_commit);
  } finally {
    if (workerCwd) {
      const branch = spawnSync("git", ["-C", workerCwd, "branch", "--show-current"], {
        encoding: "utf8"
      }).stdout.trim();
      spawnSync("git", ["worktree", "remove", "--force", workerCwd], { encoding: "utf8" });
      if (branch) spawnSync("git", ["branch", "-D", branch], { encoding: "utf8" });
    }
  }
});

test("live workbench starts Claude DeepSeek child workers with output path for integration writeback", () => {
  const script = readFileSync("scripts/start-workbench-live.sh", "utf8");
  assert.ok(script.includes("run-claude-deepseek-child-worker.sh"));
  assert.ok(script.includes("deepseek-v4-pro[1m]"));
  assert.ok(script.includes("start-claude-deepseek-no-proxy.sh"));
  assert.ok(script.includes("AI_CONTROL_WORKBENCH_REQUIREMENT_PLAN_COMMAND_SUPPORTS_MODEL_ARG"));
  assert.ok(script.includes("AI_CONTROL_WORKBENCH_REQUIREMENT_PLAN_COMMAND_SUPPORTS_ROLE_ARG"));
  assert.ok(script.includes(`DEFAULT_CHILD_WORKER_ARGS_JSON='["{prompt_file}","{output_path}"]'`));
});

test("Claude role proxy allocates developer keys from the developer pool", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-role-proxy-"));
  const poolDir = join(tempDir, "pools");
  const stateDir = join(tempDir, "state");
  const binDir = join(tempDir, "bin");
  const captureFile = join(tempDir, "env.json");
  mkdirSync(poolDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(poolDir, "manager.keys"), "manager-key\n");
  writeFileSync(join(poolDir, "developer.keys"), "developer-key\n");
  writeFileSync(join(binDir, "claude"), [
    "#!/usr/bin/env bash",
    "{",
    "  printf '%s\\n' \"$ANTHROPIC_API_KEY\"",
    "  printf '%s\\n' \"$ANTHROPIC_MODEL\"",
    "  printf '%s\\n' \"$@\"",
    "} > \"$CAPTURE_ENV\"",
    "printf '{\"status\":\"pass\"}\\n'"
  ].join("\n"));
  chmodSync(join(binDir, "claude"), 0o755);

  const result = spawnSync("bash", ["scripts/claude-role-proxy.sh", "--role", "developer", "-m", "claude-sonnet-4-6", "-p", "hello"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      AI_CONTROL_WORKBENCH_CLAUDE_KEY_POOL_DIR: poolDir,
      AI_CONTROL_WORKBENCH_CLAUDE_KEY_STATE_DIR: stateDir,
      CAPTURE_ENV: captureFile
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const captured = readFileSync(captureFile, "utf8").trim().split("\n");
  assert.equal(captured[0], "developer-key");
  assert.equal(captured[1], "claude-sonnet-4-6");
  assert.ok(captured.includes("-p"));
});

test("headless CLI orchestrator blocks implicit mock child worker completion", () => {
  const result = runHeadlessCliMainOrchestrator({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState()
  }, {
    cycle_id: "cycle-headless-implicit-mock-blocked",
    created_at: "2026-05-23T00:01:15.000Z",
    max_package_count: 1
  });
  const childOutput = result.child_run.package_results[0].completion_evidence.child_output;

  assert.equal(result.status, "blocked");
  assert.equal(result.phase, "child_worker_acceptance");
  assert.ok(result.issues.some((item) => item.code === "package_result_not_pass"));
  assert.equal(childOutput.command_evidence.reason, "headless main orchestrator must not use implicit mock child output");
  assert.equal(result.hardening.finding.id, "headless-child-worker-acceptance-failed");
});

test("headless child worker acceptance checks host, owned files, tests, durable state, hardening, and continuation", () => {
  const evaluation = evaluateHeadlessChildWorkerOutput({
    id: "wp",
    owned_files: ["src/workflow/headless-cli-orchestrator.js"]
  }, {
    status: "pass",
    host: "platform_core",
    changed_files: ["src/workflow/headless-cli-orchestrator.js"],
    test_results: [{ command: "node --test test/headless-cli-orchestrator.test.js", status: "pass" }],
    durable_state_updated: true,
    process_hardening: { required: false },
    continuation_readiness: { ready: true },
    self_evaluation: { aligned: true, drifted: false }
  });

  assert.equal(evaluation.status, "pass");
  assert.equal(evaluation.checked.host_boundary, "platform_core");
});

test("headless child worker acceptance allows changed files under owned directories", () => {
  const evaluation = evaluateHeadlessChildWorkerOutput({
    id: "global-goal-platform-boundary-and-state-foundation",
    owned_files: [
      "PROJECT_STATUS.json",
      "docs/contracts",
      "docs/examples/process-hardening-current.json"
    ]
  }, {
    status: "pass",
    host: "platform_core",
    changed_files: [
      "PROJECT_STATUS.json",
      "docs/contracts/CODEX_PROXY_HANDOFF_CN.md",
      "docs/examples/process-hardening-current.json"
    ],
    test_results: [{ command: "npm run check:process-hardening", status: "pass" }],
    durable_state_updated: true,
    process_hardening: { required: true, status: "completed" },
    continuation_readiness: { ready: true },
    self_evaluation: { aligned: true, drifted: false }
  });

  assert.equal(evaluation.status, "pass");
  assert.equal(evaluation.issues.length, 0);
});

test("headless child worker acceptance allows project root owned scope", () => {
  const evaluation = evaluateHeadlessChildWorkerOutput({
    id: "project-wide-worker",
    owned_files: ["."]
  }, {
    status: "pass",
    host: "platform_core",
    changed_files: [
      "package.json",
      "apps/workbench/web/app/page.tsx",
      "test/workbench-web-skeleton.test.js"
    ],
    test_results: [{ command: "node --test test/workbench-web-skeleton.test.js", status: "pass" }],
    durable_state_updated: true,
    process_hardening: { required: false },
    continuation_readiness: { ready: true },
    self_evaluation: { aligned: true, drifted: false }
  });

  assert.equal(evaluation.status, "pass");
  assert.equal(evaluation.issues.length, 0);
});

test("headless child worker project root scope rejects files outside the project", () => {
  const evaluation = evaluateHeadlessChildWorkerOutput({
    id: "project-wide-worker",
    owned_files: ["."]
  }, {
    status: "pass",
    host: "platform_core",
    changed_files: ["../stock_dashboard/src/page.tsx", "/tmp/outside.js"],
    test_results: [{ command: "node --test test/headless-cli-orchestrator.test.js", status: "pass" }],
    durable_state_updated: true,
    process_hardening: { required: false },
    continuation_readiness: { ready: true },
    self_evaluation: { aligned: true, drifted: false }
  });

  assert.equal(evaluation.status, "fail");
  assert.equal(
    evaluation.issues.filter((item) => item.code === "child_worker_owned_file_violation").length,
    2
  );
});

test("headless child worker acceptance includes touched files when checking owned scope", () => {
  const evaluation = evaluateHeadlessChildWorkerOutput({
    id: "worker-runtime-readiness-gate",
    owned_files: [
      "src/workflow/worker-runtime-readiness.js",
      "tools/check-worker-runtime-readiness.mjs",
      "test/worker-runtime-readiness.test.js",
      "package.json",
      "docs/examples/process-hardening-current.json"
    ]
  }, {
    status: "pass",
    host: "platform_core",
    touched_files: [
      "src/workflow/worker-runtime-readiness.js",
      "tools/check-worker-runtime-readiness.mjs",
      "test/worker-runtime-readiness.test.js",
      "package.json",
      "docs/examples/process-hardening-current.json"
    ],
    test_results: [{ command: "node --test test/worker-runtime-readiness.test.js", status: "pass" }],
    durable_state_updated: true,
    process_hardening: { required: true, status: "completed" },
    continuation_readiness: { ready: true },
    self_evaluation: { aligned: true, drifted: false }
  });

  assert.equal(evaluation.status, "pass");
  assert.deepEqual(evaluation.checked.owned_files, [
    "src/workflow/worker-runtime-readiness.js",
    "tools/check-worker-runtime-readiness.mjs",
    "test/worker-runtime-readiness.test.js",
    "package.json",
    "docs/examples/process-hardening-current.json"
  ]);
});

test("headless child worker acceptance rejects touched files outside owned scope", () => {
  const evaluation = evaluateHeadlessChildWorkerOutput({
    id: "worker-runtime-readiness-gate",
    owned_files: ["tools/check-worker-runtime-readiness.mjs"]
  }, {
    host: "platform_core",
    touched_files: [
      "tools/check-worker-runtime-readiness.mjs",
      "src/workflow/worker-runtime-readiness.js"
    ],
    test_results: [{ command: "node --test test/worker-runtime-readiness.test.js", status: "pass" }],
    durable_state_updated: true,
    process_hardening: { required: true, status: "completed" },
    continuation_readiness: { ready: true },
    self_evaluation: { aligned: true, drifted: false }
  });

  assert.equal(evaluation.status, "fail");
  assert.ok(evaluation.issues.some((item) => item.code === "child_worker_owned_file_violation"));
});

test("headless child worker acceptance rejects sibling paths outside owned directories", () => {
  const evaluation = evaluateHeadlessChildWorkerOutput({
    id: "global-goal-platform-boundary-and-state-foundation",
    owned_files: ["docs/contracts"]
  }, {
    host: "platform_core",
    changed_files: ["docs/contracts-extra/drift.md"],
    test_results: [{ command: "npm run check:process-hardening", status: "pass" }],
    durable_state_updated: true,
    process_hardening: { required: false },
    continuation_readiness: { ready: true },
    self_evaluation: { aligned: true, drifted: false }
  });

  assert.equal(evaluation.status, "fail");
  assert.ok(evaluation.issues.some((item) => item.code === "child_worker_owned_file_violation"));
});

test("headless child worker acceptance rejects failed status, failed command, and missing required integration", () => {
  const workPackage = {
    id: "integration-gated-package",
    owned_files: ["src/workflow/headless-cli-orchestrator.js"]
  };
  const baseOutput = {
    status: "pass",
    role: CHILD_WORKER_ROLE,
    host: "platform_core",
    changed_files: ["src/workflow/headless-cli-orchestrator.js"],
    test_results: [{ command: "node --test test/headless-cli-orchestrator.test.js", status: "pass" }],
    durable_state_updated: true,
    process_hardening: { required: false, status: "not_required" },
    continuation_readiness: { ready: true },
    self_evaluation: { aligned: true, drifted: false, evidence_sufficient: true }
  };

  const failedStatus = evaluateHeadlessChildWorkerOutput(workPackage, {
    ...baseOutput,
    status: "fail"
  });
  assert.ok(failedStatus.issues.some((item) => item.code === "child_worker_status_not_pass"));

  const failedCommand = evaluateHeadlessChildWorkerOutput(workPackage, {
    ...baseOutput,
    command_evidence: { exit_code: 1 }
  });
  assert.ok(failedCommand.issues.some((item) => item.code === "child_worker_command_failed"));

  const missingIntegration = evaluateHeadlessChildWorkerOutput(workPackage, {
    ...baseOutput,
    command_evidence: {
      exit_code: 0,
      child_worker_integration: { required: true, status: "fail" }
    }
  });
  assert.ok(missingIntegration.issues.some((item) => item.code === "child_worker_mainline_integration_missing"));
});

test("headless CLI orchestrator can execute a real child command runner and parse structured output", () => {
  const calls = [];
  const result = runHeadlessCliMainOrchestrator({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState()
  }, {
    cycle_id: "cycle-headless-real-child",
    created_at: "2026-05-23T00:01:30.000Z",
    max_package_count: 1,
    command_runner_kind: "codex_proxy_child_process",
    child_worker_runner: ({ prompt_file, work_package, timeout_ms }) => {
      calls.push({ prompt_file, work_package, timeout_ms });
      return {
        status: 0,
        stdout: JSON.stringify({
          status: "pass",
          role: CHILD_WORKER_ROLE,
          host: "platform_core",
          changed_files: ["src/workflow/headless-cli-orchestrator.js"],
          test_results: [{ command: "node --test test/headless-cli-orchestrator.test.js", status: "pass" }],
          durable_state_updated: true,
          process_hardening: { required: false, status: "not_required" },
          continuation_readiness: { ready: true },
          self_evaluation: { aligned: true, drifted: false, evidence_sufficient: true }
        }),
        stderr: ""
      };
    }
  });

  assert.equal(result.status, "pass");
  assert.equal(calls.length, 1);
  assert.match(readFileSync(calls[0].prompt_file, "utf8"), /"role": "child_worker"/);
  assert.equal(result.child_run.artifact.metadata.executor_provenance.command_runner_kind, "codex_proxy_child_process");
  assert.equal(result.child_run.artifact.metadata.package_results[0].completion_evidence.child_output.command_evidence.exit_code, 0);
});

test("headless child prompt minimizes high-risk routing keywords for external CLI providers", () => {
  const workflowState = sourceWorkflowState();
  workflowState.manifest.goal = "Run self-governance scanner through autonomous-continuation dispatch and code-review-coverage dispatch.";
  workflowState.manifest.context_pack.requirement_summary = workflowState.manifest.goal;
  workflowState.manifest.context_pack.forbidden_actions = [
    "Do not skip self-governance scanner evidence",
    "Do not bypass autonomous-continuation dispatch"
  ];
  const prompt = headlessChildWorkerPrompt(workflowState, {
    id: "self-governance-scanner-autonomous-continuation-dispatch",
    title: "Self-governance scanner autonomous-continuation dispatch",
    action: "run_self_governance_scanner_dispatch",
    owned_files: [
      "src/workflow/self-governance-scanner.js",
      "src/workflow/autonomous-continuation.js",
      "src/workflow/code-review-coverage-dispatch.js"
    ],
    acceptance_gates: ["npm run check:code-review-coverage"]
  });

  assert.match(prompt, /internal project-management and quality-operations platform/);
  assert.match(prompt, /Do not create, switch to, or delegate into another worktree/);
  assert.match(prompt, /Do not create \.claude\/worktrees or run claude --worktree/);
  assert.match(prompt, /src\/workflow\/self-governance-scanner\.js/);
  assert.doesNotMatch(prompt, /Self-governance scanner autonomous-continuation dispatch/);
  assert.doesNotMatch(prompt, /run_self_governance_scanner_dispatch/);
  assert.doesNotMatch(prompt, /docs\/contracts\/AUTONOMOUS_DEVELOPMENT_FLOW_CN\.md/);
  assert.doesNotMatch(prompt, /"Context Pack"/);
});

test("headless child prompt includes selected requirement plan step context", () => {
  const workflowState = sourceWorkflowState();
  workflowState.manifest.context_pack.subtasks = [
    {
      id: "requirement-plan-step-01",
      title: "前端重构：实施步骤 01 / 2",
      action: "execute_requirement_plan_step",
      owned_files: ["."],
      source: {
        requirement_id: "requirement-front",
        plan_step_index: 1,
        plan_step_total: 2,
        implementation_step: "盘点现有前端入口和接口调用",
        acceptance_gates: ["现状盘点清单已产出并入库"]
      }
    },
    {
      id: "requirement-plan-step-02",
      title: "前端重构：实施步骤 02 / 2",
      action: "execute_requirement_plan_step",
      owned_files: ["."],
      source: {
        requirement_id: "requirement-front",
        plan_step_index: 2,
        plan_step_total: 2,
        implementation_step: "建立后续页面迁移",
        acceptance_gates: ["后续页面迁移通过"]
      }
    }
  ];
  workflowState.manifest.context_pack.acceptance_gates = [
    "现状盘点清单已产出并入库",
    "后续页面迁移通过"
  ];
  const workPackage = {
    ...workflowState.manifest.context_pack.subtasks[0],
    status: "pending"
  };
  const prompt = headlessChildWorkerPrompt(workflowState, workPackage);

  assert.match(prompt, /盘点现有前端入口和接口调用/);
  assert.match(prompt, /现状盘点清单已产出并入库/);
  assert.doesNotMatch(prompt, /建立后续页面迁移/);
  assert.doesNotMatch(prompt, /后续页面迁移通过/);
  assert.doesNotMatch(prompt, /Internal metadata is intentionally omitted/);
});

test("headless child prompt defers parent-owned release gates outside isolated worker execution", () => {
  const workflowState = sourceWorkflowState();
  workflowState.manifest.context_pack.acceptance_gates = [
    "npm run check:workbench:browser-events",
    "npm run check:closeout"
  ];
  const workPackage = {
    id: "requirement-plan-step-03",
    title: "前端重构：实施步骤 03 / 7",
    action: "execute_requirement_plan_step",
    owned_files: ["."],
    acceptance_gates: [
      "npm run check:workbench:browser-events",
      "npm run check:closeout",
      "发布链路在 canonical checkout 上完成一次端到端 publish 演练并可回滚。",
      "PROJECT_RULES.md 与 DECISIONS.md 的规范条款合入 main。",
      "完成已审核实施步骤 3：固化 antd + Next.js 约束"
    ],
    source: {
      requirement_id: "requirement-front",
      plan_step_index: 3,
      plan_step_total: 7,
      implementation_step: "固化 antd + Next.js 约束",
      acceptance_gates: [
        "npm run check:workbench:browser-events",
        "npm run check:closeout",
        "发布链路在 canonical checkout 上完成一次端到端 publish 演练并可回滚。",
        "PROJECT_RULES.md 与 DECISIONS.md 的规范条款合入 main。",
        "完成已审核实施步骤 3：固化 antd + Next.js 约束"
      ]
    }
  };
  const prompt = headlessChildWorkerPrompt(workflowState, workPackage);
  const childOwnedPrompt = prompt.split("Deferred parent-owned release gates:")[0];

  assert.match(prompt, /Child acceptance gates:/);
  assert.match(prompt, /npm run check:workbench:browser-events/);
  assert.match(prompt, /完成已审核实施步骤 3/);
  assert.match(prompt, /Deferred parent-owned release gates:[\s\S]*npm run check:closeout/);
  assert.match(prompt, /Deferred parent-owned release gates:[\s\S]*发布链路在 canonical checkout/);
  assert.match(prompt, /Deferred parent-owned release gates:[\s\S]*PROJECT_RULES\.md 与 DECISIONS\.md/);
  assert.doesNotMatch(childOwnedPrompt, /npm run check:closeout/);
  assert.doesNotMatch(childOwnedPrompt, /发布链路在 canonical checkout/);
  assert.doesNotMatch(childOwnedPrompt, /PROJECT_RULES\.md 与 DECISIONS\.md/);
  assert.match(prompt, /Do not run deferred parent-owned release gates from the isolated worker branch/);
  assert.match(prompt, /Deferred parent-owned release gates are not your failure criteria/);
  assert.match(prompt, /Do not set process_hardening\.status="pending"/);
});

test("headless CLI orchestrator passes configured output path into child prompt and parses file output", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-child-output-path-"));
  const outputPattern = join(dir, "child-{work_package_id}-{run_id}-{cycle_id}.json");
  const calls = [];
  const result = runHeadlessCliMainOrchestrator({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState()
  }, {
    cycle_id: "cycle-headless-output-path",
    created_at: "2026-05-23T00:01:35.000Z",
    max_package_count: 1,
    command_runner_kind: "codex_proxy_child_process",
    child_worker_output_path: outputPattern,
    child_worker_runner: ({ prompt_file, output_path }) => {
      calls.push({ prompt_file, output_path });
      writeFileSync(output_path, JSON.stringify({
        status: "pass",
        role: CHILD_WORKER_ROLE,
        host: "platform_core",
        changed_files: ["src/workflow/headless-cli-orchestrator.js"],
        test_results: [{ command: "node --test test/headless-cli-orchestrator.test.js", status: "pass" }],
        durable_state_updated: true,
        process_hardening: { required: false, status: "not_required" },
        continuation_readiness: { ready: true },
        self_evaluation: { aligned: true, drifted: false, evidence_sufficient: true }
      }));
      return {
        status: 0,
        stdout: "",
        stderr: ""
      };
    }
  });
  const prompt = readFileSync(calls[0].prompt_file, "utf8");
  const childOutput = result.child_run.artifact.metadata.package_results[0].completion_evidence.child_output;

  assert.equal(result.status, "pass");
  assert.equal(calls.length, 1);
  assert.match(calls[0].output_path, /child-headless-cli-orchestrator-adapter-run-headless-cli-cycle-headless-output-path\.json$/);
  assert.match(prompt, /Final response protocol:/);
  assert.match(prompt, /Write exactly one JSON object to child_worker_output_path:/);
  assert.match(prompt, /Also print exactly the same JSON object as the final stdout content/);
  assert.equal(childOutput.command_evidence.output_path, calls[0].output_path);
  assert.equal(childOutput.command_evidence.stdout_present, false);
});

test("headless CLI orchestrator can use default child provider config with retry and split policy", () => {
  const calls = [];
  const result = runHeadlessCliMainOrchestrator({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState()
  }, {
    cycle_id: "cycle-headless-default-provider",
    created_at: "2026-05-23T01:40:00.000Z",
    max_package_count: 1,
    default_child_provider: {
      command: "codex-proxy",
      args: ["run", "--prompt", "{prompt_file}"],
      provider: "codex_proxy",
      model: "codex-cli",
      retry_policy: { max_attempts: 2, split_retry: true }
    },
    child_worker_runner: ({ attempt, split_retry }) => {
      calls.push({ attempt, split_retry });
      if (attempt === 1) {
        return {
          status: 124,
          stdout: "",
          stderr: "child worker timeout"
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          status: "pass",
          role: CHILD_WORKER_ROLE,
          host: "platform_core",
          changed_files: ["src/workflow/headless-cli-orchestrator.js"],
          test_results: [{ command: "node --test test/headless-cli-orchestrator.test.js", status: "pass" }],
          durable_state_updated: true,
          process_hardening: { required: false, status: "not_required" },
          continuation_readiness: { ready: true },
          self_evaluation: { aligned: true, drifted: false, evidence_sufficient: true }
        }),
        stderr: ""
      };
    }
  });
  const childOutput = result.child_run.artifact.metadata.package_results[0].completion_evidence.child_output;
  const provenance = result.child_run.artifact.metadata.executor_provenance;

  assert.equal(result.status, "pass");
  assert.deepEqual(calls, [
    { attempt: 1, split_retry: false },
    { attempt: 2, split_retry: true }
  ]);
  assert.equal(provenance.provider, "codex_proxy");
  assert.equal(provenance.retry_policy.max_attempts, 2);
  assert.equal(provenance.retry_policy.split_retry, true);
  assert.equal(childOutput.command_evidence.attempts.length, 2);
  assert.equal(childOutput.command_evidence.attempts[1].split_retry, true);
});

test("headless CLI orchestrator persists workflow snapshots into projection history", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cli-snapshot-"));
  const historyPath = join(dir, "projection-history.json");
  const snapshotsRoot = join(dir, "snapshots");
  const result = runHeadlessCliMainOrchestrator({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState()
  }, {
    cycle_id: "cycle-headless-persist",
    created_at: "2026-05-23T00:02:00.000Z",
    max_package_count: 1,
    allow_mock_child_worker: true,
    projection_history_path: historyPath,
    snapshots_root: snapshotsRoot,
    snapshot_prefix: "headless-test"
  });
  const history = JSON.parse(readFileSync(historyPath, "utf8"));
  const snapshot = JSON.parse(readFileSync(result.snapshot_publish.snapshot_path, "utf8"));

  assert.equal(result.status, "pass");
  assert.equal(result.snapshot_publish.status, "created");
  assert.equal(history.latest, "headless-test-cycle-headless-persist");
  assert.equal(snapshot.manifest.events.at(-1).type, "headless_cli_snapshot_publish");
  assert.equal(snapshot.artifact_ledger.artifacts.at(-1).metadata.type, "headless_cli_snapshot_publish");
  assert.equal(result.projection.run_id, "run-headless-cli");
});

test("headless CLI loop continues from persisted workflow state and snapshots every iteration", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cli-loop-"));
  const historyPath = join(dir, "projection-history.json");
  const snapshotsRoot = join(dir, "snapshots");
  const result = runHeadlessCliMainOrchestratorLoop({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState()
  }, {
    cycle_id: "cycle-headless-loop",
    created_at: "2026-05-23T00:02:30.000Z",
    max_package_count: 1,
    max_iterations: 2,
    allow_mock_child_worker: true,
    projection_history_path: historyPath,
    snapshots_root: snapshotsRoot,
    snapshot_prefix: "headless-loop-test"
  });
  const history = JSON.parse(readFileSync(historyPath, "utf8"));

  assert.equal(result.status, "pass");
  assert.equal(result.phase, "headless_loop_iteration_limit_reached");
  assert.equal(result.iterations.length, 2);
  assert.deepEqual(result.iterations.map((iteration) => iteration.snapshot_status), ["created", "created"]);
  assert.equal(history.items.length, 2);
  assert.equal(history.latest, result.iterations.at(-1).snapshot_id);
  assert.notEqual(result.iterations[0].cycle_id, result.iterations[1].cycle_id);
});

test("headless CLI loop can execute projected next_action_readout through an injected runner", () => {
  const calls = [];
  const result = runHeadlessCliMainOrchestratorLoop({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState()
  }, {
    cycle_id: "cycle-headless-projected-action",
    created_at: "2026-05-23T02:00:00.000Z",
    max_package_count: 1,
    max_iterations: 1,
    allow_mock_child_worker: true,
    execution_strategy: "projected_next_action",
    projected_next_action_readout: {
      status: "ready",
      action: "cleanup_agent_lifecycle_pool"
    },
    projected_next_action_runner: ({ action, workflow_state }) => {
      calls.push(action);
      return {
        status: "executed",
        workflow_state: {
          ...workflow_state,
          projected_action_marker: action
        },
        projection: {
          next_action_readout: {
            status: "ready",
            action: "inspect_scheduler_loop"
          }
        }
      };
    }
  });

  assert.equal(result.status, "pass");
  assert.deepEqual(calls, ["cleanup_agent_lifecycle_pool"]);
  assert.equal(result.iterations[0].projected_next_action_status, "executed");
  assert.equal(result.last_result.workflow_state.projected_action_marker, "cleanup_agent_lifecycle_pool");
  assert.ok(result.last_result.workflow_state.manifest.events.some((event) => event.type === "headless_projected_action_progress"));
  assert.ok(result.last_result.workflow_state.artifact_ledger.artifacts.some((artifact) => artifact.metadata?.type === "headless_projected_action_progress"));
});

test("headless CLI loop refreshes same service projection after in-place projected action writes", () => {
  const actions = ["run_reviewer_scope_shard", "continue_after_reviewer_aggregate"];
  let serviceReadCount = 0;
  const result = runHeadlessCliMainOrchestratorLoop({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState()
  }, {
    cycle_id: "cycle-headless-in-place-projection",
    created_at: "2026-05-23T02:00:15.000Z",
    max_package_count: 1,
    max_iterations: 2,
    allow_mock_child_worker: true,
    execution_strategy: "projected_next_action",
    workbench_base_url: "http://127.0.0.1:1",
    workbench_projection_id: "same-service-projection",
    projected_next_action_runner: ({ action, workflow_state }) => ({
      status: "executed",
      workflow_state,
      projection: {
        next_action_readout: {
          status: "ready",
          action: action === "run_reviewer_scope_shard"
            ? "continue_after_reviewer_aggregate"
            : "create_context_pack_from_seed"
        }
      }
    }),
    workbench_projection_loader: () => ({
      next_action_readout: {
        status: "ready",
        action: actions[Math.min(serviceReadCount++, actions.length - 1)]
      }
    })
  });

  assert.equal(result.status, "pass");
  assert.deepEqual(result.iterations.map((iteration) => iteration.projected_next_action), actions);
  assert.deepEqual(result.iterations.map((iteration) => iteration.workbench_projection_id), [
    "same-service-projection",
    "same-service-projection"
  ]);
  assert.equal(result.last_result.projection.next_action_readout.action, "create_context_pack_from_seed");
});

test("headless CLI loop executes service projected action before local package materialization", () => {
  const calls = [];
  const result = runHeadlessCliMainOrchestratorLoop({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState()
  }, {
    cycle_id: "cycle-headless-service-first-projection",
    created_at: "2026-05-24T05:20:00.000Z",
    max_package_count: 1,
    max_iterations: 1,
    execution_strategy: "projected_next_action",
    workbench_base_url: "http://127.0.0.1:1",
    workbench_projection_id: "service-first",
    workbench_projection_loader: () => ({
      next_action_readout: {
        status: "ready",
        action: "prepare_project_status_continuation"
      }
    }),
    projected_next_action_runner: ({ action, workflow_state }) => {
      calls.push(action);
      return {
        status: "executed",
        workflow_state,
        projection: {
          next_action_readout: {
            status: "ready",
            action: "create_context_pack_from_seed"
          }
        }
      };
    }
  });

  assert.equal(result.status, "pass");
  assert.deepEqual(calls, ["prepare_project_status_continuation"]);
  assert.equal(result.iterations.length, 1);
  assert.equal(result.iterations[0].phase, "headless_projected_next_action");
  assert.equal(result.iterations[0].projected_next_action_status, "executed");
  assert.equal(result.iterations[0].projected_next_action, "prepare_project_status_continuation");
  assert.equal(result.last_result.projection.next_action_readout.action, "create_context_pack_from_seed");
});

test("headless CLI loop blocks projected next action without progress evidence", () => {
  const result = runHeadlessCliMainOrchestratorLoop({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState()
  }, {
    cycle_id: "cycle-headless-projected-blocked",
    created_at: "2026-05-23T02:00:30.000Z",
    max_package_count: 1,
    max_iterations: 1,
    allow_mock_child_worker: true,
    execution_strategy: "projected_next_action",
    projected_next_action_readout: {
      status: "ready",
      action: "cleanup_agent_lifecycle_pool"
    },
    projected_next_action_runner: () => ({
      status: "executed"
    })
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.phase, "headless_projected_next_action");
  assert.equal(result.iterations[0].projected_next_action_status, "blocked");
  assert.ok(result.issues.some((item) => item.code === "projected_action_missing_progress_evidence"));
});

test("headless CLI loop records terminal projected next-action stops", () => {
  const result = runHeadlessCliMainOrchestratorLoop({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState()
  }, {
    cycle_id: "cycle-headless-terminal-projected",
    created_at: "2026-05-23T02:00:45.000Z",
    max_package_count: 1,
    max_iterations: 1,
    allow_mock_child_worker: true,
    execution_strategy: "projected_next_action",
    projected_next_action_readout: {
      status: "pending",
      action: "inspect_latest_driver",
      reason: "latest driver needs inspection"
    }
  });

  const progressEvent = result.last_result.workflow_state.manifest.events.find((event) => event.type === "headless_projected_action_progress");
  const progressArtifact = result.last_result.workflow_state.artifact_ledger.artifacts.find((artifact) => artifact.metadata?.type === "headless_projected_action_progress");

  assert.equal(result.status, "pass");
  assert.equal(result.iterations[0].projected_next_action_status, "stopped");
  assert.equal(progressEvent.metadata.status, "stopped");
  assert.equal(progressEvent.metadata.terminal_action, "inspect_latest_driver");
  assert.equal(progressEvent.metadata.terminal_reason, "latest driver needs inspection");
  assert.equal(progressArtifact.status, "pass");
});

test("headless CLI loop rejects nonlocal workbench next-action service URLs", () => {
  assert.throws(() => runHeadlessCliMainOrchestratorLoop({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState()
  }, {
    cycle_id: "cycle-headless-nonlocal-workbench",
    created_at: "2026-05-23T02:20:00.000Z",
    max_package_count: 1,
    max_iterations: 1,
    execution_strategy: "projected_next_action",
    workbench_base_url: "https://example.com"
  }), /local http/);
});

test("headless CLI loop blocks when configured service projection cannot be loaded", () => {
  const result = runHeadlessCliMainOrchestratorLoop({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState()
  }, {
    cycle_id: "cycle-headless-missing-service-projection",
    created_at: "2026-05-23T10:40:00.000Z",
    max_package_count: 1,
    max_iterations: 1,
    allow_mock_child_worker: true,
    execution_strategy: "projected_next_action",
    workbench_base_url: "http://127.0.0.1:9",
    workbench_projection_id: "missing"
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.phase, "headless_projected_next_action");
  assert.equal(result.iterations[0].projected_next_action_status, "blocked");
  assert.ok(result.issues.some((item) => item.code === "projected_service_projection_unavailable"));
});

test("headless snapshot ids stay within publisher-safe length", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cli-long-snapshot-"));
  const historyPath = join(dir, "projection-history.json");
  const snapshotsRoot = join(dir, "snapshots");
  const result = runHeadlessCliMainOrchestrator({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState()
  }, {
    cycle_id: "cycle-headless-cli-persistence-with-a-very-long-generated-cycle-identifier-01",
    created_at: "2026-05-23T00:02:45.000Z",
    max_package_count: 1,
    allow_mock_child_worker: true,
    projection_history_path: historyPath,
    snapshots_root: snapshotsRoot,
    snapshot_prefix: "headless-cli-current"
  });

  assert.equal(result.status, "pass");
  assert.ok(result.snapshot_publish.item.id.length <= 81);
  assert.equal(result.snapshot_publish.status, "created");
});

test("headless CLI orchestrator hardens timed-out child command output before retry", () => {
  const result = runHeadlessCliMainOrchestrator({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState()
  }, {
    cycle_id: "cycle-headless-timeout-child",
    created_at: "2026-05-23T00:01:45.000Z",
    max_package_count: 1,
    command_runner_kind: "codex_proxy_child_process",
    child_worker_runner: () => ({
      status: 124,
      stdout: "",
      stderr: "child worker timeout"
    })
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.phase, "child_worker_acceptance");
  assert.ok(result.issues.some((item) => item.code === "package_result_not_pass"));
  assert.equal(result.child_run.package_results[0].completion_evidence.child_output.command_evidence.timed_out, true);
  assert.equal(result.hardening.finding.id, "headless-child-worker-acceptance-failed");
  assert.equal(result.lifecycle_cleanup.status, "blocked");
  assert.deepEqual(result.lifecycle_cleanup.facts.map((fact) => fact.event_type), [
    "WorkerCompleted",
    "WorkerEvaluation",
    "WorkerClosed",
    "PoolIterationClosed"
  ]);
  assert.equal(result.lifecycle_cleanup.after.open, 0);
  assert.equal(result.lifecycle_cleanup.after.unevaluated, 0);
  assert.equal(result.lifecycle_cleanup.after.unclosed, 0);
  assert.ok(result.workflow_state.manifest.events.some((event) => event.type === "WorkerClosed"));
  assert.ok(result.workflow_state.manifest.events.some((event) => event.type === "PoolIterationClosed"));
});

test("headless child worker output parser accepts fenced json and rejects prose", () => {
  assert.equal(parseHeadlessChildWorkerOutput("plain prose"), null);
  assert.equal(parseHeadlessChildWorkerOutput("```json\n{\"status\":\"pass\"}\n```").status, "pass");
});

test("headless CLI orchestrator hardens no-diff child worker output before retry", () => {
  const result = runHeadlessCliMainOrchestrator({
    role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
    project_status: projectStatus(),
    workflow_state: sourceWorkflowState()
  }, {
    cycle_id: "cycle-headless-no-diff",
    created_at: "2026-05-23T00:02:00.000Z",
    max_package_count: 1,
    child_worker_outputs: [
      {
        work_package_id: "headless-cli-orchestrator-adapter",
        host: "platform_core",
        changed_files: [],
        test_results: [{ command: "node --test test/headless-cli-orchestrator.test.js", status: "pass" }],
        durable_state_updated: true,
        process_hardening: { required: false },
        continuation_readiness: { ready: true },
        self_evaluation: { aligned: true, drifted: false }
      }
    ]
  });
  const latestEvent = result.workflow_state.manifest.events.at(-1);

  assert.equal(result.status, "blocked");
  assert.equal(result.phase, "child_worker_acceptance");
  assert.ok(result.issues.some((item) => item.code === "package_result_not_pass"));
  assert.equal(result.hardening.status, "pass");
  assert.equal(result.hardening.finding.id, "headless-child-worker-acceptance-failed");
  assert.equal(result.lifecycle_cleanup.status, "blocked");
  assert.equal(result.lifecycle_cleanup.after.open, 0);
  assert.equal(result.lifecycle_cleanup.after.unevaluated, 0);
  assert.equal(result.lifecycle_cleanup.after.unclosed, 0);
  assert.equal(latestEvent.type, "PoolIterationClosed");
});

test("headless CLI orchestrator accepts no-diff child output only with already-satisfied integration evidence", () => {
  const evaluation = evaluateHeadlessChildWorkerOutput({
    owned_files: ["."]
  }, {
    status: "pass",
    role: CHILD_WORKER_ROLE,
    host: "platform_core",
    changed_files: [],
    no_diff: true,
    test_results: [{ command: "node --test test/headless-cli-orchestrator.test.js", status: "pass" }],
    durable_state_updated: true,
    process_hardening: { required: false },
    continuation_readiness: { ready: true },
    self_evaluation: { aligned: true, drifted: false },
    command_evidence: {
      exit_code: 0,
      child_worker_integration: {
        required: true,
        status: "pass",
        message: "child returned pass with no new committed delta; current mainline accepted as already satisfying the work package",
        base_commit: "abc123",
        integrated_commit: "abc123"
      }
    }
  });

  assert.equal(evaluation.status, "pass");
  assert.equal(evaluation.issues.some((item) => item.code === "child_worker_no_diff"), false);
});

test("headless CLI orchestrator blocks wrong role before mutating workflow state", () => {
  const inputState = sourceWorkflowState();
  const result = runHeadlessCliMainOrchestrator({
    role: CHILD_WORKER_ROLE,
    project_status: projectStatus(),
    workflow_state: inputState
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.phase, "input_validation");
  assert.ok(result.issues.some((item) => item.code === "invalid_orchestrator_role"));
  assert.equal(inputState.manifest.events.length, 0);
});

test("run-headless-cli-orchestrator CLI writes replayable output", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cli-orchestrator-"));
  const projectStatusPath = join(dir, "PROJECT_STATUS.json");
  const workflowStatePath = join(dir, "workflow-state.json");
  const outputPath = join(dir, "headless-output.json");

  writeFileSync(projectStatusPath, `${JSON.stringify(projectStatus(), null, 2)}\n`);
  writeFileSync(workflowStatePath, `${JSON.stringify(sourceWorkflowState(), null, 2)}\n`);

  const result = spawnSync(process.execPath, [
    "tools/run-headless-cli-orchestrator.mjs",
    "--project-status",
    projectStatusPath,
    "--workflow-state",
    workflowStatePath,
    "--output",
    outputPath,
    "--cycle-id",
    "cycle-headless-cli-file",
    "--created-at",
    "2026-05-23T00:03:00.000Z",
    "--allow-mock-child-worker"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(readFileSync(outputPath, "utf8"));
  assert.equal(output.status, "pass");
  assert.equal(output.role, HEADLESS_MAIN_ORCHESTRATOR_ROLE);
  assert.equal(output.child_role, CHILD_WORKER_ROLE);
  assert.equal(output.workflow_state.manifest.cycle_id, "cycle-headless-cli-file");
});

test("run-headless-cli-orchestrator CLI can persist a bounded loop to projection history", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-cli-orchestrator-loop-"));
  const projectStatusPath = join(dir, "PROJECT_STATUS.json");
  const workflowStatePath = join(dir, "workflow-state.json");
  const historyPath = join(dir, "projection-history.json");
  const snapshotsRoot = join(dir, "snapshots");
  const outputPath = join(dir, "headless-loop-output.json");
  const workflowOutputPath = join(dir, "headless-loop-workflow.json");

  writeFileSync(projectStatusPath, `${JSON.stringify(projectStatus(), null, 2)}\n`);
  writeFileSync(workflowStatePath, `${JSON.stringify(sourceWorkflowState(), null, 2)}\n`);

  const result = spawnSync(process.execPath, [
    "tools/run-headless-cli-orchestrator.mjs",
    "--project-status",
    projectStatusPath,
    "--workflow-state",
    workflowStatePath,
    "--output",
    outputPath,
    "--workflow-output",
    workflowOutputPath,
    "--history-path",
    historyPath,
    "--snapshots-root",
    snapshotsRoot,
    "--snapshot-prefix",
    "headless-cli-test",
    "--loop",
    "--max-iterations",
    "2",
    "--cycle-id",
    "cycle-headless-cli-loop",
    "--created-at",
    "2026-05-23T00:03:30.000Z",
    "--allow-mock-child-worker"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(readFileSync(outputPath, "utf8"));
  const history = JSON.parse(readFileSync(historyPath, "utf8"));
  const workflowOutput = JSON.parse(readFileSync(workflowOutputPath, "utf8"));
  assert.equal(output.status, "pass");
  assert.equal(output.iterations.length, 2);
  assert.equal(history.items.length, 2);
  assert.equal(workflowOutput.manifest.cycle_id, output.last_result.workflow_state.manifest.cycle_id);
  assert.equal(workflowOutput.manifest.events.at(-1).type, "headless_cli_snapshot_publish");
});

test("run-headless-cli-orchestrator CLI executes projected action through local workbench service", async () => {
  mkdirSync("tmp", { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), "tmp/headless-cli-service-trial-"));
  const projectStatusPath = join(dir, "PROJECT_STATUS.json");
  const workflowStatePath = join(dir, "workflow-state.json");
  const serviceHistoryPath = join(dir, "projection-history.json");
  const snapshotsRoot = join(dir, "snapshots");
  const serviceInputPath = join(snapshotsRoot, "service-input.json");
  const outputPath = join(dir, "headless-service-output.json");
  const workflowOutputPath = join(dir, "headless-service-workflow.json");
  const status = projectStatus({
    next_step: "",
    global_goals: [
      {
        id: "service-trial-goal",
        title: "Service trial goal",
        status: "in_progress",
        next_step: "Prepare projected service continuation.",
        owned_files: ["src/workflow/headless-cli-orchestrator.js"]
      }
    ]
  });

  mkdirSync(snapshotsRoot, { recursive: true });
  writeFileSync(projectStatusPath, `${JSON.stringify(status, null, 2)}\n`);
  writeFileSync(workflowStatePath, `${JSON.stringify(sourceWorkflowState(), null, 2)}\n`);
  writeFileSync(serviceInputPath, `${JSON.stringify(sourceWorkflowState(), null, 2)}\n`);
  writeFileSync(serviceHistoryPath, `${JSON.stringify({
    version: "projection-history.v1",
    latest: "headless-service-source",
    items: [
      {
        id: "headless-service-source",
        label: "Headless service source",
        input_path: relative(process.cwd(), serviceInputPath)
      }
    ]
  }, null, 2)}\n`);

  await withWorkbenchServer(async (baseUrl, serverOptions) => {
    const result = spawnSync(process.execPath, [
      "tools/run-headless-cli-orchestrator.mjs",
      "--project-status",
      projectStatusPath,
      "--workflow-state",
      workflowStatePath,
      "--output",
      outputPath,
      "--workflow-output",
      workflowOutputPath,
      "--history-path",
      join(dir, "headless-history.json"),
      "--snapshots-root",
      snapshotsRoot,
      "--snapshot-prefix",
      "headless-service",
      "--loop",
      "--max-iterations",
      "1",
      "--cycle-id",
      "cycle-headless-service",
      "--created-at",
      "2026-05-23T03:20:00.000Z",
      "--allow-mock-child-worker",
      "--execution-strategy",
      "projected_next_action",
      "--workbench-base-url",
      baseUrl,
      "--workbench-projection-id",
      "headless-service-source"
    ], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(readFileSync(outputPath, "utf8"));
    const workflowOutput = JSON.parse(readFileSync(workflowOutputPath, "utf8"));
    const serviceState = createSqliteWorkbenchStateStore({ dbPath: serverOptions.stateDbPath })
      .readWorkflowSnapshot("headless-service-source");
    const progressEvent = workflowOutput.manifest.events.find((event) => event.type === "headless_projected_action_progress");

    assert.equal(output.status, "pass");
    assert.equal(output.iterations[0].projected_next_action_status, "executed");
    assert.equal(output.iterations[0].projected_next_action, "prepare_project_status_continuation");
    assert.equal(serviceState.manifest.events.at(-1).type, "project_status_continuation");
    assert.ok(progressEvent);
    assert.equal(progressEvent.metadata.action, "prepare_project_status_continuation");
    assert.equal(progressEvent.metadata.has_projection, true);
  }, { historyPath: serviceHistoryPath, snapshotsRoot, projectStatusPath });
});

test("run-headless-cli-orchestrator CLI passes reviewer controls to projected service actions", async () => {
  mkdirSync("tmp", { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), "tmp/headless-cli-service-reviewer-"));
  const projectStatusPath = join(dir, "PROJECT_STATUS.json");
  const workflowStatePath = join(dir, "workflow-state.json");
  const serviceHistoryPath = join(dir, "projection-history.json");
  const snapshotsRoot = join(dir, "snapshots");
  const serviceInputPath = join(snapshotsRoot, "service-reviewer-input.json");
  const outputPath = join(dir, "headless-service-reviewer-output.json");
  const workflowOutputPath = join(dir, "headless-service-reviewer-workflow.json");
  const workflowState = currentSessionWorkflowState({
    withoutRequirementIntake: true,
    withoutSchedulerLoop: true
  });

  mkdirSync(snapshotsRoot, { recursive: true });
  writeFileSync(projectStatusPath, `${JSON.stringify(projectStatus(), null, 2)}\n`);
  writeFileSync(workflowStatePath, `${JSON.stringify(sourceWorkflowState(), null, 2)}\n`);
  writeFileSync(serviceInputPath, `${JSON.stringify(workflowState, null, 2)}\n`);
  writeFileSync(serviceHistoryPath, `${JSON.stringify({
    version: "projection-history.v1",
    latest: "headless-service-reviewer",
    items: [
      {
        id: "headless-service-reviewer",
        label: "Headless service reviewer",
        input_path: relative(process.cwd(), serviceInputPath)
      }
    ]
  }, null, 2)}\n`);

  await withWorkbenchServer(async (baseUrl, serverOptions) => {
    const result = spawnSync(process.execPath, [
      "tools/run-headless-cli-orchestrator.mjs",
      "--project-status",
      projectStatusPath,
      "--workflow-state",
      workflowStatePath,
      "--output",
      outputPath,
      "--workflow-output",
      workflowOutputPath,
      "--history-path",
      join(dir, "headless-history.json"),
      "--snapshots-root",
      snapshotsRoot,
      "--snapshot-prefix",
      "headless-service-reviewer",
      "--loop",
      "--max-iterations",
      "1",
      "--cycle-id",
      "cycle-headless-service-reviewer",
      "--created-at",
      "2026-05-23T04:30:00.000Z",
      "--allow-mock-child-worker",
      "--execution-strategy",
      "projected_next_action",
      "--workbench-base-url",
      baseUrl,
      "--workbench-projection-id",
      "headless-service-reviewer",
      "--execution-profile",
      "approved_mock_non_dry_run",
      "--context-work-package-execution-profile",
      "local_bounded",
      "--reviewer-mock-status",
      "pass"
    ], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(readFileSync(outputPath, "utf8"));
    const workflowOutput = JSON.parse(readFileSync(workflowOutputPath, "utf8"));
    const serviceState = createSqliteWorkbenchStateStore({ dbPath: serverOptions.stateDbPath })
      .readWorkflowSnapshot("headless-service-reviewer");
    const progressEvent = workflowOutput.manifest.events.find((event) => event.type === "headless_projected_action_progress");
    const shardEvent = serviceState.manifest.events.find((event) => event.type === "reviewer_shard_result");

    assert.equal(output.status, "pass");
    assert.equal(output.iterations[0].projected_next_action_status, "executed");
    assert.equal(output.iterations[0].projected_next_action, "run_reviewer_scope_shard");
    assert.ok(shardEvent);
    assert.equal(shardEvent.metadata.shard_id, "reviewer-scope-shard-001");
    assert.equal(shardEvent.metadata.executor_provenance.executor_kind, "mock");
    assert.ok(progressEvent);
    assert.equal(progressEvent.metadata.action, "run_reviewer_scope_shard");
    assert.equal(progressEvent.metadata.has_projection, true);
  }, { historyPath: serviceHistoryPath, snapshotsRoot, projectStatusPath });
});

test("run-headless-cli-orchestrator CLI continues after reviewer aggregate through service", async () => {
  mkdirSync("tmp", { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), "tmp/headless-cli-service-reviewer-aggregate-"));
  const projectStatusPath = join(dir, "PROJECT_STATUS.json");
  const workflowStatePath = join(dir, "workflow-state.json");
  const serviceHistoryPath = join(dir, "projection-history.json");
  const snapshotsRoot = join(dir, "snapshots");
  const serviceInputPath = join(snapshotsRoot, "service-reviewer-aggregate-input.json");
  const outputPath = join(dir, "headless-service-reviewer-aggregate-output.json");
  const workflowOutputPath = join(dir, "headless-service-reviewer-aggregate-workflow.json");
  const workflowState = currentSessionWorkflowState({
    withoutRequirementIntake: true,
    withoutSchedulerLoop: true
  });

  mkdirSync(snapshotsRoot, { recursive: true });
  writeFileSync(projectStatusPath, `${JSON.stringify(projectStatus(), null, 2)}\n`);
  writeFileSync(workflowStatePath, `${JSON.stringify(sourceWorkflowState(), null, 2)}\n`);
  writeFileSync(serviceInputPath, `${JSON.stringify(workflowState, null, 2)}\n`);
  writeFileSync(serviceHistoryPath, `${JSON.stringify({
    version: "projection-history.v1",
    latest: "headless-service-reviewer-aggregate",
    items: [
      {
        id: "headless-service-reviewer-aggregate",
        label: "Headless service reviewer aggregate",
        input_path: relative(process.cwd(), serviceInputPath)
      }
    ]
  }, null, 2)}\n`);

  await withWorkbenchServer(async (baseUrl, serverOptions) => {
    const result = spawnSync(process.execPath, [
      "tools/run-headless-cli-orchestrator.mjs",
      "--project-status",
      projectStatusPath,
      "--workflow-state",
      workflowStatePath,
      "--output",
      outputPath,
      "--workflow-output",
      workflowOutputPath,
      "--history-path",
      join(dir, "headless-history.json"),
      "--snapshots-root",
      snapshotsRoot,
      "--snapshot-prefix",
      "headless-service-reviewer-aggregate",
      "--loop",
      "--max-iterations",
      "5",
      "--cycle-id",
      "cycle-headless-service-reviewer-aggregate",
      "--created-at",
      "2026-05-23T04:45:00.000Z",
      "--allow-mock-child-worker",
      "--execution-strategy",
      "projected_next_action",
      "--workbench-base-url",
      baseUrl,
      "--workbench-projection-id",
      "headless-service-reviewer-aggregate",
      "--execution-profile",
      "approved_mock_non_dry_run",
      "--reviewer-mock-status",
      "pass"
    ], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(readFileSync(outputPath, "utf8"));
    const workflowOutput = JSON.parse(readFileSync(workflowOutputPath, "utf8"));
    const serviceState = createSqliteWorkbenchStateStore({ dbPath: serverOptions.stateDbPath })
      .readWorkflowSnapshot("headless-service-reviewer-aggregate");
    const progressActions = workflowOutput.manifest.events
      .filter((event) => event.type === "headless_projected_action_progress")
      .map((event) => event.metadata.action);

    assert.equal(output.status, "pass");
    assert.deepEqual(output.iterations.map((iteration) => iteration.projected_next_action), [
      "run_reviewer_scope_shard",
      "run_reviewer_scope_shard",
      "continue_after_reviewer_aggregate",
      "create_context_pack_from_seed",
      "run_context_work_packages"
    ]);
    assert.match(output.iterations[3].workbench_projection_id, /^context-pack-cycle-headless-service-reviewer-aggregate-/);
    assert.equal(output.iterations[4].workbench_projection_id, output.iterations[3].projected_next_projection_id);
    assert.equal(progressActions.at(-1), "run_context_work_packages");
    assert.ok(serviceState.manifest.events.some((event) => event.type === "reviewer_shard_aggregate"));
    assert.ok(serviceState.manifest.events.some((event) => event.type === "project_status_continuation"));
    assert.ok(serviceState.manifest.events.some((event) => event.type === "context_pack_cycle_materialized"));
    assert.equal(output.last_result.projected_next_action.action, "run_context_work_packages");
  }, { historyPath: serviceHistoryPath, snapshotsRoot, projectStatusPath });
});

test("run-headless-cli-orchestrator CLI follows service next projection into context work packages", async () => {
  mkdirSync("tmp", { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), "tmp/headless-cli-service-projection-cursor-"));
  const projectStatusPath = join(dir, "PROJECT_STATUS.json");
  const workflowStatePath = join(dir, "workflow-state.json");
  const serviceHistoryPath = join(dir, "projection-history.json");
  const snapshotsRoot = join(dir, "snapshots");
  const serviceInputPath = join(snapshotsRoot, "service-projection-cursor-input.json");
  const outputPath = join(dir, "headless-service-projection-cursor-output.json");
  const workflowOutputPath = join(dir, "headless-service-projection-cursor-workflow.json");
  const workflowState = currentSessionWorkflowState({
    withoutRequirementIntake: true,
    withoutSchedulerLoop: true
  });

  mkdirSync(snapshotsRoot, { recursive: true });
  writeFileSync(projectStatusPath, `${JSON.stringify(projectStatus(), null, 2)}\n`);
  writeFileSync(workflowStatePath, `${JSON.stringify(sourceWorkflowState(), null, 2)}\n`);
  writeFileSync(serviceInputPath, `${JSON.stringify(workflowState, null, 2)}\n`);
  writeFileSync(serviceHistoryPath, `${JSON.stringify({
    version: "projection-history.v1",
    latest: "headless-service-projection-cursor",
    items: [
      {
        id: "headless-service-projection-cursor",
        label: "Headless service projection cursor",
        input_path: relative(process.cwd(), serviceInputPath)
      }
    ]
  }, null, 2)}\n`);

  await withWorkbenchServer(async (baseUrl, serverOptions) => {
    const result = spawnSync(process.execPath, [
      "tools/run-headless-cli-orchestrator.mjs",
      "--project-status",
      projectStatusPath,
      "--workflow-state",
      workflowStatePath,
      "--output",
      outputPath,
      "--workflow-output",
      workflowOutputPath,
      "--history-path",
      join(dir, "headless-history.json"),
      "--snapshots-root",
      snapshotsRoot,
      "--snapshot-prefix",
      "headless-service-projection-cursor",
      "--loop",
      "--max-iterations",
      "5",
      "--cycle-id",
      "cycle-headless-service-projection-cursor",
      "--created-at",
      "2026-05-23T10:25:00.000Z",
      "--allow-mock-child-worker",
      "--execution-strategy",
      "projected_next_action",
      "--workbench-base-url",
      baseUrl,
      "--workbench-projection-id",
      "headless-service-projection-cursor",
      "--execution-profile",
      "approved_mock_non_dry_run",
      "--context-work-package-execution-profile",
      "local_bounded",
      "--reviewer-mock-status",
      "pass"
    ], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(readFileSync(outputPath, "utf8"));
    const store = createSqliteWorkbenchStateStore({ dbPath: serverOptions.stateDbPath });
    const serviceHistory = store.readHistory();
    const nextItem = serviceHistory.items.find((item) => item.id.startsWith("context-pack-cycle-headless-service-projection-cursor-"));
    assert.ok(nextItem, "context pack cycle snapshot must be published into service history");
    const nextState = store.readWorkflowSnapshot(nextItem.id);
    const nextEventTypes = nextState.manifest.events.map((event) => event.type);

    assert.equal(output.status, "pass");
    assert.deepEqual(output.iterations.map((iteration) => iteration.projected_next_action), [
      "run_reviewer_scope_shard",
      "run_reviewer_scope_shard",
      "continue_after_reviewer_aggregate",
      "create_context_pack_from_seed",
      "run_context_work_packages"
    ]);
    assert.ok(output.iterations[3].projected_next_projection_id);
    assert.equal(output.iterations[4].projected_next_action, "run_context_work_packages");
    assert.ok(nextEventTypes.includes("context_work_packages_run"));
    assert.equal(nextState.manifest.work_packages[0].status, "completed");
  }, { historyPath: serviceHistoryPath, snapshotsRoot, projectStatusPath });
});

test("run-headless-cli-orchestrator CLI exposes projected next-action workbench controls", () => {
  const result = spawnSync(process.execPath, [
    "tools/run-headless-cli-orchestrator.mjs",
    "--help"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /--execution-strategy/);
  assert.match(result.stdout, /--workbench-base-url/);
  assert.match(result.stdout, /--workbench-projection-id/);
  assert.match(result.stdout, /--projected-next-action/);
  assert.match(result.stdout, /--context-work-package-execution-profile/);
  assert.match(result.stdout, /--reviewer-mock-status/);
});
