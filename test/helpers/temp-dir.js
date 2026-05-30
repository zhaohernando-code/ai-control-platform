// Shared test helper: create a temp directory that is automatically removed when the
// current test finishes, using node:test's per-test teardown (t.after). This replaces the
// repeated `const dir = mkdtempSync(join(tmpdir(), "..."))` with no cleanup that left
// scratch dirs accumulating under the OS temp root across runs (P2-9).
//
// Usage:
//   import { tempDir } from "./helpers/temp-dir.js";
//   test("…", (t) => { const dir = tempDir(t, "ai-control-platform-history-"); … });
//
// The directory is removed recursively (force) after the test, pass or fail. If no test
// context is available (e.g. top-level), it falls back to process-exit cleanup.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pendingExitCleanup = new Set();
let exitHookInstalled = false;

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const dir of pendingExitCleanup) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort on exit
      }
    }
  });
}

export function tempDir(t, prefix = "ai-control-platform-test-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  if (t && typeof t.after === "function") {
    t.after(() => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore — the dir may already be gone
      }
    });
  } else {
    installExitHook();
    pendingExitCleanup.add(dir);
  }
  return dir;
}
