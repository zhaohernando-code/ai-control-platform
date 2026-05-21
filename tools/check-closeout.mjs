#!/usr/bin/env node
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function run(label, args) {
  console.log(`\n[closeout] ${label}`);
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const testFiles = readdirSync("test")
  .filter((file) => file.endsWith(".test.js"))
  .sort()
  .map((file) => join("test", file));

run("unit tests", ["--test", ...testFiles]);
run("project onboarding", ["tools/check-project-onboarding-sync.mjs", "project-manifest.json", "/Users/hernando_zhao/codex/WORKSPACE_INDEX.json"]);
run("process hardening", ["tools/check-process-hardening.mjs", "docs/examples/process-hardening-current.json"]);
run("workbench browser events", ["tools/check-workbench-browser-events.mjs"]);
run("scheduler dispatch writeback", ["tools/check-scheduler-dispatch-writeback.mjs"]);

console.log("\n[closeout] pass");
