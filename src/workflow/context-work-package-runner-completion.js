import { asArray, normalizeString } from "./context-work-package-runner-shared.js";

export function adapterResultAllowsWorkPackageCompletion(adapterResult = {}) {
  return adapterResult?.allows_work_package_completion === true ||
    adapterResult?.completion_authority?.allows_work_package_completion === true;
}

export function packageResultAllowsWorkPackageCompletion(packageResult = {}, adapterResult = {}) {
  if (!adapterResultAllowsWorkPackageCompletion(adapterResult)) return false;
  return normalizeString(packageResult?.status).toLowerCase() === "pass" &&
    (
      packageResult?.allows_work_package_completion === true ||
      packageResult?.completion_authority?.allows_work_package_completion === true
    );
}

export function completionAuthorizedExecutionNodes(selected = [], packageResults = [], adapterResult = {}) {
  const authorizedIds = new Set(
    asArray(packageResults)
      .filter((result) => packageResultAllowsWorkPackageCompletion(result, adapterResult))
      .map((result) => normalizeString(result?.work_package_id || result?.id))
      .filter(Boolean)
  );
  return selected.filter((node) => authorizedIds.has(node.id));
}

