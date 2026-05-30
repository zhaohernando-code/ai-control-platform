import assert from "node:assert/strict";
import test from "node:test";

import {
  userFacingProviderFailureReason,
  budgetLimitFromText,
  collectFailureText,
  hasInternalProviderValidationOnly
} from "../src/workflow/provider-failure-reason.js";

test("budgetLimitFromText extracts a dollar cap from varied phrasings", () => {
  assert.equal(budgetLimitFromText("--max-budget-usd 5"), "$5");
  assert.equal(budgetLimitFromText("budget limit reached: $12.50"), "$12.5");
  assert.equal(budgetLimitFromText("no money words here"), "");
});

test("userFacingProviderFailureReason: budget cap wins over everything", () => {
  const reason = userFacingProviderFailureReason({ explicitReason: "hit --max-budget-usd 8 cap" });
  assert.match(reason, /8 预算上限/);
});

test("userFacingProviderFailureReason: timeout classified with seconds", () => {
  const reason = userFacingProviderFailureReason({
    latestAttempt: { timed_out: true, command: { idle_timeout_seconds: 1800 } }
  });
  assert.match(reason, /超时/);
  assert.match(reason, /1800/);
});

test("userFacingProviderFailureReason: nonzero exit code", () => {
  const reason = userFacingProviderFailureReason({ latestAttempt: { exit_code: 137 } });
  assert.match(reason, /退出码 137/);
});

test("userFacingProviderFailureReason: hides internal-only validation text, prefers readable", () => {
  const reason = userFacingProviderFailureReason({
    failureIssues: [{ message: "provider executor result has not been validated" }, { message: "磁盘空间不足" }]
  });
  assert.equal(reason, "磁盘空间不足", "skips the internal-only line, surfaces the human one");
});

test("hasInternalProviderValidationOnly flags internal validation jargon", () => {
  assert.equal(hasInternalProviderValidationOnly("provider_executor_result_not_pass"), true);
  assert.equal(hasInternalProviderValidationOnly("磁盘空间不足"), false);
});

test("collectFailureText recurses through nested payloads", () => {
  const texts = collectFailureText({ result: { stderr: "boom" }, evidence: ["clue"] });
  assert.ok(texts.includes("boom"));
  assert.ok(texts.includes("clue"));
});
