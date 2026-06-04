# Large File Anti-Abuse and Reduction Plan

Status: in_progress
Created at: 2026-06-03T09:45:00+08:00
Updated at: 2026-06-04T12:27:10+08:00
Owner mode: AI-governed, evidence-first, no human code-detail review

## Current Decision

The current `.largefile-manifest.json` mechanism is insufficient as a hard governance gate. It records known large files and detects stale line counts, but it can still be abused by an automated agent that raises the manifest line count in the same change that grows the file.

This plan changes the governance model:

- `.largefile-manifest.json` is a debt ceiling ledger, not an exemption list.
- Existing large files may hold steady or shrink; they may not grow by updating the ledger.
- New large files may not be added to the ledger as a normal bypass.
- A large-file governance phase is not complete merely because a file shrank a little. It must meet a material reduction target or explicitly remain open.
- Starting with LFA-P17, the selected file must fall below 500 lines before a phase can be marked `pass`; intermediate reductions above 500 lines remain `in_progress`.

## Scope

This plan covers two tracks:

- **Anti-abuse gate hardening**: prevent future changes from increasing large-file debt through manifest edits, new files, or accepted/planned status changes.
- **Existing large-file reduction**: replace conservative "small shrink equals complete" behavior with measurable terminal criteria.

This plan does not replace `docs/governance/LARGE_FILE_GOVERNANCE_PLAN.md`; it supersedes the weak parts of its gate semantics and defines the next active phases.

## Current Baseline

Source: `.largefile-manifest.json` and `node tools/run-with-node18.mjs tools/report-large-files.mjs` on 2026-06-04.

| Metric | Count |
| --- | ---: |
| Manifest entries | 88 |
| Files currently above 500 lines | 23 |
| `planned_refactor` files above 500 lines | 14 |
| `accepted` files above 500 lines | 9 |
| Manifest entries already below threshold | 65 |

Highest active reduction targets:

| Priority | File | Lines | Status | Required terminal direction |
| --- | --- | ---: | --- | --- |
| LFA-Q01 | `src/workflow/requirement-intake.js` | 987 | `planned_refactor` | Extract requirement state transitions, closeout, or workflow event recording until below 500 lines. |
| LFA-Q02 | `tools/check-workbench-browser-events.mjs` | 983 | `planned_refactor` | Extract browser probe setup, route checks, API checks, and event-evidence validation until below 500 lines. |
| LFA-Q03 | `src/workflow/workbench-projection.js` | 923 | `planned_refactor` | Continue extracting projection orchestration subdomains until below 500 lines. |
| LFA-Q04 | `src/workflow/development-flow-real.js` | 892 | `planned_refactor` | Extract provider C2C governance, CLI command setup, or evidence aggregation until below 500 lines. |
| LFA-Q05 | `test/autonomous-scheduler-loop.test.js` | 877 | `planned_refactor` | Split scheduler loop replay, recovery, and continuation fixture domains until below 500 lines. |

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
4. Manifest `status` values are a closed enum: only `accepted` and `planned_refactor` are valid. Values such as `done`, `completed`, or ad hoc exemption labels fail closed.
5. `growth_justification`, `split_plan`, `next_split_plan`, and `refactor_plan` may explain work, but they cannot make growth pass.
6. New tracked source/test/tool files above 500 lines fail even if the same change adds them to the manifest.
7. Total large-file debt must not increase. Debt is the sum of line counts for tracked `.js`, `.mjs`, `.ts`, `.tsx`, `.py`, and `.css` files above the threshold.
8. Extracted modules above 500 lines are warnings. Extracted modules above 800 lines fail unless they map to one named domain concern, are directly required by the active reduction target, and carry a two-phase stabilization target.
9. A phase may not be marked complete unless the target file meets a material shrink target or is explicitly left open with a next reduction target.
10. The anti-abuse gate must scan tracked filesystem files, not only manifest entries. Any tracked source/test/tool file above the threshold is counted whether or not it appears in the manifest.
11. Baseline comparison must use the merge base against `origin/main` for ordinary task branches and must report any manifest ceiling increase relative to that base. A dedicated baseline artifact or tag may be introduced later, but it may not be advanced by the same implementation run that raises ceilings.
12. No implementation agent may accept its own gate-policy or manifest-ceiling change. Gate-policy changes require deterministic local tests plus a separate read-only reviewer artifact from another model invocation, with the reviewer instructed to look for bypasses.
13. A separate read-only reviewer invocation means a fresh non-interactive model process, no write tools, bounded focus files, no reliance on the implementation agent's summary as evidence, and a reviewer prompt that asks for bypass/fail-open findings before acceptance.

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

Status: pass

Goal: prevent "minor shrink equals complete" reporting for existing large files.

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFA-P2.1 | Add target metadata schema | `.largefile-manifest.json` | Each `planned_refactor` item above 500 lines declares `base_lines`, `target_lines`, `minimum_reduction`, `terminal_condition`, and `next_phase`. | pass |
| LFA-P2.2 | Add completion validator | `tools/large-file-reduction-targets.mjs`; `tools/report-large-files.mjs` | Missing, invalid, or too-weak `reduction_target` metadata fails the large-file report. | pass |
| LFA-P2.3 | Close `.mjs` coverage gap | `tools/report-large-files.mjs`; `.largefile-manifest.json`; `test/governance-enrollment.test.js` | `.mjs` files are scanned; five pre-existing hidden `.mjs` large files were newly backfilled as planned debt, while the already-listed `tools/workbench-server.mjs` remains in the queue. | pass |
| LFA-P2.4 | Update large-file queue | This document and manifest metadata | Queue expanded to 21 planned items with explicit target gaps and material terminal criteria. | pass |
| LFA-P2.5 | DeepSeek reduction-policy review | `docs/examples/reviewer-risk-20260603-large-file-reduction-p2-deepseek.json` | DS initially failed the phase on status-bypass risk; after adding a closed status enum, `.mjs` reverse test, and plan consistency fixes, final delta returned PASS with no blocking or non-blocking findings. | pass |

### Phase LFA-P3: First Strict Reduction Run

Status: pass

Goal: apply the stricter rules to the highest-priority file instead of doing a small symbolic split.

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFA-P3.1 | Select one high-priority target | Status update in this document | Selected Q01 `test/workbench-server.test.js` because it was the largest queue item at 4214 lines, had a clear test-only split seam, and could be reduced without runtime behavior changes. | pass |
| LFA-P3.2 | Reduce by material target | Code/test split | Root server test shard reduced from 4214 to 1717 lines, below the 2500-line phase target; moved tests into 11 shard files under 300 lines and one 283-line shared helper. The target remains open with a new 1400-line reduction target. | pass |
| LFA-P3.3 | Run target gates and full governance gate | Command evidence | Target server tests passed; split parity script confirmed 78 before / 78 after tests with no missing, added, or duplicate names. `npm test` passed 994/994, `npm run check:large-files` passed with no issues or warnings, `git diff --check` passed, and `npm run check:closeout` passed after installing ignored root and Workbench app dependencies in the isolated worktree. | pass |
| LFA-P3.4 | DeepSeek reduction review | `docs/examples/reviewer-risk-20260603-large-file-p3-first-reduction-deepseek.json` | Initial DS review failed on state-boundary file-level whitelist risk and a conditional shared-state mutation question. Delta review passed after adding per-call fixture-state annotations and confirming `currentSessionWorkflowState()` returns a fresh JSON-parsed object on every call. | pass |

### Phase LFA-P4: Workbench Server Entrypoint Reduction Step 1

Status: pass

Goal: apply the strict reduction rule to the highest-priority runtime entrypoint without changing API behavior.

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFA-P4.1 | Select current top runtime target | This document and `.largefile-manifest.json` | Selected `tools/workbench-server.mjs` because it is the largest runtime entrypoint in the active queue after P3, at 3447 baseline lines with a required 500-line material reduction and a terminal target below 2000 lines. | pass |
| LFA-P4.2 | Extract bounded support modules and route groups | `tools/workbench-http-utils.mjs`; `tools/workbench-loop-client.mjs`; `tools/workbench-server-cli.mjs`; `tools/workbench-mainline-evaluator.mjs`; `tools/workbench-basic-routes.mjs`; `tools/workbench-requirement-routes.mjs`; `tools/workbench-scheduler-dispatch-routes.mjs`; `tools/workbench-scheduler-loop-routes.mjs` | Server entrypoint reduced from 3447 to 1954 lines, below the 2000-line terminal target for this step. New helper modules are each below 500 lines. The queue item remains open with a new 1200-line target. | pass |
| LFA-P4.3 | Run focused gates | Command evidence | Focused server route/state tests passed 86/86 after the final route extractions. Final gates passed: `npm test` 995/995; `npm run check:large-files`; `npm run check:closeout`; `git diff --check`. API route contract and closeout route source lists were updated to cover the extracted route modules. | pass |
| LFA-P4.4 | DeepSeek reduction review | `docs/examples/reviewer-risk-20260603-workbench-server-entrypoint-p4-deepseek.json` | Initial DS synthesis rejected the earlier 2899-line interim split as not reaching the 2000-line target. The implementation was extended to 1954 lines; final delta synthesis returned PASS with no blockers. Post-closeout runner stabilization is covered by the final gate evidence. | pass |

### Phase LFA-P5: Workbench Projection Test Root Reduction Step 1

Status: pass

Goal: reduce `test/workbench-projection.test.js` below the 1800-line phase target through real domain test shards without weakening the projection contract.

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFA-P5.1 | Select the next highest test target | This document and `.largefile-manifest.json` | Selected `test/workbench-projection.test.js` because it was the largest remaining test root after P3/P4, with a 3175-line baseline, a required 500-line minimum reduction, and an 1800-line phase target. | pass |
| LFA-P5.2 | Extract stable projection test domains | `test/helpers/workbench-projection.js`; `test/workbench-projection-project-management.test.js`; `test/workbench-projection-project-management-dispatch.test.js`; `test/workbench-projection-governance-lifecycle.test.js`; `test/workbench-projection-agent-lifecycle.test.js`; `test/workbench-projection-agent-lifecycle-closed.test.js`; `test/workbench-projection-headless-evidence.test.js`; `test/workbench-projection-continuation.test.js`; `test/workbench-projection-continuation-terminal.test.js` | Root projection suite reduced from 3175 to 1434 lines, below the 1800-line phase target. Extracted shards are all below 300 lines. The target remains open with a new 1184-line reduction target instead of being marked complete. | pass |
| LFA-P5.3 | Run focused and final gates | Command evidence | Focused projection gates passed 55/55. Final gates passed: `npm test` 995/995, `npm run check:large-files` with staged files and no warnings, `npm run check:closeout`, and `git diff --check`. Root and app dependencies were installed in the isolated worktree so browser/Next closeout gates could run. | pass |
| LFA-P5.4 | DeepSeek reduction review | `docs/examples/reviewer-risk-20260603-workbench-projection-p5-deepseek.json` | Initial DS review failed on a plan status mismatch. After correcting status and splitting new shards below 300 lines, final DS synthesis returned PASS. A post-PASS delta review also returned PASS after helper/import cleanup. | pass |

### Phase LFA-P6: Workbench Server Entrypoint Reduction Step 2

Status: pass

Goal: continue the strict reduction of `tools/workbench-server.mjs` below the 1200-line phase target without changing Workbench API behavior or hiding routes from the API contract gate.

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFA-P6.1 | Select current runtime target | This document and `.largefile-manifest.json` | Selected `tools/workbench-server.mjs` because it remained the largest active runtime entrypoint at 1954 lines after P4, with a required 250-line minimum reduction and a 1200-line phase target. | pass |
| LFA-P6.2 | Extract requirement services and reviewer/evidence routes | `tools/workbench-requirement-services.mjs`; `tools/workbench-requirement-plan-services.mjs`; `tools/workbench-requirement-auto-advance-service.mjs`; `tools/workbench-requirement-service-utils.mjs`; `tools/workbench-reviewer-routes.mjs`; `tools/workbench-workflow-evidence-routes.mjs`; `tools/workbench-requirement-routes.mjs`; `tools/workbench-server.mjs` | Server entrypoint reduced from 1954 to 1131 lines, below the 1200-line phase target. New requirement, reviewer, and evidence modules are each below 300 lines, with the old service import preserved as an 11-line re-export layer. The server target remains open with a new 900-line target. | pass |
| LFA-P6.3 | Preserve API route contract coverage after route extraction | `test/api-route-contract.test.js`; `tools/check-api-route-contract.mjs` | Backend route source lists now include reviewer and workflow-evidence route modules, so route extraction cannot make frontend/backend drift checks silently lose coverage. | pass |
| LFA-P6.4 | Run focused gates | Command evidence | Focused server/API/state gates passed 91/91: `node tools/run-with-node18.mjs --test test/workbench-server.test.js test/workbench-server-shard-01.test.js test/workbench-server-shard-02.test.js test/workbench-server-shard-03.test.js test/workbench-server-shard-04.test.js test/workbench-server-shard-05.test.js test/workbench-server-shard-06.test.js test/workbench-server-shard-07.test.js test/workbench-server-shard-08.test.js test/workbench-server-shard-09.test.js test/workbench-server-shard-10.test.js test/workbench-server-shard-11.test.js test/workbench-server-agent-key-routes.test.js test/workbench-state-store.test.js test/api-route-contract.test.js`. | pass |
| LFA-P6.5 | DeepSeek reduction review | `docs/examples/reviewer-risk-20260603-workbench-server-entrypoint-p6-deepseek.json` | Sharded DeepSeek review returned PASS. Non-blocking findings were limited to duplicated route-source lists, lower-bound route-count self-checks, broad projection fallback catch behavior, and a future cleanup suggestion for plan-review workflow-state construction. | pass |
| LFA-P6.6 | Run final gates | Command evidence | Final gates passed: `npm test` 995/995, `npm run check:large-files` with no issues and no warnings, `git diff --check`, and `npm run check:closeout`. The isolated worktree required ignored dependency installs with `npm ci` at the repo root and in `apps/workbench` so Playwright and Next.js closeout gates could run. | pass |

### Phase LFA-P7: Headless CLI Orchestrator Runtime Reduction Step 1

Status: pass

Goal: reduce `src/workflow/headless-cli-orchestrator.js` below the 1200-line phase target without changing child-worker prompt, process-hardening, snapshot, projected next-action, or loop behavior.

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFA-P7.1 | Select current runtime target | This document and `.largefile-manifest.json` | Selected `src/workflow/headless-cli-orchestrator.js` because it was the next active runtime target at 1855 lines, with a required 250-line minimum reduction and a 1200-line phase target. | pass |
| LFA-P7.2 | Extract bounded headless runtime domains | `src/workflow/headless-child-worker-prompt.js`; `src/workflow/headless-process-hardening.js`; `src/workflow/headless-snapshot-publisher.js`; `src/workflow/headless-projected-workbench-client.js`; `src/workflow/headless-projected-next-action.js`; `src/workflow/headless-cli-orchestrator.js`; `.largefile-manifest.json` | Headless CLI orchestrator reduced from 1855 to 1136 lines, below the 1200-line phase target. New prompt, hardening, snapshot, workbench-client, and projected-action modules are each below 300 lines and are registered as accepted extraction modules. The target remains open with a new 900-line target. | pass |
| LFA-P7.3 | Run focused gates | Command evidence | Focused headless/scheduler/projection gates passed 111/111 after adding `test/headless-cli-loop-continuation.test.js`: `node tools/run-with-node18.mjs --test test/headless-cli-loop-continuation.test.js test/headless-cli-orchestrator.test.js test/headless-child-acceptance.test.js test/headless-worker-planning.test.js test/context-work-package-runner.test.js test/context-work-package-execution-scope.test.js test/autonomous-scheduler-loop.test.js test/workbench-projection-headless-evidence.test.js`. `npm run check:large-files` passed with no issues and no warnings before DS, and will be rerun after delta fixes. | pass |
| LFA-P7.4 | DeepSeek reduction review | `docs/examples/reviewer-risk-20260603-headless-cli-orchestrator-p7-deepseek.json` | Initial DS review failed on missing extracted-module manifest entries, snapshot evidence-publish rollback risk, and insufficient dedicated loop/continuation evidence. First delta still flagged orchestrator snapshot failure-state trust, so the failure path now returns the pre-publish workflow state and `test/headless-cli-loop-continuation.test.js` verifies publisher-mutated workflow state is not exposed. Second delta returned PASS. | pass |
| LFA-P7.5 | Run final gates | Command evidence | Final gates passed: `npm test` 998/998, `npm run check:large-files` with no issues and no warnings, `git diff --check`, and `npm run check:closeout`. The isolated worktree required ignored dependency installs with `npm ci` at the repo root and in `apps/workbench` so Playwright and Next.js closeout gates could run. An initial closeout run had one transient Workbench server shard failure; the shard passed on focused rerun and the full closeout rerun passed. | pass |

### Phase LFA-P8: Headless CLI Orchestrator Test Root Reduction Step 1

Status: pass

Goal: reduce `test/headless-cli-orchestrator.test.js` below the 1200-line phase target without changing headless CLI runtime behavior or weakening CLI process/service coverage.

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFA-P8.1 | Select current test target | This document and `.largefile-manifest.json` | Selected `test/headless-cli-orchestrator.test.js` because it was the highest active large-file queue item at 1745 lines, with a required 250-line minimum reduction and a 1200-line phase target. | pass |
| LFA-P8.2 | Extract bounded headless CLI test domains | `test/helpers/headless-cli-orchestrator.js`; `test/headless-cli-orchestrator-cli-basic.test.js`; `test/headless-cli-orchestrator-cli-service-actions.test.js`; `test/headless-cli-orchestrator-cli-service-loop.test.js`; `test/headless-cli-orchestrator.test.js`; `.largefile-manifest.json` | Root headless CLI orchestrator suite reduced from 1745 to 1071 lines, below the 1200-line phase target. The first cut intentionally moved CLI process and Workbench-service CLI coverage because those tests were the stable process/provider/projected-action cluster; child acceptance, provider command-runner, continuation, and injected projected-action loop coverage remain in the root for the next 850-line target. New helper and CLI shards are each below 300 lines and are registered as accepted extraction test files. | pass |
| LFA-P8.3 | Prove split parity and fixture gate coverage | `docs/examples/headless-cli-orchestrator-test-p8-split-parity.json`; `test/helpers/headless-cli-orchestrator.js` | Test-name parity against base `1b9942842874aef04e94e65001d43da05ae1ba80` passed: 40 before / 40 after, with no missing, added, or duplicate test names. Shared fixture `owned_files` and `acceptance_gates` now reference all four headless CLI orchestrator test shards instead of only the old root file. | pass |
| LFA-P8.4 | Run focused gates | Command evidence | Focused headless/scheduler/projection gates passed 111/111: `node tools/run-with-node18.mjs --test test/headless-cli-orchestrator.test.js test/headless-cli-orchestrator-cli-basic.test.js test/headless-cli-orchestrator-cli-service-actions.test.js test/headless-cli-orchestrator-cli-service-loop.test.js test/headless-cli-loop-continuation.test.js test/headless-child-acceptance.test.js test/headless-worker-planning.test.js test/workbench-projection-headless-evidence.test.js test/context-work-package-runner.test.js test/context-work-package-execution-scope.test.js test/autonomous-scheduler-loop.test.js`. `npm run check:large-files` passed with no issues or warnings after correcting the 1071-line reduction target minimum to 215. | pass |
| LFA-P8.5 | DeepSeek reduction review | `docs/examples/reviewer-risk-20260603-headless-cli-orchestrator-test-p8-deepseek.json` | Initial DS synthesis returned FAIL because the plan lacked split parity evidence, the helper fixture still referenced only the old root test gate, and the CLI process/service decomposition was not explained against the original acceptance/provider/continuation/projected-action direction. After adding `docs/examples/headless-cli-orchestrator-test-p8-split-parity.json`, helper shard gate coverage, manifest `split_evidence`, and split-direction rationale, final delta review returned PASS with no blocking findings. | pass |
| LFA-P8.6 | Run final gates | Command evidence | Final gates passed: focused headless/scheduler/projection tests 111/111, `npm test` 998/998, `npm run check:large-files` with no issues and no warnings, `git diff --check`, and `npm run check:closeout`. The isolated worktree required ignored dependency installs with `npm ci` at the repo root and in `apps/workbench` so Playwright and Next.js closeout gates could run. | pass |

### Phase LFA-P9: Workbench Server Test Root Reduction Step 2

Status: pass

Goal: reduce `test/workbench-server.test.js` below the 1400-line phase target without changing Workbench server API behavior or weakening CLI/project-status continuation coverage.

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFA-P9.1 | Select current test target | This document and `.largefile-manifest.json` | Selected `test/workbench-server.test.js` because it is the current highest-priority queue item at 1717 lines, with a required 250-line minimum reduction and a 1400-line phase target. | pass |
| LFA-P9.2 | Extract bounded CLI and project-status continuation shards | `test/workbench-server-cli.test.js`; `test/workbench-server-project-status-continuation.test.js`; `test/helpers/workbench-server.js`; `test/workbench-server.test.js`; `.largefile-manifest.json` | Root Workbench server suite reduced from 1717 to 1363 lines, below the 1400-line phase target, after extracting CLI/project-status shards and cleaning unused root imports. New CLI and project-status continuation shards are 104 and 264 lines, and the shared helper remains below 300 lines at 285 lines. The target remains open with a new 1100-line target. | pass |
| LFA-P9.3 | Prove split parity and fixture gate coverage | `docs/examples/workbench-server-test-p9-split-parity.json`; `test/helpers/workbench-server.js` | Test-name parity against base `3d50a2b25aa95d96813b5949ececa4c8181dc6f2` passed: 21 before / 21 after, with no missing, added, or duplicate test names. Shared fixture `acceptance_gates` now references the root suite, existing server shards, and the P9 CLI/project-status continuation shards. | pass |
| LFA-P9.4 | Run focused gates | Command evidence | Focused server/API/state gates passed 91/91: `node tools/run-with-node18.mjs --test test/workbench-server.test.js test/workbench-server-cli.test.js test/workbench-server-project-status-continuation.test.js test/workbench-server-agent-key-routes.test.js test/workbench-server-shard-01.test.js test/workbench-server-shard-02.test.js test/workbench-server-shard-03.test.js test/workbench-server-shard-04.test.js test/workbench-server-shard-05.test.js test/workbench-server-shard-06.test.js test/workbench-server-shard-07.test.js test/workbench-server-shard-08.test.js test/workbench-server-shard-09.test.js test/workbench-server-shard-10.test.js test/workbench-server-shard-11.test.js test/workbench-state-store.test.js test/api-route-contract.test.js`. | pass |
| LFA-P9.5 | DeepSeek reduction review | `docs/examples/reviewer-risk-20260603-workbench-server-test-p9-deepseek.json` | Initial sharded DS review returned PASS and flagged non-blocking cleanup: unused root imports, helper-gate/parity scope explanation, and retained-domain specificity. After cleanup and manifest/parity updates, delta review returned PASS. A final consistency review also returned PASS after the one-line gate-alignment change moved the root count to 1363. | pass |
| LFA-P9.6 | Run final gates | Command evidence | Final gates passed: focused server/API/state tests 91/91, `npm test` 998/998, `npm run check:large-files` with no issues and no warnings, `git diff --check`, and `npm run check:closeout`. The isolated worktree required ignored dependency installs with `npm ci` at the repo root and in `apps/workbench` so Playwright and Next.js closeout gates could run. | pass |

### Phase LFA-P10: Frontend Acceptance Test Root Reduction Step 1

Status: pass

Goal: reduce `test/frontend-acceptance.test.js` below the 1200-line phase target without weakening release-default latest-projection, content/copy, project-management semantics, command architecture, browser-error, navigation, repair, or closeout wiring coverage.

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFA-P10.1 | Select current test target | This document and `.largefile-manifest.json` | Selected `test/frontend-acceptance.test.js` because it is the current highest-priority queue item at 1670 lines, with a required 250-line minimum reduction and a 1200-line phase target. | pass |
| LFA-P10.2 | Extract bounded fixture helpers and domain shards | `test/helpers/frontend-acceptance-fixtures.js`; `test/helpers/frontend-acceptance-viewport.js`; `test/frontend-acceptance-copy-content.test.js`; `test/frontend-acceptance-content-diagnostics.test.js`; `test/frontend-acceptance-project-semantics.test.js`; `test/frontend-acceptance-command-architecture.test.js`; `test/frontend-acceptance.test.js`; `.largefile-manifest.json` | Root frontend acceptance suite reduced from 1670 to 577 lines, below the 1200-line phase target. The largest new helper is 298 lines and every new shard is below 250 lines, avoiding new near-threshold warnings. The target remains open with a new below-500 / 426-line target. | pass |
| LFA-P10.3 | Prove split parity | `docs/examples/frontend-acceptance-test-p10-split-parity.json` | Test-name parity against base `c08a0f0531afa2462099e51cdcc66471e8e8464e` passed: 36 before / 36 after, with no missing, added, or duplicate test names. | pass |
| LFA-P10.4 | Run focused gates | Command evidence | Focused frontend acceptance gates passed 36/36: `node tools/run-with-node18.mjs --test test/frontend-acceptance.test.js test/frontend-acceptance-copy-content.test.js test/frontend-acceptance-content-diagnostics.test.js test/frontend-acceptance-project-semantics.test.js test/frontend-acceptance-command-architecture.test.js`. | pass |
| LFA-P10.5 | DeepSeek reduction review | `docs/examples/reviewer-risk-20260603-frontend-acceptance-test-p10-deepseek.json` | Sharded DeepSeek review returned PASS. Non-blocking findings were limited to shard-scope caveats, the 298-line helper being close to the 300-line near-threshold warning boundary, and historical-baseline traceability; the manifest, plan, parity artifact, focused gate scope, and large-file gate are internally consistent. | pass |
| LFA-P10.6 | Run final gates | Command evidence | Final gates passed: focused frontend acceptance tests 36/36, `npm test` 998/998, `npm run check:large-files` with no issues and no warnings, `git diff --check`, and `npm run check:closeout`. The isolated worktree required ignored dependency installs with `npm ci` at the repo root and in `apps/workbench` so Playwright and Next.js closeout gates could run. A failed closeout retry left an orphaned 4191 Next process; only that isolated-worktree process group was cleared before the successful focused browser-events rerun and full closeout rerun. | pass |

### Phase LFA-P11: Retired Frontend Acceptance Script Deletion

Status: pass

Goal: delete `tools/retired-workbench-frontend-acceptance.mjs` instead of splitting a retired legacy-static browser runner, while preserving the fail-closed legacy CLI wrapper and current Next frontend-acceptance artifact builder behavior.

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFA-P11.1 | Select retired target | This document and `.largefile-manifest.json` | Selected `tools/retired-workbench-frontend-acceptance.mjs` because it was the highest-priority queue item at 1596 lines and its terminal condition explicitly allowed deletion after replacement evidence remained durable. | pass |
| LFA-P11.2 | Preserve live builder behavior without the retired runner | `tools/workbench-frontend-acceptance-artifact.mjs`; `tools/workbench-frontend-acceptance-content.mjs`; `tools/workbench-frontend-acceptance-resources.mjs`; `tools/check-workbench-frontend-acceptance.mjs`; `docs/examples/retired-frontend-acceptance-p11-parity.json` | The still-used `buildArtifact` and `parseAcceptanceOptions` exports moved into bounded helper modules of 284, 231, and 100 lines. The legacy CLI wrapper remains fail-closed. Parity evidence compares the old base builder and current split builder with canonical JSON excluding runtime `created_at`: artifact shape/status/blocking count and CLI option parsing all match. | pass |
| LFA-P11.3 | Delete retired large file and update manifest | Deleted `tools/retired-workbench-frontend-acceptance.mjs`; `.largefile-manifest.json`; `docs/examples/retired-frontend-acceptance-p11-parity.json` | The 1596-line retired script was removed and its manifest entry was deleted, reducing planned large-file queue count without adding any new file above the 300-line near-threshold budget. The parity artifact records that base `3c7112c1503d85e142c0d4e0378d6dafea0e5405` tracked the deleted file in `.largefile-manifest.json` at 1596 lines before P11. | pass |
| LFA-P11.4 | Run focused gates | Command evidence | Syntax checks passed for the new helpers and frontend-acceptance entrypoints. Focused frontend acceptance, Next frontend acceptance wiring, and legacy static retirement tests passed 43/43: `node tools/run-with-node18.mjs --test test/frontend-acceptance.test.js test/frontend-acceptance-copy-content.test.js test/frontend-acceptance-content-diagnostics.test.js test/frontend-acceptance-project-semantics.test.js test/frontend-acceptance-command-architecture.test.js test/workbench-next-frontend-acceptance.test.js test/legacy-static-workbench-inventory.test.js`. | pass |
| LFA-P11.5 | DeepSeek deletion review | `docs/examples/reviewer-risk-20260603-retired-frontend-acceptance-p11-deepseek.json` | Initial DeepSeek review failed on two evidence gaps: builder export/artifact parity and pre-delete manifest tracking. After adding `docs/examples/retired-frontend-acceptance-p11-parity.json`, delta review returned PASS with no blocking findings or required fixes. | pass |
| LFA-P11.6 | Run final gates | Command evidence | Final gates passed: focused frontend acceptance/Next wiring/legacy retirement tests 43/43, `npm test` 998/998, `npm run check:large-files` with no issues and no warnings, `git diff --check`, and `npm run check:closeout`. The isolated worktree required ignored dependency installs with `npm ci` at the repo root and in `apps/workbench` so Playwright and Next.js closeout gates could run. | pass |

### Phase LFA-P12: Workbench Projection Test Root Reduction Step 2

Status: pass

Goal: reduce `test/workbench-projection.test.js` below the 1184-line phase target without weakening scheduler dispatch, scheduler continuation, scheduler policy, scheduler loop, timeline, reviewer, operator-event, mobile, or input-validation projection coverage.

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFA-P12.1 | Select current test target | This document and `.largefile-manifest.json` | Selected `test/workbench-projection.test.js` because it was the current highest-priority queue item at 1434 lines, with a required 250-line minimum reduction and an 1184-line phase target. | pass |
| LFA-P12.2 | Extract bounded scheduler projection shards | `test/workbench-projection-scheduler-dispatch.test.js`; `test/workbench-projection-scheduler-loop.test.js`; `test/workbench-projection.test.js`; `.largefile-manifest.json` | Root Workbench projection suite reduced from 1434 to 1025 lines, below the 1184-line phase target. The new scheduler dispatch and scheduler loop shards are 216 and 209 lines, keeping each new file below the 300-line near-threshold warning boundary. The target remains open with a new 800-line target. | pass |
| LFA-P12.3 | Prove split parity | `docs/examples/workbench-projection-test-p12-split-parity.json` | Test-name parity against base `3ee1f297552b4a5a130540b2a2723f2586d8cfce` passed: 25 before / 25 after across the root plus two new scheduler shards, with no missing, added, or duplicate test names. | pass |
| LFA-P12.4 | Run focused gates | Command evidence | Focused projection gates passed 70/70: `node tools/run-with-node18.mjs --test test/workbench-projection.test.js test/workbench-projection-scheduler-dispatch.test.js test/workbench-projection-scheduler-loop.test.js test/workbench-projection-one-screen.test.js test/workbench-projection-project-management.test.js test/workbench-projection-project-management-dispatch.test.js test/workbench-projection-governance-lifecycle.test.js test/workbench-projection-agent-lifecycle.test.js test/workbench-projection-agent-lifecycle-closed.test.js test/workbench-projection-headless-evidence.test.js test/workbench-projection-continuation.test.js test/workbench-projection-continuation-terminal.test.js test/workbench-projection-fixture.test.js test/workbench-projection-purity.test.js test/workbench-projection-schema.test.js`. `npm run check:large-files` passed with no issues and no warnings. | pass |
| LFA-P12.5 | DeepSeek reduction review | `docs/examples/reviewer-risk-20260603-workbench-projection-test-p12-deepseek.json` | Initial sharded DeepSeek synthesis failed because `.largefile-manifest.json` lacked `split_evidence` and the sharded view did not jointly prove root plus both scheduler shards. After adding manifest split evidence, delta review read the root suite, both scheduler shards, manifest entry, and parity artifact together and returned PASS with no blocking findings. | pass |
| LFA-P12.6 | Run final gates | Command evidence | Final gates passed: focused projection tests 70/70, `npm test` 998/998, `npm run check:large-files` with no issues and no warnings, `git diff --check`, and `npm run check:closeout`. The isolated worktree required ignored dependency installs with `npm ci` at the repo root and in `apps/workbench` so Playwright and Next.js closeout gates could run. | pass |

### Phase LFA-P13: Workbench Server Test Root Reduction Step 3

Status: pass

Goal: reduce `test/workbench-server.test.js` below the 1100-line phase target without changing Workbench server API behavior or weakening requirement submission, plan generation, failed-plan retry/close, generated acceptance gates, or existing server shard coverage.

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFA-P13.1 | Select current test target | This document and `.largefile-manifest.json` | Selected `test/workbench-server.test.js` because it is the current highest-priority queue item at 1363 lines, with a required 250-line minimum reduction and a 1100-line phase target. | pass |
| LFA-P13.2 | Extract bounded requirement plan-generation shard | `test/workbench-server-requirement-plan-generation.test.js`; `test/workbench-server.test.js`; `test/helpers/workbench-server.js`; `.largefile-manifest.json` | Root Workbench server suite reduced from 1363 to 1092 lines, below the 1100-line phase target. The new requirement plan-generation shard is 286 lines and the shared helper remains 285 lines after adding the new shard to `WORKBENCH_SERVER_TEST_FILES`, so neither file crosses the 300-line near-threshold warning boundary. The target remains open with a new 850-line target. | pass |
| LFA-P13.3 | Prove split parity and fixture gate coverage | `docs/examples/workbench-server-test-p13-split-parity.json`; `test/helpers/workbench-server.js`; `.largefile-manifest.json` | Test-name parity against base `6e9dcb228d129af6d8232816740f328ba8682b02` passed: 17 before / 17 after across the root plus new requirement plan-generation shard, with no missing, added, or duplicate test names. Shared fixture `WORKBENCH_SERVER_TEST_FILES` now references the P13 shard so generated acceptance gates include it, and the extracted shard is registered as an independent accepted manifest entry at 286 lines. | pass |
| LFA-P13.4 | Run focused gates | Command evidence | Focused server/API/state gates passed 91/91: `node tools/run-with-node18.mjs --test test/workbench-server.test.js test/workbench-server-requirement-plan-generation.test.js test/workbench-server-cli.test.js test/workbench-server-project-status-continuation.test.js test/workbench-server-agent-key-routes.test.js test/workbench-server-shard-01.test.js test/workbench-server-shard-02.test.js test/workbench-server-shard-03.test.js test/workbench-server-shard-04.test.js test/workbench-server-shard-05.test.js test/workbench-server-shard-06.test.js test/workbench-server-shard-07.test.js test/workbench-server-shard-08.test.js test/workbench-server-shard-09.test.js test/workbench-server-shard-10.test.js test/workbench-server-shard-11.test.js test/workbench-state-store.test.js test/api-route-contract.test.js`. | pass |
| LFA-P13.5 | DeepSeek reduction review | `docs/examples/reviewer-risk-20260603-workbench-server-test-p13-deepseek.json` | Initial DeepSeek review failed on one blocking manifest completeness issue: the extracted P13 shard lacked an independent accepted manifest entry. Delta review passed after adding `test/workbench-server-requirement-plan-generation.test.js` to `.largefile-manifest.json` at 286 lines and syncing this plan. | pass |
| LFA-P13.6 | Run final gates | Command evidence | Final gates passed: `npm test` 998/998, `npm run check:large-files` pass with no issues/warnings, `git diff --check` pass, and `npm run check:closeout` pass after installing root/app dependencies in the isolated worktree to satisfy browser/Next checks. | pass |

### Phase LFA-P14: Autonomous Continuation Test Root Reduction Step 1

Status: pass

Goal: reduce `test/autonomous-continuation.test.js` below the 1000-line phase target without weakening base continuation decisions, global-goal lifecycle handling, self-governance repair scheduling, frontend repair dedupe, governance audit repair, reviewer recovery, provider health, rollback/human-stop, snapshot publishing, or project-status next-work-package coverage.

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFA-P14.1 | Select current test target | This document and `.largefile-manifest.json` | Selected `test/autonomous-continuation.test.js` because it is the current highest-priority queue item at 1357 lines, with a required 250-line minimum reduction and a 1000-line phase target. | pass |
| LFA-P14.2 | Extract bounded global-goal and governance repair shards | `test/autonomous-continuation-global-goals.test.js`; `test/autonomous-continuation-governance-repair.test.js`; `test/autonomous-continuation.test.js`; `.largefile-manifest.json` | Root autonomous continuation suite reduced from 1357 to 840 lines, below the 1000-line phase target. The new global-goals shard is 257 lines and the governance-repair shard is 294 lines, so both remain below the 300-line near-threshold warning boundary. The target remains open with a new 690-line target. | pass |
| LFA-P14.3 | Prove split parity and manifest coverage | `docs/examples/autonomous-continuation-test-p14-split-parity.json`; `.largefile-manifest.json` | Test-name parity against base `origin/main` passed: 37 before / 37 after across the root plus two new shards, with no missing, added, or duplicate test names. Both extracted shards are registered as independent accepted manifest entries. | pass |
| LFA-P14.4 | Run focused gates | Command evidence | Focused autonomous continuation gates passed 37/37: `node tools/run-with-node18.mjs --test test/autonomous-continuation.test.js test/autonomous-continuation-global-goals.test.js test/autonomous-continuation-governance-repair.test.js`. | pass |
| LFA-P14.5 | DeepSeek reduction review | `docs/examples/reviewer-risk-20260603-autonomous-continuation-test-p14-deepseek.json` | DeepSeek read-only sharded review passed: it confirmed parity, shard dependencies, assertion preservation, independent manifest entries for both shards, the 690-line follow-up target, and no premature phase pass. | pass |
| LFA-P14.6 | Run final gates | Command evidence | Final gates passed: `npm test` 998/998, `npm run check:large-files` pass with no issues/warnings, `git diff --check` pass, and `npm run check:closeout` pass after installing root/app dependencies in the isolated worktree to satisfy browser/Next checks. | pass |

### Phase LFA-P15: Requirement Intake Runtime Extraction Step 1

Status: pass

Goal: reduce `src/workflow/requirement-intake.js` below the 1000-line phase target without changing public imports or weakening requirement submission, generated plan validation, plan review approval/revision, frontend view slicing, requirement completion/closeout, or workflow event recording behavior.

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFA-P15.1 | Select current runtime target | This document and `.largefile-manifest.json` | Selected `src/workflow/requirement-intake.js` because it was the current runtime queue item at 1318 lines, with a required 250-line minimum reduction and a 1000-line phase target. | pass |
| LFA-P15.2 | Extract bounded plan generation and granularity modules | `src/workflow/requirement-plan-generation.js`; `src/workflow/requirement-plan-granularity.js`; `src/workflow/requirement-intake.js`; `.largefile-manifest.json` | Root requirement intake module reduced from 1318 to 987 lines, below the 1000-line phase target. The new generation helper is 124 lines and the granularity helper is 276 lines, so both remain below the 300-line near-threshold warning boundary. The target remains open with a new 800-line target. | pass |
| LFA-P15.3 | Prove export compatibility and manifest coverage | `docs/examples/requirement-intake-p15-extraction-parity.json`; `.largefile-manifest.json` | Compatibility artifact records root public exports, retained root domains, moved domains, and focused runtime gates. Both extracted helpers are registered as independent accepted manifest entries. | pass |
| LFA-P15.4 | Run focused gates | Command evidence | Syntax check passed for all three runtime modules. Focused runtime gates passed 49/49: `node tools/run-with-node18.mjs --test test/requirement-intake.test.js test/workbench-server.test.js test/workbench-projection.test.js test/context-pack-cycle.test.js`. `npm run check:large-files` passed with no issues and no warnings after manifest refresh. | pass |
| LFA-P15.5 | DeepSeek reduction review | `docs/examples/reviewer-risk-20260603-requirement-intake-p15-deepseek.json` | DeepSeek read-only sharded review passed. It confirmed public re-exports, fail-closed plan generation validation, frontend view slicing/dependency rewriting/execution_governance coverage, manifest registration for both new helpers, the retained 800-line follow-up target, and no premature phase pass. | pass |
| LFA-P15.6 | Run final gates | Command evidence | Final gates passed after installing root and workbench dependencies inside the isolated worktree: `npm test` passed 1001/1001, `npm run check:large-files` passed with no issues and no warnings, `git diff --check` passed, and `npm run check:closeout` passed. During closeout, the governance audit skill trial exposed a false-red parser gap for prose DeepSeek verdicts; the runner now accepts only explicit conclusion labels, blocks explicit failing verdicts, and fails closed on incidental pass words. Delta tests passed 13/13 and DeepSeek delta review passed after one failed first review was repaired. | pass |

### Phase LFA-P16: Context Work Package Runner Test Split Step 1

Status: pass

Goal: reduce `test/context-work-package-runner.test.js` below the 950-line phase target without weakening dispatch execution, fixed-development owned-files gating, local completion authority rejection, provider-routed completion authority, background dispatch staging, failed dispatch retry, workspace mutation guard, or isolated worker worktree enforcement.

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFA-P16.1 | Select current test target | This document and `.largefile-manifest.json` | Selected `test/context-work-package-runner.test.js` because it is the current highest-priority queue item at 1242 lines, with a required 249-line minimum reduction and a 950-line phase target. | pass |
| LFA-P16.2 | Extract shared fixtures and bounded execution-guard shard | `test/helpers/context-work-package-runner.js`; `test/context-work-package-runner-execution-guards.test.js`; `test/context-work-package-runner.test.js`; `.largefile-manifest.json` | Root context-work-package runner suite reduced from 1242 to 801 lines, below the 950-line phase target. The new execution-guards shard is 244 lines and the shared fixture helper is 212 lines, so both remain below the 300-line near-threshold warning boundary. The root remains planned debt with a new 650-line follow-up target. | pass |
| LFA-P16.3 | Prove split parity and manifest coverage | `docs/examples/context-work-package-runner-test-p16-split-parity.json`; `.largefile-manifest.json` | Test-name parity against base `origin/main` passed: 24 before / 24 after across the root plus new shard, with no missing, added, or duplicate test names. The helper and shard are registered as independent accepted manifest entries. | pass |
| LFA-P16.4 | Run focused gates | Command evidence | Syntax checks passed for the root, new shard, and helper. Focused context-work-package runner gates passed 24/24: `node tools/run-with-node18.mjs --test test/context-work-package-runner.test.js test/context-work-package-runner-execution-guards.test.js`. `npm run check:large-files` passed with no issues and no warnings after manifest refresh. | pass |
| LFA-P16.5 | DeepSeek reduction review | `docs/examples/reviewer-risk-20260603-context-work-package-runner-test-p16-deepseek.json` | DeepSeek read-only sharded review passed. It confirmed fixture factory independence, execution-guard fail-closed assertion preservation, parity evidence, manifest registration, the retained 650-line follow-up target, and no premature phase pass. | pass |
| LFA-P16.6 | Run final gates | Command evidence | Final gates passed after installing root and workbench dependencies inside the isolated worktree: `npm test` passed 1001/1001, `npm run check:large-files` passed with no issues and no warnings, `git diff --check` passed, JSON artifacts parsed, and `npm run check:closeout` passed. The first closeout attempt failed only because the fresh worktree lacked `playwright`; root/app `npm ci` resolved the environment gap and the full rerun passed. | pass |

### Phase LFA-P17: Headless CLI Orchestrator Below-500 Extraction

Status: pass

Goal: reduce `src/workflow/headless-cli-orchestrator.js` from 1136 lines to below 500 lines in this phase, without weakening input validation, child worker execution, provider executor completion authority, lifecycle facts, context work-package dispatch, snapshot publishing, projected next-action loop behavior, or public exports. New extracted modules must stay below 500 lines and should remain below the 300-line near-threshold budget where practical.

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFA-P17.1 | Select current runtime target and apply below-500 policy | This document and `.largefile-manifest.json` | Selected `src/workflow/headless-cli-orchestrator.js` because it is the current highest-priority runtime queue item at 1136 lines. Under the new policy, this phase may pass only if the root file is below 500 lines and no newly extracted module exceeds 500 lines. | pass |
| LFA-P17.2 | Extract bounded orchestration modules | `src/workflow/headless-orchestrator-utils.js`; `src/workflow/headless-child-worker-runtime.js`; `src/workflow/headless-provider-executor.js`; `src/workflow/headless-main-orchestrator-cycle.js`; `src/workflow/headless-main-orchestrator-loop.js`; `src/workflow/headless-cli-orchestrator.js`; `.largefile-manifest.json` | Root orchestrator reduced from 1136 to 27 lines, below the 500-line terminal target. Extracted modules are 102, 394, 93, 313, and 228 lines, all below 500, and preserve the existing public entrypoint through re-exports. | pass |
| LFA-P17.3 | Prove export compatibility and manifest coverage | `docs/examples/headless-cli-orchestrator-p17-extraction-parity.json`; `.largefile-manifest.json` | Compatibility artifact records public exports, moved domains, line counts, focused gates, and below-500 policy compliance. All extracted modules are registered as accepted manifest entries. Remaining planned-refactor manifest targets were tightened to below-500 terminal targets. | pass |
| LFA-P17.4 | Run focused gates | Command evidence | Syntax checks passed for the root and all five extracted modules. Focused headless/scheduler/projection gates passed 88/88. `npm run check:large-files` passed with no issues and no warnings after manifest refresh. | pass |
| LFA-P17.5 | DeepSeek reduction review | `docs/examples/reviewer-risk-20260604-headless-cli-orchestrator-p17-deepseek.json` | Initial DeepSeek review returned an evidence-gap fail, not a concrete code defect. Supplemental export/line-count evidence was recorded, and the full-file delta DeepSeek review returned PASS with no blocking findings. | pass |
| LFA-P17.6 | Run final gates | Command evidence | Final gates passed: `npm test` 1001/1001, `npm run check:large-files`, `git diff --check`, JSON parsing for manifest/parity/reviewer artifacts, and `npm run check:closeout` after installing root and `apps/workbench` dependencies in the isolated worktree. | pass |

### Phase LFA-P18: Context Work Package Runner Below-500 Extraction

Status: pass

Goal: reduce `src/workflow/context-work-package-runner.js` from 1135 lines to below 500 lines in this phase, without weakening manifest validation, runnable work-package selection, fixed-development and execution-governance gates, provider/model-routed completion authority, local bounded completion rejection, dispatch staging/failure persistence, project-status sync, artifact recording, lifecycle facts, or public exports. New extracted modules must stay below 500 lines.

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFA-P18.1 | Select current runtime target and apply below-500 policy | This document and `.largefile-manifest.json` | Selected `src/workflow/context-work-package-runner.js` because it was the current highest-priority runtime queue item at 1135 lines. Under the active policy, this phase may pass only if the root file is below 500 lines and no newly extracted module exceeds 500 lines. | pass |
| LFA-P18.2 | Extract bounded runner modules | `src/workflow/context-work-package-runner-shared.js`; `src/workflow/context-work-package-runner-completion.js`; `src/workflow/context-work-package-runner-lifecycle.js`; `src/workflow/context-work-package-runner-dispatch.js`; `src/workflow/context-work-package-runner.js`; `.largefile-manifest.json` | Root runner reduced from 1135 to 472 lines, below the 500-line terminal target. Extracted modules are 283, 26, 207, and 202 lines, all below 500, and the root preserves the public entrypoint through re-exports. | pass |
| LFA-P18.3 | Prove export compatibility and manifest coverage | `docs/examples/context-work-package-runner-p18-extraction-parity.json`; `.largefile-manifest.json` | Compatibility artifact records public exports, moved domains, line counts, focused gates, and below-500 policy compliance. All extracted modules are registered as accepted manifest entries. | pass |
| LFA-P18.4 | Run focused gates | Command evidence | Syntax checks passed for the root and all four extracted modules. Focused context/headless/scheduler/server/development-flow gates passed 109/109. `npm run check:large-files` passed with no issues after manifest refresh. | pass |
| LFA-P18.5 | DeepSeek reduction review | `docs/examples/reviewer-risk-20260604-context-work-package-runner-p18-deepseek.json` | DeepSeek read-only review returned `通过` with synthesis `PASS`, confirming public compatibility, behavior-preserving extraction, below-500 compliance, manifest registration, no oversized replacement module, and no premature plan completion. | pass |
| LFA-P18.6 | Run final gates | Command evidence | Final gates passed: `npm test` passed 1001/1001; `npm run check:large-files` passed; `git diff --check` passed; JSON parsing passed for the manifest, P18 parity artifact, and DeepSeek review artifact; `npm run check:closeout` passed after installing root and `apps/workbench` dependencies in the isolated worktree. | pass |

### Phase LFA-P19: Workbench Server Below-500 Extraction

Status: pass

Goal: reduce `tools/workbench-server.mjs` from 1131 lines to below 500 lines in this phase, without weakening the Workbench API route surface, SQLite-first live state boundary, projection/history reads, project-status continuation, context-pack materialization, context work-package background/foreground dispatch, scheduler/reviewer/requirement route ordering, agent health timer behavior, or CLI startup. New extracted modules must stay below 500 lines and must be registered independently in `.largefile-manifest.json`.

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFA-P19.1 | Select current server target and apply below-500 policy | This document and `.largefile-manifest.json` | Selected `tools/workbench-server.mjs` because it is the current highest-priority runtime queue item at 1131 lines. This phase may pass only if the root server entrypoint is below 500 lines and no newly extracted module exceeds 500 lines. | pass |
| LFA-P19.2 | DeepSeek plan review before code extraction | `docs/examples/reviewer-risk-20260604-workbench-server-p19-plan-deepseek.json` | Initial DeepSeek review found blockers around oversized helper extraction, routeContext compatibility, context-work-package closure injection, and structured diagnostics. The plan was revised to require multiple bounded helper modules, explicit dependency injection, routeContext key evidence, and structured diagnostic assertions; DeepSeek delta review returned `通过`. | pass |
| LFA-P19.3 | Extract state/projection and scheduler helper surface into multiple bounded modules | `tools/workbench-server-state-access.mjs`; `tools/workbench-server-scheduler-utils.mjs`; `tools/workbench-server.mjs`; `.largefile-manifest.json` | State/history/projection/snapshot/event helpers and scheduler continuation/background helpers were extracted into two bounded modules. Current line counts: server 408, state-access 287, scheduler-utils 346. A moved-helper import gap around `relative` was caught by focused tests and repaired with explicit module imports. | pass |
| LFA-P19.4 | Extract project-status/context-pack/context-work-package routes with explicit dependency injection | `tools/workbench-context-routes.mjs`; `tools/workbench-context-work-package-routes.mjs`; `tools/workbench-server.mjs`; `.largefile-manifest.json` | Project-status continuation, context-pack cycle, and context work-package foreground/background dispatch moved into bounded route modules at 109 and 141 lines. Handlers receive explicit routeContext dependencies for provider executor, background launcher, state store/db path, projection, and read/write helpers. | pass |
| LFA-P19.5 | Prove routeContext, diagnostics, exports, and manifest compatibility | `docs/examples/workbench-server-p19-extraction-parity.json`; `test/api-route-contract.test.js`; `test/workbench-server-project-status-continuation.test.js`; `.largefile-manifest.json` | P19 parity artifact records exports, moved routes, line counts, routeContext keys, and diagnostic fields. API route contract now includes the extracted route modules plus a routeContext/diagnostic static test. Runtime server coverage asserts structured 409 diagnostics retain `phase`, governance fields, completion authority, executor provenance, and package results. | pass |
| LFA-P19.6 | Run focused gates and DeepSeek code review | `docs/examples/reviewer-risk-20260604-workbench-server-p19-deepseek.json`; command evidence | Focused server/API/context/scheduler gates passed 129/129 with `--test-concurrency=1`; `npm run check:large-files` passed with no issues or warnings; JSON parsing passed for P19 artifacts. DeepSeek initial code/document review found two documentation blockers around ambiguous corrected-gate status and premature artifact-level pass status; both were repaired, and DeepSeek delta review returned PASS with no new blockers. | pass |
| LFA-P19.7 | Run final gates | Command evidence | Final gates passed: syntax checks for `tools/workbench-server.mjs`, the four extracted modules, and `tools/check-api-route-contract.mjs`; JSON parsing passed for the manifest and P19 artifacts; `git diff --check` passed; `npm run check:large-files` passed with no issues or warnings; focused route/server/context/scheduler gates passed 129/129; `npm test` passed 1002/1002; `npm run check:closeout` passed after root and Workbench app dependencies were installed in the isolated worktree. The first closeout retry exposed a stale local Next runtime on port 4191; browser-events passed independently on 4291 and the full closeout passed after the stale port cleared. | pass |

### Phase LFA-P20: Workbench Server Root Test Below-500 Split

Status: pass

Goal: reduce `test/workbench-server.test.js` from 1092 lines to below 500 lines in this phase, without changing Workbench server behavior, route coverage, or assertion semantics. New test shards must stay below 300 lines where practical and must be registered independently in `.largefile-manifest.json` when they are retained above the near-threshold budget.

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFA-P20.1 | Select current test target and apply below-500 policy | This document and `.largefile-manifest.json` | Selected `test/workbench-server.test.js` because it is the current Q01 planned-refactor item at 1092 lines. This phase may pass only if the root test falls below 500 lines and no newly extracted shard exceeds 500 lines. | pass |
| LFA-P20.2 | DeepSeek plan review before test movement | `docs/examples/reviewer-risk-20260604-workbench-server-test-p20-plan-deepseek.json` | Initial DeepSeek plan review failed because three tests lacked explicit target assignment, provider/agent/closeout boundaries were ambiguous, and parity/helper/manifest requirements were underspecified. Revised mapping accounts for all 14 current root tests: keep the three projection-baseline tests plus the long context-pack snapshot-id test in the root; move fallback and supplied-plan retry tests to `test/workbench-server-requirement-plan-retry.test.js` (budget <260 lines); move plan-review decision and auto-development tests to `test/workbench-server-plan-review.test.js` (budget <260 lines); move background dispatch staging to `test/workbench-server-background-dispatch.test.js` (budget <220 lines); move verified-provider requirement completion and provider-context dual-call tests to `test/workbench-server-provider-execution.test.js` (budget <280 lines); move closeout and governed-agent executor tests to `test/workbench-server-requirement-closeout.test.js` (budget <260 lines); move provider default next-action coverage to `test/workbench-server-provider-defaults.test.js` (budget <180 lines). DeepSeek delta review returned PASS with no remaining required changes. | pass |
| LFA-P20.3 | Move tests into bounded shards without changing assertions | Test shard files and root test | Moved whole `test(...)` blocks into six bounded shards without `.skip`/`.todo` conversions or assertion edits. Current line counts: root 160, requirement-plan-retry 159, plan-review 201, background-dispatch 145, provider-execution 216, requirement-closeout 208, provider-defaults 87. Syntax checks passed for root, helper, and all new shards; focused P20 root/shard tests passed 14/14. | pass |
| LFA-P20.4 | Prove split parity, helper coverage, and manifest compatibility | `docs/examples/workbench-server-test-p20-split-parity.json`; `test/helpers/workbench-server.js`; `.largefile-manifest.json` | Parity artifact records 14 before / 14 after tests with no missing, added, or duplicate names. `WORKBENCH_SERVER_TEST_FILES` includes all P20 shards, and `.largefile-manifest.json` records the root at 160 accepted lines plus accepted entries for each new shard. | pass |
| LFA-P20.5 | Run focused gates and DeepSeek code review | `docs/examples/reviewer-risk-20260604-workbench-server-test-p20-deepseek.json`; command evidence | Syntax checks passed for the root, helper, and all new shards. Focused P20 tests passed 14/14; expanded server/API focused tests passed 87/87; split parity validation passed for 14 current tests; `npm run check:large-files` passed with no issues or warnings. DeepSeek sharded code/evidence review returned PASS with no blocking findings. | pass |
| LFA-P20.6 | Run final gates | Command evidence | Final gates passed: JSON parsing for `.largefile-manifest.json` and P20 artifacts; `git diff --check`; `npm run check:large-files`; focused P20 root/shard tests 14/14; expanded server/API tests 87/87; `npm test` 1002/1002; and full `npm run check:closeout`. The first full closeout retry exposed a transient local Next browser-events timeout on port 4191; after clearing the leftover temporary Next dev process, the standalone browser-events gate passed 15 scenarios and the full closeout rerun passed, including frontend acceptance and scheduler dispatch writeback. | pass |

### Phase LFA-P21: Headless CLI Orchestrator Root Test Below-500 Split

Status: pass

Goal: reduce `test/headless-cli-orchestrator.test.js` from 1071 lines to below 500 lines in this phase, without changing headless CLI runtime behavior, child-worker acceptance semantics, prompt safety checks, provider execution, projected next-action loop behavior, snapshot publishing, or hardening/no-diff gates. New test shards must stay below 300 lines where practical and below 500 lines as a hard pass condition.

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFA-P21.1 | Select current test target and apply below-500 policy | This document and `.largefile-manifest.json` | Selected `test/headless-cli-orchestrator.test.js` because it is the current Q01 planned-refactor item at 1071 lines. This phase may pass only if the root test falls below 500 lines and no newly extracted shard exceeds 500 lines. | pass |
| LFA-P21.2 | DeepSeek plan review before test movement | `docs/examples/reviewer-risk-20260604-headless-cli-orchestrator-test-p21-plan-deepseek.json` | Initial DeepSeek review failed because the plan used a stale 31-test count instead of the actual 33 tests, and the proposed child-provider and loop-projection shards were too close to the 300-line near-threshold budget. Revised mapping accounts for all 33 current root tests: keep the main orchestrator smoke, existing context cycle continuation, sanitized child-worker environment, implicit mock block, long snapshot-id, and wrong-role input-validation tests in the root; move child-worker acceptance, owned-file boundary, and child output-path parsing tests to `test/headless-cli-orchestrator-child-acceptance.test.js` (budget <290 lines); move real child command runner, prompt minimization, requirement step context, deferred parent-owned gates, and governed-agent retry coverage to `test/headless-cli-orchestrator-child-provider.test.js` (budget <260 lines); move snapshot persistence and loop snapshot persistence to `test/headless-cli-orchestrator-loop-persistence.test.js` (budget <160 lines); move projected next-action, service projection refresh, service-first projection, projected-action blocker/terminal/nonlocal/missing-service checks to `test/headless-cli-orchestrator-loop-projection.test.js` (budget <270 lines); move timed-out child hardening, fenced JSON parser, no-diff retry hardening, and no-diff integration acceptance to `test/headless-cli-orchestrator-hardening.test.js` (budget <180 lines). DeepSeek delta review returned PASS with no blocking findings; it noted child-acceptance remains near the 300-line threshold and must be checked with actual line counts. | pass |
| LFA-P21.3 | Move tests into bounded shards without changing assertions | Test shard files and root test | Moved whole `test(...)` blocks into five bounded shards without `.skip`/`.todo` conversions or assertion edits. Current line counts: root 209, child-acceptance 275, child-provider 240, loop-projection 248, hardening 129, loop-persistence 79; helper remains 204 and does not exceed its accepted manifest ceiling. Syntax checks passed for the root, helper, and all new shards; focused P21 root/shard tests passed 33/33. | pass |
| LFA-P21.4 | Prove split parity, helper coverage, and manifest compatibility | `docs/examples/headless-cli-orchestrator-test-p21-split-parity.json`; `test/helpers/headless-cli-orchestrator.js`; `.largefile-manifest.json` | Split parity records 33 before / 33 after tests with no missing, added, or duplicate names, derived from actual test-name extraction. `HEADLESS_CLI_ORCHESTRATOR_TEST_FILES` includes every retained shard, `.largefile-manifest.json` records the root at 209 accepted lines plus accepted entries for all five new shards, and `npm run check:large-files` passed with no issues or warnings. | pass |
| LFA-P21.5 | Run focused gates and DeepSeek code review | `docs/examples/reviewer-risk-20260604-headless-cli-orchestrator-test-p21-deepseek.json`; command evidence | Syntax checks passed; focused P21 root/shard tests passed 33/33; expanded headless/scheduler/projection/context gates passed 104/104; split parity validation passed for 33 current tests; `npm run check:large-files` passed with no issues or warnings. DeepSeek sharded code/evidence synthesis returned PASS with no blocking findings; one plan-document shard correctly noted P21.5/P21.6 were pending at review time, so final status remains gated on LFA-P21.6. | pass |
| LFA-P21.6 | Run final gates | Command evidence | Final gates passed: JSON parsing for `.largefile-manifest.json` and all P21 artifacts; split parity validation 33/33 from actual shard files; `git diff --check`; `npm run check:large-files`; `npm test` 1002/1002; and full `npm run check:closeout`. The first closeout attempt failed because this fresh worktree lacked Playwright dependencies; after running `npm ci` in the repo root and `apps/workbench`, the rerun passed including public browser route, browser-events 15 scenarios, frontend acceptance, and scheduler dispatch writeback. | pass |

### Phase LFA-P22: Workbench Projection Root Test Below-500 Split

Status: in_progress

Goal: reduce `test/workbench-projection.test.js` from 1025 lines to below 500 lines in this phase, without changing workbench projection behavior, reviewer recovery/readout coverage, reviewer shard aggregation, operations timeline ordering, operator event ingestion precedence, mobile projection subset behavior, or input-validation fail-closed semantics. New test shards must stay below 300 lines where practical and below 500 lines as a hard pass condition.

| ID | Work item | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- | --- |
| LFA-P22.1 | Select current projection test target and apply below-500 policy | This document and `.largefile-manifest.json` | Selected `test/workbench-projection.test.js` because it is the current Q01 planned-refactor item at 1025 lines with a target gap of 526 lines. This phase may pass only if the root test falls below 500 lines and no newly extracted shard exceeds 500 lines. | pass |
| LFA-P22.2 | DeepSeek plan review before test movement | `docs/examples/reviewer-risk-20260604-workbench-projection-test-p22-plan-deepseek.json` | Planned mapping accounts for all 19 current root tests: keep the broad projection smoke, terminal next-action, closeout publish evidence, browser event evidence, failed frontend acceptance repair, replay validation resume health, mobile subset, and input validation tests in the root; move reviewer provider health, reviewer scope split, and partial next-shard advancement to `test/workbench-projection-reviewer-recovery.test.js` (budget <230 lines); move reviewer shard aggregate status and reviewer aggregate continuation to `test/workbench-projection-reviewer-aggregate.test.js` (budget <230 lines); move compact operations timeline and clock-skew ordering to `test/workbench-projection-operations-timeline.test.js` (budget <230 lines); move operator event ingestion, stale-run precedence, explicit run evaluation fallback, and ingestion fail-closed coverage to `test/workbench-projection-operator-events.test.js` (budget <180 lines). DeepSeek returned PASS with no blocking findings; it required only non-blocking implementation care around helper acceptance gates, reviewer-aggregate headroom, and P12 parity supersession. | pass |
| LFA-P22.3 | Move tests into bounded shards without changing assertions | Test shard files and root test | Moved whole `test(...)` blocks into four bounded shards without `.skip`/`.todo` conversions or assertion edits. Current line counts: root 395, reviewer-recovery 169, reviewer-aggregate 184, operations-timeline 180, operator-events 126; helper is 110 and `contextPack().acceptance_gates` now references the root plus all current projection shards through `WORKBENCH_PROJECTION_TEST_FILES`. Syntax checks passed for the root, helper, and all new shards. | pass |
| LFA-P22.4 | Prove split parity, helper coverage, and manifest compatibility | `docs/examples/workbench-projection-test-p22-split-parity.json`; `.largefile-manifest.json` | P22 parity artifact records 19 before / 19 after tests with no missing, added, or duplicate names, and explicitly supersedes `docs/examples/workbench-projection-test-p12-split-parity.json`. `.largefile-manifest.json` records the root at 395 accepted lines plus independent accepted entries for all four new shards. Focused projection suite passed 70/70 and `npm run check:large-files` passed with no issues or warnings. | pass |
| LFA-P22.5 | Run focused gates and DeepSeek code review | `docs/examples/reviewer-risk-20260604-workbench-projection-test-p22-deepseek.json`; command evidence | Syntax checks passed for root/new shards/helper; focused projection suite passed 70/70; split parity validation passed for 19 current tests; `npm run check:large-files` passed with no issues or warnings. DeepSeek sharded code/evidence synthesis returned PASS with no blocking findings; bounded shard evidence gaps were resolved by later shards and synthesis. | pass |
| LFA-P22.6 | Run final gates | Command evidence | Final gates passed: JSON parsing for `.largefile-manifest.json` and P22 artifacts, split parity validation, `git diff --check`, `npm run check:large-files`, `npm test` 1002/1002, and full `npm run check:closeout`. The first closeout attempt failed because the isolated worktree lacked Playwright dependencies; after `npm ci` in the root and `apps/workbench`, the rerun passed. | pass |

## Acceptance Tracking

| Phase | Status | Latest evidence | Reviewer |
| --- | --- | --- | --- |
| LFA-P0 | pass | Initial DS review failed with three blockers; plan was revised; delta DS review passed with no blocking findings. | DeepSeek PASS after delta |
| LFA-P1 | pass | Baseline anti-abuse gate implemented; focused tests, `npm test`, `npm run check:large-files`, `npm run check:closeout`, and `git diff --check` passed. | DeepSeek PASS after delta |
| LFA-P2 | pass | Focused tests passed: `node tools/run-with-node18.mjs --test test/large-file-report.test.js test/large-file-reduction-targets.test.js test/select-affected-tests.test.js test/governance-enrollment.test.js`; `npm run check:large-files`; `git diff --check`; `npm test`; `npm run check:closeout`. DeepSeek final delta PASS is recorded in `docs/examples/reviewer-risk-20260603-large-file-reduction-p2-deepseek.json`. | DeepSeek PASS after delta |
| LFA-P3 | pass | Selected Q01 `test/workbench-server.test.js`; root shard is 1717 lines after split, target tests, large-file gate, full `npm test`, and full closeout passed. DeepSeek initial fail was repaired; delta review passed with no blocking findings. | DeepSeek PASS after delta |
| LFA-P4 | pass | Selected `tools/workbench-server.mjs`; entrypoint is 1954 lines after extracting HTTP utilities, loop/next-action support, CLI parsing, mainline preflight evaluator, snapshot/event routes, requirement routes, scheduler dispatch routes, and scheduler loop/next-action routes. Final gates passed: focused server tests 86/86, `npm test` 995/995, large-file gate, full closeout, and diff whitespace check. | DeepSeek PASS after delta |
| LFA-P5 | pass | Selected `test/workbench-projection.test.js`; root shard is 1434 lines after extracting shared fixtures plus project-management, project-management-dispatch, governance-lifecycle, agent-lifecycle, agent-lifecycle-closed, headless-evidence, continuation, and continuation-terminal shards, all under 300 lines. Final gates passed: focused projection tests 55/55, `npm test` 995/995, staged large-file gate with no warnings, full closeout, and diff whitespace check. | DeepSeek PASS after delta |
| LFA-P6 | pass | Selected `tools/workbench-server.mjs`; entrypoint is 1131 lines after extracting requirement plan, auto-advance, reviewer, and workflow-evidence routes/services; all new extraction modules are below 300 lines. Focused server/API/state gates passed 91/91. Final gates passed: `npm test` 995/995, large-file gate with no warnings, full closeout, and diff whitespace check. | DeepSeek PASS |
| LFA-P7 | pass | Selected `src/workflow/headless-cli-orchestrator.js`; runtime file is 1136 lines after extracting child-worker prompt, process-hardening, snapshot publisher, projected workbench client, and projected next-action execution modules, all below 300 lines and registered in the manifest. Focused headless/scheduler/projection gates passed 111/111 after adding snapshot rollback, dirty-state failure, and loop continuation evidence. Final gates passed: `npm test` 998/998, large-file gate with no warnings, full closeout, and diff whitespace check. | DeepSeek PASS after delta |
| LFA-P8 | pass | Selected `test/headless-cli-orchestrator.test.js`; root suite is 1071 lines after extracting shared headless CLI fixtures and three CLI process/service shards, all under 300 lines. Split parity passed 40/40 with no missing, added, or duplicate tests. Final gates passed: focused tests 111/111, `npm test` 998/998, large-file gate, diff whitespace check, and full closeout. | DeepSeek PASS after delta |
| LFA-P9 | pass | Selected `test/workbench-server.test.js`; root suite is 1363 lines after extracting CLI bootstrap/state-db/port validation and project-status continuation next-action shards, both under 300 lines. Split parity passed 21/21 with no missing, added, or duplicate tests. Final gates passed: focused server/API/state tests 91/91, `npm test` 998/998, large-file gate, diff whitespace check, and full closeout. | DeepSeek PASS after delta/final consistency |
| LFA-P10 | pass | Selected `test/frontend-acceptance.test.js`; root suite is 577 lines after extracting shared fixtures plus copy/content, diagnostic content, project-management semantics, and command-architecture shards, all under 300 lines. Split parity passed 36/36 with no missing, added, or duplicate tests. Final gates passed: focused frontend acceptance tests 36/36, `npm test` 998/998, large-file gate, diff whitespace check, and full closeout. | DeepSeek PASS |
| LFA-P11 | pass | Selected `tools/retired-workbench-frontend-acceptance.mjs`; deleted the 1596-line retired legacy-static runner after moving still-used artifact builder exports into bounded helper modules under 300 lines. Parity artifact proved old/new artifact and option behavior matched, focused frontend acceptance/Next wiring/legacy retirement tests passed 43/43, `npm test` passed 998/998, large-file gate and full closeout passed. | DeepSeek PASS after delta |
| LFA-P12 | pass | Selected `test/workbench-projection.test.js`; root suite is 1025 lines after extracting scheduler dispatch/continuation/policy and scheduler loop/resume coverage into two shards under 300 lines. Split parity passed 25/25 with no missing, added, or duplicate tests. Final gates passed: focused projection tests 70/70, `npm test` 998/998, large-file gate, diff whitespace check, and full closeout. | DeepSeek PASS after delta |
| LFA-P13 | pass | Selected `test/workbench-server.test.js`; root suite is 1092 lines after extracting requirement submission, pending plan generation, and failed plan retry/close coverage into a 286-line shard. Split parity passed 17/17 with no missing, added, or duplicate tests. Focused server/API/state tests passed 91/91. Final gates passed: `npm test` 998/998, large-file gate, diff whitespace check, and full closeout. DeepSeek initial fail was repaired by adding the shard's independent manifest entry; delta review passed. | DeepSeek PASS after delta |
| LFA-P14 | pass | Selected `test/autonomous-continuation.test.js`; root suite is 840 lines after extracting global-goal lifecycle and governance/frontend-repair continuation coverage into 257-line and 294-line shards. Split parity passed 37/37 with no missing, added, or duplicate tests. Focused autonomous continuation tests passed 37/37. Final gates passed: `npm test` 998/998, large-file gate, diff whitespace check, and full closeout. | DeepSeek PASS |
| LFA-P15 | pass | Selected `src/workflow/requirement-intake.js`; root runtime module is 987 lines after extracting 124-line plan generation and 276-line plan granularity helpers. Compatibility artifact records public exports and focused runtime gates passed 49/49. Closeout-runner prose verdict parsing was tightened after final gate discovery, with 13/13 focused tests passing. Full gates passed: `npm test` 1001/1001, `npm run check:large-files`, `git diff --check`, and `npm run check:closeout`. | DeepSeek PASS; DeepSeek delta PASS |
| LFA-P16 | pass | Selected `test/context-work-package-runner.test.js`; root suite is 801 lines after extracting a 244-line execution-guards shard and 212-line shared fixture helper. Split parity passed 24/24 with no missing, added, or duplicate tests. Focused context-work-package runner tests passed 24/24. Final gates passed: `npm test` 1001/1001, `npm run check:large-files`, `git diff --check`, JSON parsing, and full closeout. | DeepSeek PASS |
| LFA-P17 | pass | Selected `src/workflow/headless-cli-orchestrator.js`; root entrypoint is 27 lines after extracting five bounded modules, all below 500 lines. Public export compatibility artifact is written, focused gates passed 88/88, large-file gate passes with remaining planned-refactor targets tightened below 500, DeepSeek delta review returned PASS after evidence-gap repair, and final closeout passed. | DeepSeek PASS after delta |
| LFA-P18 | pass | Selected `src/workflow/context-work-package-runner.js`; root entrypoint is 472 lines after extracting four bounded modules, all below 500 lines. Public export compatibility artifact is written, focused gates passed 109/109, large-file gate passes after manifest refresh, DeepSeek review returned PASS, and final gates passed: `npm test` 1001/1001, `npm run check:large-files`, `git diff --check`, JSON parsing, and full closeout. | DeepSeek PASS |
| LFA-P19 | pass | Selected `tools/workbench-server.mjs`; root entrypoint is 408 lines after extracting state/projection access, scheduler helpers, context routes, and context work-package routes into four bounded modules under 500 lines. RouteContext dependencies and structured diagnostics are covered by static API contract and runtime 409 assertions. Focused gates passed 129/129, `npm test` passed 1002/1002, `npm run check:large-files` passed, JSON parsing and `git diff --check` passed, and full closeout passed. DeepSeek plan review and code/doc review both passed after delta repairs. | DeepSeek PASS after plan and code deltas |
| LFA-P20 | pass | Selected `test/workbench-server.test.js`; root is now 160 lines after moving whole test blocks into bounded domain shards for requirement plan retry, plan review, background dispatch, provider execution, requirement closeout, and provider defaults. P20 split parity records 14 before / 14 after tests with no missing, added, or duplicate names. Final gates passed: focused P20 tests 14/14, expanded server/API tests 87/87, `npm test` 1002/1002, `npm run check:large-files`, JSON parsing, `git diff --check`, standalone browser-events 15 scenarios after clearing a leftover temporary Next process, and full `npm run check:closeout`. | DeepSeek plan PASS after delta; DeepSeek code PASS |
| LFA-P21 | pass | Selected `test/headless-cli-orchestrator.test.js`; root is now 209 lines after moving whole test blocks into five bounded shards for child acceptance/output-path, child provider/prompt, loop persistence, loop projection, and hardening/parser/no-diff. P21 split parity records 33 before / 33 after tests with no missing, added, or duplicate names; final gates passed: `npm test` 1002/1002, `npm run check:large-files`, JSON parsing, split parity validation, `git diff --check`, and full `npm run check:closeout`. | DeepSeek plan PASS after delta; DeepSeek code PASS |
| LFA-P22 | pass | Selected `test/workbench-projection.test.js` at 1025 lines. Root is now 395 lines after moving whole test blocks into bounded reviewer recovery, reviewer aggregate, operations timeline, and operator events shards. P22 split parity records 19 before / 19 after tests with no missing, added, or duplicate names. Final gates passed: `npm test` 1002/1002, `npm run check:large-files`, JSON parsing, split parity validation, `git diff --check`, and full `npm run check:closeout`. | DeepSeek plan PASS; code review PASS |

## Daily Run Shape

Each future scheduled run must:

1. Run the anti-abuse large-file gate before selecting a reduction target.
2. Reject changes that raise manifest ceilings or total large-file debt.
3. Select at most one planned-refactor target unless an explicit multi-file extraction risk exists.
4. State the target file, base line count, required reduction, and terminal threshold before editing.
5. Treat sub-target progress as `in_progress`, not `pass`.
6. Run local gates and DeepSeek review before merge.
7. Clean the worktree only after merge/push and, if runtime-facing, publish verification.
