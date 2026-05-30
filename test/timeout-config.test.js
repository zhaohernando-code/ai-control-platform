import assert from "node:assert/strict";
import test from "node:test";

import { resolveMs, resolveSeconds, lockTtlMsFor } from "../src/workflow/timeout-config.js";

test("resolveMs precedence: input snake > input camel > profile snake > profile camel > fallback", () => {
  assert.equal(resolveMs({ timeout_ms: 1 }, { timeout_ms: 9 }, "timeout", 99), 1);
  assert.equal(resolveMs({ timeoutMs: 2 }, { timeout_ms: 9 }, "timeout", 99), 2);
  assert.equal(resolveMs({}, { timeout_ms: 3 }, "timeout", 99), 3);
  assert.equal(resolveMs({}, { timeoutMs: 4 }, "timeout", 99), 4);
  assert.equal(resolveMs({}, {}, "timeout", 99), 99);
});

test("resolveMs/resolveSeconds use the right key suffix and ignore non-finite/negative", () => {
  assert.equal(resolveSeconds({ timeout_seconds: 7200 }, {}, "timeout", 30), 7200);
  assert.equal(resolveSeconds({ idle_timeout_seconds: 1800 }, {}, "idle_timeout", 60), 1800);
  assert.equal(resolveMs({ timeout_ms: "nope" }, {}, "timeout", 5), 5, "non-numeric ignored");
  assert.equal(resolveMs({ timeout_ms: -1 }, {}, "timeout", 5), 5, "negative ignored");
  assert.equal(resolveMs({ timeout_ms: 0 }, {}, "timeout", 5), 0, "zero is a valid explicit value");
});

test("lockTtlMsFor: never shorter than invocation + grace, floored at 10min", () => {
  // short invocation (3 min) -> floored to 10 min
  assert.equal(lockTtlMsFor(180000), 10 * 60 * 1000);
  // long invocation (20 min) -> invocation + 60s grace, above the floor
  assert.equal(lockTtlMsFor(20 * 60 * 1000), 20 * 60 * 1000 + 60000);
  // exactly at boundary: 9 min + 60s grace = 600000 == floor
  assert.equal(lockTtlMsFor(9 * 60 * 1000), 10 * 60 * 1000);
  // invalid -> floor
  assert.equal(lockTtlMsFor(NaN), 10 * 60 * 1000);
});

test("lockTtlMsFor: a config profile timeout (5min) yields a 10min lock, not a 5min one (the bug fix)", () => {
  // profiles set timeout_ms 120000..300000; all must produce a lock >= 10min so the lock
  // cannot expire while the invocation is still running.
  for (const t of [120000, 180000, 240000, 300000]) {
    assert.ok(lockTtlMsFor(t) >= 10 * 60 * 1000, `lock ttl for ${t}ms invocation must be >= 10min`);
    assert.ok(lockTtlMsFor(t) > t, "lock must outlive the invocation");
  }
});
