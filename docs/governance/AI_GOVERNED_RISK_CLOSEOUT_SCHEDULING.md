# AI Governed Risk Closeout Scheduling

## Purpose

This document defines the timer-facing preflight entrypoint for known-risk closeout. The current entrypoint is intentionally dry-run by default: it selects bounded risks, evaluates the ledger structure gate, inspects lock state, and writes a machine-readable run artifact without mutating the ledger, branches, locks, or worktrees.

The current entrypoint does not repair risks, execute per-risk acceptance gates, obtain reviewer verdicts, merge branches, publish runtime changes, or close risks. A dry-run artifact is a scheduling and readiness artifact only.

## Command

```bash
npm run run:known-risk-closeout -- --max-risks 2 --output docs/examples/known-risk-closeout-run.json
```

Equivalent direct command:

```bash
node tools/run-with-node18.mjs tools/run-known-risk-closeout.mjs \
  --dry-run \
  --max-risks 2 \
  --output docs/examples/known-risk-closeout-run.json
```

## Scheduling Contract

- Run from an isolated project checkout or a clean canonical checkout.
- Keep `--dry-run` until P7 write-mode orchestration is explicitly implemented and reviewed by DeepSeek.
- Use `--max-risks` to bound each timer invocation.
- Use `--risk-id` for a targeted maintenance run.
- Preserve the output artifact as the durable handoff for the next agent run.
- Treat non-zero exit as a failed governance run, not as permission to skip the ledger.
- Treat zero exit as preflight success only; it is not evidence that selected risks were remediated.

## Artifact Contract

The run artifact uses `version: "known-risk-closeout-run.v1"`, `status: "preflight_pass"`, `preflight_only: true`, and `closeout_completed: false` for successful dry runs. It includes:

- `run_id`
- `mode`
- `selected_risks`
- `stale_in_progress`
- `gates`
- `reviewers`
- `release_decision`
- `cleanup`

## Current Limitation

Write mode is intentionally not implemented in this phase. The dry-run entrypoint is the scheduling harness that P7 or later phases can connect to actual repair orchestration after independent DeepSeek review.
