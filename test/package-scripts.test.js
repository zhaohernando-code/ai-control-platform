import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function packageScripts() {
  return JSON.parse(readFileSync("package.json", "utf8")).scripts;
}

test("default test scripts run through the Node18 wrapper", () => {
  const scripts = packageScripts();

  assert.match(scripts.test, /^node tools\/run-with-node18\.mjs --test test\/\*\.test\.js$/);
  assert.match(scripts["test:coverage"], /^node tools\/run-with-node18\.mjs --test --experimental-test-coverage /);
});
