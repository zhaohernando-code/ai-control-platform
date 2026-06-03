import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { createRunManifest } from "../../src/workflow/run-manifest.js";

export const HEADLESS_CLI_ORCHESTRATOR_TEST_FILES = [
  "test/headless-cli-orchestrator.test.js",
  "test/headless-cli-orchestrator-cli-basic.test.js",
  "test/headless-cli-orchestrator-cli-service-actions.test.js",
  "test/headless-cli-orchestrator-cli-service-loop.test.js"
];

export async function withWorkbenchServer(fn, options = {}) {
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

export function projectStatus(overrides = {}) {
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
              ...HEADLESS_CLI_ORCHESTRATOR_TEST_FILES,
              "docs/examples/process-hardening-current.json"
            ]
          }
        ],
        owned_files: [
          "src/workflow/headless-cli-orchestrator.js",
          "tools/run-headless-cli-orchestrator.mjs",
          ...HEADLESS_CLI_ORCHESTRATOR_TEST_FILES,
          "docs/examples/process-hardening-current.json"
        ]
      }
    ],
    ...overrides
  };
}

export function governedAgentStateStore() {
  return {
    acquireAgentKeyForRole(role, options) {
      return {
        status: "acquired",
        key: {
          id: `test-key-${options.agent_id}`,
          secret: `test-secret-${options.agent_id}-${role}`,
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

export function sourceWorkflowState() {
  const contextPack = {
    requirement_summary: "Source workflow state for headless CLI orchestrator.",
    host: "platform_core",
    target_project_id: "ai-control-platform",
    non_goals: ["Do not modify managed projects"],
    forbidden_actions: ["Do not skip main-process evaluation"],
    owned_files: ["src/workflow/headless-cli-orchestrator.js"],
    acceptance_gates: [`node --test ${HEADLESS_CLI_ORCHESTRATOR_TEST_FILES.join(" ")}`],
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

export function materializedWorkflowStateWithCompletedFirstPackage() {
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
