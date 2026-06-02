# AI Governed Risk Closeout Skill Contract

## Purpose

This contract records the P2 skill-level requirements for the user-level Codex skill `ai-governed-risk-closeout`.

The skill exists at:

```text
/Users/hernando_zhao/.codex/skills/ai-governed-risk-closeout/SKILL.md
```

The skill is intentionally outside this repository so future Codex sessions and timer-triggered agents can discover it as a reusable operating procedure. This repository keeps the contract so the behavior can be audited alongside the ledger, policy, and closeout gate.

## Trigger Contract

The skill must be used when Codex is asked to:

- close known risks from `known-risk-ledger.json`
- run scheduled or single-run AI risk closeout
- repair ledger-recorded risks without human code review
- enforce multi-model review, evidence, policy gates, rollback, or worktree cleanup
- operate `check-known-risk-closeout`

## Required Inputs

The skill requires the agent to read:

1. `docs/governance/known-risk-ledger.json`
2. `docs/governance/AI_GOVERNED_RISK_CLOSEOUT_REQUIREMENTS.md`
3. `docs/governance/AI_GOVERNED_RISK_CLOSEOUT_PLAN.md` as the archived plan index, plus the archive artifact it names when historical phase details are needed
4. the active risk closeout policy, defaulting to `docs/governance/ai-governed-risk-closeout-policy.example.json`
5. `docs/governance/ai-reviewer-verdict.schema.json`
6. `tools/check-known-risk-closeout.mjs`, `tools/risk-ledger.mjs`, `tools/known-risk-reviewer-prompt.mjs`, `tools/risk-closeout-recovery.mjs`, `tools/scan-risk-closeout-worktrees.mjs`, `tools/risk-closeout-orchestrator-contract.mjs`, and `tools/run-known-risk-closeout.mjs` when implementation details matter
7. `docs/governance/AI_GOVERNED_RISK_CLOSEOUT_SCHEDULING.md` when setting up timer-triggered runs

## Hard Rules

- The repair run must use an isolated task worktree.
- Scheduled unattended runs must use a run-level lock before ledger or branch mutation.
- The repair agent cannot be the sole verifier for `fixed`.
- Newly discovered risks must be added to the ledger with `source: "closeout-discovery"`.
- Risks must not be removed, downgraded, or deferred merely to satisfy a gate.
- Owner questions must ask for risk or business authorization, not code-detail review.
- Auto-merge and auto-publish are forbidden unless policy permits them and all gates pass.
- Every future phase-level deliverable for this capability must receive a read-only DeepSeek review before merge or acceptance.
- The dry-run scheduled entrypoint is preflight only. It must not be described as having remediated or closed selected risks.
- `tools/run-known-risk-closeout.mjs --write` must be rejected before reading the ledger, acquiring locks, creating branches, or touching worktrees until the write-mode orchestrator is explicitly implemented and DeepSeek-reviewed.

## Workflow Contract

The skill workflow must include these steps:

1. Establish risk ids and dependency order.
2. Prepare isolated worktree and run lock.
3. Repair only selected risks within `owned_files`, or record scope expansion.
4. Run risk acceptance gates and repository gates.
5. Obtain read-only independent reviewer verdicts for non-trivial code changes.
6. Write terminal status evidence for `fixed`, `invalidated`, `deferred`, `blocked`, or `requires_owner_authorization`.
7. Merge/publish only when policy, gates, reviewers, and rollback conditions permit.
8. Preserve run artifacts, clean worktrees, and release locks.

Reviewer prompts may be generated with:

```bash
node tools/run-with-node18.mjs tools/known-risk-reviewer-prompt.mjs --risk-id <risk-id>
```

Reviewer output must conform to `docs/governance/ai-reviewer-verdict.schema.json` before being copied into the ledger.

Closeout recovery state and candidate stale worktrees may be inspected with:

```bash
node tools/run-with-node18.mjs tools/scan-risk-closeout-worktrees.mjs
```

The dry-run scheduled entrypoint is:

```bash
npm run run:known-risk-closeout -- --max-risks 2
```

This command can prove only that scheduling preflight completed. It cannot move a risk to `fixed`, merge, publish, or satisfy terminal closeout evidence until P7 write-mode orchestration exists.

The write-mode guard must be verified with:

```bash
node tools/run-with-node18.mjs tools/run-known-risk-closeout.mjs --write
```

Expected result: non-zero exit with `mode: "write_mode_rejected"` and no ledger, lock, branch, or worktree mutation.

## Final Output Contract

Each run must end with a table containing:

| field | meaning |
| --- | --- |
| risk id | ledger id |
| final status | terminal or authorization status |
| commit | repair commit when applicable |
| gates | pass/fail gate summary |
| reviewer | independent reviewer summary |
| publish/live | runtime verification status when applicable |
| notes | blocker, deferral, or authorization notes |

The final response must also report:

- branch or commit pushed
- whether policy authorization is required
- whether new risks were added
- whether worktrees and locks were cleaned

## P2 Acceptance

| ID | Requirement | Verification |
| --- | --- | --- |
| P2.1 | User-level skill exists | `test -f /Users/hernando_zhao/.codex/skills/ai-governed-risk-closeout/SKILL.md` |
| P2.2 | Skill validates | `python3 /Users/hernando_zhao/.codex/skills/.system/skill-creator/scripts/quick_validate.py /Users/hernando_zhao/.codex/skills/ai-governed-risk-closeout` |
| P2.3 | Skill declares trigger contexts in frontmatter | inspect `description` in `SKILL.md` |
| P2.4 | Skill requires worktree isolation and run lock | inspect `Hard Rules` and `Workflow` in `SKILL.md` |
| P2.5 | Skill forbids repair-agent self-verification | inspect `Hard Rules` and `Independent Review` in `SKILL.md` |
| P2.6 | Skill defines final output contract | inspect `Final Response Contract` in `SKILL.md` |

## P7 Acceptance

| ID | Requirement | Verification |
| --- | --- | --- |
| P7.1 | Repair contract enforces isolated worktree and owned scope | `node tools/run-with-node18.mjs --test test/risk-closeout-orchestrator-contract.test.js` |
| P7.2 | Evidence contract requires every acceptance gate command to pass | `node tools/run-with-node18.mjs --test test/risk-closeout-orchestrator-contract.test.js` |
| P7.3 | Reviewer handoff requires risk, diff, evidence refs, changed files, and terminal claim | `node tools/run-with-node18.mjs --test test/risk-closeout-orchestrator-contract.test.js` |
| P7.4 | Ledger transition composes repair/evidence/reviewer contracts | `node tools/run-with-node18.mjs --test test/risk-closeout-orchestrator-contract.test.js` |
| P7.5 | Write mode is rejected before mutation | `node tools/run-with-node18.mjs --test test/known-risk-closeout-runner.test.js` |
| P7.6 | DeepSeek phase gate blocks non-pass or blocking findings | `node tools/run-with-node18.mjs --test test/risk-closeout-orchestrator-contract.test.js` |
