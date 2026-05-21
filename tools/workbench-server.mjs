#!/usr/bin/env node
import { createServer, request as httpRequest } from "node:http";
import { dirname, extname, isAbsolute, normalize, relative, resolve } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { createWorkbenchProjection } from "../src/workflow/workbench-projection.js";
import { publishWorkbenchSnapshot, snapshotIssues } from "../src/workflow/workbench-snapshots.js";
import { createSchedulerDispatchPlan } from "../src/workflow/scheduler-dispatch-plan.js";
import {
  evaluateSchedulerDispatchControlPolicy,
  normalizeSchedulerDispatchControlRequest,
  recordSchedulerDispatchPolicyDecision
} from "../src/workflow/scheduler-dispatch-policy.js";
import { recordReviewerProviderHealthFact } from "../src/workflow/reviewer-provider-health.js";
import {
  recordReviewerShardAggregate,
  recordReviewerShardResult
} from "../src/workflow/reviewer-shard-results.js";
import {
  createSchedulerDispatchRunArtifact,
  recordSchedulerDispatchRunArtifact,
  runSchedulerDispatchPlan
} from "../src/workflow/scheduler-dispatch-runner.js";
import {
  prepareSchedulerDispatchContinuationFromRunArtifact,
  recordSchedulerDispatchContinuationPrepared,
  recordSchedulerNextCycleEnqueue
} from "../src/workflow/scheduler-dispatch-continuation.js";
import {
  createSchedulerLoopRunArtifact,
  recordAutonomousSchedulerLoopRunArtifact,
  runSchedulerLoopDriver
} from "../src/workflow/autonomous-scheduler-loop.js";

const root = resolve(process.cwd());
const historyPath = resolve(root, "docs/examples/projection-history.json");
const defaultEventsPath = resolve(root, "docs/examples/operator-events.json");
const examplesRoot = resolve(root, "docs/examples");
const defaultSnapshotsRoot = resolve(root, "tmp/workbench-snapshots");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function jsonResponse(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function isWithinPath(basePath, filePath) {
  return filePath === basePath || filePath.startsWith(`${basePath}/`);
}

function historyItemPath(itemPath, field, allowedRoots = [examplesRoot, defaultSnapshotsRoot]) {
  if (!itemPath) return null;
  if (typeof itemPath !== "string" || isAbsolute(itemPath)) {
    const error = new Error(`${field} must be a relative workbench history path`);
    error.code = "INVALID_HISTORY_PATH";
    throw error;
  }

  const filePath = resolve(root, itemPath);
  if (!allowedRoots.some((allowedRoot) => isWithinPath(allowedRoot, filePath))) {
    const error = new Error(`${field} must stay under allowed workbench history roots`);
    error.code = "INVALID_HISTORY_PATH";
    throw error;
  }

  return filePath;
}

function projectionById(id = null, history = readJson(historyPath), allowedRoots = [examplesRoot, defaultSnapshotsRoot]) {
  const selectedId = id || history.latest;
  const item = history.items.find((entry) => entry.id === selectedId);

  if (!item) {
    const error = new Error(`projection not found: ${selectedId}`);
    error.code = "PROJECTION_NOT_FOUND";
    throw error;
  }

  return {
    history,
    item,
    projection: item.input_path
      ? createWorkbenchProjection(readJson(historyItemPath(item.input_path, "input_path", allowedRoots)))
      : readJson(historyItemPath(item.projection_path, "projection_path", allowedRoots))
  };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function artifactsOf(workflowState = {}) {
  return [
    ...asArray(workflowState?.artifact_ledger?.artifacts || workflowState?.artifactLedger?.artifacts),
    ...asArray(workflowState?.manifest?.artifacts)
  ];
}

function latestArtifactForEvent(workflowState = {}, eventType) {
  const event = asArray(workflowState?.manifest?.events)
    .filter((entry) => entry?.type === eventType)
    .at(-1) || null;
  if (!event) return { event: null, artifact: null, metadata: null };

  const artifact = artifactsOf(workflowState).find((entry) => entry?.id === event.artifact_id) || null;
  return {
    event,
    artifact,
    metadata: artifact?.metadata || event.metadata || null
  };
}

function latestSchedulerDispatchRun(workflowState = {}) {
  return latestArtifactForEvent(workflowState, "scheduler_dispatch_run");
}

function schedulerContinuationOutputPath(runArtifact = {}) {
  return normalizeString(runArtifact?.input?.plan?.continuation_output?.path);
}

function safeGeneratedContinuationPath(itemPath, allowedRoots) {
  if (!itemPath) {
    const error = new Error("scheduler dispatch continuation output path is required");
    error.code = "INVALID_CONTINUATION_PATH";
    throw error;
  }
  if (typeof itemPath !== "string") {
    const error = new Error("scheduler dispatch continuation output path must be a string");
    error.code = "INVALID_CONTINUATION_PATH";
    throw error;
  }
  const filePath = isAbsolute(itemPath) ? resolve(itemPath) : resolve(root, itemPath);
  if (!allowedRoots.some((allowedRoot) => isWithinPath(allowedRoot, filePath))) {
    const error = new Error("scheduler dispatch continuation output path must stay under controlled roots");
    error.code = "INVALID_CONTINUATION_PATH";
    throw error;
  }
  return filePath;
}

function generatedContinuationInputIssues(generated = {}, prepared = {}) {
  const issues = [];
  if (!generated || typeof generated !== "object" || Array.isArray(generated)) {
    return ["generated continuation input must be an object"];
  }
  if (generated.project_status?.project !== "ai-control-platform") {
    issues.push("generated continuation input must target ai-control-platform");
  }
  const generatedManifest = generated.workflow_state?.manifest || {};
  const expectedRunId = prepared.scheduler_dispatch?.run_id;
  const expectedCycleId = prepared.scheduler_dispatch?.cycle_id;
  if (expectedRunId && generatedManifest.run_id !== expectedRunId) {
    issues.push("generated continuation input run_id must match scheduler dispatch run");
  }
  if (expectedCycleId && generatedManifest.cycle_id !== expectedCycleId) {
    issues.push("generated continuation input cycle_id must match scheduler dispatch run");
  }
  const expectedWorkPackages = asArray(prepared.next_decision?.next_work_packages).length;
  const generatedWorkPackages = asArray(generated.workflow_state?.manifest?.work_packages).length;
  if (expectedWorkPackages !== generatedWorkPackages) {
    issues.push("generated continuation input work package count must match replay-validated continuation");
  }
  return issues;
}

function projectionHistoryWithReadiness(history = {}, allowedRoots = [examplesRoot, defaultSnapshotsRoot]) {
  return {
    ...history,
    items: asArray(history.items).map((item) => {
      if (!item?.input_path) return item;
      try {
        const workflowState = readJson(historyItemPath(item.input_path, "input_path", allowedRoots));
        const projection = createWorkbenchProjection(workflowState);
        return {
          ...item,
          scheduler_dispatch: {
            status: projection.scheduler_dispatch.status,
            phase: projection.scheduler_dispatch.phase,
            artifact_id: projection.scheduler_dispatch.artifact_id,
            continuation_status: projection.scheduler_continuation.continuation_status || projection.scheduler_dispatch.next_continuation_status,
            continuation_ready: projection.scheduler_continuation.ready,
            enqueue_status: projection.scheduler_continuation.enqueue_status,
            enqueue_available: projection.scheduler_continuation.enqueue_available,
            continuation_input_path: projection.scheduler_continuation.continuation_input_path,
            next_continuation_action: projection.scheduler_dispatch.next_continuation_action,
            next_work_package_count: projection.scheduler_continuation.next_work_package_count || projection.scheduler_dispatch.next_work_package_count,
            latest_issue: projection.scheduler_continuation.latest_issue
          },
          scheduler_loop: {
            status: projection.scheduler_loop.status,
            phase: projection.scheduler_loop.phase,
            run_count: projection.scheduler_loop.run_count,
            invalid_count: projection.scheduler_loop.invalid_count,
            iteration_count: projection.scheduler_loop.iteration_count,
            recovery_status: projection.scheduler_loop.recovery_status,
            recovery_action: projection.scheduler_loop.recovery_action,
            resumable: projection.scheduler_loop.resumable,
            resume_projection_id: projection.scheduler_loop.resume_projection_id,
            latest_projection_id: projection.scheduler_loop.latest_projection_id,
            latest_issue: projection.scheduler_loop.latest_issue
          }
        };
      } catch (error) {
        return {
          ...item,
          scheduler_dispatch: {
            status: "history_read_failed",
            continuation_ready: false,
            enqueue_available: false,
            latest_issue: error.message
          },
          scheduler_loop: {
            status: "history_read_failed",
            recovery_status: "blocked",
            recovery_action: "repair_history_input",
            resumable: false,
            latest_issue: error.message
          }
        };
      }
    })
  };
}

function metadataPath(filePath) {
  return isWithinPath(root, filePath) ? relative(root, filePath) : filePath;
}

function writePreparedSchedulerContinuation(runArtifact, prepared, allowedOutputRoots) {
  const outputPath = safeGeneratedContinuationPath(schedulerContinuationOutputPath(runArtifact), allowedOutputRoots);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(prepared.continuation_input, null, 2)}\n`);
  return outputPath;
}

function requestJson(url, body = null) {
  return new Promise((resolveRequest, reject) => {
    if (url.protocol !== "http:") {
      reject(new Error("workbench loop client supports only local http"));
      return;
    }
    const payload = body ? JSON.stringify(body) : null;
    const req = httpRequest(url, {
      method: payload ? "POST" : "GET",
      headers: payload
        ? {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload)
        }
        : {}
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        text += chunk;
      });
      response.on("end", () => {
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(json?.error || text || `workbench request failed: ${response.statusCode}`));
          return;
        }
        resolveRequest(json);
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function createWorkbenchLoopClient(baseUrl) {
  const base = new URL(baseUrl);
  return {
    loadHistory() {
      return requestJson(new URL("/api/workbench/projections", base));
    },
    createSchedulerDispatchPlan(projectionId, body = {}) {
      const url = new URL("/api/workbench/scheduler-dispatch-plan", base);
      if (projectionId) url.searchParams.set("id", projectionId);
      return requestJson(url, body);
    },
    runSchedulerDispatch(projectionId, body = {}) {
      const url = new URL("/api/workbench/scheduler-dispatch", base);
      if (projectionId) url.searchParams.set("id", projectionId);
      return requestJson(url, body);
    },
    enqueueSchedulerNextCycle(projectionId, body = {}) {
      const url = new URL("/api/workbench/scheduler-next-cycle", base);
      if (projectionId) url.searchParams.set("id", projectionId);
      return requestJson(url, body);
    }
  };
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolveBody(body));
    req.on("error", reject);
  });
}

function normalizeEvent(input = {}, projectionId = null) {
  const createdAt = input.created_at || new Date().toISOString();
  return {
    id: input.id || `operator-event-${createdAt}`,
    type: typeof input.type === "string" && input.type.trim() ? input.type.trim() : "operator_action",
    action: input.action.trim(),
    projection_id: input.projection_id || projectionId || null,
    run_id: input.run_id.trim(),
    cycle_id: input.cycle_id.trim(),
    created_at: createdAt,
    metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {}
  };
}

function workbenchBaseUrlFromRequest(req) {
  const host = String(req.headers.host || "").trim();
  if (!host || !/^[a-zA-Z0-9.:-]+$/.test(host)) {
    const error = new Error("request host is required for scheduler dispatch writeback planning");
    error.code = "INVALID_WORKBENCH_HOST";
    throw error;
  }
  return `http://${host}`;
}

function operatorEventIssues(input = {}) {
  const issues = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return ["event must be an object"];
  }
  for (const field of ["action", "run_id", "cycle_id"]) {
    if (typeof input[field] !== "string" || !input[field].trim()) {
      issues.push(`${field} is required`);
    }
  }
  if (input.metadata !== undefined && (!input.metadata || typeof input.metadata !== "object" || Array.isArray(input.metadata))) {
    issues.push("metadata must be an object when provided");
  }
  return issues;
}

function schedulerDispatchRunArtifactFromInput(input = {}) {
  return input.artifact || input.run_artifact || input.runArtifact || input;
}

function schedulerDispatchRunIssues(input = {}) {
  const artifact = schedulerDispatchRunArtifactFromInput(input);
  const issues = [];

  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    return ["scheduler dispatch run artifact must be an object"];
  }
  if (artifact.version !== "scheduler-dispatch-run.v1") {
    issues.push("scheduler dispatch run artifact version must be scheduler-dispatch-run.v1");
  }
  if (!["pass", "fail"].includes(String(artifact.status || ""))) {
    issues.push("scheduler dispatch run artifact status must be pass or fail");
  }
  if (!artifact.result || typeof artifact.result !== "object" || Array.isArray(artifact.result)) {
    issues.push("scheduler dispatch run artifact result is required");
  }
  if (artifact.result && !Array.isArray(artifact.result.steps)) {
    issues.push("scheduler dispatch run artifact result.steps must be an array");
  }

  return issues;
}

function schedulerPlanInputFromWorkflowState(workflowState, input = {}) {
  return {
    project_status: {
      project: "ai-control-platform",
      blockers: [],
      next_step: input.next_step || input.nextStep || ""
    },
    run_evaluation: input.run_evaluation || input.runEvaluation || { status: "pass" },
    workflow_state: workflowState
  };
}

function schedulerPlanOptionsFromRequest(req, item, selectedId, input = {}) {
  return {
    workflow_state_input_path: item.input_path,
    workbench_writeback_mode: "service",
    workbench_base_url: workbenchBaseUrlFromRequest(req),
    projection_id: selectedId,
    reviewer_mock_status: input.reviewer_mock_status || input.reviewerMockStatus,
    reviewer_mock_findings_json: input.reviewer_mock_findings_json || input.reviewerMockFindingsJson,
    next_step: input.next_step || input.nextStep
  };
}

function readEvents(eventsPath) {
  return readJson(eventsPath);
}

function appendEvent(eventsPath, event) {
  const ledger = readEvents(eventsPath);
  const nextLedger = {
    version: ledger.version || "operator-events.v1",
    events: [...(Array.isArray(ledger.events) ? ledger.events : []), event]
  };
  writeFileSync(eventsPath, `${JSON.stringify(nextLedger, null, 2)}\n`);
  return nextLedger;
}

function safeStaticPath(pathname) {
  const normalized = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const filePath = resolve(root, normalized.replace(/^[/\\]/, ""));

  if (!filePath.startsWith(root)) {
    return null;
  }

  return filePath;
}

export function createWorkbenchServer(options = {}) {
  const eventsPath = options.eventsPath || defaultEventsPath;
  const serverHistoryPath = options.historyPath || historyPath;
  const snapshotsRoot = resolve(options.snapshotsRoot || defaultSnapshotsRoot);
  const allowedHistoryRoots = [examplesRoot, snapshotsRoot];

  return createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    try {
      if (url.pathname === "/api/workbench/projection") {
        const { projection } = projectionById(url.searchParams.get("id"), readJson(serverHistoryPath), allowedHistoryRoots);
        jsonResponse(res, 200, projection);
        return;
      }

      if (url.pathname === "/api/workbench/projections") {
        const history = readJson(serverHistoryPath);
        jsonResponse(res, 200, projectionHistoryWithReadiness(history, allowedHistoryRoots));
        return;
      }

      if (url.pathname === "/api/workbench/snapshot" && req.method === "GET") {
        const history = readJson(serverHistoryPath);
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 404, { error: `snapshot input not found: ${selectedId}` });
          return;
        }
        jsonResponse(res, 200, readJson(historyItemPath(item.input_path, "input_path", allowedHistoryRoots)));
        return;
      }

      if (url.pathname === "/api/workbench/snapshots" && req.method === "POST") {
        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }
        const issues = snapshotIssues(input);
        if (issues.length > 0) {
          jsonResponse(res, 400, { error: "invalid workflow state snapshot", issues });
          return;
        }
        const result = publishWorkbenchSnapshot(input, {
          root,
          historyPath: serverHistoryPath,
          snapshotsRoot
        });
        if (result.status === "fail") {
          jsonResponse(res, 400, { error: "workflow state snapshot publish failed", issues: result.issues });
          return;
        }
        jsonResponse(res, 201, { status: result.status, item: result.item, projection: result.projection });
        return;
      }

      if (url.pathname === "/api/workbench/reviewer-provider-health" && req.method === "POST") {
        const history = readJson(serverHistoryPath);
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }

        const inputPath = historyItemPath(item.input_path, "input_path", allowedHistoryRoots);
        const workflowState = readJson(inputPath);
        const result = recordReviewerProviderHealthFact(workflowState, {
          request: workflowState.reviewer_gate?.request || workflowState.reviewerGate?.request || workflowState.reviewer_gate || workflowState.reviewerGate,
          smoke_status: input.smoke_status || input.smokeStatus || input.provider_smoke_status,
          tools: input.tools || input.allowed_tools || input.allowedTools,
          created_at: input.created_at
        });
        if (result.status !== "pass") {
          jsonResponse(res, 400, { error: "reviewer provider health record failed", issues: result.issues });
          return;
        }

        writeFileSync(inputPath, `${JSON.stringify({ ...workflowState, ...result.workflow_state }, null, 2)}\n`);
        jsonResponse(res, 201, {
          status: "created",
          item,
          fact: result.fact,
          projection: createWorkbenchProjection(result.workflow_state)
        });
        return;
      }

      if (url.pathname === "/api/workbench/reviewer-shard-result" && req.method === "POST") {
        const history = readJson(serverHistoryPath);
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }

        const inputPath = historyItemPath(item.input_path, "input_path", allowedHistoryRoots);
        const workflowState = readJson(inputPath);
        const result = recordReviewerShardResult(workflowState, {
          shard_id: input.shard_id || input.shardId,
          status: input.status,
          findings: input.findings || input.review_findings || [],
          created_at: input.created_at
        });
        if (result.status !== "pass") {
          jsonResponse(res, 400, { error: "reviewer shard result record failed", issues: result.issues });
          return;
        }

        let nextState = result.workflow_state;
        let aggregate = null;
        if (input.aggregate === true) {
          aggregate = recordReviewerShardAggregate(nextState, {
            created_at: input.aggregate_created_at || input.created_at
          });
          if (aggregate.status !== "pass") {
            jsonResponse(res, 400, { error: "reviewer shard aggregate record failed", issues: aggregate.issues });
            return;
          }
          nextState = aggregate.workflow_state;
        }

        writeFileSync(inputPath, `${JSON.stringify({ ...workflowState, ...nextState }, null, 2)}\n`);
        jsonResponse(res, 201, {
          status: "created",
          item,
          fact: result.fact,
          aggregate: aggregate?.fact || null,
          projection: createWorkbenchProjection(nextState)
        });
        return;
      }

      if (url.pathname === "/api/workbench/scheduler-dispatch-plan" && req.method === "POST") {
        const history = readJson(serverHistoryPath);
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }

        const inputPath = historyItemPath(item.input_path, "input_path", allowedHistoryRoots);
        const workflowState = readJson(inputPath);
        const plan = createSchedulerDispatchPlan(
          schedulerPlanInputFromWorkflowState(workflowState, input),
          schedulerPlanOptionsFromRequest(req, item, selectedId, input)
        );
        if (plan.status !== "pass") {
          jsonResponse(res, 400, { error: "scheduler dispatch plan failed", issues: plan.issues });
          return;
        }

        jsonResponse(res, 201, {
          status: "created",
          item,
          plan
        });
        return;
      }

      if (url.pathname === "/api/workbench/scheduler-dispatch" && req.method === "POST") {
        const history = readJson(serverHistoryPath);
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }
        const normalizedControl = normalizeSchedulerDispatchControlRequest(input);
        if (normalizedControl.status !== "pass") {
          jsonResponse(res, 400, { error: "scheduler dispatch control request rejected", issues: normalizedControl.issues });
          return;
        }
        const controlInput = normalizedControl.input;
        const inputPath = historyItemPath(item.input_path, "input_path", allowedHistoryRoots);
        const workflowState = readJson(inputPath);
        const plan = createSchedulerDispatchPlan(
          schedulerPlanInputFromWorkflowState(workflowState, controlInput),
          schedulerPlanOptionsFromRequest(req, item, selectedId, controlInput)
        );
        if (plan.status !== "pass") {
          jsonResponse(res, 400, { error: "scheduler dispatch plan failed", issues: plan.issues });
          return;
        }

        const policy = evaluateSchedulerDispatchControlPolicy(controlInput, plan);
        const policyRecorded = recordSchedulerDispatchPolicyDecision(workflowState, policy, {
          created_at: controlInput.created_at || controlInput.createdAt,
          plan
        });
        if (policyRecorded.status !== "pass") {
          jsonResponse(res, 400, { error: "scheduler dispatch policy record failed", issues: policyRecorded.issues });
          return;
        }
        writeFileSync(inputPath, `${JSON.stringify({ ...workflowState, ...policyRecorded.workflow_state }, null, 2)}\n`);

        if (policy.status !== "pass") {
          jsonResponse(res, 400, {
            error: "scheduler dispatch policy rejected",
            issues: policy.issues,
            policy,
            control: normalizedControl,
            artifact: policyRecorded.artifact,
            projection: createWorkbenchProjection(policyRecorded.workflow_state)
          });
          return;
        }

        const runResult = await runSchedulerDispatchPlan(plan, { dry_run: policy.execution_mode === "dry_run" });
        const runArtifact = createSchedulerDispatchRunArtifact(plan, runResult, {
          created_at: controlInput.created_at || controlInput.createdAt
        });
        const recorded = recordSchedulerDispatchRunArtifact(policyRecorded.workflow_state, runArtifact, {
          created_at: controlInput.created_at || controlInput.createdAt
        });
        if (recorded.status !== "pass") {
          jsonResponse(res, 400, { error: "scheduler dispatch run record failed", issues: recorded.issues });
          return;
        }

        let nextWorkflowState = recorded.workflow_state;
        let continuation = null;
        if (policy.execution_mode !== "dry_run") {
          continuation = prepareSchedulerDispatchContinuationFromRunArtifact(runArtifact);
          if (continuation.status !== "ready") {
            jsonResponse(res, 400, {
              error: "scheduler dispatch continuation preparation failed",
              issues: continuation.issues || [],
              continuation,
              projection: createWorkbenchProjection(nextWorkflowState)
            });
            return;
          }
          const continuationOutputPath = writePreparedSchedulerContinuation(runArtifact, continuation, [
            resolve(root, "tmp"),
            snapshotsRoot
          ]);
          const continuationRecorded = recordSchedulerDispatchContinuationPrepared(nextWorkflowState, continuation, {
            created_at: controlInput.created_at || controlInput.createdAt,
            source_artifact_id: recorded.artifact.id,
            continuation_input_path: metadataPath(continuationOutputPath)
          });
          if (continuationRecorded.status !== "pass") {
            jsonResponse(res, 400, { error: "scheduler dispatch continuation record failed", issues: continuationRecorded.issues });
            return;
          }
          nextWorkflowState = continuationRecorded.workflow_state;
        }

        writeFileSync(inputPath, `${JSON.stringify({ ...workflowState, ...nextWorkflowState }, null, 2)}\n`);
        jsonResponse(res, 201, {
          status: "created",
          item,
          plan,
          policy,
          control: normalizedControl,
          result: runResult,
          artifact: recorded.artifact,
          continuation,
          projection: createWorkbenchProjection(nextWorkflowState)
        });
        return;
      }

      if (url.pathname === "/api/workbench/scheduler-next-cycle" && req.method === "POST") {
        const history = readJson(serverHistoryPath);
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }

        const inputPath = historyItemPath(item.input_path, "input_path", allowedHistoryRoots);
        const workflowState = readJson(inputPath);
        const latestRun = latestSchedulerDispatchRun(workflowState);
        if (!latestRun.metadata) {
          jsonResponse(res, 400, { error: "scheduler dispatch run artifact not found" });
          return;
        }

        const continuation = prepareSchedulerDispatchContinuationFromRunArtifact(latestRun.metadata);
        if (continuation.status !== "ready") {
          jsonResponse(res, 400, {
            error: "scheduler dispatch continuation preparation failed",
            issues: continuation.issues || [],
            continuation
          });
          return;
        }

        let continuationOutputPath;
        let generatedInput;
        try {
          continuationOutputPath = safeGeneratedContinuationPath(
            schedulerContinuationOutputPath(latestRun.metadata),
            [resolve(root, "tmp"), snapshotsRoot]
          );
          generatedInput = readJson(continuationOutputPath);
        } catch (error) {
          if (error.code === "ENOENT") {
            jsonResponse(res, 400, { error: "scheduler dispatch generated continuation input not found" });
            return;
          }
          throw error;
        }
        const generatedIssues = generatedContinuationInputIssues(generatedInput, continuation);
        if (generatedIssues.length > 0) {
          jsonResponse(res, 400, { error: "generated continuation input validation failed", issues: generatedIssues });
          return;
        }

        const createdAt = input.created_at || input.createdAt;
        const sourceArtifactId = latestRun.artifact?.id || latestRun.event?.artifact_id;
        const continuationInputPath = metadataPath(continuationOutputPath);
        const existingContinuation = latestArtifactForEvent(workflowState, "scheduler_dispatch_continuation");
        const existingContinuationMatchesRun = existingContinuation.metadata?.status === "ready" &&
          existingContinuation.metadata?.source_artifact_id === sourceArtifactId &&
          existingContinuation.metadata?.continuation_input_path === continuationInputPath;
        const continuationRecorded = existingContinuationMatchesRun
          ? {
            status: "pass",
            artifact: existingContinuation.artifact,
            workflow_state: workflowState
          }
          : recordSchedulerDispatchContinuationPrepared(workflowState, continuation, {
            created_at: createdAt,
            source_artifact_id: sourceArtifactId,
            continuation_input_path: continuationInputPath
          });
        if (continuationRecorded.status !== "pass") {
          jsonResponse(res, 400, { error: "scheduler dispatch continuation record failed", issues: continuationRecorded.issues });
          return;
        }

        const requestedSnapshotId = normalizeString(input.snapshot_id || input.snapshotId);
        const snapshotId = requestedSnapshotId || `next-cycle-${selectedId}-${Date.now()}`;
        const enqueued = recordSchedulerNextCycleEnqueue(continuationRecorded.workflow_state, continuation, {
          created_at: createdAt,
          source_artifact_id: sourceArtifactId,
          continuation_artifact_id: continuationRecorded.artifact.id,
          continuation_input_path: continuationInputPath,
          snapshot_id: snapshotId
        });
        if (enqueued.status !== "pass") {
          jsonResponse(res, 400, { error: "scheduler next cycle enqueue record failed", issues: enqueued.issues });
          return;
        }

        const published = publishWorkbenchSnapshot({
          id: snapshotId,
          label: input.label || `Next cycle from ${selectedId}`,
          input: generatedInput.workflow_state,
          created_at: createdAt
        }, {
          root,
          historyPath: serverHistoryPath,
          snapshotsRoot
        });
        if (published.status === "fail") {
          jsonResponse(res, 400, { error: "scheduler next cycle snapshot publish failed", issues: published.issues });
          return;
        }

        writeFileSync(inputPath, `${JSON.stringify({ ...workflowState, ...enqueued.workflow_state }, null, 2)}\n`);

        jsonResponse(res, 201, {
          status: "queued",
          item,
          continuation,
          continuation_artifact: continuationRecorded.artifact,
          enqueue_artifact: enqueued.artifact,
          next_item: published.item,
          projection: published.projection,
          current_projection: createWorkbenchProjection(enqueued.workflow_state)
        });
        return;
      }

      if (url.pathname === "/api/workbench/autonomous-scheduler-loop" && req.method === "POST") {
        const history = readJson(serverHistoryPath);
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }

        const maxIterations = Number(input.max_iterations || input.maxIterations || 1);
        const loopInput = {
          start_projection_id: selectedId,
          max_iterations: maxIterations,
          execution_profile: input.execution_profile || input.executionProfile || "approved_mock_non_dry_run",
          snapshot_prefix: input.snapshot_prefix || input.snapshotPrefix || "autonomous-loop",
          created_at: input.created_at || input.createdAt
        };
        const loopResult = await runSchedulerLoopDriver(loopInput, {
          client: createWorkbenchLoopClient(workbenchBaseUrlFromRequest(req))
        });
        const loopArtifact = createSchedulerLoopRunArtifact(loopInput, loopResult, {
          created_at: input.created_at || input.createdAt
        });

        const inputPath = historyItemPath(item.input_path, "input_path", allowedHistoryRoots);
        const latestWorkflowState = readJson(inputPath);
        const recorded = recordAutonomousSchedulerLoopRunArtifact(latestWorkflowState, loopArtifact, {
          created_at: input.created_at || input.createdAt
        });
        if (recorded.status !== "pass") {
          jsonResponse(res, 400, { error: "autonomous scheduler loop record failed", issues: recorded.issues });
          return;
        }
        writeFileSync(inputPath, `${JSON.stringify({ ...latestWorkflowState, ...recorded.workflow_state }, null, 2)}\n`);

        jsonResponse(res, loopResult.status === "pass" ? 201 : 400, {
          status: loopResult.status === "pass" ? "created" : "failed",
          item,
          result: loopResult,
          artifact: recorded.artifact,
          projection: createWorkbenchProjection(recorded.workflow_state)
        });
        return;
      }

      if (url.pathname === "/api/workbench/scheduler-dispatch-run" && req.method === "POST") {
        const history = readJson(serverHistoryPath);
        const selectedId = url.searchParams.get("id") || history.latest;
        const item = history.items.find((entry) => entry.id === selectedId);
        if (!item?.input_path) {
          jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
          return;
        }

        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }

        const issues = schedulerDispatchRunIssues(input);
        if (issues.length > 0) {
          jsonResponse(res, 400, { error: "invalid scheduler dispatch run artifact", issues });
          return;
        }

        const inputPath = historyItemPath(item.input_path, "input_path", allowedHistoryRoots);
        const workflowState = readJson(inputPath);
        const result = recordSchedulerDispatchRunArtifact(
          workflowState,
          schedulerDispatchRunArtifactFromInput(input),
          { created_at: input.created_at }
        );
        if (result.status !== "pass") {
          jsonResponse(res, 400, { error: "scheduler dispatch run record failed", issues: result.issues });
          return;
        }

        writeFileSync(inputPath, `${JSON.stringify({ ...workflowState, ...result.workflow_state }, null, 2)}\n`);
        jsonResponse(res, 201, {
          status: "created",
          item,
          artifact: result.artifact,
          projection: createWorkbenchProjection(result.workflow_state)
        });
        return;
      }

      if (url.pathname === "/api/workbench/events" && req.method === "GET") {
        jsonResponse(res, 200, readEvents(eventsPath));
        return;
      }

      if (url.pathname === "/api/workbench/events" && req.method === "POST") {
        const body = await readBody(req);
        let input = {};
        try {
          input = body ? JSON.parse(body) : {};
        } catch {
          jsonResponse(res, 400, { error: "invalid json" });
          return;
        }
        const issues = operatorEventIssues(input);
        if (issues.length > 0) {
          jsonResponse(res, 400, { error: "invalid operator event", issues });
          return;
        }
        const event = normalizeEvent(input, url.searchParams.get("projection_id"));
        const ledger = appendEvent(eventsPath, event);
        jsonResponse(res, 201, { status: "created", event, count: ledger.events.length });
        return;
      }

      const staticPath = safeStaticPath(url.pathname === "/" ? "/apps/workbench/desktop.html" : url.pathname);
      if (!staticPath) {
        jsonResponse(res, 403, { error: "forbidden" });
        return;
      }

      const content = readFileSync(staticPath);
      res.writeHead(200, {
        "content-type": MIME_TYPES[extname(staticPath)] || "application/octet-stream",
        "cache-control": "no-store"
      });
      res.end(content);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "PROJECTION_NOT_FOUND") {
        jsonResponse(res, 404, { error: error.message });
        return;
      }

      if (error.code === "INVALID_HISTORY_PATH") {
        jsonResponse(res, 400, { error: error.message });
        return;
      }

      if (error.code === "INVALID_WORKBENCH_HOST") {
        jsonResponse(res, 400, { error: error.message });
        return;
      }

      if (error.code === "INVALID_CONTINUATION_PATH") {
        jsonResponse(res, 400, { error: error.message });
        return;
      }

      jsonResponse(res, 500, { error: error.message });
    }
  });
}

export function startWorkbenchServer({ port = 4180, host = "127.0.0.1" } = {}) {
  const server = createWorkbenchServer();
  server.listen(port, host);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || process.argv[2] || 4180);
  const server = startWorkbenchServer({ port });
  server.on("listening", () => {
    const address = server.address();
    console.log(`Workbench server listening on http://${address.address}:${address.port}`);
  });
}
