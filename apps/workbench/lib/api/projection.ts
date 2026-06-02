import { fetchWorkbenchJson } from "./index";

/**
 * Projection API 客户端薄封装。
 *
 * 真实字段类型在后续切片中按 `src/workflow/workbench-projection.js`
 * 与 `tools/check-workbench-projection.mjs` 的 schema 同步收敛；
 * 骨架阶段保留 `unknown` 以避免重复定义未稳定的契约。
 */
export interface ProjectionResponse {
  projection_id?: string;
  generated_at?: string;
  [key: string]: unknown;
}

export interface ProjectionHistoryItem {
  id: string;
  generated_at?: string;
  source?: string;
  projection_path?: string;
  input_path?: string;
}

export interface ProjectionHistoryResponse {
  items?: ProjectionHistoryItem[];
  latest?: string | null;
}

/**
 * Snapshot（projection-ready workflow state）响应类型。
 */
export interface SnapshotResponse {
  snapshot_id?: string;
  created_at?: string;
  [key: string]: unknown;
}

/**
 * Events 账本单条事件。
 */
export interface WorkbenchEvent {
  id?: string;
  type?: string;
  timestamp?: string;
  [key: string]: unknown;
}

export interface EventsResponse {
  events?: WorkbenchEvent[];
  count?: number;
}

export function fetchCurrentProjection(init?: RequestInit): Promise<ProjectionResponse> {
  return fetchWorkbenchJson<ProjectionResponse>("/api/workbench/projection", init);
}

export function fetchProjectionHistory(init?: RequestInit): Promise<ProjectionHistoryResponse> {
  return fetchWorkbenchJson<ProjectionHistoryResponse>("/api/workbench/projections", init);
}

export function fetchSnapshot(id: string): Promise<SnapshotResponse> {
  return fetchWorkbenchJson<SnapshotResponse>(`/api/workbench/snapshot?id=${encodeURIComponent(id)}`);
}

export function fetchEvents(): Promise<EventsResponse> {
  return fetchWorkbenchJson<EventsResponse>("/api/workbench/events");
}
