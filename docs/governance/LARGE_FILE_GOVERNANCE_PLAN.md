# Large File Governance Status Plan

Status: pending  
Created at: 2026-06-02T15:00:00+08:00  
Updated at: 2026-06-02T15:08:00+08:00  
Owner mode: AI-governed, evidence-first, no human code-detail review  

## Current Decision

`docs/governance/AI_GOVERNED_RISK_CLOSEOUT_PLAN.md` is not archived in this phase.

Reason:

- The file is still a required input for the `ai-governed-risk-closeout` skill contract.
- P6/P7 remain intentionally dry-run/fail-closed for unattended write mode.
- Verification showed `test/known-risk-closeout-runner.test.js` currently fails after all known risks are terminal because one dry-run assertion still expects one selected open risk. This is a closeout-runner maintenance item, not part of large-file governance.

Archive condition for the closeout plan:

- A replacement closeout runbook or archived index exists at the required path.
- Timer-triggered write-mode semantics are either implemented and DeepSeek-reviewed or explicitly removed from the plan.
- `node tools/run-with-node18.mjs --test test/risk-closeout-orchestrator-contract.test.js test/known-risk-closeout-runner.test.js` passes when the ledger has zero open risks.

The large-file plan does not replace the closeout plan yet. The closeout plan can stop being a required live input only after LFG-P2 converts large-file items into known-risk work packages and a separate closeout-plan maintenance task updates the skill contract to point at an archived index or successor runbook.

## Objective

Turn `.largefile-manifest.json` `planned_refactor` entries into a bounded, daily-governable repair queue. Each selected large-file item must either:

- shrink below the 500-line governance threshold,
- split into smaller owned modules with behavior-preserving tests,
- split tests into maintainable shards without weakening coverage,
- or remain explicitly accepted with a fresh evidence-backed reason.

The goal is not to refactor every large file in one run. The goal is that each discovered large-file governance item has an auditable state, acceptance gates, independent model review, and clear next action.

## Ground Rules

- Work only from isolated task worktrees for edits.
- Do not increase `.largefile-manifest.json` line counts to avoid refactor pressure.
- Do not mark a phase complete without command evidence and a read-only DeepSeek pass.
- Runtime-facing files require Next build and served-route/browser verification after merge.
- Test-only splits must prove that existing behavior coverage is preserved.
- If a file cannot be reduced safely in one run, create a smaller follow-up plan item rather than doing broad refactor.

## State Vocabulary

| Status | Meaning |
| --- | --- |
| `pending` | Defined but not started. |
| `in_progress` | Current bounded phase is being worked. |
| `blocked` | Cannot continue without a concrete dependency or policy decision. |
| `review_pending` | Implementation or plan exists and awaits DeepSeek review. |
| `pass` | Acceptance gates and DeepSeek review passed. |
| `archived` | Superseded by a newer durable plan or terminal evidence. |

## Current Large-File Queue

The current source of truth is `.largefile-manifest.json`, `reviewed_at: 2026-06-02`.

Priority order is line-count first, then runtime/contract blast radius. This favors the largest files, but keeps source/runtime boundaries ahead of pure test sharding when the line counts are close. Test files remain high priority because they currently hide broad fixture coupling and make behavior-preserving source splits harder to validate.

| Priority | File | Lines | Current manifest status | Governance intent |
| --- | --- | ---: | --- | --- |
| LFG-Q01 | `test/workbench-server.test.js` | 4353 | `planned_refactor` | Split server API/live/static/state-store tests into domain shards. |
| LFG-Q02 | `tools/workbench-server.mjs` | 3516 | `planned_refactor` | Continue extracting route groups and runtime service bridges. |
| LFG-Q03 | `test/workbench-projection.test.js` | 3294 | `planned_refactor` | Split projection schema/domain regression suites. |
| LFG-Q04 | `src/workflow/headless-cli-orchestrator.js` | 2090 | `planned_refactor` | Extract worker planning, acceptance, and continuation packaging. |
| LFG-Q05 | `test/headless-cli-orchestrator.test.js` | 2054 | `planned_refactor` | Split orchestrator tests along extracted domains. |
| LFG-Q06 | `src/workflow/workbench-projection.js` | 1944 | `planned_refactor` | Extract project-management and next-action readout domains. |
| LFG-Q07 | `test/frontend-acceptance.test.js` | 1595 | `planned_refactor` | Split content, browser error, route, and command-architecture validators. |
| LFG-Q08 | `test/autonomous-continuation.test.js` | 1357 | `planned_refactor` | Split continuation recovery, reviewer, and work-package fixtures. |
| LFG-Q09 | `src/workflow/requirement-intake.js` | 1318 | `planned_refactor` | Extract plan review, validation, and work-package generation. |
| LFG-Q10 | `apps/workbench/workbench.js` | 1289 | `planned_refactor` | Retire or quarantine legacy static shell once Next.js routes are complete. |
| LFG-Q11 | `test/context-work-package-runner.test.js` | 1242 | `planned_refactor` | Split owned-file, dependency, and execution-governance tests. |
| LFG-Q12 | `src/workflow/context-work-package-runner.js` | 1217 | `planned_refactor` | Extract owned-file enforcement and execution-result normalization. |
| LFG-Q13 | `apps/workbench/styles.css` | 963 | `planned_refactor` | Retire or split legacy static-shell styles. |
| LFG-Q14 | `src/workflow/development-flow-real.js` | 892 | `planned_refactor` | Extract provider C2C governance and phase evidence aggregation. |
| LFG-Q15 | `test/autonomous-scheduler-loop.test.js` | 877 | `planned_refactor` | Split scheduler loop replay and recovery fixtures. |
| LFG-Q16 | `src/workflow/autonomous-scheduler-loop.js` | 869 | `planned_refactor` | Extract recovery, projection reuse, and execution-root propagation. |
| LFG-Q17 | `src/workflow/autonomous-continuation.js` | 842 | `planned_refactor` | Extract next-action selection and recovery package generation. |
| LFG-Q18 | `src/workflow/frontend-acceptance.js` | 801 | `planned_refactor` | Extract acceptance subvalidators and browser-evidence parsing. |

## Phase Plan

### Phase LFG-P0: Plan Baseline and Review

Status: review_pending

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFG-P0.1 | Record current large-file queue | `LARGE_FILE_GOVERNANCE_PLAN.md` | Manifest entries are reflected with file, line count, and intent. | review_pending |
| LFG-P0.2 | Decide old closeout plan archival state | This document | The plan states whether `AI_GOVERNED_RISK_CLOSEOUT_PLAN.md` is archived and why. | review_pending |
| LFG-P0.3 | Independent plan review | DeepSeek review output | Read-only DeepSeek returns PASS with no blocking findings. | pass |

### Phase LFG-P1: Large-File Governance Gate Hardening

Status: pending

Goal: make large-file governance stable before refactor work starts.

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFG-P1.1 | Add machine-readable queue report | `tools/report-large-files.mjs` or equivalent | Reports manifest status, current line count, stale line counts, and priority order. | pending |
| LFG-P1.2 | Detect duplicate manifest keys and stale line counts | Tests | Gate fails on duplicate JSON keys before parse-last-wins can hide stale entries. | pending |
| LFG-P1.3 | Require growth justification for `planned_refactor` files | Test or hook update | Growing a planned-refactor file without a split plan fails governance. | pending |
| LFG-P1.4 | DeepSeek phase review | Reviewer artifact | DS confirms the gate prevents stale or weakening manifest updates. | pending |

Suggested gates:

```bash
node tools/run-with-node18.mjs --test test/governance-enrollment.test.js
npm run check:known-risk-closeout
```

### Phase LFG-P2: Convert Queue Items into Known-Risk Work Packages

Status: pending

Goal: make large-file items selectable by the same known-risk closeout process used for prior risk repair.

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFG-P2.1 | Add large-file risk entries for top candidates | `known-risk-ledger.json` | Each entry has scope, owned files, acceptance gates, and status `open`. | pending |
| LFG-P2.2 | Add risk grouping policy | Governance docs | Test files and source files can be grouped only when a common extraction owns both. | pending |
| LFG-P2.3 | Add dry-run selection rule | Runner or docs | Daily run can select one bounded large-file risk without broad refactor. | pending |
| LFG-P2.4 | DeepSeek phase review | Reviewer artifact | DS confirms large-file risks are actionable and not vague refactor wishes. | pending |

Initial recommended risk entries:

- `risk-20260602-workbench-server-test-shards`
- `risk-20260602-workbench-server-route-groups`
- `risk-20260602-workbench-projection-test-shards`
- `risk-20260602-workbench-projection-domain-splits`

### Phase LFG-P3: Workbench Server Route and Test Boundary Split

Status: pending

Goal: reduce the highest-impact server boundary without breaking public route, state-store, or API behavior.

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFG-P3.1 | Split server tests by route domain | New test files | `test/workbench-server.test.js` line count decreases and all extracted tests pass. | pending |
| LFG-P3.2 | Extract next route groups from server entrypoint | Route modules | `tools/workbench-server.mjs` line count decreases and API route contract passes. | pending |
| LFG-P3.3 | Preserve live route behavior | Live evidence | Next build, closeout, and public browser route pass after merge. | pending |
| LFG-P3.4 | DeepSeek phase review | Reviewer artifact | DS confirms no static compatibility or state-store behavior was lost. | pending |

Suggested gates:

```bash
node tools/run-with-node18.mjs --test test/workbench-server.test.js test/api-route-contract.test.js
node ../../tools/run-with-node18.mjs node_modules/next/dist/bin/next build
npm run check:closeout
```

### Phase LFG-P4: Workbench Projection Domain Split

Status: pending

Goal: reduce projection aggregation risk while preserving one-screen and mobile contracts.

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFG-P4.1 | Split projection tests by schema domain | New test shards | `test/workbench-projection.test.js` line count decreases and all projection shards pass. | pending |
| LFG-P4.2 | Extract project-management projection | `src/workflow/workbench-project-management.js` or equivalent | Existing project/task counters and readouts remain unchanged. | pending |
| LFG-P4.3 | Extract next-action readout projection | New module | Scheduler, lifecycle, reviewer, and terminal next-action tests still pass. | pending |
| LFG-P4.4 | DeepSeek phase review | Reviewer artifact | DS confirms extraction is behavior-preserving and does not just move complexity. | pending |

Suggested gates:

```bash
node tools/run-with-node18.mjs --test test/workbench-projection.test.js test/workbench-shell.test.js
npm run test:coverage
```

### Phase LFG-P5: Headless and Context Execution Split

Status: pending

Goal: split long-running orchestration and execution files into auditable contracts.

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFG-P5.1 | Extract headless worker planning | Module + tests | Headless orchestrator tests pass and line count decreases. | pending |
| LFG-P5.2 | Extract headless acceptance/closeout packaging | Module + tests | Acceptance gates and continuation packaging remain fail-closed. | pending |
| LFG-P5.3 | Extract context runner owned-file enforcement | Module + tests | Owned scope tests remain pass/fail as before. | pending |
| LFG-P5.4 | DeepSeek phase review | Reviewer artifact | DS confirms no host-boundary or completion-authority regression. | pending |

### Phase LFG-P6: Legacy Static Workbench Retirement

Status: pending

Goal: remove or quarantine legacy static assets once Next.js mounted routes own the runtime.

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFG-P6.1 | Inventory static shell dependencies | Report | Tests identify which legacy routes/assets still require `workbench.js` or `styles.css`. | pending |
| LFG-P6.2 | Retire unused static code | Deletions or quarantine | Next.js routes, browser events, and frontend acceptance still pass. | pending |
| LFG-P6.3 | Update manifest | `.largefile-manifest.json` | Removed/retired files no longer appear as planned-refactor entries. | pending |
| LFG-P6.4 | DeepSeek phase review | Reviewer artifact | DS confirms no public route or compatibility fixture was broken. | pending |

## Daily Run Shape

Each scheduled large-file governance run should:

1. Read this plan, `.largefile-manifest.json`, and `known-risk-ledger.json`.
2. Select one bounded queue item or one open large-file risk.
3. Create an isolated worktree.
4. Make a behavior-preserving split or create a narrower follow-up risk.
5. Run the file-specific gates plus `test/governance-enrollment.test.js`.
6. Run DeepSeek read-only review for the phase result.
7. Merge, publish, and clean only if policy and gates allow it.

## DeepSeek Review Record

| Review | Model | Result | Notes |
| --- | --- | --- | --- |
| Initial plan review | `deepseek-v4-pro` compact no-tools retry | PASS | No blocking findings. Non-blocking findings requested status update after review, old-plan replacement timing, and priority rationale. |
| Delta review | `deepseek-v4-flash` no-tools | PASS | Confirmed the three non-blocking findings were closed and no new blocking or non-blocking findings remained. |

## Current External Dependencies

| Dependency | Status | Impact |
| --- | --- | --- |
| `AI_GOVERNED_RISK_CLOSEOUT_PLAN.md` archival | blocked | Not fully complete; leave active until write-mode/dry-run zero-risk behavior is resolved or the required input path is replaced by an archived index. |
| `test/known-risk-closeout-runner.test.js` zero-open-risk dry-run behavior | open external maintenance item | P7 verification currently fails after all known risks are terminal because one test expects a selected open risk. |
| DeepSeek review for this plan | pass | Initial compact read-only review returned PASS with no blocking findings. Non-blocking findings were addressed by updating this status, clarifying old-plan replacement timing, and adding priority rationale. |

## Acceptance Tracking

| Phase | Status | Latest evidence | Reviewer |
| --- | --- | --- | --- |
| LFG-P0 | pass | Plan created and non-blocking DS feedback incorporated. | DeepSeek PASS, no blocking findings |
| LFG-P1 | pending | Not started. | pending |
| LFG-P2 | pending | Not started. | pending |
| LFG-P3 | pending | Not started. | pending |
| LFG-P4 | pending | Not started. | pending |
| LFG-P5 | pending | Not started. | pending |
| LFG-P6 | pending | Not started. | pending |
