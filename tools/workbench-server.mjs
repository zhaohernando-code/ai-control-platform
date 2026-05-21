#!/usr/bin/env node
import { createServer } from "node:http";
import { extname, isAbsolute, normalize, resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

import { createWorkbenchProjection } from "../src/workflow/workbench-projection.js";
import { publishWorkbenchSnapshot, snapshotIssues } from "../src/workflow/workbench-snapshots.js";
import { recordReviewerProviderHealthFact } from "../src/workflow/reviewer-provider-health.js";
import {
  recordReviewerShardAggregate,
  recordReviewerShardResult
} from "../src/workflow/reviewer-shard-results.js";
import { recordSchedulerDispatchRunArtifact } from "../src/workflow/scheduler-dispatch-runner.js";

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
        jsonResponse(res, 200, history);
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
