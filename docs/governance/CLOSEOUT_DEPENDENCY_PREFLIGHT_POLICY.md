# Closeout Dependency Preflight Policy

Status: active
Created at: 2026-06-08T00:00:00+08:00
Owner mode: AI-governed, deterministic closeout readiness

## Purpose

Fresh isolated worktrees do not contain ignored `node_modules` directories. Full closeout must not repeatedly fail midway because Playwright or the Workbench Next.js runtime is absent. `npm run check:closeout` owns this readiness check before any expensive or browser-based gate runs.

## Required Dependencies

| Dependency | Directory | Resolution check | Repair command |
| --- | --- | --- | --- |
| Root Playwright | repo root | `playwright` resolves from root `package.json` | `npm ci` |
| Workbench Next.js | `apps/workbench` | `next` resolves from `apps/workbench/package.json` | `npm ci` |

## Rules

1. The dependency readiness preflight runs at the top of `tools/check-closeout.mjs`.
2. If all required dependencies resolve, closeout skips installation and continues.
3. If a dependency is missing, closeout runs `npm ci` only in the directory that owns the missing dependency.
4. `AI_CONTROL_CLOSEOUT_FORCE_DEPENDENCY_INSTALL=1` forces `npm ci` in all required dependency directories.
5. `AI_CONTROL_CLOSEOUT_SKIP_DEPENDENCY_PREFLIGHT=1` disables installation; if dependencies are missing, closeout fails before running any later gate.
6. Missing `package-lock.json` fails closed because reproducible install state is required.
7. Any `npm ci` error, non-zero status, signal, or timeout fails closed.
8. Installation is not considered successful until the dependency resolves after `npm ci`.
9. The preflight may modify ignored dependency directories only; it must not update tracked package metadata.
10. A closeout run is not complete if this preflight fails or is bypassed while dependencies are missing.

## Exit Codes

| Exit code | Meaning |
| ---: | --- |
| 2 | Required lockfile is missing. |
| 3 | `npm ci` failed, errored, timed out, or was interrupted. |
| 4 | Dependency install was skipped by env and required dependencies are missing. |
| 5 | Dependencies still do not resolve after install. |

## Evidence

Every full closeout run should show a `[closeout] dependency readiness` block. The block records whether dependency install was skipped, installed, or failed before the remaining closeout gates start.
