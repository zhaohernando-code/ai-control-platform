import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import {
  createSchedulerDispatchRunArtifact,
  runSchedulerDispatchPlan
} from "../src/workflow/scheduler-dispatch-runner.js";
import { createSchedulerDispatchPlan } from "../src/workflow/scheduler-dispatch-plan.js";
import { createWorkbenchServer } from "../tools/workbench-server.mjs";

async function withServer(fn, options = {}) {
  const server = createWorkbenchServer(options);
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

function runNode(args, options = {}) {
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

test("workbench server returns latest projection", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/projection`);
    const projection = response.json();

    assert.equal(response.status, 200);
    assert.equal(projection.projection_version, "workbench.v1");
    assert.equal(projection.run_id, "run-20260521-platform-self-trial");
    assert.equal(projection.operator_events.status, "pass");
    assert.equal(projection.operator_events.applied_artifacts, 1);
    assert.equal(projection.manifest.event_count, 5);
    assert.equal(projection.artifacts.total, 5);
    assert.equal(projection.reviewer_provider_health.provider_health, "healthy");
    assert.equal(projection.reviewer_scope_split.shard_count, 2);
  });
});

test("workbench server builds latest projection from workflow state input", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/projection`);
    const projection = response.json();

    assert.equal(response.status, 200);
    assert.equal(projection.operator_events.event_count, 1);
    assert.equal(projection.artifacts.by_type.evaluation, 3);
    assert.equal(projection.autonomous_run.summaries.artifacts.total, 5);
    assert.equal(projection.reviewer_provider_health.next_action, "rerun_without_tools");
    assert.equal(projection.reviewer_scope_split.next_shard, "reviewer-scope-shard-001");
  });
});

test("workbench server returns projection history index", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/projections`);
    const history = response.json();

    assert.equal(response.status, 200);
    assert.equal(history.version, "projection-history.v1");
    assert.equal(history.latest, "current-session");
    assert.equal(history.items.length, 2);
  });
});

test("workbench server returns selected historical projection", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/projection?id=bootstrap`);
    const projection = response.json();

    assert.equal(response.status, 200);
    assert.equal(projection.run_id, "run-20260521-platform-bootstrap");
    assert.equal(projection.status, "pass");
  });
});

test("workbench server prefers input snapshot over static projection path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-history-"));
  const historyPath = join(dir, "projection-history.json");
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "diverged",
    items: [
      {
        id: "diverged",
        label: "Diverged",
        input_path: "docs/examples/current-session-workbench-input.json",
        projection_path: "docs/examples/bootstrap-workbench-projection.json"
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/projection`);
    const projection = response.json();

    assert.equal(response.status, 200);
    assert.equal(projection.run_id, "run-20260521-platform-self-trial");
    assert.equal(projection.operator_events.status, "pass");
  }, { historyPath });
});

test("workbench server rejects projection history paths outside examples", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-history-"));
  const historyPath = join(dir, "projection-history.json");
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "escape",
    items: [
      {
        id: "escape",
        label: "Escape",
        input_path: "../package.json",
        projection_path: "docs/examples/current-session-workbench-projection.json"
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/projection`);
    const body = response.json();

    assert.equal(response.status, 400);
    assert.match(body.error, /input_path must stay under allowed workbench history roots/);
  }, { historyPath });
});

test("workbench server persists workflow state snapshots and updates history", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-snapshots-"));
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-history-"));
  const historyPath = join(dir, "projection-history.json");
  writeFileSync(historyPath, JSON.stringify({ version: "projection-history.v1", latest: null, items: [] }));
  const workflowState = JSON.parse(readFileSync("docs/examples/current-session-workbench-input.json", "utf8"));

  await withServer(async (baseUrl) => {
    const createResponse = await request(`${baseUrl}/api/workbench/snapshots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "posted-snapshot",
        label: "Posted snapshot",
        input: workflowState,
        created_at: "2026-05-21T09:00:00.000Z"
      })
    });
    const created = createResponse.json();
    const history = (await request(`${baseUrl}/api/workbench/projections`)).json();
    const projection = (await request(`${baseUrl}/api/workbench/projection?id=posted-snapshot`)).json();
    const snapshot = (await request(`${baseUrl}/api/workbench/snapshot?id=posted-snapshot`)).json();

    assert.equal(createResponse.status, 201);
    assert.equal(created.status, "created");
    assert.equal(created.item.id, "posted-snapshot");
    assert.match(created.item.input_path, /^tmp\/workbench-server-snapshots-/);
    assert.equal(history.latest, "posted-snapshot");
    assert.equal(projection.run_id, "run-20260521-platform-self-trial");
    assert.equal(projection.operator_events.status, "pass");
    assert.equal(snapshot.manifest.run_id, "run-20260521-platform-self-trial");
  }, { historyPath, snapshotsRoot });
});

test("workbench server records reviewer provider health into workflow state input", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-provider-health-"));
  const inputPath = join(snapshotsRoot, "provider-health-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = JSON.parse(readFileSync("docs/examples/current-session-workbench-input.json", "utf8"));
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "provider-health",
    items: [
      {
        id: "provider-health",
        label: "Provider health",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/reviewer-provider-health`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        smoke_status: "timeout",
        tools: ["Read", "Grep"],
        created_at: "2026-05-21T12:20:00.000Z"
      })
    });
    const created = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.status, "created");
    assert.equal(created.fact.provider_health, "unhealthy");
    assert.equal(created.fact.scheduled_actions[0], "fallback_model_or_defer_external_review");
    assert.equal(created.projection.reviewer_provider_health.provider_health, "unhealthy");
    assert.equal(state.manifest.events.at(-1).type, "reviewer_provider_health");
    assert.equal(state.artifact_ledger.artifacts.at(-1).metadata.provider_health, "unhealthy");
  }, { historyPath, snapshotsRoot });
});

test("workbench server rejects provider health recording without workflow state input", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/reviewer-provider-health?id=bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ smoke_status: "pass" })
    });
    const rejected = response.json();

    assert.equal(response.status, 400);
    assert.match(rejected.error, /workflow state input not found/);
  });
});

test("workbench server records reviewer shard results into workflow state input", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-shard-result-"));
  const inputPath = join(snapshotsRoot, "shard-result-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = JSON.parse(readFileSync("docs/examples/current-session-workbench-input.json", "utf8"));
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "shard-result",
    items: [
      {
        id: "shard-result",
        label: "Shard result",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const first = await request(`${baseUrl}/api/workbench/reviewer-shard-result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shard_id: "reviewer-scope-shard-001",
        status: "pass",
        created_at: "2026-05-21T12:30:00.000Z"
      })
    });
    const second = await request(`${baseUrl}/api/workbench/reviewer-shard-result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shard_id: "reviewer-scope-shard-002",
        findings: [
          {
            id: "api-shard-finding",
            status: "fail",
            severity: "medium",
            category: "reviewer",
            message: "api shard finding"
          }
        ],
        aggregate: true,
        created_at: "2026-05-21T12:31:00.000Z"
      })
    });
    const created = second.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(created.aggregate.status, "fail");
    assert.equal(created.projection.reviewer_shard_review.completed_shards, 2);
    assert.equal(created.projection.reviewer_shard_review.failed_finding_count, 1);
    assert.equal(state.manifest.events.at(-1).type, "reviewer_shard_aggregate");
    assert.ok(state.manifest.review_findings.some((finding) => finding.finding_id === "api-shard-finding"));
  }, { historyPath, snapshotsRoot });
});

test("workbench server creates scheduler dispatch plans from projection history input", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-scheduler-plan-"));
  const inputPath = join(snapshotsRoot, "scheduler-plan-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = JSON.parse(readFileSync("docs/examples/current-session-workbench-input.json", "utf8"));
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "scheduler-plan",
    items: [
      {
        id: "scheduler-plan",
        label: "Scheduler plan",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-dispatch-plan?id=scheduler-plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        next_step: "Continue from generated scheduler plan.",
        reviewer_mock_status: "pass"
      })
    });
    const created = response.json();

    assert.equal(response.status, 201);
    assert.equal(created.status, "created");
    assert.equal(created.plan.status, "pass");
    assert.equal(created.plan.writeback.mode, "service");
    assert.equal(created.plan.writeback.base_url, baseUrl);
    assert.equal(created.plan.writeback.projection_id, "scheduler-plan");
    assert.ok(created.plan.steps[0].args.includes(relative(process.cwd(), inputPath)));
    assert.ok(created.plan.steps[0].args.includes("--mock-status"));
  }, { historyPath, snapshotsRoot });
});

test("workbench server runs guarded scheduler dispatch dry-run from projection history input", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-scheduler-control-"));
  const inputPath = join(snapshotsRoot, "scheduler-control-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = JSON.parse(readFileSync("docs/examples/current-session-workbench-input.json", "utf8"));
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "scheduler-control",
    items: [
      {
        id: "scheduler-control",
        label: "Scheduler control",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-dispatch?id=scheduler-control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dry_run: true })
    });
    const created = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.status, "created");
    assert.equal(created.policy.execution_mode, "dry_run");
    assert.equal(created.result.status, "pass");
    assert.equal(created.projection.scheduler_dispatch.status, "pass");
    assert.equal(created.projection.scheduler_dispatch.policy_status, "pass");
    assert.equal(created.projection.scheduler_dispatch.policy_execution_mode, "dry_run");
    assert.equal(created.projection.scheduler_dispatch.step_count, 3);
    assert.equal(state.manifest.events.at(-2).type, "scheduler_dispatch_policy");
    assert.equal(state.manifest.events.at(-1).type, "scheduler_dispatch_run");
  }, { historyPath, snapshotsRoot });
});

test("workbench server runs approved mocked non-dry-run scheduler dispatch from profile", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-scheduler-approved-mock-"));
  const inputPath = join(snapshotsRoot, "scheduler-approved-mock-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = JSON.parse(readFileSync("docs/examples/current-session-workbench-input.json", "utf8"));
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "scheduler-approved-mock",
    items: [
      {
        id: "scheduler-approved-mock",
        label: "Scheduler approved mock",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-dispatch?id=scheduler-approved-mock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        execution_profile: "approved_mock_non_dry_run",
        created_at: "2026-05-22T00:10:00.000Z"
      })
    });
    const created = response.json();
    const historyReady = (await request(`${baseUrl}/api/workbench/projections`)).json();
    const readyItem = historyReady.items.find((entry) => entry.id === "scheduler-approved-mock");
    const nextCycle = await request(`${baseUrl}/api/workbench/scheduler-next-cycle?id=scheduler-approved-mock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        snapshot_id: "scheduler-approved-mock-next",
        label: "Scheduler approved mock next",
        created_at: "2026-05-22T00:11:00.000Z"
      })
    });
    const queued = nextCycle.json();
    const historyQueued = (await request(`${baseUrl}/api/workbench/projections`)).json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.control.input.execution_profile, "approved_mock_non_dry_run");
    assert.equal(created.policy.execution_mode, "execute");
    assert.equal(created.policy.controls.max_external_reviewer_calls, 0);
    assert.equal(created.result.status, "pass");
    assert.equal(created.projection.scheduler_dispatch.dry_run, false);
    assert.equal(created.projection.scheduler_dispatch.policy_execution_mode, "execute");
    assert.equal(created.projection.scheduler_dispatch.next_continuation_action, "rerun");
    assert.equal(created.projection.scheduler_dispatch.next_work_package_count, 3);
    assert.equal(created.projection.scheduler_continuation.ready, true);
    assert.equal(created.projection.scheduler_continuation.next_work_package_count, 3);
    assert.equal(readyItem.scheduler_dispatch.continuation_ready, true);
    assert.equal(readyItem.scheduler_dispatch.enqueue_available, true);
    assert.equal(readyItem.scheduler_dispatch.next_work_package_count, 3);
    assert.equal(nextCycle.status, 201);
    assert.equal(queued.status, "queued");
    assert.equal(queued.next_item.id, "scheduler-approved-mock-next");
    assert.equal(queued.projection.scheduler_continuation.status, "not_configured");
    assert.equal(queued.current_projection.scheduler_continuation.enqueue_status, "queued");
    assert.equal(historyQueued.latest, "scheduler-approved-mock-next");
    assert.equal(state.manifest.events.at(-4).type, "scheduler_dispatch_policy");
    assert.equal(state.manifest.events.at(-3).type, "scheduler_dispatch_run");
    assert.equal(state.manifest.events.at(-2).type, "scheduler_dispatch_continuation");
    assert.equal(state.manifest.events.at(-1).type, "scheduler_next_cycle_enqueue");
  }, { historyPath, snapshotsRoot });
});

test("workbench server rejects scheduler next-cycle without workflow state input", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-next-cycle?id=bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    const rejected = response.json();

    assert.equal(response.status, 400);
    assert.match(rejected.error, /workflow state input not found/);
  });
});

test("workbench server rejects scheduler next-cycle without dispatch run artifact", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-next-cycle-missing-"));
  const inputPath = join(snapshotsRoot, "next-cycle-missing-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = JSON.parse(readFileSync("docs/examples/current-session-workbench-input.json", "utf8"));
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "next-cycle-missing",
    items: [
      {
        id: "next-cycle-missing",
        label: "Next cycle missing",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-next-cycle?id=next-cycle-missing`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ snapshot_id: "next-cycle-missing-output" })
    });
    const rejected = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 400);
    assert.equal(rejected.error, "scheduler dispatch run artifact not found");
    assert.equal(state.manifest.events.length, workflowState.manifest.events.length);
  }, { historyPath, snapshotsRoot });
});

test("workbench server executes allowlisted projected next actions", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-next-action-"));
  const inputPath = join(snapshotsRoot, "next-action-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = JSON.parse(readFileSync("docs/examples/current-session-workbench-input.json", "utf8"));
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "next-action-source",
    items: [
      {
        id: "next-action-source",
        label: "Next action source",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const dispatch = await request(`${baseUrl}/api/workbench/scheduler-dispatch?id=next-action-source`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        execution_profile: "approved_mock_non_dry_run",
        created_at: "2026-05-22T02:50:00.000Z"
      })
    });
    assert.equal(dispatch.status, 201);

    const enqueue = await request(`${baseUrl}/api/workbench/next-action?id=next-action-source`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "enqueue_scheduler_next_cycle",
        snapshot_id: "next-action-queued",
        label: "Next action queued",
        created_at: "2026-05-22T02:51:00.000Z"
      })
    });
    const queued = enqueue.json();
    const sourceAfterEnqueue = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(enqueue.status, 201);
    assert.equal(queued.status, "executed");
    assert.equal(queued.action, "enqueue_scheduler_next_cycle");
    assert.equal(queued.next_action_readout.action, "enqueue_scheduler_next_cycle");
    assert.equal(queued.result.status, "queued");
    assert.equal(queued.result.next_item.id, "next-action-queued");
    assert.equal(sourceAfterEnqueue.manifest.events.at(-1).type, "scheduler_next_cycle_enqueue");

    const loop = await request(`${baseUrl}/api/workbench/next-action?id=next-action-source`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "run_autonomous_scheduler_loop",
        max_iterations: 1,
        snapshot_prefix: "next-action-loop",
        created_at: "2026-05-22T02:52:00.000Z"
      })
    });
    const looped = loop.json();
    const sourceAfterLoop = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(loop.status, 201);
    assert.equal(looped.status, "executed");
    assert.equal(looped.action, "run_autonomous_scheduler_loop");
    assert.equal(looped.next_action_readout.action, "run_autonomous_scheduler_loop");
    assert.equal(looped.result.status, "created");
    assert.equal(looped.result.result.phase, "iteration_limit_reached");
    assert.equal(sourceAfterLoop.manifest.events.at(-1).type, "autonomous_scheduler_loop_run");
  }, { historyPath, snapshotsRoot });
});

test("workbench server runs reviewer shard through projected next action", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-next-action-reviewer-"));
  const inputPath = join(snapshotsRoot, "next-action-reviewer-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = JSON.parse(readFileSync("docs/examples/current-session-workbench-input.json", "utf8"));
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "next-action-reviewer",
    items: [
      {
        id: "next-action-reviewer",
        label: "Next action reviewer",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/next-action?id=next-action-reviewer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "run_reviewer_scope_shard",
        reviewer_mock_status: "pass",
        created_at: "2026-05-22T02:53:00.000Z"
      })
    });
    const created = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.status, "executed");
    assert.equal(created.action, "run_reviewer_scope_shard");
    assert.equal(created.result.status, "created");
    assert.equal(created.result.phase, "shard_recorded");
    assert.equal(created.projection.reviewer_shard_review.completed_shards, 1);
    assert.equal(state.manifest.events.at(-1).type, "reviewer_shard_result");
  }, { historyPath, snapshotsRoot });
});

test("workbench server records direct reviewer shard runs", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-reviewer-shard-run-"));
  const inputPath = join(snapshotsRoot, "reviewer-shard-run-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = JSON.parse(readFileSync("docs/examples/current-session-workbench-input.json", "utf8"));
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "reviewer-shard-run",
    items: [
      {
        id: "reviewer-shard-run",
        label: "Reviewer shard run",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/reviewer-shard-run?id=reviewer-shard-run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reviewer_mock_status: "pass",
        created_at: "2026-05-22T02:53:30.000Z"
      })
    });
    const created = response.json();

    assert.equal(response.status, 201);
    assert.equal(created.status, "created");
    assert.equal(created.phase, "shard_recorded");
    assert.equal(created.shard_id, "reviewer-scope-shard-001");
    assert.equal(created.pending_shards, 1);
    assert.equal(created.projection.reviewer_shard_review.completed_shards, 1);
  }, { historyPath, snapshotsRoot });
});

test("workbench server resumes scheduler loop through projected next action", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-next-action-resume-"));
  const inputPath = join(snapshotsRoot, "next-action-resume-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = JSON.parse(readFileSync("docs/examples/current-session-workbench-input.json", "utf8"));
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "next-action-resume",
    items: [
      {
        id: "next-action-resume",
        label: "Next action resume",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const loop = await request(`${baseUrl}/api/workbench/autonomous-scheduler-loop?id=next-action-resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_iterations: 1,
        snapshot_prefix: "resume-loop",
        created_at: "2026-05-22T02:53:40.000Z"
      })
    });
    assert.equal(loop.status, 201);

    const response = await request(`${baseUrl}/api/workbench/next-action?id=next-action-resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "resume_autonomous_scheduler_loop",
        snapshot_prefix: "next-action-resume",
        created_at: "2026-05-22T02:53:50.000Z"
      })
    });
    const created = response.json();
    const sourceState = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.status, "executed");
    assert.equal(created.action, "resume_autonomous_scheduler_loop");
    assert.equal(created.result.status, "created");
    assert.equal(created.result.recovery.status, "ready");
    assert.equal(sourceState.manifest.events.at(-1).type, "scheduler_loop_resume_attempt");
    assert.equal(sourceState.manifest.events.at(-1).status, "pass");
  }, { historyPath, snapshotsRoot });
});

test("workbench server fails closed for unsupported projected next action", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-next-action-unsupported-"));
  const inputPath = join(snapshotsRoot, "next-action-unsupported-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = JSON.parse(readFileSync("docs/examples/current-session-workbench-input.json", "utf8"));
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "next-action-unsupported",
    items: [
      {
        id: "next-action-unsupported",
        label: "Next action unsupported",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const first = await request(`${baseUrl}/api/workbench/autonomous-scheduler-loop?id=next-action-unsupported`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_iterations: 1,
        snapshot_prefix: "unsupported-loop",
        created_at: "2026-05-22T02:53:40.000Z"
      })
    });
    assert.equal(first.status, 201);
    const resumed = await request(`${baseUrl}/api/workbench/next-action?id=next-action-unsupported`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "resume_autonomous_scheduler_loop",
        snapshot_prefix: "unsupported-resume",
        created_at: "2026-05-22T02:53:50.000Z"
      })
    });
    assert.equal(resumed.status, 201);

    const response = await request(`${baseUrl}/api/workbench/next-action?id=next-action-unsupported`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "inspect_resume_target",
        created_at: "2026-05-22T02:54:00.000Z"
      })
    });
    const rejected = response.json();

    assert.equal(response.status, 409);
    assert.equal(rejected.next_action_readout.action, "inspect_resume_target");
    assert.equal(rejected.issues[0].code, "unsupported_projected_next_action");
  }, { historyPath, snapshotsRoot });
});

test("workbench server fails closed when projected next action drifts", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/next-action?id=current-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected_action: "enqueue_scheduler_next_cycle",
        created_at: "2026-05-22T02:54:00.000Z"
      })
    });
    const rejected = response.json();

    assert.equal(response.status, 409);
    assert.equal(rejected.next_action_readout.action, "run_reviewer_scope_shard");
    assert.equal(rejected.issues[0].code, "next_action_drift");
  });
});

test("workbench server runs bounded autonomous scheduler loop from projection history input", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-autonomous-loop-"));
  const inputPath = join(snapshotsRoot, "autonomous-loop-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = JSON.parse(readFileSync("docs/examples/current-session-workbench-input.json", "utf8"));
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "autonomous-loop",
    items: [
      {
        id: "autonomous-loop",
        label: "Autonomous loop",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/autonomous-scheduler-loop?id=autonomous-loop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_iterations: 1,
        snapshot_prefix: "server-loop",
        created_at: "2026-05-22T00:50:00.000Z"
      })
    });
    const created = response.json();
    const history = (await request(`${baseUrl}/api/workbench/projections`)).json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.status, "created");
    assert.equal(created.result.phase, "iteration_limit_reached");
    assert.equal(created.projection.scheduler_loop.status, "pass");
    assert.equal(created.projection.scheduler_loop.iteration_count, 1);
    assert.equal(created.projection.scheduler_loop.recovery_status, "ready");
    assert.equal(history.latest, "server-loop-autonomous-loop-01");
    const sourceItem = history.items.find((entry) => entry.id === "autonomous-loop");
    assert.equal(sourceItem.scheduler_loop.status, "pass");
    assert.equal(sourceItem.scheduler_loop.recovery_status, "ready");
    assert.equal(sourceItem.scheduler_loop.resume_projection_id, "server-loop-autonomous-loop-01");
    assert.equal(state.manifest.events.at(-1).type, "autonomous_scheduler_loop_run");
  }, { historyPath, snapshotsRoot });
});

test("workbench server can run autonomous scheduler loop through projected next actions", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-projected-loop-"));
  const inputPath = join(snapshotsRoot, "projected-loop-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = JSON.parse(readFileSync("docs/examples/current-session-workbench-input.json", "utf8"));
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "projected-loop",
    items: [
      {
        id: "projected-loop",
        label: "Projected loop",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/autonomous-scheduler-loop?id=projected-loop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_iterations: 2,
        execution_strategy: "projected_next_action",
        reviewer_mock_status: "pass",
        snapshot_prefix: "projected-loop",
        created_at: "2026-05-22T03:45:00.000Z"
      })
    });
    const created = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.status, "created");
    assert.equal(created.result.phase, "iteration_limit_reached");
    assert.equal(created.result.iterations[0].projected_action, "run_reviewer_scope_shard");
    assert.equal(created.result.iterations[1].projected_action, "run_reviewer_scope_shard");
    assert.equal(state.manifest.events.at(-2).type, "reviewer_shard_aggregate");
    assert.equal(state.manifest.events.at(-1).type, "autonomous_scheduler_loop_run");
    assert.equal(created.projection.reviewer_shard_review.pending_shards, 0);
  }, { historyPath, snapshotsRoot });
});

test("workbench server resumes autonomous scheduler loop from registry recovery policy", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-autonomous-loop-resume-"));
  const inputPath = join(snapshotsRoot, "autonomous-loop-resume-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = JSON.parse(readFileSync("docs/examples/current-session-workbench-input.json", "utf8"));
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "resume-source",
    items: [
      {
        id: "resume-source",
        label: "Resume source",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const first = await request(`${baseUrl}/api/workbench/autonomous-scheduler-loop?id=resume-source`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_iterations: 1,
        snapshot_prefix: "server-loop",
        created_at: "2026-05-22T01:20:00.000Z"
      })
    });
    assert.equal(first.status, 201);

    const resumed = await request(`${baseUrl}/api/workbench/autonomous-scheduler-loop-resume?id=resume-source`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        max_iterations: 1,
        snapshot_prefix: "server-resume",
        created_at: "2026-05-22T01:21:00.000Z"
      })
    });
    const created = resumed.json();
    const history = (await request(`${baseUrl}/api/workbench/projections`)).json();
    const targetInputPath = join(snapshotsRoot, "server-loop-resume-source-01.workbench-input.json");
    const targetState = JSON.parse(readFileSync(targetInputPath, "utf8"));
    const sourceState = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(resumed.status, 201);
    assert.equal(created.status, "created");
    assert.equal(created.recovery.status, "ready");
    assert.equal(created.resume_attempt.metadata.status, "pass");
    assert.equal(created.item.id, "server-loop-resume-source-01");
    assert.equal(created.result.phase, "no_dispatchable_scheduler_actions");
    assert.equal(history.latest, "server-loop-resume-source-01");
    assert.equal(sourceState.manifest.events.at(-1).type, "scheduler_loop_resume_attempt");
    assert.equal(sourceState.manifest.events.at(-1).status, "pass");
    assert.equal(targetState.manifest.events.at(-1).type, "autonomous_scheduler_loop_run");
  }, { historyPath, snapshotsRoot });
});

test("workbench server rejects autonomous scheduler loop resume without ready recovery", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-autonomous-loop-resume-blocked-"));
  const inputPath = join(snapshotsRoot, "autonomous-loop-resume-blocked-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = JSON.parse(readFileSync("docs/examples/current-session-workbench-input.json", "utf8"));
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "resume-blocked",
    items: [
      {
        id: "resume-blocked",
        label: "Resume blocked",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/autonomous-scheduler-loop-resume?id=resume-blocked`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ max_iterations: 1 })
    });
    const rejected = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 409);
    assert.equal(rejected.recovery.status, "not_configured");
    assert.equal(rejected.resume_attempt.metadata.status, "blocked");
    assert.equal(rejected.projection.scheduler_loop.latest_resume_status, "blocked");
    assert.equal(state.manifest.events.at(-1).type, "scheduler_loop_resume_attempt");
    assert.equal(state.manifest.events.at(-1).status, "blocked");
  }, { historyPath, snapshotsRoot });
});

test("workbench server rejects autonomous scheduler loop without workflow state input", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/autonomous-scheduler-loop?id=bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ max_iterations: 1 })
    });
    const rejected = response.json();

    assert.equal(response.status, 400);
    assert.match(rejected.error, /workflow state input not found/);
  });
});

test("workbench server records scheduler dispatch runs into workflow state input", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-scheduler-dispatch-"));
  const inputPath = join(snapshotsRoot, "scheduler-dispatch-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = JSON.parse(readFileSync("docs/examples/current-session-workbench-input.json", "utf8"));
  const plan = createSchedulerDispatchPlan({
    project_status: {
      project: "ai-control-platform",
      blockers: [],
      next_step: ""
    },
    run_evaluation: { status: "pass" },
    workflow_state: workflowState
  }, {
    workflow_state_input_path: "tmp/workbench-server-scheduler-dispatch/input.json"
  });
  const artifact = createSchedulerDispatchRunArtifact(
    plan,
    await runSchedulerDispatchPlan(plan, { dry_run: true }),
    { created_at: "2026-05-21T23:01:00.000Z" }
  );
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "scheduler-dispatch",
    items: [
      {
        id: "scheduler-dispatch",
        label: "Scheduler dispatch",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-dispatch-run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ artifact })
    });
    const created = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 201);
    assert.equal(created.status, "created");
    assert.equal(created.artifact.producer, "scheduler-dispatch-runner");
    assert.equal(created.projection.scheduler_dispatch.status, "pass");
    assert.equal(created.projection.scheduler_dispatch.step_count, 3);
    assert.equal(state.manifest.events.at(-1).type, "scheduler_dispatch_run");
    assert.equal(state.artifact_ledger.artifacts.at(-1).metadata.version, "scheduler-dispatch-run.v1");
  }, { historyPath, snapshotsRoot });
});

test("run-scheduler-dispatch-plan CLI records scheduler dispatch run through workbench service", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-scheduler-cli-"));
  const inputPath = join(snapshotsRoot, "scheduler-cli-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const planPath = join(snapshotsRoot, "scheduler-cli-plan.json");
  const outputPath = join(snapshotsRoot, "scheduler-cli-run.json");
  const workflowState = JSON.parse(readFileSync("docs/examples/current-session-workbench-input.json", "utf8"));
  const plan = createSchedulerDispatchPlan({
    project_status: {
      project: "ai-control-platform",
      blockers: [],
      next_step: ""
    },
    run_evaluation: { status: "pass" },
    workflow_state: workflowState
  }, {
    workflow_state_input_path: relative(process.cwd(), inputPath)
  });
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(planPath, JSON.stringify(plan, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "scheduler-cli",
    items: [
      {
        id: "scheduler-cli",
        label: "Scheduler CLI",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const result = await runNode([
      "tools/run-scheduler-dispatch-plan.mjs",
      "--plan",
      planPath,
      "--output",
      outputPath,
      "--dry-run",
      "--workbench-base-url",
      baseUrl,
      "--projection-id",
      "scheduler-cli"
    ]);
    const summary = JSON.parse(result.stdout);
    const state = JSON.parse(readFileSync(inputPath, "utf8"));
    const projection = (await request(`${baseUrl}/api/workbench/projection?id=scheduler-cli`)).json();

    assert.equal(result.status, 0, result.stderr);
    assert.equal(summary.status, "pass");
    assert.equal(summary.record_status, "pass");
    assert.equal(summary.projection_scheduler_status, "pass");
    assert.equal(summary.projection_scheduler_steps, 3);
    assert.equal(state.manifest.events.at(-1).type, "scheduler_dispatch_run");
    assert.equal(projection.scheduler_dispatch.status, "pass");
    assert.equal(projection.scheduler_dispatch.step_count, 3);
  }, { historyPath, snapshotsRoot });
});

test("workbench server rejects reviewer shard results without workflow state input", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/reviewer-shard-result?id=bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shard_id: "reviewer-scope-shard-001" })
    });
    const rejected = response.json();

    assert.equal(response.status, 400);
    assert.match(rejected.error, /workflow state input not found/);
  });
});

test("workbench server rejects scheduler dispatch runs without workflow state input", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-dispatch-run?id=bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        artifact: {
          version: "scheduler-dispatch-run.v1",
          status: "pass",
          result: { steps: [] }
        }
      })
    });
    const rejected = response.json();

    assert.equal(response.status, 400);
    assert.match(rejected.error, /workflow state input not found/);
  });
});

test("workbench server rejects scheduler dispatch plans without workflow state input", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-dispatch-plan?id=bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    const rejected = response.json();

    assert.equal(response.status, 400);
    assert.match(rejected.error, /workflow state input not found/);
  });
});

test("workbench server rejects unauthorized non-dry-run scheduler dispatch from workbench control", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-scheduler-control-reject-"));
  const inputPath = join(snapshotsRoot, "scheduler-control-reject-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = JSON.parse(readFileSync("docs/examples/current-session-workbench-input.json", "utf8"));
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "scheduler-control-reject",
    items: [
      {
        id: "scheduler-control-reject",
        label: "Scheduler control reject",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dry_run: false })
    });
    const rejected = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 400);
    assert.equal(rejected.error, "scheduler dispatch policy rejected");
    assert.ok(rejected.issues.some((entry) => entry.code === "missing_operator_authorization"));
    assert.equal(rejected.projection.scheduler_dispatch.status, "blocked");
    assert.equal(rejected.projection.scheduler_dispatch.policy_status, "fail");
    assert.equal(rejected.projection.scheduler_dispatch.policy_issue_count, rejected.issues.length);
    assert.equal(state.manifest.events.at(-1).type, "scheduler_dispatch_policy");
  }, { historyPath, snapshotsRoot });
});

test("workbench server rejects unsupported scheduler dispatch execution profiles", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-scheduler-profile-reject-"));
  const inputPath = join(snapshotsRoot, "scheduler-profile-reject-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = JSON.parse(readFileSync("docs/examples/current-session-workbench-input.json", "utf8"));
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "scheduler-profile-reject",
    items: [
      {
        id: "scheduler-profile-reject",
        label: "Scheduler profile reject",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ execution_profile: "unbounded_real_model" })
    });
    const rejected = response.json();
    const state = JSON.parse(readFileSync(inputPath, "utf8"));

    assert.equal(response.status, 400);
    assert.equal(rejected.error, "scheduler dispatch control request rejected");
    assert.ok(rejected.issues.some((entry) => entry.code === "unsupported_scheduler_dispatch_profile"));
    assert.equal(state.manifest.events.length, workflowState.manifest.events.length);
  }, { historyPath, snapshotsRoot });
});

test("workbench server rejects scheduler dispatch plan creation with unsafe host", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-scheduler-plan-host-"));
  const inputPath = join(snapshotsRoot, "scheduler-plan-host-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = JSON.parse(readFileSync("docs/examples/current-session-workbench-input.json", "utf8"));
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "scheduler-plan-host",
    items: [
      {
        id: "scheduler-plan-host",
        label: "Scheduler plan host",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-dispatch-plan`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "bad/host"
      },
      body: JSON.stringify({})
    });
    const rejected = response.json();

    assert.equal(response.status, 400);
    assert.match(rejected.error, /request host is required/);
  }, { historyPath, snapshotsRoot });
});

test("workbench server rejects scheduler dispatch run identity drift", async () => {
  mkdirSync("tmp", { recursive: true });
  const snapshotsRoot = mkdtempSync(join(process.cwd(), "tmp/workbench-server-scheduler-drift-"));
  const inputPath = join(snapshotsRoot, "scheduler-drift-input.json");
  const historyPath = join(snapshotsRoot, "projection-history.json");
  const workflowState = JSON.parse(readFileSync("docs/examples/current-session-workbench-input.json", "utf8"));
  writeFileSync(inputPath, JSON.stringify(workflowState, null, 2));
  writeFileSync(historyPath, JSON.stringify({
    version: "projection-history.v1",
    latest: "scheduler-drift",
    items: [
      {
        id: "scheduler-drift",
        label: "Scheduler drift",
        input_path: relative(process.cwd(), inputPath)
      }
    ]
  }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/scheduler-dispatch-run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        artifact: {
          version: "scheduler-dispatch-run.v1",
          run_id: "wrong-run",
          status: "pass",
          result: { steps: [] }
        }
      })
    });
    const rejected = response.json();

    assert.equal(response.status, 400);
    assert.equal(rejected.error, "scheduler dispatch run record failed");
    assert.ok(rejected.issues.some((entry) => entry.code === "scheduler_dispatch_identity_mismatch"));
  }, { historyPath, snapshotsRoot });
});

test("workbench server rejects unsafe workflow state snapshot ids", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-history-"));
  const historyPath = join(dir, "projection-history.json");
  writeFileSync(historyPath, JSON.stringify({ version: "projection-history.v1", latest: null, items: [] }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/snapshots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "../escape", input: {} })
    });
    const rejected = response.json();

    assert.equal(response.status, 400);
    assert.equal(rejected.error, "invalid workflow state snapshot");
    assert.ok(rejected.issues.includes("id must be a safe snapshot id"));
  }, { historyPath });
});

test("workbench server rejects non-string workflow state snapshot ids", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-history-"));
  const historyPath = join(dir, "projection-history.json");
  writeFileSync(historyPath, JSON.stringify({ version: "projection-history.v1", latest: null, items: [] }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/snapshots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 123, input: {} })
    });
    const rejected = response.json();

    assert.equal(response.status, 400);
    assert.equal(rejected.error, "invalid workflow state snapshot");
    assert.ok(rejected.issues.includes("id must be a safe snapshot id"));
  }, { historyPath });
});

test("workbench server rejects workflow state snapshots that are not projection-ready", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-history-"));
  const historyPath = join(dir, "projection-history.json");
  writeFileSync(historyPath, JSON.stringify({ version: "projection-history.v1", latest: null, items: [] }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/snapshots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "not-ready",
        input: {
          manifest: { run_id: "not-ready", cycle_id: "cycle-not-ready" },
          artifact_ledger: { artifacts: [] }
        }
      })
    });
    const rejected = response.json();
    const history = (await request(`${baseUrl}/api/workbench/projections`)).json();

    assert.equal(response.status, 400);
    assert.equal(rejected.error, "workflow state snapshot publish failed");
    assert.ok(rejected.issues.includes("projection input validation must pass before snapshot publish"));
    assert.equal(history.latest, null);
  }, { historyPath });
});

test("workbench server rejects workflow state snapshots without operator event facts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-history-"));
  const historyPath = join(dir, "projection-history.json");
  const workflowState = JSON.parse(readFileSync("docs/examples/current-session-workbench-input.json", "utf8"));
  delete workflowState.operator_event_ledger;
  writeFileSync(historyPath, JSON.stringify({ version: "projection-history.v1", latest: null, items: [] }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/snapshots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "missing-operator-events",
        input: workflowState
      })
    });
    const rejected = response.json();
    const history = (await request(`${baseUrl}/api/workbench/projections`)).json();

    assert.equal(response.status, 400);
    assert.equal(rejected.error, "workflow state snapshot publish failed");
    assert.ok(rejected.issues.includes("operator events must apply before snapshot publish"));
    assert.equal(history.latest, null);
  }, { historyPath });
});

test("workbench server serves desktop app shell", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/apps/workbench/desktop.html`);
    const html = response.text;

    assert.equal(response.status, 200);
    assert.match(html, /data-view="desktop"/);
    assert.match(response.headers["content-type"], /text\/html/);
  });
});

test("workbench server rejects unknown projection ids", async () => {
  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/projection?id=missing`);
    const body = response.json();

    assert.equal(response.status, 404);
    assert.match(body.error, /projection not found/);
  });
});

test("workbench server persists operator events", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-events-"));
  const eventsPath = join(dir, "operator-events.json");
  writeFileSync(eventsPath, JSON.stringify({ version: "operator-events.v1", events: [] }));

  await withServer(async (baseUrl) => {
    const createResponse = await request(`${baseUrl}/api/workbench/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "validate", run_id: "run-1", cycle_id: "cycle-1" })
    });
    const created = createResponse.json();
    const listResponse = await request(`${baseUrl}/api/workbench/events`);
    const ledger = listResponse.json();

    assert.equal(createResponse.status, 201);
    assert.equal(created.status, "created");
    assert.equal(ledger.events.length, 1);
    assert.equal(ledger.events[0].action, "validate");
    assert.equal(ledger.events[0].run_id, "run-1");
  }, { eventsPath });
});

test("workbench server rejects operator events without ownership fields", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-events-"));
  const eventsPath = join(dir, "operator-events.json");
  writeFileSync(eventsPath, JSON.stringify({ version: "operator-events.v1", events: [] }));

  await withServer(async (baseUrl) => {
    const createResponse = await request(`${baseUrl}/api/workbench/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "validate" })
    });
    const rejected = createResponse.json();
    const listResponse = await request(`${baseUrl}/api/workbench/events`);
    const ledger = listResponse.json();

    assert.equal(createResponse.status, 400);
    assert.equal(rejected.error, "invalid operator event");
    assert.deepEqual(rejected.issues, ["run_id is required", "cycle_id is required"]);
    assert.equal(ledger.events.length, 0);
  }, { eventsPath });
});

test("workbench server rejects malformed operator event json", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-events-"));
  const eventsPath = join(dir, "operator-events.json");
  writeFileSync(eventsPath, JSON.stringify({ version: "operator-events.v1", events: [] }));

  await withServer(async (baseUrl) => {
    const response = await request(`${baseUrl}/api/workbench/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{"
    });

    assert.equal(response.status, 400);
    assert.equal(response.json().error, "invalid json");
  }, { eventsPath });
});
