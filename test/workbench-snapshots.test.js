import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { publishWorkbenchSnapshot, snapshotIssues } from "../src/workflow/workbench-snapshots.js";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("snapshot request validation rejects unsafe ids", () => {
  assert.deepEqual(snapshotIssues({ id: "../escape", input: {} }), ["id must be a safe snapshot id"]);
  assert.deepEqual(snapshotIssues({ id: 123, input: {} }), ["id must be a safe snapshot id"]);
});

test("publishWorkbenchSnapshot writes input and updates history latest", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-snapshot-"));
  const historyPath = join(dir, "projection-history.json");
  const snapshotsRoot = join(dir, "snapshots");
  const workflowState = readJson("docs/examples/current-session-workbench-input.json");
  writeFileSync(historyPath, JSON.stringify({ version: "projection-history.v1", latest: null, items: [] }));

  const result = publishWorkbenchSnapshot({
    id: "closeout-snapshot",
    label: "Closeout snapshot",
    input: workflowState,
    created_at: "2026-05-21T09:30:00.000Z"
  }, {
    root: dir,
    historyPath,
    snapshotsRoot
  });
  const history = readJson(historyPath);
  const snapshot = readJson(result.snapshot_path);

  assert.equal(result.status, "created");
  assert.equal(result.projection.run_id, "run-20260521-platform-self-trial");
  assert.equal(result.item.status, "rerun");
  assert.equal(history.latest, "closeout-snapshot");
  assert.equal(history.items[0].id, "closeout-snapshot");
  assert.equal(snapshot.manifest.run_id, "run-20260521-platform-self-trial");
});
