import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createWorkbenchServer } from "./workbench-server.mjs";

export const WORKBENCH_MOUNT_PREFIX = "/projects/ai-control-platform";

const NEXT_READY_TIMEOUT_MS = 90000;

function valueAfter(flag, args = process.argv.slice(2)) {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : "";
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function requestText(url) {
  return new Promise((resolveRequest, reject) => {
    const req = httpRequest(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolveRequest({
        status: res.statusCode || 0,
        headers: res.headers,
        body
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function listenServer(server) {
  const listening = once(server, "listening");
  const errored = once(server, "error").then(([error]) => {
    throw error;
  });
  server.listen(0, "127.0.0.1");
  await Promise.race([listening, errored]);
  return server.address().port;
}

async function closeServer(server) {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

async function waitForNextRoute(baseUrl, child) {
  const deadline = Date.now() + NEXT_READY_TIMEOUT_MS;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Next.js process exited before serving route: ${child.exitCode}`);
    }
    try {
      const response = await requestText(`${baseUrl}${WORKBENCH_MOUNT_PREFIX}/`);
      if (response.status >= 200 && response.status < 400) return response;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await sleep(500);
  }
  throw new Error(`Next.js route was not ready within ${NEXT_READY_TIMEOUT_MS}ms: ${lastError}`);
}

async function startNextServer({ apiPort, nextPort }) {
  const nextDir = resolve("apps/workbench");
  const nextBin = resolve(nextDir, "node_modules/next/dist/bin/next");
  const env = {
    ...process.env,
    WORKBENCH_MOUNT_PREFIX,
    WORKBENCH_API_BASE: WORKBENCH_MOUNT_PREFIX,
    WORKBENCH_API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`
  };
  const child = spawn(process.execPath, [
    nextBin,
    "dev",
    "-H",
    "127.0.0.1",
    "-p",
    String(nextPort)
  ], {
    cwd: nextDir,
    env,
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

  const baseUrl = `http://127.0.0.1:${nextPort}`;
  try {
    await waitForNextRoute(baseUrl, child);
  } catch (error) {
    child.kill("SIGTERM");
    throw new Error(`${error.message}\nstdout:\n${stdout.slice(-4000)}\nstderr:\n${stderr.slice(-4000)}`);
  }

  return {
    baseUrl,
    child,
    logs: () => ({ stdout, stderr })
  };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    sleep(5000).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    })
  ]);
}

export async function withRuntime(fn, options = {}) {
  mkdirSync("tmp", { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-next-served-route-"));
  const server = createWorkbenchServer({
    eventsPath: options.eventsPath || join(dir, "operator-events.json"),
    historyPath: options.historyPath || "docs/examples/projection-history.json",
    snapshotsRoot: options.snapshotsRoot || "docs/examples",
    projectStatusPath: Object.hasOwn(options, "projectStatusPath") ? options.projectStatusPath : "PROJECT_STATUS.json",
    stateDbPath: options.stateDbPath || join(dir, "workbench-state.sqlite"),
    realReviewerExecutor: options.realReviewerExecutor
  });
  const apiPort = await listenServer(server);
  const nextPort = Number(valueAfter("--port")) || 4191;
  let nextRuntime = null;
  try {
    nextRuntime = await startNextServer({ apiPort, nextPort });
    return await fn({ ...nextRuntime, apiPort, nextPort });
  } finally {
    if (nextRuntime) await stopChild(nextRuntime.child);
    await closeServer(server);
  }
}
