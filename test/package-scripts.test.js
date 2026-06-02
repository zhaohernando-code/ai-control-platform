import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function packageScripts() {
  return JSON.parse(readFileSync("package.json", "utf8")).scripts;
}

function checkCloseoutScript() {
  return readFileSync("tools/check-closeout.mjs", "utf8");
}

test("default test scripts run through the Node18 wrapper", () => {
  const scripts = packageScripts();

  assert.match(scripts.test, /^node tools\/run-with-node18\.mjs --test test\/\*\.test\.js$/);
  assert.match(scripts["test:coverage"], /^node tools\/run-with-node18\.mjs --test --experimental-test-coverage .* test\/\*\.test\.js$/);
});

test("closeout unit test gate does not force a divergent test-runner exit mode", () => {
  const script = checkCloseoutScript();

  assert.doesNotMatch(script, /--test-force-exit/);
  assert.match(script, /run\("unit tests", \["--test", \.\.\.testFiles\]/);
  assert.match(script, /timeout: CLOSEOUT_CHILD_TIMEOUT_MS/);
});
