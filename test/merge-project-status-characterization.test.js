// Characterization tests for mergeProjectStatusHistory — the lossy last-write-wins merge
// at the heart of the project_status store. P0-2 narrows what this merge is allowed to do
// (status fields must not be silently overwritten without ordering), so pin the EXACT
// current behavior first, including the foot-guns, so the refactor is provably scoped.

import assert from "node:assert/strict";
import test from "node:test";

import { mergeProjectStatusHistory } from "../src/workflow/workbench-state-store.js";

test("characterize: later object overwrites earlier scalar fields (last-write-wins)", () => {
  const merged = mergeProjectStatusHistory(
    { phase: "in_development", note: "first" },
    { phase: "closeout" }
  );
  assert.equal(merged.phase, "closeout", "last write wins for scalars");
  assert.equal(merged.note, "first", "fields absent in later object are preserved");
});

test("characterize: arrays with ids merge by id (right wins per id), order preserved", () => {
  const merged = mergeProjectStatusHistory(
    { next_work_packages: [{ id: "a", status: "pending" }, { id: "b", status: "pending" }] },
    { next_work_packages: [{ id: "a", status: "done" }, { id: "c", status: "pending" }] }
  );
  assert.deepEqual(merged.next_work_packages.map((w) => w.id), ["a", "b", "c"], "union by id, first-seen order");
  assert.equal(merged.next_work_packages.find((w) => w.id === "a").status, "done", "right wins per id");
});

test("characterize: array entries WITHOUT an id are DROPPED by mergeArrayById (foot-gun)", () => {
  const merged = mergeProjectStatusHistory(
    { next_work_packages: [{ status: "pending" }, { id: "b" }] },
    {}
  );
  // the id-less entry is silently discarded — a real lossy quirk P0-2 must not rely on.
  assert.deepEqual(merged.next_work_packages.map((w) => w.id), ["b"]);
});

test("characterize: empty merged arrays are omitted entirely (not set to [])", () => {
  const merged = mergeProjectStatusHistory({ note: "x" }, { note: "y" });
  assert.equal("next_work_packages" in merged, false, "no array key when nothing to merge");
  assert.equal("global_goals" in merged, false);
});

test("characterize: requirement_intake.items merge by id; active/latest prefer later then earlier", () => {
  const merged = mergeProjectStatusHistory(
    { requirement_intake: { items: [{ id: "r1", v: 1 }], active_requirement_id: "r1", latest_requirement_id: "r1" } },
    { requirement_intake: { items: [{ id: "r1", v: 2 }, { id: "r2" }], active_requirement_id: "r2" } }
  );
  assert.deepEqual(merged.requirement_intake.items.map((i) => i.id), ["r1", "r2"]);
  assert.equal(merged.requirement_intake.items.find((i) => i.id === "r1").v, 2, "right wins per item");
  assert.equal(merged.requirement_intake.active_requirement_id, "r2", "later active wins");
  assert.equal(merged.requirement_intake.latest_requirement_id, "r1", "falls back to earlier latest when later absent");
});

test("characterize: non-object args are filtered out (null/undefined/strings ignored)", () => {
  const merged = mergeProjectStatusHistory(null, { phase: "x" }, undefined, "nope", { note: "y" });
  assert.deepEqual(merged, { phase: "x", note: "y", plan_reviews: {}, requirement_intake: { active_requirement_id: null, latest_requirement_id: null } });
});

test("characterize: plan_reviews is a shallow object-map merge (right wins per key)", () => {
  const merged = mergeProjectStatusHistory(
    { plan_reviews: { p1: { ok: true }, p2: { ok: false } } },
    { plan_reviews: { p2: { ok: true } } }
  );
  assert.deepEqual(merged.plan_reviews, { p1: { ok: true }, p2: { ok: true } });
});
