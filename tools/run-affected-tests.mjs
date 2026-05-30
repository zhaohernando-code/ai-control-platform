#!/usr/bin/env node
// Affected-test runner (門禁治理 phase 2): the `npm run test:affected` entrypoint. It is a
// DEVELOPMENT-TIME ACCELERATOR — the full `npm test` remains the authoritative closeout gate.
//
// Flow:
//   1. Reuse the phase-1 location guard (tools/check-test-location.mjs) so we never run from
//      the canonical checkout (would yield ~17 misleading headless failures).
//   2. Compute changed files from git (or accept them as CLI args).
//   3. Ask select-affected-tests.mjs for the decision.
//   4. decision "full" -> run the whole suite; "subset" -> run only the selected test files.
//      Either path runs through `node --test`, exactly like `npm test`.

import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { selectAffectedTests, changedFilesFromGit } from "./select-affected-tests.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", encoding: "utf8", ...opts });
}

// 1. location guard (same gate npm test's pretest uses) — fail fast with its clear message.
const guard = run(process.execPath, [resolve(here, "check-test-location.mjs")], { stdio: "inherit" });
if (guard.status !== 0) process.exit(guard.status ?? 2);

// 2. changed files: explicit CLI args win, else derive from git.
const argv = process.argv.slice(2);
const changed = argv.length > 0 ? argv : changedFilesFromGit();

if (changed.length === 0) {
  process.stdout.write("test:affected: no changed files detected vs origin/main — nothing to run.\n");
  process.stdout.write("(Run the full suite with `npm test` before closeout.)\n");
  process.exit(0);
}

// 3. selection
const result = selectAffectedTests(changed);

process.stdout.write(`test:affected: ${changed.length} changed file(s); decision=${result.decision}\n`);
for (const r of result.reasons || []) process.stdout.write(`  - ${r}\n`);
for (const w of result.warnings || []) process.stdout.write(`  ! ${w}\n`);

// 4. run
let testGlobArgs;
if (result.decision === "full") {
  process.stdout.write("Running FULL suite (could not prove a safe subset).\n\n");
  testGlobArgs = ["--test", "test/*.test.js"];
} else if (result.tests.length === 0) {
  process.stdout.write("No affected test files — change is not reached by any test.\n");
  process.stdout.write("(This is a coverage signal, not a pass. Closeout still requires `npm test`.)\n");
  process.exit(0);
} else {
  process.stdout.write(`Running ${result.tests.length}/72 affected test file(s):\n`);
  for (const t of result.tests) process.stdout.write(`  ${t}\n`);
  process.stdout.write("\n");
  testGlobArgs = ["--test", ...result.tests];
}

// Reuse the same canonical-test override the guard honors, so the node --test child (which
// triggers no pretest of its own) runs cleanly here in the worktree.
const test = run(process.execPath, testGlobArgs, {
  env: { ...process.env, AI_CONTROL_PLATFORM_ALLOW_CANONICAL_TEST: process.env.AI_CONTROL_PLATFORM_ALLOW_CANONICAL_TEST },
});
process.exit(test.status ?? 1);
