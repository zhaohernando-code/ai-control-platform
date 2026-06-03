# Large File Anti-Abuse and Reduction Plan

Status: in_progress
Created at: 2026-06-03T09:45:00+08:00
Updated at: 2026-06-03T10:50:00+08:00
Owner mode: AI-governed, evidence-first, no human code-detail review

## Current Decision

The current `.largefile-manifest.json` mechanism is insufficient as a hard governance gate. It records known large files and detects stale line counts, but it can still be abused by an automated agent that raises the manifest line count in the same change that grows the file.

This plan changes the governance model:

- `.largefile-manifest.json` is a debt ceiling ledger, not an exemption list.
- Existing large files may hold steady or shrink; they may not grow by updating the ledger.
- New large files may not be added to the ledger as a normal bypass.
- A large-file governance phase is not complete merely because a file shrank a little. It must meet a material reduction target or explicitly remain open.

## Scope

This plan covers two tracks:

- **Anti-abuse gate hardening**: prevent future changes from increasing large-file debt through manifest edits, new files, or accepted/planned status changes.
- **Existing large-file reduction**: replace conservative "small shrink equals complete" behavior with measurable terminal criteria.

This plan does not replace `docs/governance/LARGE_FILE_GOVERNANCE_PLAN.md`; it supersedes the weak parts of its gate semantics and defines the next active phases.

## Current Baseline

Source: `.largefile-manifest.json` and `node tools/run-with-node18.mjs tools/report-large-files.mjs` on 2026-06-03.

| Metric | Count |
| --- | ---: |
| Manifest entries | 31 |
| Files currently above 500 lines | 25 |
| `planned_refactor` files above 500 lines | 16 |
| `accepted` files above 500 lines | 9 |
| Manifest entries already below threshold | 6 |

Highest active reduction targets:

| Priority | File | Lines | Status | Required terminal direction |
| --- | --- | ---: | --- | --- |
| LFA-Q01 | `test/workbench-server.test.js` | 4214 | `planned_refactor` | Split to domain shards until the root shard is below 2500 lines, then continue until below 1500 unless explicitly reaccepted with evidence. |
| LFA-Q02 | `tools/workbench-server.mjs` | 3447 | `planned_refactor` | Extract route/service groups until the entrypoint is below 2000 lines, then continue toward below 1200. |
| LFA-Q03 | `test/workbench-projection.test.js` | 3175 | `planned_refactor` | Split schema/domain suites until the root shard is below 1800 lines, then continue toward below 1200. |
| LFA-Q04 | `src/workflow/headless-cli-orchestrator.js` | 1855 | `planned_refactor` | Extract runner dispatch and continuation packaging until below 1200 lines. |
| LFA-Q05 | `test/headless-cli-orchestrator.test.js` | 1745 | `planned_refactor` | Split by acceptance, provider, continuation, and projected-action fixtures until below 1200 lines. |

## State Vocabulary

| Status | Meaning |
| --- | --- |
| `pending` | Defined but not started. |
| `in_progress` | Implementation or evidence collection has started. |
| `review_pending` | Local work exists and awaits DeepSeek review. |
| `pass` | Acceptance gates and DeepSeek review passed. |
| `blocked` | Cannot continue without a concrete dependency or policy decision. |
| `superseded` | Replaced by a later plan or stricter gate. |

## Non-Negotiable Rules

1. Manifest line counts are ceilings. A change that increases a manifest line count fails unless it is a temporary exception file approved by a dedicated policy and reviewer record.
2. `accepted` is not a growth permit. Accepted files may not grow above their recorded line count.
3. `planned_refactor` means "must shrink or split"; it cannot continue receiving unrelated logic.
4. `growth_justification`, `split_plan`, `next_split_plan`, and `refactor_plan` may explain work, but they cannot make growth pass.
5. New tracked source/test/tool files above 500 lines fail even if the same change adds them to the manifest.
6. Total large-file debt must not increase. Debt is the sum of line counts for tracked `.js`, `.ts`, `.tsx`, `.py`, and `.css` files above the threshold.
7. Extracted modules above 500 lines are warnings. Extracted modules above 800 lines fail unless they map to one named domain concern, are directly required by the active reduction target, and carry a two-phase stabilization target.
8. A phase may not be marked complete unless the target file meets a material shrink target or is explicitly left open with a next reduction target.
9. The anti-abuse gate must scan tracked filesystem files, not only manifest entries. Any tracked source/test/tool file above the threshold is counted whether or not it appears in the manifest.
10. Baseline comparison must use the merge base against `origin/main` for ordinary task branches and must report any manifest ceiling increase relative to that base. A dedicated baseline artifact or tag may be introduced later, but it may not be advanced by the same implementation run that raises ceilings.
11. No implementation agent may accept its own gate-policy or manifest-ceiling change. Gate-policy changes require deterministic local tests plus a separate read-only reviewer artifact from another model invocation, with the reviewer instructed to look for bypasses.
12. A separate read-only reviewer invocation means a fresh non-interactive model process, no write tools, bounded focus files, no reliance on the implementation agent's summary as evidence, and a reviewer prompt that asks for bypass/fail-open findings before acceptance.

## Material Reduction Criteria

For files above 2000 lines:

- A phase must reduce the target by at least 25% or at least 500 lines, whichever is smaller.
- The only threshold-crossing shortcut is dropping below the next lower bracket floor: 2000, 1000, or 500 lines.
- Even when crossing a bracket floor, a phase must still reduce at least 15% of its starting line count.
- Reducing a 3000-line file by 100-200 lines is progress, not completion.

For files between 1000 and 2000 lines:

- A phase must reduce the target by at least 20% or at least 250 lines, whichever is smaller.
- The only threshold-crossing shortcut is dropping below the next lower bracket floor: 1000 or 500 lines.
- Even when crossing a bracket floor, a phase must still reduce at least 15% of its starting line count.

For files between 500 and 1000 lines:

- A phase must either drop the file below 500 lines or reduce it by at least 150 lines and create a concrete follow-up target.

For accepted files:

- Accepted status must be refreshed only when the file is stable, below a domain-specific ceiling, and covered by a reason that explains why further splitting would reduce clarity.
- Accepted files over 750 lines must carry a `rechallenge_due` date or phase marker. If the marker is missing or expired, the gate must report the entry as needing planned-refactor review.

## Anti-Gaming Coverage

The gate must explicitly cover these bypass classes:

| Bypass class | Required gate behavior |
| --- | --- |
| Raise manifest lines with file growth | Fail: manifest ceiling increases are not allowed in ordinary implementation branches. |
| Mark growth as `accepted` or add `growth_justification` | Fail: status and justification do not override the ceiling. |
| Rename a large file to escape the manifest key | Fail: tracked filesystem scan counts any >500-line file; follow-up similarity detection should identify likely renames. |
| Add a new >500-line file and register it in the manifest | Fail by default unless a dedicated exception policy exists and is reviewed separately. |
| Add many near-threshold files | Warn or fail through a secondary 300-line complexity budget. |
| Split into 600-800 line coherent domain shards | Allow with warning and stabilization target; do not force harmful micro-shards. |
| Split into >800 line broad shards | Fail unless the shard is the active target and maps to one named domain concern. |

## Phase Plan

### Phase LFA-P0: Mechanism Review and Plan Baseline

Status: pass

Goal: prove that the new anti-abuse model addresses the observed failure mode before code changes.

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFA-P0.1 | Record baseline and abuse model | This document | Plan states current counts, bypass vectors, and debt-ceiling semantics. | pass |
| LFA-P0.2 | Define material reduction criteria | This document | Plan rejects tiny shrink as terminal completion for large files. | pass |
| LFA-P0.3 | DeepSeek mechanism review | `docs/examples/reviewer-risk-20260603-large-file-anti-abuse-plan-deepseek.json` | DS initially rejected the plan with three blockers: threshold shortcut, reviewer circularity, and overstrict extracted-module thresholds. | fail |
| LFA-P0.4 | Address review blockers | This document | Plan closes the threshold shortcut, reviewer-independence, and extracted-module overconstraint blockers. | pass |
| LFA-P0.5 | DeepSeek delta review | `docs/examples/reviewer-risk-20260603-large-file-anti-abuse-plan-deepseek.json` | DS delta review returned PASS with no blocking findings. | pass |

### Phase LFA-P1: Anti-Abuse Gate Implementation

Status: pass

Goal: make `npm run check:large-files` fail when a change increases large-file debt or raises manifest ceilings.

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFA-P1.1 | Add baseline comparison mode | `tools/report-large-files.mjs` | Report compares current manifest/files against the merge base of `origin/main`, or an explicit `--base-ref`. | pass |
| LFA-P1.2 | Reject manifest line-count increases | `tools/report-large-files.mjs`; `test/large-file-report.test.js` | A test proves raising `files[path].lines` fails even when current file line count matches the raised value. | pass |
| LFA-P1.3 | Reject known large-file growth for all statuses | `tools/report-large-files.mjs`; tests | `accepted` and `planned_refactor` files fail when current lines exceed base lines. | pass |
| LFA-P1.4 | Reject new large-file manifest bypass | `tools/report-large-files.mjs`; tests | Adding a new >500-line file plus a manifest entry in the same change fails by default. | pass |
| LFA-P1.5 | Add total-debt gate | `tools/report-large-files.mjs`; tests | Sum of tracked filesystem lines above threshold cannot increase relative to base, independent of manifest entries. | pass |
| LFA-P1.6 | Add near-threshold budget | `tools/report-large-files.mjs`; tests | New files above 300 lines are reported, and excessive near-threshold growth fails without an explicit bounded extraction reason. | pass |
| LFA-P1.7 | Add accepted re-challenge check | `.largefile-manifest.json`; `test/large-file-report.test.js` | Accepted files over 750 lines require an unexpired `rechallenge_due` marker. | pass |
| LFA-P1.8 | Add reviewer anti-self-dealing rule | This document and tests if applicable | Gate-policy and manifest-ceiling changes require deterministic local tests plus a fresh no-write reviewer invocation that inspects bypass risk directly. | pass |
| LFA-P1.9 | DeepSeek implementation review | `docs/examples/reviewer-risk-20260603-large-file-anti-abuse-p1-deepseek.json` | DS initially rejected `--disable-baseline`; delta returned PASS after the CLI bypass was removed. The internal programmatic bypass noted as non-blocking was also removed. | pass |

Required gates:

```bash
node tools/run-with-node18.mjs --test test/large-file-report.test.js test/select-affected-tests.test.js test/governance-enrollment.test.js
npm run check:large-files
git diff --check
```

### Phase LFA-P2: Reduction Target Enforcement

Status: in_progress

Goal: prevent "minor shrink equals complete" reporting for existing large files.

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFA-P2.1 | Add target metadata schema | `.largefile-manifest.json` or companion policy file | Each `planned_refactor` item can state `target_lines`, `minimum_reduction`, and `terminal_condition`. | pending |
| LFA-P2.2 | Add completion validator | `tools/report-large-files.mjs` or a dedicated checker | A phase cannot be marked pass if the target file misses its material reduction criteria. | pending |
| LFA-P2.3 | Update large-file queue | This document and manifest/policy metadata | Top queue items have explicit next thresholds, not vague "continue splitting" instructions. | pending |
| LFA-P2.4 | DeepSeek reduction-policy review | Reviewer artifact | DS confirms the criteria prevent premature closeout. | pending |

### Phase LFA-P3: First Strict Reduction Run

Status: pending

Goal: apply the stricter rules to the highest-priority file instead of doing a small symbolic split.

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFA-P3.1 | Select one high-priority target | Status update in this document | Selection uses line count, blast radius, and available behavior-preserving test seam. | pending |
| LFA-P3.2 | Reduce by material target | Code/test split | Selected target meets the phase reduction criterion or remains open. | pending |
| LFA-P3.3 | Run target gates and full governance gate | Command evidence | Target tests, `npm run check:large-files`, and relevant closeout gates pass. | pending |
| LFA-P3.4 | DeepSeek reduction review | Reviewer artifact | DS confirms the split reduced complexity rather than hiding it. | pending |

## Acceptance Tracking

| Phase | Status | Latest evidence | Reviewer |
| --- | --- | --- | --- |
| LFA-P0 | pass | Initial DS review failed with three blockers; plan was revised; delta DS review passed with no blocking findings. | DeepSeek PASS after delta |
| LFA-P1 | pass | Baseline anti-abuse gate implemented; focused tests, `npm test`, `npm run check:large-files`, `npm run check:closeout`, and `git diff --check` passed. | DeepSeek PASS after delta |
| LFA-P2 | in_progress | Reduction target enforcement selected as the next active phase. | pending |
| LFA-P3 | pending | Not started. | pending |

## Daily Run Shape

Each future scheduled run must:

1. Run the anti-abuse large-file gate before selecting a reduction target.
2. Reject changes that raise manifest ceilings or total large-file debt.
3. Select at most one planned-refactor target unless an explicit multi-file extraction risk exists.
4. State the target file, base line count, required reduction, and terminal threshold before editing.
5. Treat sub-target progress as `in_progress`, not `pass`.
6. Run local gates and DeepSeek review before merge.
7. Clean the worktree only after merge/push and, if runtime-facing, publish verification.
