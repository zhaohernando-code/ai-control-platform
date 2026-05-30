#!/usr/bin/env node
// Pretest hermeticity guard (P2 test-trust): a subset of the suite drives the headless
// orchestrator down its real child-worker path, which by design REFUSES to run code-output
// work packages in the PRIMARY/canonical checkout (code_output_requires_isolated_worktree).
// Running `npm test` directly in the canonical checkout therefore produces ~17 cryptic
// "blocked !== pass" failures that look like broken code but are really "wrong location".
//
// This guard turns that into ONE clear, early, actionable error — and is the documented
// rule that the suite must run from an isolated task worktree (per CODEX.md), not the
// canonical checkout. Override for intentional canonical runs with
// AI_CONTROL_PLATFORM_ALLOW_CANONICAL_TEST=1.

import { resolve } from "node:path";
import { realpathSync } from "node:fs";

// Resolve through symlinks so comparisons are robust (e.g. macOS /tmp -> /private/tmp).
function realPath(p) {
  try {
    return realpathSync(resolve(p));
  } catch {
    return resolve(p);
  }
}

const cwd = realPath(process.cwd());
const primary = realPath(
  process.env.AI_CONTROL_PLATFORM_PRIMARY_WORKTREE ||
  "/Users/hernando_zhao/codex/projects/ai-control-platform"
);

// Mirror context-work-package-runner.js isWorkerWorktree(): a worker worktree either lives
// under a `worker-workspaces` path segment, or is simply not the primary checkout.
const inWorkerWorkspaces = cwd.split(/[\\/]+/).includes("worker-workspaces");
const isPrimary = cwd === primary;

if (isPrimary && !inWorkerWorkspaces && process.env.AI_CONTROL_PLATFORM_ALLOW_CANONICAL_TEST !== "1") {
  process.stderr.write(
    [
      "",
      "✗ refusing to run the test suite from the PRIMARY (canonical) checkout:",
      `    ${cwd}`,
      "",
      "  The headless-orchestrator tests exercise the real child-worker path, which by",
      "  design blocks code-output execution in the primary worktree. Running here yields",
      "  ~17 misleading 'blocked !== pass' failures that are NOT real defects.",
      "",
      "  Run the suite from an isolated task worktree instead, e.g.:",
      "    git worktree add -b task/<name> \\",
      "      ../../worker-workspaces/ai-control-platform/<yyyymmdd>-<name> origin/main",
      "    cd ../../worker-workspaces/ai-control-platform/<yyyymmdd>-<name> && npm test",
      "",
      "  (Intentional canonical run: set AI_CONTROL_PLATFORM_ALLOW_CANONICAL_TEST=1.)",
      ""
    ].join("\n")
  );
  process.exit(2);
}
