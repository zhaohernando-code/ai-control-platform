import assert from "node:assert/strict";
import test from "node:test";

import { toCloseoutResult, allClosed, aggregateCloseout } from "../src/workflow/closeout-contract.js";

test("toCloseoutResult: canonical {status,issues} passes through", () => {
  assert.deepEqual(toCloseoutResult({ status: "pass", issues: [] }), { status: "pass", issues: [] });
  assert.deepEqual(toCloseoutResult({ status: "fail", issues: ["x"] }), { status: "fail", issues: ["x"] });
});

test("toCloseoutResult: issues present forces fail even if status says pass (fail-closed)", () => {
  assert.deepEqual(toCloseoutResult({ status: "pass", issues: ["leak"] }), { status: "fail", issues: ["leak"] });
});

test("toCloseoutResult: reads alias keys reasons/failures/errors/blocked_reasons", () => {
  assert.deepEqual(toCloseoutResult({ reasons: ["r1"] }), { status: "fail", issues: ["r1"] });
  assert.deepEqual(toCloseoutResult({ failures: ["f1"] }), { status: "fail", issues: ["f1"] });
  assert.deepEqual(toCloseoutResult({ errors: ["e1"] }), { status: "fail", issues: ["e1"] });
  assert.deepEqual(toCloseoutResult({ blocked_reasons: [{ code: "c1" }] }), { status: "fail", issues: ["c1"] });
});

test("toCloseoutResult: fail-synonym status (failed/error/timeout) maps to fail", () => {
  for (const s of ["failed", "error", "errored", "timeout", "blocked"]) {
    assert.equal(toCloseoutResult({ status: s }).status, "fail", `${s} -> fail`);
  }
});

test("toCloseoutResult: bare boolean/string coercion", () => {
  assert.deepEqual(toCloseoutResult(true), { status: "pass", issues: [] });
  assert.deepEqual(toCloseoutResult(false), { status: "fail", issues: ["unspecified closeout failure"] });
  assert.equal(toCloseoutResult("pass").status, "pass");
  assert.equal(toCloseoutResult("fail").status, "fail");
  assert.equal(toCloseoutResult("").status, "pass", "empty/unknown is not a failure by itself");
  assert.equal(toCloseoutResult(null).status, "pass");
});

test("toCloseoutResult: object findings are stringified via message/code", () => {
  assert.deepEqual(toCloseoutResult({ issues: [{ message: "boom" }, { code: "E1" }] }), { status: "fail", issues: ["boom", "E1"] });
});

test("allClosed: true only when every result passes", () => {
  assert.equal(allClosed({ status: "pass" }, { status: "pass", issues: [] }), true);
  assert.equal(allClosed({ status: "pass" }, { status: "fail", issues: ["x"] }), false);
  assert.equal(allClosed([{ status: "pass" }, true]), true);
});

test("aggregateCloseout: unions issues and fails if any fails", () => {
  assert.deepEqual(
    aggregateCloseout([{ status: "pass" }, { reasons: ["a"] }, { status: "fail", issues: ["b"] }]),
    { status: "fail", issues: ["a", "b"] }
  );
  assert.deepEqual(aggregateCloseout([{ status: "pass" }, true]), { status: "pass", issues: [] });
});
