import assert from "node:assert/strict";
import test from "node:test";

import {
  createArtifactLedger,
  recordArtifact,
  summarizeArtifactLedger,
  validateArtifactLedger
} from "../src/workflow/artifact-ledger.js";

test("artifact ledger validates artifacts with evidence", () => {
  const ledger = createArtifactLedger({
    run_id: "run-c",
    cycle_id: "cycle-20260521",
    artifacts: [
      {
        id: "context-pack",
        type: "context_pack",
        status: "pass",
        path: "docs/contracts/CONTEXT_PACK_CN.md",
        producer: "main-process",
        created_at: "2026-05-21T00:00:00.000Z"
      },
      {
        id: "patch-hash",
        type: "patch",
        status: "pass",
        content_hash: "sha256:abc123",
        producer: "agent-c",
        created_at: "2026-05-21T00:01:00.000Z"
      }
    ]
  });

  const validation = validateArtifactLedger(ledger);

  assert.equal(validation.status, "pass");
});

test("artifact ledger fails when an artifact lacks path uri or content hash", () => {
  const ledger = createArtifactLedger({
    run_id: "run-c",
    cycle_id: "cycle-20260521",
    artifacts: [
      {
        id: "review",
        type: "review",
        status: "fail",
        producer: "llm-reviewer",
        created_at: "2026-05-21T00:02:00.000Z"
      }
    ]
  });

  const validation = validateArtifactLedger(ledger);

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some((issue) => issue.code === "missing_artifact_evidence"));
});

test("recordArtifact returns a new ledger and summary counts by type and status", () => {
  const ledger = createArtifactLedger({
    run_id: "run-c",
    cycle_id: "cycle-20260521",
    artifacts: [
      {
        id: "requirement",
        type: "requirement",
        status: "pass",
        uri: "codex://thread/request",
        producer: "user",
        created_at: "2026-05-21T00:00:00.000Z"
      }
    ]
  });

  const nextLedger = recordArtifact(ledger, {
    id: "unit-tests",
    type: "test",
    status: "fail",
    path: "test/artifact-ledger.test.js",
    producer: "agent-c",
    created_at: "2026-05-21T00:03:00.000Z"
  });
  const summary = summarizeArtifactLedger(nextLedger);

  assert.notEqual(nextLedger, ledger);
  assert.equal(ledger.artifacts.length, 1);
  assert.equal(nextLedger.artifacts.length, 2);
  assert.deepEqual(summary, {
    total: 2,
    by_type: { requirement: 1, test: 1 },
    by_status: { pass: 1, fail: 1 }
  });
});
