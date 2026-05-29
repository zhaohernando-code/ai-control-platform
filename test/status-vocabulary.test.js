// Golden membership test for the shared status vocabulary. This is the single source of
// truth that ~6 modules build their status Sets from, so an accidental edit here has a
// wide blast radius. These tests lock the EXACT membership and the frozen-ness so any
// change must be deliberate (update this test on purpose) rather than silent.

import assert from "node:assert/strict";
import test from "node:test";

import {
  PASS_SYNONYMS,
  COMPLETE_SYNONYMS,
  FAIL_SYNONYMS,
  RUNNING_SYNONYMS,
  PENDING_SYNONYMS,
  FINDING_PASS_SYNONYMS,
  FINDING_FAIL_SYNONYMS,
  normalizeToken
} from "../src/workflow/status-vocabulary.js";

test("golden: exact membership of each shared set", () => {
  assert.deepEqual([...PASS_SYNONYMS], ["pass", "passed", "ok", "success", "succeeded", "complete", "completed"]);
  assert.deepEqual([...COMPLETE_SYNONYMS], ["pass", "passed", "ok", "success", "succeeded", "complete", "completed", "done"]);
  assert.deepEqual([...FAIL_SYNONYMS], ["fail", "failed", "error", "errored", "blocked", "timeout", "timed_out"]);
  assert.deepEqual([...RUNNING_SYNONYMS], ["running", "active", "in_progress", "in-progress"]);
  assert.deepEqual([...PENDING_SYNONYMS], ["pending", "queued", "ready", "todo"]);
  assert.deepEqual([...FINDING_PASS_SYNONYMS], ["pass", "passed", "ok", "success", "succeeded"]);
  assert.deepEqual([...FINDING_FAIL_SYNONYMS], ["fail", "failed", "error", "blocked"]);
});

test("golden: COMPLETE_SYNONYMS is exactly PASS_SYNONYMS + 'done'", () => {
  assert.deepEqual([...COMPLETE_SYNONYMS], [...PASS_SYNONYMS, "done"]);
});

test("golden: finding sets are a strict subset of the general sets (deliberately narrower)", () => {
  for (const s of FINDING_PASS_SYNONYMS) assert.ok(PASS_SYNONYMS.includes(s), `${s} should be in PASS_SYNONYMS`);
  for (const s of FINDING_FAIL_SYNONYMS) assert.ok(FAIL_SYNONYMS.includes(s), `${s} should be in FAIL_SYNONYMS`);
  // and narrower: finding-pass omits complete/completed; finding-fail omits errored/timeout/timed_out
  assert.equal(FINDING_PASS_SYNONYMS.includes("completed"), false);
  assert.equal(FINDING_FAIL_SYNONYMS.includes("timeout"), false);
});

test("golden: exported arrays are frozen (no importer can mutate the shared source)", () => {
  for (const arr of [PASS_SYNONYMS, COMPLETE_SYNONYMS, FAIL_SYNONYMS, RUNNING_SYNONYMS, PENDING_SYNONYMS, FINDING_PASS_SYNONYMS, FINDING_FAIL_SYNONYMS]) {
    assert.equal(Object.isFrozen(arr), true);
    assert.throws(() => arr.push("x"), TypeError);
  }
});

test("golden: no overlap between PASS and FAIL sets (a token can't be both)", () => {
  for (const s of COMPLETE_SYNONYMS) assert.equal(FAIL_SYNONYMS.includes(s), false, `${s} must not be in both`);
});

test("normalizeToken: trims + lowercases; non-strings coerce predictably", () => {
  assert.equal(normalizeToken("  PASS  "), "pass");
  assert.equal(normalizeToken(""), "");
  assert.equal(normalizeToken(null), "");
  assert.equal(normalizeToken(undefined), "");
  assert.equal(normalizeToken(0), ""); // 0 || "" -> ""
});
