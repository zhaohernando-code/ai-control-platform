// P2-10: PROJECT_STATUS.json should be DURABLE INTENT, not a runtime log.
//
// PROJECT_STATUS.json historically churned ~185 commits because it mixed two things:
//   - DURABLE intent a human/agent deliberately edits (goals, phase, blockers, next steps)
//   - DERIVED runtime evidence re-stamped every run (live-route probes, timestamps,
//     browser-evidence, capture times) — noise that should live with the run artifacts,
//     not in the committed intent file.
//
// This module declares the split and provides a pure separator so writers can persist only
// the durable subset to PROJECT_STATUS.json and route the derived subset to the run/
// evidence ledger. It does NOT itself do I/O — callers decide where each half goes.

// Fields that are runtime-DERIVED evidence/telemetry. These should NOT be committed into
// PROJECT_STATUS.json; they belong with the run manifest / artifact ledger (or a separate
// evidence file) and are reproducible from a run.
export const DERIVED_STATUS_FIELDS = Object.freeze([
  "updated_at",
  "latest_update",
  "agent_module_live_route_evidence",
  "workbench_live_route_evidence",
  "latest_public_live_route_probe",
  "latest_public_live_route_browser_evidence"
]);

// Fields that are DURABLE intent — the legitimate, human-meaningful contents of
// PROJECT_STATUS.json. (Anything not listed as derived is treated as durable by default,
// so new intent fields are kept; this list documents the expected set.)
export const DURABLE_STATUS_FIELDS = Object.freeze([
  "project",
  "status",
  "current_phase",
  "current_milestone",
  "progress_summary",
  "blockers",
  "global_goals",
  "next_step",
  "next_work_packages",
  "requirement_intake",
  "plan_reviews",
  "linked_docs",
  "references",
  "restoration_note",
  "project_wide_child_worker_scope"
]);

const DERIVED_SET = new Set(DERIVED_STATUS_FIELDS);

// Split a project_status object into { durable, derived }. Pure; does not mutate input.
// Default policy: a key is derived ONLY if it is in DERIVED_SET; everything else is durable
// (fail-safe — unknown/new fields are preserved as intent, never silently dropped).
export function separateProjectStatus(projectStatus = {}) {
  const durable = {};
  const derived = {};
  for (const [key, value] of Object.entries(projectStatus || {})) {
    if (DERIVED_SET.has(key)) derived[key] = value;
    else durable[key] = value;
  }
  return { durable, derived };
}

// The durable view that SHOULD be committed to PROJECT_STATUS.json.
export function durableProjectStatus(projectStatus = {}) {
  return separateProjectStatus(projectStatus).durable;
}

// True if a project_status object still carries derived/runtime fields that ought to be
// stripped before committing — used by governance/closeout to flag log-style churn.
export function hasDerivedStatusFields(projectStatus = {}) {
  return Object.keys(projectStatus || {}).some((key) => DERIVED_SET.has(key));
}
