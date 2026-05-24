import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateWorkerRuntimeReadiness
} from "../src/workflow/worker-runtime-readiness.js";
import {
  parseWorkerRuntimeReadinessArgs
} from "../tools/check-worker-runtime-readiness.mjs";

test("browser-backed scripts fail closed when playwright is absent", () => {
  const result = evaluateWorkerRuntimeReadiness({
    scripts: ["check:workbench:browser-events"],
    package_availability: {
      playwright: { available: false, error_code: "MODULE_NOT_FOUND" }
    }
  });

  assert.equal(result.status, "fail");
  assert.deepEqual(result.required_packages, ["playwright"]);
  assert.equal(result.issues[0]?.code, "missing_runtime_dependency");
  assert.equal(result.issues[0]?.dependency, "playwright");
  assert.ok(result.issues[0]?.requested_by.some((item) => item.matched === "check:workbench:browser-events"));
});

test("browser-backed scripts pass when playwright is present", () => {
  const result = evaluateWorkerRuntimeReadiness({
    scripts: ["check:closeout"],
    package_availability: {
      playwright: { available: true, resolved: "/repo/node_modules/playwright/index.js" }
    }
  });

  assert.equal(result.status, "pass");
  assert.deepEqual(result.required_packages, ["playwright"]);
  assert.equal(result.issues.length, 0);
});

test("commands containing browser scripts or playwright-backed tools require playwright", () => {
  const result = evaluateWorkerRuntimeReadiness({
    commands: [
      "npm run check:scheduler-dispatch-writeback",
      ["node", "tools/check-workbench-frontend-acceptance.mjs", "--output", "tmp/run.json"]
    ],
    package_availability: {
      playwright: { available: false }
    }
  });

  assert.equal(result.status, "fail");
  assert.ok(result.detections.some((item) => item.kind === "command_script" && item.matched === "check:scheduler-dispatch-writeback"));
  assert.ok(result.detections.some((item) => item.kind === "command_tool" && item.matched === "tools/check-workbench-frontend-acceptance.mjs"));
});

test("non-browser scripts do not require playwright", () => {
  const result = evaluateWorkerRuntimeReadiness({
    scripts: ["check:process-hardening"],
    commands: ["node --test test/process-hardening.test.js"],
    package_availability: {
      playwright: { available: false }
    }
  });

  assert.equal(result.status, "pass");
  assert.deepEqual(result.required_packages, []);
  assert.equal(result.issues.length, 0);
});

test("CLI parser accepts repeated scripts and raw command args", () => {
  assert.deepEqual(
    parseWorkerRuntimeReadinessArgs([
      "--script",
      "check:closeout",
      "--script",
      "check:process-hardening",
      "--",
      "npm",
      "run",
      "check:workbench:browser-events"
    ]),
    {
      scripts: ["check:closeout", "check:process-hardening"],
      commands: [["npm", "run", "check:workbench:browser-events"]]
    }
  );
});
