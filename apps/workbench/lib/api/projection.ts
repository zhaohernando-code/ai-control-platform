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

export function fetchCurrentProjection(): Promise<ProjectionResponse> {
  return fetchWorkbenchJson<ProjectionResponse>("/api/workbench/projection");
}

export function fetchProjectionHistory(): Promise<ProjectionHistoryResponse> {
  return fetchWorkbenchJson<ProjectionHistoryResponse>("/api/workbench/projections");
}
