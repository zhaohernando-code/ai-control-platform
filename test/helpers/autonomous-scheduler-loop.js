import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWorkbenchServer } from "../../tools/workbench-server.mjs";
import { currentSessionWorkflowState } from "./current-session-workflow-state.js";

export async function withServer(options, fn) {
  const stateDbPath = options.stateDbPath || join(mkdtempSync(join(tmpdir(), "ai-control-platform-workbench-state-")), "workbench-state.sqlite");
  const serverOptions = { ...options, stateDbPath };
  const server = createWorkbenchServer(serverOptions);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, serverOptions);
  } finally {
    server.close();
    await once(server, "close");
  }
}

export function runNode(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
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

export function fakeClient(overrides = {}) {
  const calls = [];
  return {
    calls,
    async loadHistory() {
      calls.push(["loadHistory"]);
      return overrides.history || { latest: "current" };
    },
    async createSchedulerDispatchPlan(id, body) {
      calls.push(["plan", id, body]);
      return overrides.plan || {
        status: "created",
        plan: {
          status: "pass",
          phase: "scheduler_dispatch_plan",
          steps: [{ id: "run-reviewer-shard-loop" }]
        }
      };
    },
    async runSchedulerDispatch(id, body) {
      calls.push(["dispatch", id, body]);
      return overrides.dispatch || {
        status: "created",
        projection: {
          scheduler_continuation: { ready: true }
        }
      };
    },
    async enqueueSchedulerNextCycle(id, body) {
      calls.push(["enqueue", id, body]);
      return overrides.enqueue || {
        status: "queued",
        next_item: { id: `${id}-next` }
      };
    }
  };
}

export function currentSessionWithoutSchedulerLoop() {
  // currentSessionWorkflowState returns a fresh parsed object; clone again before pruning to keep this helper resilient to future fixture changes.
  const workflowState = JSON.parse(JSON.stringify(currentSessionWorkflowState()));
  const schedulerEventTypes = new Set(["autonomous_scheduler_loop_run", "scheduler_loop_resume_attempt"]);
  workflowState.manifest.events = (workflowState.manifest.events || [])
    .filter((event) => !schedulerEventTypes.has(event.type));
  workflowState.manifest.artifacts = (workflowState.manifest.artifacts || [])
    .filter((artifact) => !schedulerEventTypes.has(artifact.metadata?.type));
  workflowState.artifact_ledger.artifacts = (workflowState.artifact_ledger.artifacts || [])
    .filter((artifact) => !schedulerEventTypes.has(artifact.metadata?.type));
  return workflowState;
}
