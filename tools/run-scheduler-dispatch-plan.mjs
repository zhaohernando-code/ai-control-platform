#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname, resolve } from "node:path";

import {
  createSchedulerDispatchRunArtifact,
  runSchedulerDispatchPlan
} from "../src/workflow/scheduler-dispatch-runner.js";
import { prepareSchedulerDispatchContinuationFromRunArtifact } from "../src/workflow/scheduler-dispatch-continuation.js";

function valueAfter(flag, args) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : "";
}

function hasFlag(flag, args) {
  return args.includes(flag);
}

function usage() {
  return [
    "Usage: node tools/run-scheduler-dispatch-plan.mjs --plan <dispatch-plan.json> --output <scheduler-dispatch-run.v1.json>",
    "",
    "Options:",
    "  --dry-run  Validate and record steps without executing commands",
    "  --continuation-output <path>  Validate scheduler dispatch outputs and write next continuation input",
    "  --workbench-base-url <url>  POST the run artifact to the workbench scheduler dispatch writeback API",
    "  --projection-id <id>  Optional workbench projection history id for writeback"
  ].join("\n");
}

function schedulerDispatchRecordUrl(baseUrl, projectionId = "") {
  const url = new URL("/api/workbench/scheduler-dispatch-run", baseUrl);
  if (projectionId) url.searchParams.set("id", projectionId);
  return url;
}

function postJson(url, body) {
  return new Promise((resolvePost, reject) => {
    const client = url.protocol === "https:" ? httpsRequest : httpRequest;
    if (!["http:", "https:"].includes(url.protocol)) {
      reject(new Error("workbench base url must use http or https"));
      return;
    }
    const payload = JSON.stringify(body);
    const req = client(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload)
      }
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
      });
      res.on("end", () => {
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        resolvePost({ status: res.statusCode, text, json });
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(usage());
  process.exit(0);
}

const planPath = valueAfter("--plan", args);
const outputPath = valueAfter("--output", args);
const continuationOutputPath = valueAfter("--continuation-output", args);
let workbenchBaseUrl = valueAfter("--workbench-base-url", args);
let projectionId = valueAfter("--projection-id", args);
if (!planPath || !outputPath) {
  console.error(usage());
  process.exit(1);
}

let plan;
let result;
try {
  plan = JSON.parse(readFileSync(resolve(planPath), "utf8"));
  if (!workbenchBaseUrl && plan?.writeback?.mode === "service") {
    workbenchBaseUrl = plan.writeback.base_url || "";
  }
  if (!projectionId && plan?.writeback?.mode === "service") {
    projectionId = plan.writeback.projection_id || "";
  }
  result = await runSchedulerDispatchPlan(plan, {
    dry_run: hasFlag("--dry-run", args)
  });
} catch (error) {
  result = {
    status: "fail",
    phase: "input",
    issues: [{ code: "scheduler_dispatch_run_input_failed", message: error.message, path: "plan" }],
    steps: []
  };
  plan = null;
}

const artifact = createSchedulerDispatchRunArtifact(plan || {}, result);
const resolvedOutput = resolve(outputPath);
mkdirSync(dirname(resolvedOutput), { recursive: true });
writeFileSync(resolvedOutput, `${JSON.stringify(artifact, null, 2)}\n`);

let continuation = null;
if (continuationOutputPath) {
  continuation = prepareSchedulerDispatchContinuationFromRunArtifact(artifact);
  if (continuation.status === "ready") {
    const resolvedContinuationOutput = resolve(continuationOutputPath);
    mkdirSync(dirname(resolvedContinuationOutput), { recursive: true });
    writeFileSync(resolvedContinuationOutput, `${JSON.stringify(continuation.continuation_input, null, 2)}\n`);
    continuation = {
      status: "ready",
      output: resolvedContinuationOutput,
      next_work_package_count: continuation.scheduler_dispatch?.next_work_package_count ?? null
    };
  } else {
    continuation = {
      status: "blocked",
      issues: continuation.issues || []
    };
  }
}

let record = null;
if (workbenchBaseUrl) {
  try {
    const response = await postJson(schedulerDispatchRecordUrl(workbenchBaseUrl, projectionId), { artifact });
    record = response.status >= 200 && response.status < 300
      ? {
        status: "pass",
        response_status: response.status,
        projection_status: response.json?.projection?.scheduler_dispatch?.status || null,
        scheduler_dispatch_steps: response.json?.projection?.scheduler_dispatch?.step_count ?? null
      }
      : {
        status: "fail",
        response_status: response.status,
        error: response.json?.error || response.text || "scheduler dispatch writeback failed"
      };
  } catch (error) {
    record = {
      status: "fail",
      error: error.message
    };
  }
}

console.log(JSON.stringify({
  status: record?.status === "fail" ? "fail" : artifact.status,
  artifact_status: artifact.status,
  phase: artifact.phase,
  output: resolvedOutput,
  step_count: artifact.result.steps.length,
  continuation_status: continuation?.status || "not_requested",
  continuation_output: continuation?.output || null,
  continuation_next_work_packages: continuation?.next_work_package_count ?? null,
  continuation_issues: continuation?.issues || [],
  record_status: record?.status || "not_requested",
  record_response_status: record?.response_status || null,
  projection_scheduler_status: record?.projection_status || null,
  projection_scheduler_steps: record?.scheduler_dispatch_steps ?? null,
  record_error: record?.error || null
}, null, 2));
if (artifact.status !== "pass" || record?.status === "fail" || continuation?.status === "blocked") {
  process.exit(1);
}
