# AI Governance Role Model

Status: active
Created at: 2026-06-08T00:00:00+08:00
Owner mode: AI-governed, evidence-first, no human code-detail review

## Purpose

This standard defines the daily governance operating model for AI-only projects where the owner cannot reliably review implementation details. It is designed for timer-triggered agent runs that must close already-known risks without depending on a multi-turn human review loop.

## Role Split

| Role | Primary responsibility | Authority boundary |
| --- | --- | --- |
| Codex | Start the isolated run and perform final review, gates, merge, push, and cleanup. | Codex may accept or reject work, but must not accept its own gate-policy changes without an independent read-only reviewer pass. |
| DS v4 Pro | Select targets, design the plan, define constraints, and review high-risk architecture or governance choices before implementation. | Pro is read-only during planning. It must not edit files or declare implementation complete. |
| DS v4 Flash | Land bounded mechanical changes from the approved Pro plan. | Flash must not weaken gates, delete assertions, expand scope, or mark risks/phases as closed. |

## Standard Run

1. Codex creates or confirms an isolated task worktree.
2. Codex runs readiness preflight for ignored dependencies and other deterministic local prerequisites.
3. Codex sends a bounded read-only planning prompt to DS v4 Pro.
4. DS v4 Pro returns the target, baseline, terminal condition, behavior inventory, owned files, required evidence, and prohibited shortcuts.
5. DS v4 Flash performs only bounded mechanical landing tasks, such as whole-block movement, import repair, parity artifact generation, manifest line-count refresh, and status-file updates.
6. Codex reviews the diff against the Pro plan and Flash output.
7. Codex runs focused gates, required independent DeepSeek review, full project gates, and live verification when user-visible runtime changes require it.
8. Codex merges, pushes, and cleans the worktree only after the evidence is sufficient.

## Review Contract

DS v4 Pro plan output must answer:

- A machine-readable verdict: `DS_PRO_PLAN_PASS` or `DS_PRO_PLAN_FAIL`.
- Which risk or target is selected and why.
- What exact files are owned by the run.
- What behavior must be preserved.
- What shortcuts are forbidden.
- What tests, parity artifacts, manifest checks, and closeout gates must pass.
- When the run must stop instead of trying to repair locally.

DS v4 Flash landing output must answer:

- Which approved mechanical tasks were completed.
- Which files changed.
- Which parity or accounting artifacts were generated.
- Whether any task exceeded the Pro-approved scope.
- `DS_FLASH_LANDING_PASS` or `DS_FLASH_LANDING_FAIL`.

Codex final review must answer:

- Whether the diff matches the Pro plan.
- Whether tests or assertions were deleted, skipped, renamed, or weakened.
- Whether manifest/accounting changes match real filesystem state.
- Whether all required gates and reviewer passes succeeded.
- Whether merge, push, runtime publish, and worktree cleanup were completed.

Independent read-only review output must be JSON with:

- `verdict`: `DS_CODE_PASS`, `DS_CODE_FAIL`, `DS_REVIEW_PASS`, or `DS_REVIEW_FAIL`.
- `blockers`: blocking findings that prevent closeout.
- `non_blocking_findings`: advisory findings that do not prevent closeout.
- `required_repairs`: concrete repairs required before merge.
- `confidence`: reviewer confidence or reason for low confidence.

## Acceptance Gates

Codex may accept and merge only when all applicable gates are true:

| Gate | Required condition |
| --- | --- |
| Plan | DS v4 Pro returned `DS_PRO_PLAN_PASS` with owned files, evidence, and prohibited shortcuts. |
| Landing | DS v4 Flash returned `DS_FLASH_LANDING_PASS`, or Codex explicitly records why the task was not mechanical and Flash landing was not used. |
| Diff review | Codex confirms the diff matches the approved plan and contains no assertion deletion, gate weakening, hidden scope expansion, or manifest ceiling increase. |
| Tests | Focused tests for touched behavior pass. |
| Project gates | `npm test`, `npm run check:large-files`, `git diff --check`, and `npm run check:closeout` pass unless a narrower documented policy explicitly supersedes them. |
| Independent review | Required read-only DeepSeek review returns a pass verdict with no blockers. |
| Runtime | User-visible runtime changes are published and verified on the served route before closeout. |
| Cleanup | Successful run worktrees are merged, pushed, and removed; failed worktrees are preserved only with recorded recovery evidence. |

## Escalation

If Codex final review finds a structural boundary problem, a weakened gate, missing parity evidence, or a scope expansion, the run must return to DS v4 Pro for a revised plan. Codex should not locally redesign the work unless the change is a narrow correction already authorized by the Pro plan.
