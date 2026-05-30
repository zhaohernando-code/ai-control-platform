// Child/parent acceptance-gate classification, extracted from headless-cli-orchestrator.js
// (P2-8 god-file split #4). Decides which acceptance gates a dispatched child worker owns
// vs which stay parent-owned, and attaches them to a work package. Pure; depends only on
// local array/string normalization.

function asArray(value) {
  return Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : value === null || value === undefined ? "" : String(value).trim();
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compactStrings(value) {
  return asArray(value).map(normalizeString).filter(Boolean);
}

export function selectedChildAcceptanceGates(workPackage = {}, contextPack = {}, options = {}) {
  const packageGates = compactStrings(workPackage.acceptance_gates || workPackage.acceptanceGates);
  const sourceGates = compactStrings(workPackage.source?.acceptance_gates || workPackage.source?.acceptanceGates);
  const optionGates = compactStrings(options.acceptance_gates || options.acceptanceGates);
  const contextGates = compactStrings(contextPack.acceptance_gates || contextPack.acceptanceGates);
  const focused = [...new Set([...packageGates, ...sourceGates])];
  return splitChildAcceptanceGates(focused.length > 0 ? focused : [...new Set([...optionGates, ...contextGates])]).child_gates;
}

export function isParentOwnedAcceptanceGate(gate = "") {
  const normalized = normalizeString(gate).toLowerCase();
  if (
    normalized === "npm run check:closeout" ||
    normalized.includes("check-closeout.mjs") ||
    normalized.includes("mainline release readiness") ||
    normalized.includes("mainline-release-readiness")
  ) {
    return true;
  }
  // Human/manual gates and live-environment verifications are not executable
  // by an isolated headless worker. They must be deferred to the parent
  // orchestrator (or human operator) so the worker does not self-evaluate as
  // failed just because it cannot run a manual checklist.
  const raw = normalizeString(gate);
  if (/真实浏览器|verify\s+技能|verify技能|live\s+route|publish|release|手动|人工|人工走查|发布链路|发布演练|可回滚/i.test(raw)) {
    return true;
  }
  // Free-form 中文 statements that describe an outcome the worker cannot
  // self-assert (e.g. "现状盘点清单经用户/评审确认" or "完成已审核实施步骤 N：…")
  // are also parent/operator-owned.
  if (/经用户.*确认|经评审.*确认|用户\/评审|完成已审核实施步骤|合入\s*main|合入主线/.test(raw)) {
    return true;
  }
  return false;
}

export function splitChildAcceptanceGates(gates = []) {
  const uniqueGates = [...new Set(compactStrings(gates))];
  return {
    child_gates: uniqueGates.filter((gate) => !isParentOwnedAcceptanceGate(gate)),
    parent_gates: uniqueGates.filter(isParentOwnedAcceptanceGate)
  };
}

export function selectedParentAcceptanceGates(workPackage = {}, contextPack = {}, options = {}) {
  const packageGates = compactStrings(workPackage.acceptance_gates || workPackage.acceptanceGates);
  const sourceGates = compactStrings(workPackage.source?.acceptance_gates || workPackage.source?.acceptanceGates);
  const optionGates = compactStrings(options.acceptance_gates || options.acceptanceGates);
  const contextGates = compactStrings(contextPack.acceptance_gates || contextPack.acceptanceGates);
  const focused = [...new Set([...packageGates, ...sourceGates])];
  return splitChildAcceptanceGates(focused.length > 0 ? focused : [...new Set([...optionGates, ...contextGates])]).parent_gates;
}

export function withAcceptanceGates(workPackage = {}, acceptanceGates = []) {
  return {
    ...workPackage,
    acceptance_gates: acceptanceGates,
    source: isObject(workPackage.source)
      ? {
          ...workPackage.source,
          acceptance_gates: acceptanceGates
        }
      : workPackage.source
  };
}
