#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  createSchedulerLoopRunArtifact,
  runSchedulerLoopDriver
} from "../src/workflow/autonomous-scheduler-loop.js";

function valueAfter(flag, args) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : "";
}

function usage() {
  return [
    "Usage: node tools/run-autonomous-scheduler-loop.mjs --workbench-base-url <url> --output <autonomous-scheduler-loop-run.v1.json>",
    "",
    "Options:",
    "  --start-projection-id <id>",
    "  --max-iterations <n>  Bounded loop count, 1-5",
    "  --execution-profile <profile>  Currently only approved_mock_non_dry_run",
    "  --snapshot-prefix <id-prefix>"
  ].join("\n");
}

function assertLocalWorkbenchBaseUrl(value) {
  const url = new URL(value);
  const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  if (url.protocol !== "http:" || !localHosts.has(url.hostname)) {
    const error = new Error("scheduler loop workbench base url must be local http");
    error.code = "INVALID_WORKBENCH_BASE_URL";
    throw error;
  }
  return url;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new Error(payload?.error || text || `workbench request failed: ${response.status}`);
  }
  return payload;
}

function createWorkbenchSchedulerLoopClient(baseUrl) {
  const base = assertLocalWorkbenchBaseUrl(baseUrl);

  function apiUrl(path, projectionId = "") {
    const url = new URL(path, base);
    if (projectionId) url.searchParams.set("id", projectionId);
    return url;
  }

  return {
    loadHistory() {
      return requestJson(apiUrl("/api/workbench/projections"));
    },
    createSchedulerDispatchPlan(projectionId, body = {}) {
      return requestJson(apiUrl("/api/workbench/scheduler-dispatch-plan", projectionId), {
        method: "POST",
        body
      });
    },
    runSchedulerDispatch(projectionId, body = {}) {
      return requestJson(apiUrl("/api/workbench/scheduler-dispatch", projectionId), {
        method: "POST",
        body
      });
    },
    enqueueSchedulerNextCycle(projectionId, body = {}) {
      return requestJson(apiUrl("/api/workbench/scheduler-next-cycle", projectionId), {
        method: "POST",
        body
      });
    }
  };
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(usage());
  process.exit(0);
}

const workbenchBaseUrl = valueAfter("--workbench-base-url", args);
const outputPath = valueAfter("--output", args);
if (!workbenchBaseUrl || !outputPath) {
  console.error(usage());
  process.exit(1);
}

const input = {
  start_projection_id: valueAfter("--start-projection-id", args),
  max_iterations: Number(valueAfter("--max-iterations", args) || 1),
  execution_profile: valueAfter("--execution-profile", args) || "approved_mock_non_dry_run",
  snapshot_prefix: valueAfter("--snapshot-prefix", args) || "scheduler-loop"
};

let result;
try {
  result = await runSchedulerLoopDriver(input, {
    client: createWorkbenchSchedulerLoopClient(workbenchBaseUrl)
  });
} catch (error) {
  result = {
    status: "fail",
    phase: "input",
    issues: [{ code: error.code || "scheduler_loop_cli_failed", message: error.message, path: "workbench_base_url" }],
    iterations: []
  };
}

const artifact = createSchedulerLoopRunArtifact(input, result);
const resolvedOutput = resolve(outputPath);
mkdirSync(dirname(resolvedOutput), { recursive: true });
writeFileSync(resolvedOutput, `${JSON.stringify(artifact, null, 2)}\n`);

console.log(JSON.stringify({
  status: artifact.status,
  phase: artifact.phase,
  output: resolvedOutput,
  iteration_count: artifact.result.iterations.length,
  latest_iteration_status: artifact.result.iterations.at(-1)?.status || null,
  issues: artifact.result.issues
}, null, 2));

if (artifact.status !== "pass") {
  process.exit(1);
}
