# Large File Governance Status Plan

Status: pass
Created at: 2026-06-02T15:00:00+08:00  
Updated at: 2026-06-03T10:15:00+08:00
Owner mode: AI-governed, evidence-first, no human code-detail review  

## Current Decision

Active successor: `docs/governance/LARGE_FILE_ANTI_ABUSE_AND_REDUCTION_PLAN.md`.

This historical plan completed the first governance cycle, but its original manifest semantics were too permissive: a model could still grow a file while updating `.largefile-manifest.json` to match. Future large-file work must follow the successor plan's debt-ceiling rules, anti-abuse gate, and material reduction criteria.

`docs/governance/AI_GOVERNED_RISK_CLOSEOUT_PLAN.md` is now an archive index. The full historical plan has been moved to `docs/governance/archive/AI_GOVERNED_RISK_CLOSEOUT_PLAN.archived-20260602.md`.

Reason:

- The required input path remains available as an archive index, so the `ai-governed-risk-closeout` skill can still load required context.
- P6/P7 historical details remain preserved in the archive, while active scheduling and skill-contract documents now describe the current dry-run/fail-closed posture.
- `test/known-risk-closeout-runner.test.js` now covers both a seeded open-risk dry-run and a zero-open-risk dry-run without pretending closeout completed.

Archive acceptance evidence for the closeout plan:

- A replacement archived index exists at the required path.
- Timer-triggered write-mode semantics remain explicitly fail-closed in the active scheduling and skill-contract documents rather than hidden in the archived implementation backlog.
- `node tools/run-with-node18.mjs --test test/risk-closeout-orchestrator-contract.test.js test/known-risk-closeout-runner.test.js` passes when the ledger has zero open risks.

The large-file plan does not replace the closeout process. It depends on the active closeout requirements, scheduling document, skill contract, and ledger gates, while the old phased implementation plan remains available only as audit history.

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

The current source of truth is `.largefile-manifest.json`. The top-level `reviewed_at: 2026-06-02` records the latest full report date; individual entries retain their own `reviewed_at` dates when their file-specific rationale was last refreshed.

Priority order is current line count first. Runtime/contract blast radius is used when selecting a bounded phase scope from the queue, not as a hidden reordering rule. Test files remain high priority because they currently hide broad fixture coupling and make behavior-preserving source splits harder to validate.

| Priority | File | Lines | Current manifest status | Governance intent |
| --- | --- | ---: | --- | --- |
| LFG-Q01 | `test/workbench-server.test.js` | 4214 | `planned_refactor` | Split server API/live/state-store tests into domain shards. First agent-key route shard extracted; legacy static opt-in assertions now cover retired fail-closed behavior without growing the shard. |
| LFG-Q02 | `tools/workbench-server.mjs` | 3447 | `planned_refactor` | Continue extracting route groups and runtime service bridges. Legacy static compatibility routing extracted. |
| LFG-Q03 | `test/workbench-projection.test.js` | 3175 | `planned_refactor` | Split projection schema/domain regression suites. One-screen helper shard extracted. |
| LFG-Q04 | `src/workflow/headless-cli-orchestrator.js` | 1855 | `planned_refactor` | Worker planning and child acceptance packaging extracted; continue extracting runner dispatch and continuation packaging. |
| LFG-Q05 | `test/headless-cli-orchestrator.test.js` | 1745 | `planned_refactor` | Split orchestrator tests along extracted domains. |
| LFG-Q06 | `test/frontend-acceptance.test.js` | 1670 | `planned_refactor` | Split content, browser error, route, and command-architecture validators. |
| LFG-Q07 | `test/autonomous-continuation.test.js` | 1357 | `planned_refactor` | Split continuation recovery, reviewer, and work-package fixtures. |
| LFG-Q08 | `src/workflow/requirement-intake.js` | 1318 | `planned_refactor` | Extract plan review, validation, and work-package generation. |
| LFG-Q09 | `test/context-work-package-runner.test.js` | 1242 | `planned_refactor` | Split owned-file, dependency, and execution-governance tests. |
| LFG-Q10 | `src/workflow/context-work-package-runner.js` | 1135 | `planned_refactor` | Execution-scope and workspace mutation guard extracted; continue splitting execution governance, worker dispatch, and result normalization. |
| LFG-Q11 | `src/workflow/workbench-projection.js` | 923 | `planned_refactor` | Next-action readout and project-management readout domains extracted; remaining logic is projection composition. |
| LFG-Q12 | `src/workflow/development-flow-real.js` | 892 | `planned_refactor` | Extract provider C2C governance and phase evidence aggregation. |
| LFG-Q13 | `test/autonomous-scheduler-loop.test.js` | 877 | `planned_refactor` | Split scheduler loop replay and recovery fixtures. |
| LFG-Q14 | `src/workflow/autonomous-scheduler-loop.js` | 869 | `planned_refactor` | Extract recovery, projection reuse, and execution-root propagation. |
| LFG-Q15 | `src/workflow/autonomous-continuation.js` | 842 | `planned_refactor` | Extract next-action selection and recovery package generation. |
| LFG-Q16 | `src/workflow/frontend-acceptance.js` | 818 | `planned_refactor` | Extract acceptance subvalidators and browser-evidence parsing. |

## Phase Plan

### Phase LFG-P0: Plan Baseline and Review

Status: pass

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFG-P0.1 | Record current large-file queue | `LARGE_FILE_GOVERNANCE_PLAN.md` | Manifest entries are reflected with file, line count, and intent. | pass |
| LFG-P0.2 | Decide old closeout plan archival state | This document | The plan states whether `AI_GOVERNED_RISK_CLOSEOUT_PLAN.md` is archived and why. | pass |
| LFG-P0.3 | Independent plan review | DeepSeek review output | Read-only DeepSeek returns PASS with no blocking findings. | pass |

### Phase LFG-P1: Large-File Governance Gate Hardening

Status: pass

Goal: make large-file governance stable before refactor work starts.

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFG-P1.1 | Add machine-readable queue report | `tools/report-large-files.mjs` plus `npm run check:large-files` | Reports manifest status, current line count, stale line counts, and priority order. | pass |
| LFG-P1.2 | Detect duplicate manifest keys and stale line counts | `test/large-file-report.test.js` | Gate fails on duplicate JSON keys before parse-last-wins can hide stale entries. | pass |
| LFG-P1.3 | Require growth justification for `planned_refactor` files | `tools/report-large-files.mjs` and tests | Growing a planned-refactor file without a split plan fails governance. | pass |
| LFG-P1.4 | DeepSeek phase review | `docs/examples/reviewer-risk-20260602-large-file-governance-p1-deepseek.json` | DS confirms the gate prevents stale or weakening manifest updates. | pass |

Suggested gates:

```bash
node tools/run-with-node18.mjs --test test/governance-enrollment.test.js
node tools/run-with-node18.mjs --test test/large-file-report.test.js test/select-affected-tests.test.js test/governance-enrollment.test.js
npm run check:large-files
npm run check:known-risk-closeout
```

### Phase LFG-P2: Convert Queue Items into Known-Risk Work Packages

Status: pass

Goal: make large-file items selectable by the same known-risk closeout process used for prior risk repair.

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFG-P2.1 | Add large-file risk entries for top candidates | `known-risk-ledger.json` | Each entry has scope, owned files, acceptance gates, and status `open`. | pass |
| LFG-P2.2 | Add risk grouping policy | This document | Test files and source files can be grouped only when a common extraction owns both. | pass |
| LFG-P2.3 | Add dry-run selection rule | `test/known-risk-closeout-runner.test.js` plus Daily Run Shape | Daily run can select one bounded large-file risk without broad refactor. | pass |
| LFG-P2.4 | DeepSeek phase review | `docs/examples/reviewer-risk-20260602-large-file-governance-p2-deepseek.json` | DS confirms large-file risks are actionable and not vague refactor wishes. | pass |

Initial recommended risk entries:

- `risk-20260602-workbench-server-test-shards`
- `risk-20260602-workbench-server-route-groups`
- `risk-20260602-workbench-projection-test-shards`
- `risk-20260602-workbench-projection-domain-splits`

These four entries intentionally cover the Workbench server/projection clusters first. `src/workflow/headless-cli-orchestrator.js` is larger than `src/workflow/workbench-projection.js`, but its source/test split belongs to LFG-P5 and is not mixed into the Workbench P3/P4 boundary package.

LFG-P2 intentionally reopens the known-risk ledger. `npm run check:known-risk-closeout` must pass, but `npm run check:known-risk-closeout:required` is expected to fail until these newly queued large-file risks reach terminal states.

#### Large-File Risk Grouping Policy

- A test-file risk may include its source file in `scope` only to preserve behavior context; its default `owned_files` should keep source edits out unless the selected split requires fixture or route-contract changes.
- A source-file risk may include test files in `owned_files` only when the extraction must preserve behavior through targeted regression tests.
- A source-file risk that depends on a test-shard risk must list the test-shard risk in `depends_on`, so behavior-preserving tests are made smaller before source extraction broadens.
- Static legacy Workbench files (`apps/workbench/workbench.js`, `apps/workbench/styles.css`) were removed from the queue in LFG-P6.4 only after inventory evidence proved the Next.js runtime owned the retirement boundary.
- One closeout run should select at most one large-file risk by default. Broader grouping requires an explicit risk entry with shared extraction rationale, owned files, and DeepSeek review.

#### Daily Dry-Run Selection Rule

The daily preflight command remains:

```bash
npm run run:known-risk-closeout -- --max-risks 1
```

With the current queue this selects `risk-20260602-workbench-server-test-shards` first. Selection is dependency-first: if a selected risk depends on another open or in-progress risk, the dependency is returned before the dependent risk. The dry-run artifact is a scheduler input only: it must show `preflight_only: true` and `closeout_completed: false`.

### Phase LFG-P3: Workbench Server Route and Test Boundary Split

Status: pass

Goal: reduce the highest-impact server boundary without breaking public route, state-store, or API behavior.

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFG-P3.1 | Split server tests by route domain | `test/workbench-server-agent-key-routes.test.js` | `test/workbench-server.test.js` line count decreased from 4353 to 4218; extracted shard is 185 lines and all extracted tests pass. | pass |
| LFG-P3.2 | Extract next route groups from server entrypoint | `tools/workbench-static-routes.mjs` | `tools/workbench-server.mjs` line count decreased from 3516 to 3447; new route module is 102 lines and API route contract passes. | pass |
| LFG-P3.3 | Preserve live route behavior | Live evidence | Next build, full closeout, public browser route, state-boundary, live-state cleanliness, and governance audit skill trial pass after merge. | pass |
| LFG-P3.4 | DeepSeek phase review | `docs/examples/reviewer-risk-20260602-workbench-server-test-shards-deepseek.json`; `docs/examples/reviewer-risk-20260602-workbench-server-route-groups-deepseek.json`; `docs/examples/reviewer-risk-20260602-workbench-server-live-route-evidence-deepseek.json` | DS confirms no static compatibility or state-store behavior was lost, and the live-route/state-boundary closeout evidence is sufficient. | pass |

Suggested gates:

```bash
node tools/run-with-node18.mjs --test test/workbench-server.test.js test/workbench-server-*.test.js test/api-route-contract.test.js
node ../../tools/run-with-node18.mjs node_modules/next/dist/bin/next build
npm run check:closeout
```

### Phase LFG-P4: Workbench Projection Domain Split

Status: pass

Goal: reduce projection aggregation risk while preserving one-screen and mobile contracts.

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFG-P4.1 | Split projection tests by schema domain | `test/workbench-projection-one-screen.test.js` | `test/workbench-projection.test.js` line count decreased from 3294 to 3175; extracted shard is 122 lines and projection/shell gates pass. | pass |
| LFG-P4.2 | Extract project-management projection | `src/workflow/workbench-project-management.js`; `src/workflow/workbench-project-task-items.js` | `src/workflow/workbench-projection.js` decreased from 1463 to 923 lines; extracted modules are 167 and 393 lines, and project/task counters plus plan-review/task-flow tests pass. | pass |
| LFG-P4.3 | Extract next-action readout projection | `src/workflow/workbench-next-action-readout.js` | `src/workflow/workbench-projection.js` decreased from 1944 to 1463 lines; extracted helper is 497 lines and scheduler, lifecycle, reviewer, and terminal next-action tests pass. | pass |
| LFG-P4.4 | DeepSeek phase review | `docs/examples/reviewer-risk-20260602-workbench-projection-domain-splits-deepseek.json`; `docs/examples/reviewer-risk-20260602-workbench-project-management-split-deepseek.json` | DS confirms extraction is behavior-preserving and does not just move complexity. | pass |

Suggested gates:

```bash
node tools/run-with-node18.mjs --test test/workbench-projection.test.js test/workbench-shell.test.js
npm run test:coverage
```

### Phase LFG-P5: Headless and Context Execution Split

Status: pass

Goal: split long-running orchestration and execution files into auditable contracts.

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFG-P5.1 | Extract headless worker planning | `src/workflow/headless-worker-planning.js`; `test/headless-worker-planning.test.js` | `src/workflow/headless-cli-orchestrator.js` decreased from 2090 to 2042 lines; headless worker planning and orchestrator tests pass. | pass |
| LFG-P5.2 | Extract headless acceptance/closeout packaging | `src/workflow/headless-child-acceptance.js`; `test/headless-child-acceptance.test.js` | `src/workflow/headless-cli-orchestrator.js` decreased from 2042 to 1855 lines; child acceptance and orchestrator tests pass, and acceptance remains fail-closed. | pass |
| LFG-P5.3 | Extract context runner owned-file enforcement | `src/workflow/context-work-package-execution-scope.js`; `test/context-work-package-execution-scope.test.js` | `src/workflow/context-work-package-runner.js` decreased from 1217 to 1135 lines; fixed owned_files gate still runs before provider adapter, code-output packages still require isolated worker worktrees, and no-code mutation guard still fails closed. | pass |
| LFG-P5.4 | DeepSeek phase review | `docs/examples/reviewer-risk-20260602-context-execution-scope-split-deepseek.json` | DS confirms no host-boundary or completion-authority regression. | pass |

### Phase LFG-P6: Legacy Static Workbench Retirement

Status: pass

Goal: remove or quarantine legacy static assets once Next.js mounted routes own the runtime.

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFG-P6.1 | Inventory static shell dependencies | `docs/governance/legacy-static-workbench-inventory.json`; `test/legacy-static-workbench-inventory.test.js` | Tests identify which legacy routes/assets still require `workbench.js` or `styles.css`. | pass |
| LFG-P6.2 | Verify Next replacement gates | `tools/check-workbench-next-served-route.mjs`; `tools/check-workbench-next-browser-events.mjs`; `tools/check-workbench-next-frontend-acceptance.mjs`; served-route, browser-events probe, and frontend-acceptance evidence | Next.js served-route gate passes through the mounted App Router runtime; primary frontend-acceptance passes through the mounted App Router runtime with durable release evidence and fail-closed legacy-shell detection; a separate Next browser-events writeback probe passes through the mounted API. | pass |
| LFG-P6.3 | Migrate remaining legacy-dependent gates | Full browser-events closeout, scheduler writeback browser verification, and shell tests no longer depend on `desktop.html`/`mobile.html`/`workbench.js`/`styles.css` | Full browser-events closeout now replays the 15 required scenarios through the mounted Next.js App Router runtime, scheduler dispatch writeback now verifies desktop/mobile readouts through the mounted Next.js App Router runtime, and `test/workbench-shell.test.js` now asserts Next.js/Ant Design shell source contracts plus mounted runtime replacement gates without reading legacy static assets. | pass |
| LFG-P6.4 | Quarantine/delete legacy static assets and update manifest | `.largefile-manifest.json`; deleted legacy static entries | Removed files no longer appear as planned-refactor entries after P6.3 passed. `apps/workbench/desktop.html`, `mobile.html`, `workbench.js`, `projection-source.js`, `styles.css`, and legacy `favicon.svg` were deleted; `tools/workbench-server.mjs` rejects legacy static opt-in; the old frontend-acceptance CLI is fail-closed; docs no longer require fallback retention. | pass |
| LFG-P6.5 | DeepSeek phase review | `docs/examples/reviewer-risk-20260603-legacy-static-retirement-deepseek.json` | DS confirmed no public route or compatibility fixture was broken and no legacy-static false-pass remains. | pass |

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
| Closeout-plan archive review | `deepseek-v4-pro` bounded read-only review | PASS | No blocking findings. Non-blocking stale LFG-P0 item statuses were updated to `pass`; forward-reference note had no functional impact. |
| LFG-P1 gate review | `deepseek-v4-pro` bounded + delta read-only reviews | PASS | Initial blocking findings on shrink hard-fail and missing-entry coverage were fixed. Final delta review returned PASS with no blocking or non-blocking findings. |
| LFG-P2 risk package review | `deepseek-v4-pro` sharded + delta read-only reviews | PASS | No blocking findings. Non-blocking findings on headless scope rationale, live-ledger test coupling, and dependency-first selection were addressed; final delta returned PASS with no findings. |
| LFG-P3 test shard review | `deepseek-v4-pro` sharded review with `deepseek-v4-flash` synthesis | PASS | Confirmed the extracted agent-key shard preserved API, SQLite fail-closed, secret non-leak, health, roles, and delete assertions; final synthesis returned no blocking or non-blocking findings. |
| LFG-P3 route group review | `deepseek-v4-pro` sharded review with `deepseek-v4-flash` synthesis | PASS | Confirmed static compatibility routing, mounted path rewriting, favicon/fallback handling, and non-static API route behavior were preserved. |
| LFG-P3 live-route/state-boundary closeout review | `deepseek-v4-pro` sharded review with `deepseek-v4-flash` synthesis and delta | PASS | Initial review found only a plan-state inconsistency after code review passed; final delta confirmed P3.3, P3.4, DeepSeek record, and Acceptance Tracking were internally consistent. |
| LFG-P4 test shard review | `deepseek-v4-pro` sharded review with `deepseek-v4-flash` synthesis | PASS | Confirmed one-screen next-action/counter assertions were preserved, schema/mobile/shell coverage remained present, and metadata was consistent. |
| LFG-P4 source domain review | `deepseek-v4-pro` sharded review with `deepseek-v4-flash` synthesis | PASS | Confirmed next-action output-shape preservation, lifecycle event-set pass-through, test coverage continuity, non-weakening staged-closeout ledger tests, and metadata consistency. Delta ledger review also passed after evidence format and line-count details were strengthened. |
| LFG-P4 project-management review | `deepseek-v4-pro` sharded review with `deepseek-v4-flash` synthesis | PASS | Confirmed projection composer delegation, two-call nextActionReadout dependency handling, project/task counter preservation, plan-review/task-flow coverage, mobile/schema/shell consumer compatibility, below-threshold extracted modules, and metadata consistency. |
| LFG-P5.1 headless worker planning review | `deepseek-v4-pro` sharded review with `deepseek-v4-flash` synthesis | PASS | Confirmed work-package selection and child lifecycle spawn facts are behavior-preserving, child acceptance/owned-file/host-boundary/completion-authority/continuation/snapshot behavior was not weakened, tests cover the extracted boundary, and P5 metadata does not claim phase completion. |
| LFG-P5.2 headless child acceptance review | `deepseek-v4-pro` sharded review with `deepseek-v4-flash` synthesis | PASS | Confirmed child worker acceptance extraction is behavior-preserving, host boundary, owned-file, no-diff/mainline integration, command evidence, durable state, process hardening, continuation readiness, and self-evaluation checks were not weakened, direct and orchestrator tests cover the boundary, and P5 metadata stays in_progress. |
| LFG-P5.3/P5.4 context execution-scope review | `deepseek-v4-pro` sharded review with `deepseek-v4-flash` synthesis | PASS | Confirmed fixed owned_files gate ordering before provider execution, primary-worktree blocking for code-output packages, fail-closed no-code workspace mutation guard, direct and integration test coverage, and metadata consistency after delta clarification. |
| LFG-P6.1 legacy static inventory review | `deepseek-v4-pro` sharded review with `deepseek-v4-flash` synthesis and delta | PASS | Confirmed server default API-only posture, explicit legacy static opt-in, browser-events/frontend-acceptance/scheduler-writeback/shell-test dependencies, and P6.2 blocked rationale. Non-blocking missing `test/frontend-acceptance.test.js` gate dependency was added and delta review passed. |
| LFG-P6.2 Next served-route partial review | `deepseek-v4-pro` sharded review with `deepseek-v4-flash` synthesis and delta | PASS | Confirmed the new gate performs real Playwright verification of mounted Next.js App Router runtime, API rewrite, favicon, desktop/mobile viewports, all eight main routes, SPA navigation, and absence of legacy shell markers. Delta confirmed public-browser-route is a Next/Ant gate and P6.2 remains blocked rather than deletion-ready. |
| LFG-P6.2 Next browser-events writeback probe review | `deepseek-v4-pro` sharded review with `deepseek-v4-flash` synthesis; `docs/examples/reviewer-risk-20260603-next-browser-events-gate-deepseek.json` | PASS AFTER SCOPE REDUCTION | Initial review rejected claiming full browser-events migration because legacy lifecycle/cleanup scenarios were hardcoded instead of replayed through Next UI. Delta review passed after closeout stayed on the legacy gate and the Next script was recorded only as a mounted runtime/API writeback probe. |
| LFG-P6.2 Next frontend-acceptance migration review | `deepseek-v4-pro` sharded review plus bounded delta; `docs/examples/reviewer-risk-20260603-next-frontend-acceptance-deepseek.json` | PASS AFTER DELTA | Confirmed primary frontend-acceptance, closeout, and self-governance scan now run against mounted Next.js App Router; existing validator and durable release evidence are reused; legacy static deletion remains blocked. Delta review identified missing direct browser-error false-pass validator coverage, which was added and re-reviewed as PASS. |
| LFG-P6.3 full browser-events migration | `deepseek-v4-pro` sharded review with `deepseek-v4-flash` synthesis and focused follow-up; `docs/examples/reviewer-risk-20260603-next-browser-events-full-migration-deepseek.json` | PASS AFTER FOLLOW-UP | Confirmed the full browser-events closeout now runs through `tools/check-workbench-browser-events.mjs` against mounted Next.js App Router, replays success/failure/provider/scheduler/lifecycle/projected-loop/mobile scenarios, records `legacy_interactions_replayed: true`, and validates with `validateWorkbenchBrowserEventsArtifact`. Focused follow-up confirmed the initial OperationPanel exposure concern was a false positive because high-risk controls only render under `?workbench_event_controls=1`. Scheduler writeback and shell-test migration were left to later P6.3 slices. |
| LFG-P6.3 scheduler writeback migration | `deepseek-v4-pro` sharded review with `deepseek-v4-flash` synthesis; `docs/examples/reviewer-risk-20260603-scheduler-writeback-next-migration-deepseek.json` | PASS | Confirmed scheduler dispatch writeback now writes through the Workbench API service and verifies desktop/mobile scheduler dispatch readouts through the mounted Next.js App Router runtime with no legacy shell markers. Raw CLI/projection pass and three-step semantics remain strict; shell-test migration was left to the following P6.3 slice. |
| LFG-P6.3 shell gate migration | `deepseek-v4-pro` sharded review with `deepseek-v4-flash` synthesis; `docs/examples/reviewer-risk-20260603-shell-gate-next-migration-deepseek.json` | PASS | Confirmed shell tests no longer read legacy desktop/mobile shell assets as current acceptance gates and now guard the Next.js/Ant Design shell contract, mounted runtime replacement gates, projection API/hook behavior, operation readouts, scheduler/next-action/agent lifecycle controls, failure-no-false-positive behavior, and responsive overflow checks. |
| LFG-P6.4/P6.5 legacy static retirement | `deepseek-v4-pro` sharded review with `deepseek-v4-flash` synthesis; `docs/examples/reviewer-risk-20260603-legacy-static-retirement-deepseek.json` | PASS | Confirmed deleted legacy static files and manifest updates are consistent, server CLI/env/constructor legacy static opt-in paths are fail-closed, the retired legacy frontend-acceptance CLI exits non-zero, and current Next.js gates cannot false-pass through the old static shell. |
| Closeout governance-audit evidence-plan alias review | `deepseek-v4-pro` bounded read-only review; `docs/examples/reviewer-risk-20260603-governance-audit-evidence-plan-alias-deepseek.json` | PASS | Confirmed compact audit output alias normalization maps common evidence_plan keys to canonical schema fields without weakening validator or final_verdict closeout blocking. |

## Current External Dependencies

| Dependency | Status | Impact |
| --- | --- | --- |
| `AI_GOVERNED_RISK_CLOSEOUT_PLAN.md` archival | pass | Original phased plan moved to `docs/governance/archive/AI_GOVERNED_RISK_CLOSEOUT_PLAN.archived-20260602.md`; required path remains as an archive index. |
| `test/known-risk-closeout-runner.test.js` zero-open-risk dry-run behavior | pass | Runner tests now cover zero-open-risk dry-run behavior and keep `closeout_completed: false`. |
| DeepSeek review for this plan | pass | Initial compact read-only review returned PASS with no blocking findings. Non-blocking findings were addressed by updating this status, clarifying old-plan replacement timing, and adding priority rationale. |

## Acceptance Tracking

| Phase | Status | Latest evidence | Reviewer |
| --- | --- | --- | --- |
| LFG-P0 | pass | Plan created and non-blocking DS feedback incorporated. | DeepSeek PASS, no blocking findings |
| LFG-P1 | pass | `tools/report-large-files.mjs` added; report gate, duplicate-key detection, growth/stale-up detection, shrink warnings, missing-entry detection, and planned-refactor growth guard pass local tests. | DeepSeek PASS, no blocking or non-blocking findings after delta |
| LFG-P2 | pass | Four Workbench large-file queue items were converted into open known-risk entries with owned files, dependencies, and acceptance gates. Dry-run selection is dependency-first, covers one bounded large-file risk, and does not claim closeout. | DeepSeek PASS, no blocking or non-blocking findings after delta |
| LFG-P3 | pass | Agent-key route tests were extracted into `test/workbench-server-agent-key-routes.test.js`; legacy static compatibility routing was extracted into `tools/workbench-static-routes.mjs`; `node ../../tools/run-with-node18.mjs node_modules/next/dist/bin/next build`, `npm run check:closeout`, public browser route, state-boundary, live-state cleanliness, and governance audit skill trial passed. The state-boundary scanner now explicitly allows only the split server fixture shards while rejecting unapproved tests and tools. | DeepSeek PASS for test shard, route group, and live-route/state-boundary closeout |
| LFG-P4 | pass | One-screen helper counter and next-action assertions were extracted into `test/workbench-projection-one-screen.test.js`; next-action readout source policy was extracted into `src/workflow/workbench-next-action-readout.js`; project-management readout policy was extracted into `src/workflow/workbench-project-management.js` and `src/workflow/workbench-project-task-items.js`; projection/schema/shell, coverage, large-file, and known-risk required gates passed. | DeepSeek PASS for test shard, next-action split, and project-management split |
| LFG-P5 | pass | Worker planning was extracted into `src/workflow/headless-worker-planning.js`; child worker acceptance/default/missing/parse packaging was extracted into `src/workflow/headless-child-acceptance.js`; context execution-scope and workspace mutation guard logic was extracted into `src/workflow/context-work-package-execution-scope.js`; `node tools/run-with-node18.mjs --test test/context-work-package-execution-scope.test.js test/context-work-package-runner.test.js test/fixed-development-mode.test.js` passes and `src/workflow/context-work-package-runner.js` decreased from 1217 to 1135 lines. Large-file queue items such as `test/headless-cli-orchestrator.test.js` and the remaining `context-work-package-runner.js` flow are still tracked separately. | DeepSeek PASS for P5.1, P5.2, and P5.3/P5.4 |
| LFG-P6 | pass | Next.js served-route gate now passes at `/projects/ai-control-platform/` for desktop/mobile mounted App Router runtime, API rewrite, favicon, all eight main App Router routes, SPA navigation, and no legacy shell. Primary frontend-acceptance now runs through `tools/check-workbench-next-frontend-acceptance.mjs` against the mounted App Router runtime and keeps the existing artifact validator/durable release evidence. `tools/check-workbench-browser-events.mjs` now runs the full 15-scenario browser-events closeout through mounted Next.js App Router and mounted API rewrite, writes `route_family: nextjs_app_router`, `legacy_static_shell_used: false`, and `legacy_interactions_replayed: true`, and passes the existing closeout artifact validator. `tools/check-scheduler-dispatch-writeback.mjs` now writes scheduler dispatch facts through the Workbench API service and verifies desktop/mobile scheduler readouts through mounted Next.js App Router with `legacy_static_shell_used: false`. P6.4 deleted the old static Workbench files, removed their planned-refactor manifest entries, retired the legacy npm frontend-acceptance script, made legacy static server opt-in fail-closed, updated fallback-retention docs, and `npm test`, `npm run check:large-files`, and `npm run check:closeout` all passed. | DeepSeek PASS through P6.5, including `docs/examples/reviewer-risk-20260603-legacy-static-retirement-deepseek.json` |
