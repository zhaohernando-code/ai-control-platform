// Single source for resolving timeout values from input/profile/default, with explicit
// units. Many modules repeated `input.x || input.xCamel || profile.x || ... || default`
// with subtly different fallback orders; this centralizes the precedence (input wins over
// profile wins over default) and makes the unit unambiguous at the call site.
//
// UNIT CONVENTION (the audit asked for one place documenting this):
//   *_ms      values are MILLISECONDS (CLI invocation, locks, health pings, cleanup)
//   *_seconds values are SECONDS (provider / reviewer LLM runs; convert with * 1000
//             only at the spawn boundary, which the executors already do)
// These timeouts are DOMAIN-DISTINCT (a 15s health ping vs a 7200s provider run) and must
// NOT be unified to one value — only the resolution PATTERN is unified here.

function firstFinite(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return undefined;
}

// Resolve a millisecond timeout: input (snake|camel) -> profile (snake|camel) -> fallback.
export function resolveMs(input = {}, profile = {}, key = "timeout", fallbackMs = 0) {
  const snake = `${key}_ms`;
  const camel = `${key}Ms`;
  const value = firstFinite(input?.[snake], input?.[camel], profile?.[snake], profile?.[camel]);
  return value === undefined ? Number(fallbackMs) : value;
}

// Resolve a seconds timeout: input (snake|camel) -> profile (snake|camel) -> fallback.
export function resolveSeconds(input = {}, profile = {}, key = "timeout", fallbackSeconds = 0) {
  const snake = `${key}_seconds`;
  const camel = `${key}Seconds`;
  const value = firstFinite(input?.[snake], input?.[camel], profile?.[snake], profile?.[camel]);
  return value === undefined ? Number(fallbackSeconds) : value;
}

// A key lock must OUTLIVE the invocation it guards — otherwise the lock can expire while
// the agent is still running (the exact class of bug the lock-leak fix addressed). So the
// lock TTL is max(invocation hard timeout + grace, floor), never shorter than the run.
export function lockTtlMsFor(invocationTimeoutMs, { graceMs = 60000, floorMs = 10 * 60 * 1000 } = {}) {
  const base = Number.isFinite(Number(invocationTimeoutMs)) ? Number(invocationTimeoutMs) + graceMs : 0;
  return Math.max(base, floorMs);
}
