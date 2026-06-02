import assert from "node:assert/strict";
import test from "node:test";

import {
  ALLOWED_FIXTURE_FILE_STATE_FILES,
  createServerCallIssues
} from "../tools/check-workbench-state-boundary.mjs";

const FIXTURE_FILE_STATE_OPTION = "allowFixture" + "FileState";
const FIXTURE_SERVER_SOURCE = `
import { createWorkbenchServer } from "../tools/workbench-server.mjs";
createWorkbenchServer({ ${FIXTURE_FILE_STATE_OPTION}: true });
`;

test("state boundary allows only explicit workbench server fixture shards", () => {
  assert.ok(ALLOWED_FIXTURE_FILE_STATE_FILES.has("test/workbench-server.test.js"));
  assert.ok(ALLOWED_FIXTURE_FILE_STATE_FILES.has("test/workbench-server-agent-key-routes.test.js"));

  for (const file of ALLOWED_FIXTURE_FILE_STATE_FILES) {
    assert.deepEqual(createServerCallIssues(file, FIXTURE_SERVER_SOURCE), []);
  }
});

test("state boundary rejects unapproved fixture file-state callers", () => {
  const issues = createServerCallIssues("test/other-workbench-server.test.js", FIXTURE_SERVER_SOURCE);
  assert.deepEqual(issues.map((issue) => issue.code), ["workbench_fixture_file_state_not_allowed"]);
});

test("state boundary keeps tools out of fixture file-state mode", () => {
  const issues = createServerCallIssues("tools/example-workbench-tool.mjs", FIXTURE_SERVER_SOURCE);
  assert.deepEqual(issues.map((issue) => issue.code), [
    "workbench_fixture_file_state_not_allowed",
    "tool_uses_fixture_file_state"
  ]);
});

test("state boundary accepts explicit SQLite-backed server callers", () => {
  const issues = createServerCallIssues(
    "tools/example-workbench-tool.mjs",
    `
import { createWorkbenchServer } from "../tools/workbench-server.mjs";
createWorkbenchServer({ stateDbPath: "tmp/workbench.sqlite" });
`
  );
  assert.deepEqual(issues, []);
});
