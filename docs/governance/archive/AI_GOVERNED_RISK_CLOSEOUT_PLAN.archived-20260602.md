# AI Governed Risk Closeout Implementation Plan

Status: archived
Archived at: 2026-06-02T15:18:00+08:00
Archive index: `docs/governance/AI_GOVERNED_RISK_CLOSEOUT_PLAN.md`

## Delivery Model

This plan is intentionally phased. Each phase must be independently reviewable and must have explicit acceptance gates. Later phases may not claim completion for earlier phases unless the listed gates pass.

Every future phase-level deliverable must receive a read-only DeepSeek review before merge or acceptance. If DeepSeek is unavailable or inconclusive, the phase must stop with an explicit blocker rather than proceed as accepted.

P6 is a dry-run/preflight entrypoint only. Its `pass` result means "preflight completed", not "known risks closed". The seven seeded open risks must not be remediated by the scheduled runner until P7 or an equivalent write-mode orchestrator contract is implemented and reviewed.

## Phase P0: Governance Documents and Schemas

| ID | Work item | Deliverable | Acceptance |
| --- | --- | --- | --- |
| P0.1 | Define requirements | `AI_GOVERNED_RISK_CLOSEOUT_REQUIREMENTS.md` | Every requirement has a stable ID. |
| P0.2 | Define implementation plan | `AI_GOVERNED_RISK_CLOSEOUT_PLAN.md` | Each phase has work items and acceptance gates. |
| P0.3 | Define ledger schema | `known-risk-ledger.schema.json` | Example/current ledger is valid JSON and matches required fields by inspection. |
| P0.4 | Define policy schema | `ai-governed-risk-closeout-policy.schema.json` | Example policy is valid JSON and covers merge/publish/review limits. |
| P0.5 | Seed known risks | `known-risk-ledger.json` | Current known risks are recorded as `open`, not lost in chat history. |

Suggested verification:

```bash
node -e 'for (const f of process.argv.slice(1)) JSON.parse(require("fs").readFileSync(f, "utf8"))' \
  docs/governance/known-risk-ledger.json \
  docs/governance/known-risk-ledger.schema.json \
  docs/governance/ai-governed-risk-closeout-policy.schema.json \
  docs/governance/ai-governed-risk-closeout-policy.example.json
```

## Phase P1: Ledger Library and Gate

| ID | Work item | Deliverable | Acceptance |
| --- | --- | --- | --- |
| P1.1 | Ledger read/normalize helpers | `tools/risk-ledger.mjs` | Unit tests cover valid and invalid ledgers. |
| P1.2 | Closeout gate | `tools/check-known-risk-closeout.mjs` | Gate fails on open risks when closeout-required mode is enabled. |
| P1.3 | Terminal evidence checks | tests | Gate fails for `fixed` without commit, `invalidated` without evidence, `deferred` without SLA, `blocked` without recovery conditions. |
| P1.4 | Dependency graph checks | tests | Gate fails on cyclic `depends_on`. |
| P1.5 | npm script | `package.json` | `npm run check:known-risk-closeout` runs through `tools/run-with-node18.mjs`. |

## Phase P2: Skill Contract

| ID | Work item | Deliverable | Acceptance |
| --- | --- | --- | --- |
| P2.1 | Add `ai-governed-risk-closeout` skill | Codex skill directory | Skill describes single-run workflow and hard constraints. |
| P2.2 | Worktree and lock rules | skill docs | Skill requires isolated worktree and run lock before writes. |
| P2.3 | Role separation | skill docs | Skill forbids repair agent self-verification. |
| P2.4 | Output contract | skill docs | Final output includes per-risk terminal table and run artifact path. |

## Phase P3: Independent AI Review

| ID | Work item | Deliverable | Acceptance |
| --- | --- | --- | --- |
| P3.1 | Reviewer artifact schema | `docs/governance/ai-reviewer-verdict.schema.json` | Reviewer results are machine-readable. |
| P3.2 | DeepSeek/Claude review adapter | `tools/known-risk-reviewer-prompt.mjs` plus skill integration | Read-only reviewer can review diff and evidence. |
| P3.3 | Blocking finding handling | gate tests | Any blocking finding prevents `fixed` closeout. |
| P3.4 | Two-model policy | policy + tests | High-risk scopes require two independent reviewer passes. |

Suggested verification:

```bash
node tools/run-with-node18.mjs --test test/known-risk-ledger.test.js test/known-risk-reviewer-prompt.test.js
npm run check:known-risk-closeout
npm run check:known-risk-closeout:required
```

`check:known-risk-closeout:required` is expected to fail while seeded ledger risks remain `open`.

## Phase P4: Policy-Based Merge and Publish Controller

| ID | Work item | Deliverable | Acceptance |
| --- | --- | --- | --- |
| P4.1 | Policy loader | tool module | Invalid policy fails closed. |
| P4.2 | Merge eligibility checker | tests | Severity, path, and reviewer requirements are enforced. |
| P4.3 | Publish eligibility checker | tests | User-visible changes require live verification policy. |
| P4.4 | Owner authorization state | ledger support | Out-of-policy risks become `requires_owner_authorization`, not silently merged. |

Suggested verification:

```bash
node tools/run-with-node18.mjs --test test/risk-closeout-policy.test.js
```

## Phase P5: Recovery, Locking, and Cleanup

| ID | Work item | Deliverable | Acceptance |
| --- | --- | --- | --- |
| P5.1 | Run lock | tool module | Concurrent runs are rejected. |
| P5.2 | Stale run detection | tool module | Stale `in_progress` risks can be resumed or marked blocked. |
| P5.3 | Orphan worktree scan | script | Old closeout worktrees are reported before new work starts. |
| P5.4 | Cleanup rules | script/tests | Successful runs clean temp worktrees; failed runs preserve evidence. |

Suggested verification:

```bash
node tools/run-with-node18.mjs --test test/risk-closeout-recovery.test.js
node tools/run-with-node18.mjs tools/scan-risk-closeout-worktrees.mjs
```

## Phase P6: Scheduled Single-Run Entry

| ID | Work item | Deliverable | Acceptance |
| --- | --- | --- | --- |
| P6.1 | CLI entry | script | Can run in dry-run mode without writes. |
| P6.2 | Bounded run mode | script | Can limit max risks per run. |
| P6.3 | Run artifact | JSON artifact | Contains run id, risks attempted, gates, reviewers, release decision, cleanup status. |
| P6.4 | Scheduling docs | docs | Documents how to invoke from a timer without interactive chat. |
| P6.5 | Dry-run wording hardening | runner/docs | Dry-run artifacts cannot be mistaken for terminal closeout success. |

Suggested verification:

```bash
node tools/run-with-node18.mjs --test test/known-risk-closeout-runner.test.js
npm run run:known-risk-closeout -- --max-risks 2
```

## Phase P7: Write-Mode Orchestrator Contract

This phase is mandatory before using the scheduled runner to remediate the seven seeded open risks.

| ID | Work item | Deliverable | Acceptance |
| --- | --- | --- | --- |
| P7.1 | Repair agent interface | contract + tests | Selected risks move to `in_progress` only inside an isolated worktree and owned-file scope. |
| P7.2 | Evidence agent interface | contract + tests | Each selected risk's `acceptance_gates` run with command, exit code, and artifact evidence. |
| P7.3 | Reviewer handoff | contract + tests | Reviewer prompts include risk, diff, evidence, and terminal claim; blocking findings stop closeout. |
| P7.4 | Ledger transition engine | tool module + tests | `open -> in_progress -> fixed/invalidated/deferred/blocked/requires_owner_authorization` transitions are explicit and auditable. |
| P7.5 | Write-mode runner guard | script/tests | `--write` is rejected until P7 passes; dry-run cannot mutate ledger, locks, branches, or worktrees. |
| P7.6 | Per-phase DeepSeek gate | process + artifact | Every subsequent phase records a DeepSeek verdict before merge. |

Suggested verification:

```bash
node tools/run-with-node18.mjs --test test/risk-closeout-orchestrator-contract.test.js test/known-risk-closeout-runner.test.js
node tools/run-with-node18.mjs tools/run-known-risk-closeout.mjs --write
python3 /Users/hernando_zhao/.codex/skills/claude-deepseek-review/scripts/run_claude_deepseek_review.py \
  --cwd /Users/hernando_zhao/codex/projects/ai-control-platform \
  --bounded-review \
  --tools Read \
  --prompt-file /tmp/phase-review.md
```

## Current Seed Risks

The initial ledger records these known risks for future closeout:

1. `risk-20260601-npm-test-node-wrapper`
2. `risk-20260601-workbench-server-route-boundary`
3. `risk-20260601-workbench-projection-boundary`
4. `risk-20260601-workbench-api-error-diagnostics`
5. `risk-20260601-code-review-coverage-denominator`
6. `risk-20260601-playwright-cli-artifact-cleanliness`
7. `risk-20260601-use-projection-request-order`

## Acceptance Tracking Template

```text
ID:
Requirement or work item:
Implementation files:
Verification command:
Expected result:
Actual result:
Status: pending | pass | fail | blocked
Evidence:
Reviewer verdict:
```
