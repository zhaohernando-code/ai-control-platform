import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { tempDir } from "./helpers/temp-dir.js";

let leaked = "";

test("tempDir creates a usable directory", (t) => {
  const dir = tempDir(t, "ai-control-platform-helper-test-");
  assert.ok(existsSync(dir), "dir exists during the test");
  writeFileSync(join(dir, "f.txt"), "x");
  assert.ok(existsSync(join(dir, "f.txt")));
  leaked = dir; // capture to assert removal in a later test
});

test("tempDir removed the previous test's directory via t.after", () => {
  assert.notEqual(leaked, "");
  assert.equal(existsSync(leaked), false, "dir is cleaned up after the owning test finishes");
});
