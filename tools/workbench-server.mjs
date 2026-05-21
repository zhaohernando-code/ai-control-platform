#!/usr/bin/env node
import { createServer } from "node:http";
import { extname, normalize, resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

const root = resolve(process.cwd());
const historyPath = resolve(root, "docs/examples/projection-history.json");
const defaultEventsPath = resolve(root, "docs/examples/operator-events.json");

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

function projectionById(id = null) {
  const history = readJson(historyPath);
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
    projection: readJson(resolve(root, item.projection_path))
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

  return createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    try {
      if (url.pathname === "/api/workbench/projection") {
        const { projection } = projectionById(url.searchParams.get("id"));
        jsonResponse(res, 200, projection);
        return;
      }

      if (url.pathname === "/api/workbench/projections") {
        const history = readJson(historyPath);
        jsonResponse(res, 200, history);
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
