import assert from "node:assert/strict";
import test from "node:test";
import { validateOperatorEventLedger } from "../src/workflow/operator-events.js";

// Error-branch coverage for operator-events.js ledger validation. The operator event ledger is
// an external-input surface (operators POST events), so its rejection branches are exactly the
// kind of error path that must be pinned. All reachable with plain input.

const OK_EVENT = {
  event_type: "operator_note",
  id: "evt-1",
  action: "note",
  run_id: "run-1",
  cycle_id: "cycle-1",
  created_at: "2026-05-31T00:00:00Z"
};

test("validateOperatorEventLedger: a non-object ledger is rejected", () => {
  for (const bad of [null, "x", 42]) {
    const r = validateOperatorEventLedger(bad);
    assert.equal(r.status, "fail");
    assert.equal(r.issues[0].code, "invalid_operator_event_ledger");
  }
});

test("validateOperatorEventLedger: wrong version is rejected", () => {
  const r = validateOperatorEventLedger({ version: "wrong-version", events: [] });
  assert.ok(r.issues.some((i) => i.code === "invalid_operator_event_ledger_version"));
});

test("validateOperatorEventLedger: non-array events is rejected", () => {
  const r = validateOperatorEventLedger({ version: "operator-events.v1", events: "not-an-array" });
  assert.ok(r.issues.some((i) => i.code === "invalid_operator_events"));
});

test("validateOperatorEventLedger: an event missing required fields is rejected", () => {
  const r = validateOperatorEventLedger({ version: "operator-events.v1", events: [{}] }, { run_id: "run-1", cycle_id: "cycle-1" });
  assert.equal(r.status, "fail");
  assert.ok(r.issues.some((i) => i.code === "missing_operator_event_field"));
});

test("validateOperatorEventLedger: an event whose run_id mismatches the target run is rejected", () => {
  const r = validateOperatorEventLedger(
    { version: "operator-events.v1", events: [{ ...OK_EVENT, run_id: "run-OTHER" }] },
    { run_id: "run-1", cycle_id: "cycle-1" }
  );
  assert.ok(r.issues.some((i) => i.code === "operator_event_run_mismatch"));
});

test("validateOperatorEventLedger: a well-formed ledger with matching identity passes", () => {
  const r = validateOperatorEventLedger(
    { version: "operator-events.v1", events: [OK_EVENT] },
    { run_id: "run-1", cycle_id: "cycle-1" }
  );
  assert.equal(r.status, "pass");
});
