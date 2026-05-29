// Single source of truth for task/run status vocabulary.
//
// Historically the synonym sets were copy-defined across many modules and DRIFTED
// (different members, different output tokens), which is the audit's root cause A.
// This module centralizes the raw synonym sets so there is one place to edit. It does
// NOT unify the OUTPUT vocabularies — those are intentionally different domains:
//   - task-dag.js maps to DAG lifecycle states: done | running | blocked | pending
//   - autonomous-run.js maps to run verdicts:    pass | fail | unknown
// Each consumer keeps its own mapping but builds it from these shared sets, so the
// members stay in sync even though the output labels differ. Arrays are frozen so a
// stray mutation in one importer cannot silently poison every other consumer.
// Behavior is pinned by the characterization nets (task-dag-status-characterization,
// autonomous-run-status-characterization) and the golden membership test
// (status-vocabulary.test.js) — any edit here must break those tests, on purpose.

// Terminal-pass / success synonyms (NOT including "done").
export const PASS_SYNONYMS = Object.freeze(["pass", "passed", "ok", "success", "succeeded", "complete", "completed"]);

// "Completed work item" vocabulary = PASS_SYNONYMS plus "done" (task-dag's success label).
// Use this where the question is "is this work item finished/succeeded", e.g. the
// scheduler's autonomous-run verdict and task-dag's DONE mapping. Centralizing it fixed a
// real drift bug: autonomous-run previously used PASS_SYNONYMS (no "done") and so re-ran
// completed ("done") work packages, while task-dag and the completion modules treated
// "done" as finished. See the autonomous-run characterization net.
export const COMPLETE_SYNONYMS = Object.freeze([...PASS_SYNONYMS, "done"]);

// "Work item complete" = COMPLETE_SYNONYMS plus the lifecycle terminals a WORK PACKAGE can
// carry beyond a pass verdict: it was accepted, or its requirement was closed. Used by the
// continuation/dispatch/context-pack modules that ask "is this work package finished".
// Deriving from COMPLETE_SYNONYMS (not a hand-typed list) keeps ok/success/succeeded/done
// in sync — those were silently dropped by the old inline copies, which made e.g. a
// "succeeded" package look incomplete to continuation while autonomous-run saw it done.
export const WORK_ITEM_COMPLETE_SYNONYMS = Object.freeze([...COMPLETE_SYNONYMS, "accepted", "closed"]);

// "Goal complete" = WORK_ITEM_COMPLETE_SYNONYMS plus GOAL-only terminals: a goal that was
// closed_failed / canceled / shipped is terminal for completion purposes even though it is
// not a pass. Broader than work-item terminality on purpose; do not use for pass/fail.
export const GOAL_COMPLETE_SYNONYMS = Object.freeze([...WORK_ITEM_COMPLETE_SYNONYMS, "closed_failed", "canceled", "cancelled", "shipped"]);

// Failure synonyms. task-dag folds these into "blocked"; autonomous-run folds them into
// "fail". "blocked" itself is a member.
export const FAIL_SYNONYMS = Object.freeze(["fail", "failed", "error", "errored", "blocked", "timeout", "timed_out"]);

// Running/in-flight synonyms (used by task-dag's lifecycle mapping).
export const RUNNING_SYNONYMS = Object.freeze(["running", "active", "in_progress", "in-progress"]);

// Pending/not-started synonyms (used by task-dag's lifecycle mapping).
export const PENDING_SYNONYMS = Object.freeze(["pending", "queued", "ready", "todo"]);

// Review-FINDING verdict vocabulary. Deliberately NARROWER than PASS/FAIL_SYNONYMS:
// a finding has no "completed/timeout" lifecycle, and an unknown finding status
// defaults to "fail" (fail-closed for review gates). Shared verbatim by
// process-hardening.js and llm-reviewer-gate.js (previously byte-identical copies).
// Do NOT merge into PASS/FAIL_SYNONYMS — the membership and fallback differ on purpose.
export const FINDING_PASS_SYNONYMS = Object.freeze(["pass", "passed", "ok", "success", "succeeded"]);
export const FINDING_FAIL_SYNONYMS = Object.freeze(["fail", "failed", "error", "blocked"]);

export function normalizeToken(value) {
  return String(value || "").trim().toLowerCase();
}
