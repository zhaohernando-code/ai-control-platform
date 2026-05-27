/**
 * Workbench React hooks — 公共数据基础设施。
 *
 * 本文件为 `apps/workbench/lib/hooks/` 的统一出口。
 * 所有 workbench 页面应通过此 barrel 引用 hooks，
 * 不得直接从子模块导入，以方便未来重构 hook 内部实现。
 */
export {
  useProjection,
  useProjectionHistory
} from "./useProjection";
export type {
  UseProjectionOptions,
  UseProjectionResult,
  UseProjectionHistoryResult
} from "./useProjection";

export { useSnapshot } from "./useSnapshot";
export type { UseSnapshotResult } from "./useSnapshot";

export {
  useWorkbenchSse,
  useWorkbenchEvents
} from "./useWorkbenchSse";
export type {
  SseConnectionState,
  SsePayload,
  UseWorkbenchSseOptions,
  UseWorkbenchSseResult
} from "./useWorkbenchSse";
