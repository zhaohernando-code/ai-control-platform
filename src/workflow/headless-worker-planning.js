export const HEADLESS_MAIN_ORCHESTRATOR_ROLE = "main_orchestrator";
export const CHILD_WORKER_ROLE = "child_worker";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeToken(value) {
  return normalizeString(value).toLowerCase();
}

function compactStrings(value) {
  return asArray(value).map(normalizeString).filter(Boolean);
}

function safeIdPart(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

export function headlessLifecyclePoolId(workflowState = {}, options = {}) {
  return normalizeString(options.pool_id || options.poolId) ||
    `headless-cli-${safeIdPart(workflowState?.manifest?.run_id)}-${safeIdPart(workflowState?.manifest?.cycle_id)}`;
}

export function headlessChildWorkerId(workPackage = {}, index = 0, options = {}) {
  return normalizeString(options.worker_id || options.workerId) ||
    `child-${safeIdPart(workPackage.id || workPackage.work_package_id || index + 1)}`;
}

export function selectHeadlessWorkPackages(workflowState = {}, options = {}) {
  const maxPackageCount = Math.max(1, Number(options.max_package_count || options.maxPackageCount || 1));
  return asArray(workflowState?.manifest?.work_packages)
    .filter((workPackage) => normalizeToken(workPackage?.status || "pending") !== "completed")
    .filter((workPackage) => workPackage?.dispatch_allowed !== false)
    .slice(0, maxPackageCount);
}

export function createHeadlessWorkerSpawnFacts(workflowState = {}, workPackages = [], options = {}) {
  const poolId = headlessLifecyclePoolId(workflowState, options);
  const createdAt = normalizeString(options.created_at || options.createdAt) || new Date().toISOString();
  return asArray(workPackages).flatMap((workPackage, index) => {
    const workerId = headlessChildWorkerId(workPackage, index, options);
    const baseSource = {
      orchestrator_role: HEADLESS_MAIN_ORCHESTRATOR_ROLE,
      worker_role: CHILD_WORKER_ROLE,
      work_package_id: workPackage.id || workPackage.work_package_id,
      owned_files: compactStrings(workPackage.owned_files),
      executor: normalizeString(options.executor_kind || options.executorKind) || "agent_or_cli_worker"
    };
    return [
      {
        event_type: "WorkerSpawned",
        pool_id: poolId,
        worker_id: workerId,
        status: "pass",
        message: `${workerId} spawned by headless CLI main orchestrator`,
        created_at: createdAt,
        source: baseSource
      },
      {
        event_type: "WorkerHeartbeat",
        pool_id: poolId,
        worker_id: workerId,
        status: "pass",
        message: `${workerId} heartbeat recorded before bounded execution`,
        created_at: createdAt,
        source: baseSource
      }
    ];
  });
}
