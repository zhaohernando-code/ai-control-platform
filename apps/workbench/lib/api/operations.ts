import { fetchWorkbenchJson } from "./index";
import type { ProjectionResponse } from "./projection";

export interface WorkbenchMutationResponse {
  status?: string;
  projection?: ProjectionResponse;
  current_projection?: ProjectionResponse;
  item?: { id?: string };
  next_item?: { id?: string };
  result?: {
    item?: { id?: string };
    next_item?: { id?: string };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function withProjection(path: string, projectionId?: string | null): string {
  if (!projectionId) return path;
  return `${path}?id=${encodeURIComponent(projectionId)}`;
}

export function projectionFromMutation(payload: WorkbenchMutationResponse): ProjectionResponse | null {
  return payload.projection || payload.current_projection || null;
}

export function nextProjectionIdFromMutation(payload: WorkbenchMutationResponse): string | null {
  return payload.result?.next_item?.id ||
    payload.result?.item?.id ||
    payload.next_item?.id ||
    payload.item?.id ||
    null;
}

export function recordOperatorEvent(input: Record<string, unknown>): Promise<WorkbenchMutationResponse> {
  return fetchWorkbenchJson<WorkbenchMutationResponse>("/api/workbench/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
}

export function recordProviderHealth(input: Record<string, unknown>): Promise<WorkbenchMutationResponse> {
  return fetchWorkbenchJson<WorkbenchMutationResponse>("/api/workbench/reviewer-provider-health", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
}

export function runSchedulerDispatch(input: Record<string, unknown>): Promise<WorkbenchMutationResponse> {
  return fetchWorkbenchJson<WorkbenchMutationResponse>("/api/workbench/scheduler-dispatch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
}

export function runAutonomousSchedulerLoop(
  projectionId: string | null,
  input: Record<string, unknown>
): Promise<WorkbenchMutationResponse> {
  return fetchWorkbenchJson<WorkbenchMutationResponse>(
    withProjection("/api/workbench/autonomous-scheduler-loop", projectionId),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    }
  );
}

export function resumeAutonomousSchedulerLoop(
  projectionId: string | null,
  input: Record<string, unknown>
): Promise<WorkbenchMutationResponse> {
  return fetchWorkbenchJson<WorkbenchMutationResponse>(
    withProjection("/api/workbench/autonomous-scheduler-loop-resume", projectionId),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    }
  );
}

export function runNextAction(
  projectionId: string | null,
  input: Record<string, unknown>
): Promise<WorkbenchMutationResponse> {
  return fetchWorkbenchJson<WorkbenchMutationResponse>(
    withProjection("/api/workbench/next-action", projectionId),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    }
  );
}
