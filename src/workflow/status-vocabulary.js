// Single source of truth for task/run status vocabulary.
//
// Historically the synonym sets were copy-defined in BOTH task-dag.js and
// autonomous-run.js, and they DRIFTED (different members, different output tokens).
// This module centralizes the raw synonym sets so there is one place to edit. It does
// NOT unify the two output vocabularies — those are intentionally different domains:
//   - task-dag.js maps to DAG lifecycle states: done | running | blocked | pending
//   - autonomous-run.js maps to run verdicts:    pass | fail | unknown
// Each consumer keeps its own mapping but builds it from these shared sets, so the
// members stay in sync even though the output labels differ. See the characterization
// tests (task-dag-status-characterization, autonomous-run-status-characterization)
// which pin the exact current behavior this module must preserve.

// Success/terminal-pass synonyms. NOTE: task-dag additionally treats "done" as success;
// autonomous-run historically does NOT (a documented divergence). "done" is therefore
// NOT in this shared set — task-dag adds it locally — so this extraction preserves both
// behaviors exactly. Do not add "done" here without updating both characterization nets.
export const PASS_SYNONYMS = ["pass", "passed", "ok", "success", "succeeded", "complete", "completed"];

// Failure synonyms. task-dag also folds these into "blocked"; autonomous-run folds them
// into "fail". "blocked" itself is a member (autonomous-run counts a blocked item as a
// failure; task-dag's own output label is also "blocked").
export const FAIL_SYNONYMS = ["fail", "failed", "error", "errored", "blocked", "timeout", "timed_out"];

// Running/in-flight synonyms (used by task-dag's lifecycle mapping).
export const RUNNING_SYNONYMS = ["running", "active", "in_progress", "in-progress"];

// Pending/not-started synonyms (used by task-dag's lifecycle mapping).
export const PENDING_SYNONYMS = ["pending", "queued", "ready", "todo"];

// Review-FINDING verdict vocabulary. Deliberately NARROWER than PASS/FAIL_SYNONYMS:
// a finding has no "completed/timeout" lifecycle, and an unknown finding status
// defaults to "fail" (fail-closed for review gates). Shared verbatim by
// process-hardening.js and llm-reviewer-gate.js (previously byte-identical copies).
// Do NOT merge into PASS/FAIL_SYNONYMS — the membership and fallback differ on purpose.
export const FINDING_PASS_SYNONYMS = ["pass", "passed", "ok", "success", "succeeded"];
export const FINDING_FAIL_SYNONYMS = ["fail", "failed", "error", "blocked"];

export function normalizeToken(value) {
  return String(value || "").trim().toLowerCase();
}
