import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import {
  createSchedulerDispatchRunArtifact,
  runSchedulerDispatchPlan
} from "../../src/workflow/scheduler-dispatch-runner.js";
import { createSchedulerDispatchPlan } from "../../src/workflow/scheduler-dispatch-plan.js";
import { createRunManifest } from "../../src/workflow/run-manifest.js";
import { VERIFIED_PROVIDER_MULTI_AGENT_PROFILE } from "../../src/workflow/context-work-package-execution-adapter.js";
import { assertWorkbenchProjectionSchema } from "../../src/workflow/workbench-projection-schema.js";
import { createWorkbenchServer } from "../../tools/workbench-server.mjs";
import { currentSessionWorkflowState } from "./current-session-workflow-state.js";

mkdirSync("tmp", { recursive: true });

export const WORKBENCH_SERVER_TEST_FILES = ["test/workbench-server.test.js", "test/workbench-server-agent-key-routes.test.js", "test/workbench-server-background-dispatch.test.js", "test/workbench-server-cli.test.js", "test/workbench-server-plan-review.test.js", "test/workbench-server-project-status-continuation.test.js", "test/workbench-server-provider-defaults.test.js", "test/workbench-server-provider-execution.test.js", "test/workbench-server-requirement-closeout.test.js", "test/workbench-server-requirement-plan-generation.test.js", "test/workbench-server-requirement-plan-retry.test.js", "test/workbench-server-shard-01.test.js", "test/workbench-server-shard-02.test.js", "test/workbench-server-shard-03.test.js", "test/workbench-server-shard-04.test.js", "test/workbench-server-shard-05.test.js", "test/workbench-server-shard-06.test.js", "test/workbench-server-shard-07.test.js", "test/workbench-server-shard-08.test.js", "test/workbench-server-shard-09.test.js", "test/workbench-server-shard-10.test.js", "test/workbench-server-shard-11.test.js"];

export { assertWorkbenchProjectionSchema, chmodSync, createSchedulerDispatchPlan, createSchedulerDispatchRunArtifact, createWorkbenchServer, currentSessionWorkflowState, join, mkdirSync, mkdtempSync, once, readFileSync, relative, runSchedulerDispatchPlan, spawn, tmpdir, VERIFIED_PROVIDER_MULTI_AGENT_PROFILE, writeFileSync };

export function currentProjectionHistory() {
  return JSON.parse(readFileSync("docs/examples/projection-history.json", "utf8"));
}

export function currentSessionWithoutRequirementPlanReview() {
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

export function currentSessionWithoutSchedulerLoop() {
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

export function generatedRequirementPlan(overrides = {}) {
  return {
    assessment_summary: "模型评估认为该需求需要先完成方案审核，再进入受控开发。",
    proposed_acceptance_plan: "## 目标\n形成可审核方案。\n## 验收\n方案通过前不自动开发；通过后进入受控任务执行。",
    implementation_outline: ["生成方案", "等待审核", "审核通过后派发"],
    acceptance_gates: [`node --test ${WORKBENCH_SERVER_TEST_FILES.join(" ")}`],
    risks: ["模型方案必须结构化保存"],
    ...overrides
  };
}

export function isolatedExecutionCwd(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

export async function withServer(fn, options = {}) {
  // workbench-state-boundary-allow fixture-file-state: shared test-only fixture server; runtime callers must use SQLite state.
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

export function request(url, options = {}) {
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

export function runNode(args, options = {}) {
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

export function waitForOutput(child, pattern) {
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

export async function waitForCondition(predicate, description, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`timed out waiting for ${description}`);
}

export function providerContextWorkPackageWorkflowState() {
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
        acceptance_gates: [`node --test ${WORKBENCH_SERVER_TEST_FILES.join(" ")}`],
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

export function retryAgentWorkerWorkflowState() {
  const contextPack = {
    requirement_summary: "Retry timed-out child worker through context package execution.",
    host: "platform_core",
    target_project_id: "ai-control-platform",
    non_goals: ["Do not modify managed business projects"],
    forbidden_actions: ["Do not skip main-process evaluation gates"],
    owned_files: ["src/workflow/context-work-package-runner.js"],
    acceptance_gates: [`node --test ${WORKBENCH_SERVER_TEST_FILES.join(" ")}`],
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
