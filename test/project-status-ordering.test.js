import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";

import { createSqliteWorkbenchStateStore } from "../src/workflow/workbench-state-store.js";
import { tempDir } from "./helpers/temp-dir.js";

function freshStore() {
  const dir = tempDir(null, "p02-order-");
  return createSqliteWorkbenchStateStore({ dbPath: join(dir, "s.sqlite") });
}

const base = { manifest: { run_id: "r", events: [] }, artifact_ledger: { artifacts: [] } };

function writeSnap(store, id, createdAt, projectStatus) {
  store.writeWorkflowSnapshot(id, { ...base, project_status: projectStatus }, {
    id,
    input_path: `sqlite://workflow-snapshot/${id}`,
    created_at: createdAt,
    status: "pass"
  });
  return { id, input_path: `sqlite://workflow-snapshot/${id}`, created_at: createdAt, status: "pass" };
}

// projectStatusHistoryFromSnapshots accumulates project_status across snapshots, merging
// OLDEST -> NEWEST so the latest snapshot wins per id. The order must come from created_at,
// NOT from history.items array order (which seeding/migration can leave unsorted). A wrong
// order silently resurrects stale statuses (mergeProjectStatusHistory is last-write-wins).
test("P0-2: latest snapshot status wins regardless of history.items array order", () => {
  const store = freshStore();
  const old = writeSnap(store, "old", "2026-05-28T00:00:00.000Z", { project: "p", next_work_packages: [{ id: "wp1", status: "failed" }] });
  const recent = writeSnap(store, "new", "2026-05-29T00:00:00.000Z", { project: "p", next_work_packages: [{ id: "wp1", status: "done" }] });

  // deliberately UNSORTED (oldest-first) array order to prove sorting is by created_at
  const merged = store.projectStatusHistoryFromSnapshots({ version: "projection-history.v1", latest: "new", items: [old, recent] });
  const pkg = (merged.next_work_packages || []).find((w) => w.id === "wp1");
  assert.equal(pkg.status, "done", "newest (done) wins over older (failed), by created_at not array order");
});

test("P0-2: reversed array order also yields newest-wins (order-independent)", () => {
  const store = freshStore();
  const old = writeSnap(store, "old", "2026-05-28T00:00:00.000Z", { project: "p", next_work_packages: [{ id: "wp1", status: "failed" }] });
  const recent = writeSnap(store, "new", "2026-05-29T00:00:00.000Z", { project: "p", next_work_packages: [{ id: "wp1", status: "done" }] });
  const merged = store.projectStatusHistoryFromSnapshots({ version: "projection-history.v1", latest: "new", items: [recent, old] });
  assert.equal((merged.next_work_packages || []).find((w) => w.id === "wp1").status, "done");
});

test("P0-2: historical task ids are preserved across snapshots (no regression)", () => {
  const store = freshStore();
  const s1 = writeSnap(store, "s1", "2026-05-28T00:00:00.000Z", { project: "p", next_work_packages: [{ id: "wpA", status: "done" }] });
  const s2 = writeSnap(store, "s2", "2026-05-29T00:00:00.000Z", { project: "p", next_work_packages: [{ id: "wpB", status: "pending" }] });
  const merged = store.projectStatusHistoryFromSnapshots({ version: "projection-history.v1", latest: "s2", items: [s2, s1] });
  const ids = (merged.next_work_packages || []).map((w) => w.id).sort();
  assert.deepEqual(ids, ["wpA", "wpB"], "both historical work packages preserved");
});
