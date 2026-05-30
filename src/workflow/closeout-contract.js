// Canonical closeout/gate result contract.
//
// The workflow has ONE dominant gate-result shape — { status: "pass"|"fail", issues: [] }
// — used by closeout-runner, reviewer gates, state-store publish, and ~300 other sites.
// A few modules historically returned the same idea under different keys (`reasons`,
// `failures`, `errors`) or as a bare boolean/string. This module is the single definition
// of the contract plus a normalizer, so any gate output can be coerced to the canonical
// shape at an aggregation boundary without each caller re-implementing the mapping.
//
// NOTE: `blockers` is intentionally NOT folded in here. In this codebase `blockers` is a
// distinct RUN/GOAL-level escalation concept (drives hard-exit and continuation decisions
// in autonomous-continuation / live-route-acceptance), not a gate's pass/fail detail list.
// Keep the two separate; see status-vocabulary.js for the parallel "don't over-merge"
// rule on status synonyms.

import { FAIL_SYNONYMS, normalizeToken } from "./status-vocabulary.js";

const FAIL_SET = new Set(FAIL_SYNONYMS);

function asList(value) {
  if (Array.isArray(value)) return value.filter((entry) => entry != null && entry !== "");
  if (value == null || value === "") return [];
  return [value];
}

// Coerce any gate-ish result into { status: "pass"|"fail", issues: string[] }.
// Rules (fail-closed): explicit fail-synonym status => fail; any issues present => fail;
// a bare false / "fail" => fail; otherwise pass. Issue lists are read from the common key
// aliases (issues|reasons|failures|errors|blocked_reasons) and flattened to strings.
export function toCloseoutResult(result) {
  if (result === true) return { status: "pass", issues: [] };
  if (result === false) return { status: "fail", issues: ["unspecified closeout failure"] };

  if (result == null || typeof result !== "object") {
    const token = normalizeToken(result);
    if (!token) return { status: "pass", issues: [] };
    return FAIL_SET.has(token) ? { status: "fail", issues: [String(result)] } : { status: "pass", issues: [] };
  }

  const issues = [
    ...asList(result.issues),
    ...asList(result.reasons),
    ...asList(result.failures),
    ...asList(result.errors),
    ...asList(result.blocked_reasons)
  ].map((entry) => (typeof entry === "string" ? entry : entry?.message || entry?.code || JSON.stringify(entry)));

  const statusToken = normalizeToken(result.status || result.result || result.outcome);
  const failedByStatus = FAIL_SET.has(statusToken);
  const status = failedByStatus || issues.length > 0 ? "fail" : "pass";
  return { status, issues };
}

// True iff every provided gate result is pass under the canonical contract.
export function allClosed(...results) {
  return results.flat().every((result) => toCloseoutResult(result).status === "pass");
}

// Aggregate many gate results into one canonical result (union of issues, fail if any fail).
export function aggregateCloseout(results = []) {
  const issues = [];
  let status = "pass";
  for (const result of asList(results)) {
    const normalized = toCloseoutResult(result);
    if (normalized.status === "fail") status = "fail";
    issues.push(...normalized.issues);
  }
  return { status, issues };
}
