# AI Governed Risk Closeout Requirements

## Purpose

This document defines the governance requirements for a scheduled, single-run AI process that closes known risks. The goal is not perfect risk discovery. The goal is to ensure that every risk already discovered and recorded is either fixed, invalidated, deferred with a bounded plan, blocked with recoverable conditions, or escalated for owner authorization.

The process assumes that the human owner may not be able to review implementation details across all technical stacks. Trust must therefore come from role separation, machine gates, independent AI review, durable evidence, and rollback-capable release controls.

## Non Goals

- It does not guarantee discovery of all unknown risks.
- It does not rely on a human reading code diffs line by line.
- It does not allow a natural-language summary to close a risk.
- It does not allow the same agent that repairs a risk to be the only authority that verifies it.
- It does not grant automatic live publish rights unless policy explicitly allows them.

## Terms

- **Known risk**: A risk recorded in `docs/governance/known-risk-ledger.json`.
- **Risk closeout run**: One scheduled or manual invocation of the AI-governed closeout process.
- **Repair agent**: The agent that changes files to address a risk.
- **Evidence agent**: The agent or deterministic runner that executes tests, builds, coverage checks, live checks, and records evidence.
- **Skeptic reviewer**: A read-only independent model reviewer that looks for false fixes, weak evidence, hidden regressions, and scope drift.
- **Release controller**: The role that decides whether a repaired branch can be merged, published, rolled back, or left for authorization based only on policy, gates, and evidence.

## Requirements

### Risk Ledger

- **AGR-R001**: Every discovered risk that is not immediately proven invalid must be written to `docs/governance/known-risk-ledger.json`.
- **AGR-R002**: A risk entry must have a stable `id`, `title`, `source`, `created_at`, `updated_at`, `status`, `severity`, `scope`, `owned_files`, and `acceptance_gates`.
- **AGR-R003**: Valid statuses are `open`, `in_progress`, `fixed`, `invalidated`, `deferred`, `blocked`, and `requires_owner_authorization`.
- **AGR-R004**: A closeout run must not drop a risk from the ledger. Superseded risks must be linked through `superseded_by` and keep their resolution evidence.
- **AGR-R005**: A risk may only move to a terminal status when its terminal-status evidence requirements are satisfied.
- **AGR-R006**: A risk discovered during closeout must be appended to the ledger with `source: "closeout-discovery"` before the run can report success.
- **AGR-R007**: Risk dependencies in `depends_on` must form an acyclic graph.

### Terminal Status Rules

- **AGR-T001**: `fixed` requires `resolution.fixed_by_commit`, at least one verification command or live check, and a reviewer result unless policy explicitly marks the risk as documentation-only.
- **AGR-T002**: `fixed` for user-visible runtime, public route, edge proxy, LaunchAgent, or live service changes requires live verification evidence.
- **AGR-T003**: `invalidated` requires evidence explaining why the original risk is not applicable or has already been resolved.
- **AGR-T004**: `deferred` requires `deferred_until`, `deferral_reason`, `priority`, and future `acceptance_gates`.
- **AGR-T005**: `deferred` may not be used for `critical` risks unless policy explicitly permits owner authorization.
- **AGR-T006**: `blocked` requires a concrete blocker, blocker owner or external condition, recovery conditions, and `last_condition_check`.
- **AGR-T007**: `requires_owner_authorization` must ask only for business or risk-policy authorization. It must not ask the owner to review code details.

### AI Role Separation

- **AGR-A001**: The repair agent may modify code and docs only inside an isolated task worktree.
- **AGR-A002**: The repair agent must not be the sole authority that marks a risk `fixed`.
- **AGR-A003**: The evidence agent must record command, exit code, relevant output summary, and artifact paths.
- **AGR-A004**: The skeptic reviewer must be read-only and must receive the diff, risk entry, tests, and evidence. It must not rely on the repair agent's summary alone.
- **AGR-A005**: High-risk scopes configured by policy require at least two independent model reviewer passes.
- **AGR-A006**: Blocking reviewer findings must prevent merge, publish, and terminal `fixed` status.
- **AGR-A007**: Every future phase-level deliverable for this closeout capability must receive a read-only DeepSeek reviewer pass before it is merged or treated as accepted.

### Policy and Authorization

- **AGR-P001**: Automatic merge and publish are controlled by `docs/governance/ai-governed-risk-closeout-policy.example.json` or an equivalent runtime policy file.
- **AGR-P002**: The policy must define whether automatic merge and automatic publish are allowed.
- **AGR-P003**: The policy must define maximum severity allowed for automatic merge.
- **AGR-P004**: The policy must define path and scope limits for automated repair.
- **AGR-P005**: The policy must define when two-model review is required.
- **AGR-P006**: If a run exceeds policy, it must stop with `requires_owner_authorization`.

### Gates and Evidence

- **AGR-G001**: `check-known-risk-closeout` must fail on schema-invalid ledger entries.
- **AGR-G002**: `check-known-risk-closeout` must fail if a risk is terminal without required evidence.
- **AGR-G003**: `check-known-risk-closeout` must fail if a `deferred` risk is past `deferred_until`.
- **AGR-G004**: `check-known-risk-closeout` must fail if dependency cycles exist.
- **AGR-G005**: The closeout run must preserve raw verification evidence or a durable artifact that points to it.
- **AGR-G006**: The closeout run must include a machine-readable run artifact with risk ids, attempted actions, gates, reviewer verdicts, release decision, and cleanup status.
- **AGR-G007**: A dry-run or preflight artifact must not use language that implies risk closeout completion. It must distinguish ledger structure validation from terminal closeout validation.
- **AGR-G008**: Actual risk remediation must execute each selected risk's `acceptance_gates` and record command-level evidence before a risk can become `fixed`.

### Concurrency, Recovery, and Cleanup

- **AGR-C001**: Only one AI-governed risk closeout run may operate on the ledger at a time.
- **AGR-C002**: A run must acquire a lock before modifying the ledger or creating repair branches.
- **AGR-C003**: Stale `in_progress` risks must be recoverable by a later run using `last_agent_run_id` and worktree status.
- **AGR-C004**: The run must detect orphaned worktrees created by prior closeout runs.
- **AGR-C005**: Successful runs must clean their temporary worktrees after merge or after preserving required failure evidence.
- **AGR-C006**: Failed runs must leave enough evidence for a future run to resume or for the owner to inspect the failure.

### Release and Rollback

- **AGR-L001**: Automatic merge is allowed only when policy permits it and all gates pass.
- **AGR-L002**: Automatic publish is allowed only when policy permits it and publish/liveness checks pass.
- **AGR-L003**: User-visible runtime changes must have a rollback commit or rollback procedure recorded before publish is marked successful.
- **AGR-L004**: Live verification failure after publish must either roll back automatically when policy permits or mark the run `blocked` with recovery conditions.

## Acceptance Checklist

Each requirement above is accepted with this format:

```text
ID:
Requirement:
Implementation files:
Verification command:
Expected result:
Status: pending | pass | fail | blocked
Evidence:
```
