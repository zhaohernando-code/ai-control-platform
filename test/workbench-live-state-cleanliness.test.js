import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { createSqliteWorkbenchStateStore } from "../src/workflow/workbench-state-store.js";
import {
  cleanupWorkbenchLiveTestData,
  inspectWorkbenchLiveStateCleanliness
} from "../src/workflow/workbench-live-state-cleanliness.js";

function contaminatedProjectStatus() {
  return {
    project: "ai-control-platform",
    requirement_intake: {
      items: [
        {
          id: "requirement-UI-nonblocking-submit-2026-05-28T07-12-48-536Z-20260528071248",
          title: "UI nonblocking submit 2026-05-28T07-12-48-536Z"
        },
        {
          id: "requirement-Codex-loading-06-46-47-20260528064649",
          title: "Codex复现任务流loading 06:46:47"
        },
        {
          id: "requirement-real-feature",
          title: "真实业务任务"
        }
      ],
      active_requirement_id: "requirement-UI-nonblocking-submit-2026-05-28T07-12-48-536Z-20260528071248",
      latest_requirement_id: "requirement-UI-nonblocking-submit-2026-05-28T07-12-48-536Z-20260528071248"
    },
    plan_reviews: {
      "requirement-UI-nonblocking-submit-2026-05-28T07-12-48-536Z-20260528071248": {
        requirement_id: "requirement-UI-nonblocking-submit-2026-05-28T07-12-48-536Z-20260528071248",
        requirement_title: "UI nonblocking submit 2026-05-28T07-12-48-536Z"
      },
      "requirement-Codex-loading-06-46-47-20260528064649": {
        requirement_id: "requirement-Codex-loading-06-46-47-20260528064649",
        requirement_title: "Codex复现任务流loading 06:46:47"
      },
      "requirement-real-feature": {
        requirement_id: "requirement-real-feature",
        requirement_title: "真实业务任务"
      }
    },
    global_goals: [
      {
        id: "requirement-UI-nonblocking-submit-2026-05-28T07-12-48-536Z-20260528071248",
        title: "UI nonblocking submit 2026-05-28T07-12-48-536Z",
        status: "in_progress"
      },
      {
        id: "requirement-Codex-loading-06-46-47-20260528064649",
        title: "Codex复现任务流loading 06:46:47",
        status: "pending_review"
      },
      {
        id: "requirement-real-feature",
        title: "真实业务任务",
        status: "in_progress"
      }
    ],
    next_work_packages: [
      {
        id: "requirement-UI-nonblocking-submit-2026-05-28T07-12-48-536Z-20260528071248-intake",
        title: "处理需求：UI nonblocking submit 2026-05-28T07-12-48-536Z",
        source: {
          requirement_id: "requirement-UI-nonblocking-submit-2026-05-28T07-12-48-536Z-20260528071248"
        }
      },
      {
        id: "requirement-Codex-loading-06-46-47-20260528064649-intake",
        title: "处理需求：Codex复现任务流loading 06:46:47",
        source: {
          requirement_id: "requirement-Codex-loading-06-46-47-20260528064649"
        }
      },
      {
        id: "requirement-real-feature-intake",
        title: "处理需求：真实业务任务",
        source: {
          requirement_id: "requirement-real-feature"
        }
      }
    ]
  };
}

function workflowState(projectStatus) {
  return {
    manifest: {
      run_id: "run-live-cleanliness",
      cycle_id: "cycle-live-cleanliness",
      events: [
        {
          id: "event-requirement-UI-nonblocking-submit",
          type: "requirement_intake_submitted",
          requirement_id: "requirement-UI-nonblocking-submit-2026-05-28T07-12-48-536Z-20260528071248"
        },
        {
          id: "event-requirement-Codex-loading",
          type: "requirement_intake_submitted",
          requirement_id: "requirement-Codex-loading-06-46-47-20260528064649"
        },
        {
          id: "event-real-feature",
          type: "requirement_intake_submitted",
          requirement_id: "requirement-real-feature"
        }
      ],
      work_packages: [
        {
          id: "requirement-UI-nonblocking-submit-2026-05-28T07-12-48-536Z-20260528071248-intake",
          title: "处理需求：UI nonblocking submit 2026-05-28T07-12-48-536Z"
        },
        {
          id: "requirement-Codex-loading-06-46-47-20260528064649-intake",
          title: "处理需求：Codex复现任务流loading 06:46:47"
        },
        {
          id: "requirement-real-feature-intake",
          title: "处理需求：真实业务任务"
        }
      ]
    },
    artifact_ledger: {
      artifacts: [
        {
          id: "artifact-UI-nonblocking-submit",
          uri: "codex://test/UI nonblocking submit"
        },
        {
          id: "artifact-Codex-loading",
          uri: "codex://test/Codex复现任务流loading"
        },
        {
          id: "artifact-real-feature",
          uri: "codex://real-feature"
        }
      ]
    },
    project_status: projectStatus
  };
}

test("workbench live state cleanliness gate fails on reserved test requirement residue", () => {
  const dir = mkdtempSync(join(tmpdir(), "workbench-live-cleanliness-"));
  const dbPath = join(dir, "workbench-state.sqlite");
  const store = createSqliteWorkbenchStateStore({ dbPath });
  store.writeProjectStatus(contaminatedProjectStatus());
  store.writeWorkflowSnapshot("live-snapshot", workflowState(contaminatedProjectStatus()));

  const result = inspectWorkbenchLiveStateCleanliness({ dbPath });

  assert.equal(result.status, "fail");
  assert.ok(result.issue_count >= 4);
  assert.ok(result.issues.some((entry) => entry.path.includes("plan_reviews")));
  assert.ok(result.issues.some((entry) => entry.path.includes("manifest.events")));
});

test("workbench live state cleanup removes reserved test residue and preserves real tasks", () => {
  const dir = mkdtempSync(join(tmpdir(), "workbench-live-cleanup-"));
  const dbPath = join(dir, "workbench-state.sqlite");
  const store = createSqliteWorkbenchStateStore({ dbPath });
  store.writeProjectStatus(contaminatedProjectStatus());
  store.writeWorkflowSnapshot("live-snapshot", workflowState(contaminatedProjectStatus()));

  const cleanup = cleanupWorkbenchLiveTestData({ dbPath });
  const projectStatus = store.readProjectStatus();
  const snapshot = store.readWorkflowSnapshot("live-snapshot");

  assert.equal(cleanup.status, "pass");
  assert.ok(cleanup.cleaned_count > 0);
  assert.deepEqual(Object.keys(projectStatus.plan_reviews), ["requirement-real-feature"]);
  assert.deepEqual(projectStatus.requirement_intake.items.map((item) => item.id), ["requirement-real-feature"]);
  assert.deepEqual(projectStatus.global_goals.map((goal) => goal.id), ["requirement-real-feature"]);
  assert.equal(projectStatus.requirement_intake.active_requirement_id, "requirement-real-feature");
  assert.equal(snapshot.manifest.events.length, 1);
  assert.equal(snapshot.manifest.events[0].requirement_id, "requirement-real-feature");
  assert.equal(snapshot.artifact_ledger.artifacts.length, 1);
  assert.equal(snapshot.artifact_ledger.artifacts[0].id, "artifact-real-feature");
});

test("workbench live state cleanliness CLI fails before cleanup and passes after cleanup", () => {
  const dir = mkdtempSync(join(tmpdir(), "workbench-live-cleanliness-cli-"));
  const dbPath = join(dir, "workbench-state.sqlite");
  const store = createSqliteWorkbenchStateStore({ dbPath });
  store.writeProjectStatus(contaminatedProjectStatus());

  const failed = spawnSync(process.execPath, ["tools/check-workbench-live-state-cleanliness.mjs", "--state-db", dbPath], {
    encoding: "utf8"
  });
  const cleaned = spawnSync(process.execPath, ["tools/check-workbench-live-state-cleanliness.mjs", "--state-db", dbPath, "--cleanup"], {
    encoding: "utf8"
  });
  const passed = spawnSync(process.execPath, ["tools/check-workbench-live-state-cleanliness.mjs", "--state-db", dbPath], {
    encoding: "utf8"
  });

  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /live_state_test_data_residue/);
  assert.equal(cleaned.status, 0);
  assert.equal(passed.status, 0);
});
