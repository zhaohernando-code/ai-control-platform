import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join, relative } from "node:path";
import test from "node:test";

import { createWorkbenchServer } from "../tools/workbench-server.mjs";
import {
  createSqliteWorkbenchStateStore,
  isSqliteSnapshotPath
} from "../src/workflow/workbench-state-store.js";
import { currentSessionWorkflowState } from "./helpers/current-session-workflow-state.js";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function request(url, options = {}) {
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
          body,
          json() {
            return body ? JSON.parse(body) : null;
          }
        });
      });
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test("sqlite workbench state store seeds tracked fixtures into database snapshots", () => {
  mkdirSync("tmp", { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), "tmp/workbench-state-store-"));
  const seedRoot = dir;
  const snapshotsRoot = join(dir, "snapshots");
  const inputPath = join(snapshotsRoot, "seed.workbench-input.json");
  const historyPath = join(dir, "projection-history.json");
  const projectStatusPath = join(dir, "PROJECT_STATUS.json");
  const eventsPath = join(dir, "operator-events.json");
  const workflowState = readJson("docs/examples/current-session-workbench-input.json");
  const projectStatus = {
    project: "ai-control-platform",
    status: "in_progress",
    updated_at: "2026-05-26T00:00:00.000Z",
    global_goals: []
  };
  const events = { version: "operator-events.v1", events: [] };

  mkdirSync(snapshotsRoot, { recursive: true });
  writeFileSync(inputPath, `${JSON.stringify(workflowState, null, 2)}\n`);
  writeFileSync(historyPath, `${JSON.stringify({
    version: "projection-history.v1",
    latest: "legacy-projection",
    items: [
      {
        id: "legacy-projection",
        label: "Legacy projection",
        input_path: null,
        projection_path: "docs/examples/bootstrap-workbench-projection.json",
        created_at: "2026-05-25T00:00:00.000Z",
        status: "pass"
      },
      {
        id: "seed",
        label: "Seed",
        input_path: relative(seedRoot, inputPath),
        projection_path: null,
        created_at: "2026-05-26T00:00:00.000Z",
        status: "pass"
      }
    ]
  }, null, 2)}\n`);
  writeFileSync(projectStatusPath, `${JSON.stringify(projectStatus, null, 2)}\n`);
  writeFileSync(eventsPath, `${JSON.stringify(events, null, 2)}\n`);
  const originalHistoryFile = readFileSync(historyPath, "utf8");
  const originalProjectFile = readFileSync(projectStatusPath, "utf8");
  const originalEventsFile = readFileSync(eventsPath, "utf8");

  const store = createSqliteWorkbenchStateStore({
    dbPath: join(dir, "workbench-state.sqlite"),
    seedRoot,
    seedHistoryPath: historyPath,
    seedProjectStatusPath: projectStatusPath,
    seedEventsPath: eventsPath
  });
  const history = store.readHistory();

  assert.equal(existsSync(store.dbPath), true);
  assert.equal(history.latest, "seed");
  assert.deepEqual(history.items.map((item) => item.id), ["seed"]);
  assert.equal(isSqliteSnapshotPath(history.items[0].input_path), true);
  assert.equal(store.readWorkflowSnapshot("seed").manifest.run_id, workflowState.manifest.run_id);

  store.writeProjectStatus({ ...projectStatus, status: "rerun" });
  store.writeEvents({ version: "operator-events.v1", events: [{ id: "event-1", type: "validate" }] });
  store.writeWorkflowSnapshot("seed", {
    ...workflowState,
    generated_at: "2026-05-26T01:00:00.000Z"
  }, history.items[0]);

  assert.equal(readFileSync(historyPath, "utf8"), originalHistoryFile);
  assert.equal(readFileSync(projectStatusPath, "utf8"), originalProjectFile);
  assert.equal(readFileSync(eventsPath, "utf8"), originalEventsFile);
  assert.equal(store.readProjectStatus().status, "rerun");
  assert.equal(store.readEvents().events[0].id, "event-1");
  assert.equal(store.readWorkflowSnapshot("seed").generated_at, "2026-05-26T01:00:00.000Z");
});

test("workbench server state-db mode keeps live writes out of seeded json files", async () => {
  mkdirSync("tmp", { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), "tmp/workbench-state-server-"));
  const seedRoot = dir;
  const snapshotsRoot = join(dir, "snapshots");
  const inputPath = join(snapshotsRoot, "seed.workbench-input.json");
  const historyPath = join(dir, "projection-history.json");
  const projectStatusPath = join(dir, "PROJECT_STATUS.json");
  const eventsPath = join(dir, "operator-events.json");
  const stateDbPath = join(dir, "workbench-state.sqlite");
  const workflowState = readJson("docs/examples/current-session-workbench-input.json");

  mkdirSync(snapshotsRoot, { recursive: true });
  writeFileSync(inputPath, `${JSON.stringify(workflowState, null, 2)}\n`);
  writeFileSync(historyPath, `${JSON.stringify({
    version: "projection-history.v1",
    latest: "seed",
    items: [{
      id: "seed",
      label: "Seed",
      input_path: relative(seedRoot, inputPath),
      projection_path: null,
      created_at: "2026-05-26T00:00:00.000Z",
      status: "pass"
    }]
  }, null, 2)}\n`);
  writeFileSync(projectStatusPath, `${JSON.stringify({ project: "ai-control-platform", status: "in_progress" }, null, 2)}\n`);
  writeFileSync(eventsPath, `${JSON.stringify({ version: "operator-events.v1", events: [] }, null, 2)}\n`);
  const originals = {
    history: readFileSync(historyPath, "utf8"),
    projectStatus: readFileSync(projectStatusPath, "utf8"),
    events: readFileSync(eventsPath, "utf8"),
    input: readFileSync(inputPath, "utf8")
  };

  const server = createWorkbenchServer({
    historyPath,
    snapshotsRoot,
    eventsPath,
    projectStatusPath,
    stateDbPath
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();

  try {
    const eventResponse = await request(`http://127.0.0.1:${port}/api/workbench/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "validate",
        run_id: workflowState.manifest.run_id,
        cycle_id: workflowState.manifest.cycle_id,
        created_at: "2026-05-26T01:00:00.000Z"
      })
    });
    const snapshotResponse = await request(`http://127.0.0.1:${port}/api/workbench/snapshots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "posted-snapshot",
        label: "Posted snapshot",
        input: workflowState,
        created_at: "2026-05-26T01:01:00.000Z"
      })
    });
    const history = (await request(`http://127.0.0.1:${port}/api/workbench/projections`)).json();

    assert.equal(eventResponse.status, 201);
    assert.equal(snapshotResponse.status, 201);
    assert.equal(history.latest, "posted-snapshot");
    assert.equal(isSqliteSnapshotPath(history.items[0].input_path), true);
    assert.equal(readFileSync(historyPath, "utf8"), originals.history);
    assert.equal(readFileSync(projectStatusPath, "utf8"), originals.projectStatus);
    assert.equal(readFileSync(eventsPath, "utf8"), originals.events);
    assert.equal(readFileSync(inputPath, "utf8"), originals.input);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("workbench state-db projection preserves historical task items when latest status is narrower", async () => {
  mkdirSync("tmp", { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), "tmp/workbench-state-history-"));
  const store = createSqliteWorkbenchStateStore({
    dbPath: join(dir, "workbench-state.sqlite")
  });
  const baseWorkflowState = currentSessionWorkflowState({ withoutRequirementIntake: true });
  const historicalProjectStatus = {
    project: "ai-control-platform",
    status: "in_progress",
    updated_at: "2026-05-28T12:17:35.134Z",
    requirement_intake: {
      items: [
        {
          id: "requirement-tab-20260528064224",
          title: "完成“项目”tab",
          project_id: "ai-control-platform",
          status: "submitted",
          submitted_at: "2026-05-28T06:42:24.931Z",
          problem_statement: "项目 tab 需要接入项目治理。"
        }
      ],
      latest_requirement_id: "requirement-tab-20260528064224"
    },
    plan_reviews: {
      "requirement-tab-20260528064224": {
        id: "plan-review-requirement-tab-20260528064224",
        requirement_id: "requirement-tab-20260528064224",
        requirement_title: "完成“项目”tab",
        phase: "in_development",
        status: "approved"
      }
    },
    global_goals: [
      {
        id: "requirement-tab-20260528064224",
        title: "完成“项目”tab",
        status: "in_progress"
      }
    ],
    next_work_packages: [
      {
        id: "requirement-tab-20260528064224-plan-step-02",
        title: "完成“项目”tab：实施步骤 02 / 6",
        action: "execute_requirement_plan_step",
        status: "failed",
        global_goal_id: "requirement-tab-20260528064224",
        source: { requirement_id: "requirement-tab-20260528064224" }
      }
    ]
  };
  const narrowProjectStatus = {
    project: "ai-control-platform",
    status: "in_progress",
    updated_at: "2026-05-29T05:25:14.507Z",
    requirement_intake: {
      items: [
        {
          id: "requirement-unknown-20260526033003",
          title: "前端重构",
          project_id: "ai-control-platform",
          status: "completed",
          submitted_at: "2026-05-26T03:30:03.063Z"
        }
      ],
      latest_requirement_id: "requirement-unknown-20260526033003"
    },
    global_goals: []
  };
  const oldItem = {
    id: "old-with-project-tab",
    label: "Old with project tab",
    input_path: "sqlite://workflow-snapshot/old-with-project-tab",
    projection_path: null,
    created_at: "2026-05-28T12:17:35.134Z",
    status: "pass"
  };
  const latestItem = {
    id: "latest-narrow",
    label: "Latest narrow",
    input_path: "sqlite://workflow-snapshot/latest-narrow",
    projection_path: null,
    created_at: "2026-05-29T05:25:14.507Z",
    status: "pass"
  };
  store.writeWorkflowSnapshot("old-with-project-tab", {
    ...baseWorkflowState,
    project_status: historicalProjectStatus,
    global_goals: historicalProjectStatus.global_goals
  }, oldItem);
  store.writeWorkflowSnapshot("latest-narrow", {
    ...baseWorkflowState,
    project_status: narrowProjectStatus,
    global_goals: narrowProjectStatus.global_goals
  }, latestItem);
  store.writeHistory({
    version: "projection-history.v1",
    latest: "latest-narrow",
    items: [latestItem, oldItem]
  });
  store.writeProjectStatus(narrowProjectStatus);

  const server = createWorkbenchServer({
    stateStore: store,
    projectStatusPath: null
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();

  try {
    const response = await request(`http://127.0.0.1:${port}/api/workbench/projection`);
    const projection = response.json();
    const taskIds = projection.project_management.task_items.map((task) => task.task_id);

    assert.equal(response.status, 200);
    assert.ok(taskIds.includes("requirement-tab-20260528064224"));
    assert.ok(taskIds.includes("requirement-unknown-20260526033003"));
    assert.equal(
      projection.project_management.task_items.find((task) => task.task_id === "requirement-tab-20260528064224").failure_reason,
      "完成“项目”tab：实施步骤 02 / 6 执行失败"
    );
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("workbench server state-db mode rejects projection-only history fallback", async () => {
  mkdirSync("tmp", { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), "tmp/workbench-state-no-fallback-"));
  const store = createSqliteWorkbenchStateStore({
    dbPath: join(dir, "workbench-state.sqlite")
  });
  store.writeHistory({
    version: "projection-history.v1",
    latest: "legacy",
    items: [{
      id: "legacy",
      label: "Legacy projection",
      input_path: null,
      projection_path: "docs/examples/bootstrap-workbench-projection.json",
      created_at: "2026-05-25T00:00:00.000Z",
      status: "pass"
    }]
  });

  const server = createWorkbenchServer({
    stateStore: store,
    projectStatusPath: null
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();

  try {
    const response = await request(`http://127.0.0.1:${port}/api/workbench/projection?id=legacy`);
    assert.equal(response.status, 400);
    assert.match(response.json().error, /requires workflow snapshots/);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("workbench server refuses implicit json state mode", () => {
  assert.throws(
    () => createWorkbenchServer({ historyPath: "docs/examples/projection-history.json" }),
    /requires SQLite/
  );
});
