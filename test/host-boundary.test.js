import assert from "node:assert/strict";
import test from "node:test";

import { assertHostBoundary, classifyHost, inferRequestedDomain } from "../src/workflow/host-boundary.js";

test("platform terms infer platform_core domain", () => {
  const result = inferRequestedDomain("建立一个新的中台，包含任务调度和 LLM Reviewer");
  assert.equal(result.domain, "platform_core");
  assert.ok(result.matchedTerms.includes("中台"));
});

test("platform work cannot target stock_dashboard", () => {
  const result = classifyHost({
    request: "把中台工作台 projection 做出来",
    targetProjectId: "stock_dashboard"
  });

  assert.equal(result.allowed, false);
  assert.equal(result.requiredHost, "ai-control-platform");
});

test("platform work is accepted in ai-control-platform", () => {
  const result = assertHostBoundary({
    request: "实现中台任务 DAG 和 Recovery Engine",
    targetProjectId: "ai-control-platform"
  });

  assert.equal(result.allowed, true);
  assert.equal(result.classification, "platform_core");
});

test("explicit adapter work is allowed with integration classification", () => {
  const result = classifyHost({
    request: "为 stock_dashboard 增加中台只读接入适配器",
    targetProjectId: "stock_dashboard",
    explicitAdapter: true
  });

  assert.equal(result.allowed, true);
  assert.equal(result.classification, "integration_adapter");
});

