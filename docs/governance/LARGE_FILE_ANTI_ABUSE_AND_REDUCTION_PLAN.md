# Large File Anti-Abuse and Reduction Plan

Status: pass
Created at: 2026-06-03T09:45:00+08:00
Updated at: 2026-06-03T19:46:47+08:00
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
| Manifest entries | 41 |
| Files currently above 500 lines | 30 |
| `planned_refactor` files above 500 lines | 21 |
| `accepted` files above 500 lines | 9 |
| Manifest entries already below threshold | 6 |

Highest active reduction targets:

| Priority | File | Lines | Status | Required terminal direction |
| --- | --- | ---: | --- | --- |
| LFA-Q01 | `test/headless-cli-orchestrator.test.js` | 1745 | `planned_refactor` | Split by acceptance, provider, continuation, and projected-action fixtures until below 1200 lines. |
| LFA-Q02 | `test/workbench-server.test.js` | 1717 | `planned_refactor` | Continue splitting broad projection, CLI, requirement-intake, and continuation-flow tests until below 1400 lines. |
| LFA-Q03 | `test/frontend-acceptance.test.js` | 1670 | `planned_refactor` | Split content, layout, console, mounted route, favicon, and live-route false-pass coverage until below 1200 lines. |
| LFA-Q04 | `tools/retired-workbench-frontend-acceptance.mjs` | 1596 | `planned_refactor` | Shrink or delete the retired legacy acceptance script after replacement evidence remains durable. |
| LFA-Q05 | `test/workbench-projection.test.js` | 1434 | `planned_refactor` | Continue stable projection domain shards until below 1184 lines. |

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

## Daily Run Shape

Each future scheduled run must:

1. Run the anti-abuse large-file gate before selecting a reduction target.
2. Reject changes that raise manifest ceilings or total large-file debt.
3. Select at most one planned-refactor target unless an explicit multi-file extraction risk exists.
4. State the target file, base line count, required reduction, and terminal threshold before editing.
5. Treat sub-target progress as `in_progress`, not `pass`.
6. Run local gates and DeepSeek review before merge.
7. Clean the worktree only after merge/push and, if runtime-facing, publish verification.
