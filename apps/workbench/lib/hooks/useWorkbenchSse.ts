"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ProjectionResponse, WorkbenchEvent } from "@/lib/api/projection";
import { fetchCurrentProjection, fetchEvents } from "@/lib/api/projection";

/** SSE 连接状态。 */
export type SseConnectionState = "connecting" | "connected" | "disconnected" | "error";

/** 单次 SSE/轮询载荷。 */
export interface SsePayload {
  type: "projection" | "events";
  projection?: ProjectionResponse | null;
  events?: WorkbenchEvent[] | null;
  timestamp: string;
}

/** useWorkbenchSse 的可选配置。 */
export interface UseWorkbenchSseOptions {
  /** 轮询间隔（毫秒），默认 5000。<= 0 禁止轮询。 */
  pollIntervalMs?: number;
  /** 是否在挂载时立即连接。默认 true。 */
  immediate?: boolean;
  /**
   * 订阅模式：
   * - "projection"：仅轮询 projection（默认）。
   * - "events"：仅轮询 events 账本。
   * - "both"：同时轮询二者。
   */
  mode?: "projection" | "events" | "both";
}

/** useWorkbenchSse 的返回值。 */
export interface UseWorkbenchSseResult {
  /** 最近一次拉取的完整 payload。 */
  payload: SsePayload | null;
  /** 连接状态。 */
  connectionState: SseConnectionState;
  /** 最后一次错误。 */
  error: Error | null;
  /** 手动重连/刷新。 */
  reconnect: () => void;
}

/**
 * useWorkbenchSse —— Projection / Events 订阅 hook（轮询实现，SSE-ready）。
 *
 * 当前实现使用轮询（HTTP GET），但接口预留 `connectionState` 与 `reconnect`，
 * 未来后端升级到真正的 SSE（`text/event-stream`）时只需替换内部实现，
 * 使用者无需改调用代码。
 *
 * - 组件卸载时自动停止轮询。
 * - 错误时自动进入 "error" 态，调用 `reconnect()` 后重新开始轮询。
 */
export function useWorkbenchSse(
  options: UseWorkbenchSseOptions = {}
): UseWorkbenchSseResult {
  const { pollIntervalMs = 5000, immediate = true, mode = "projection" } = options;
  const [payload, setPayload] = useState<SsePayload | null>(null);
  const [connectionState, setConnectionState] = useState<SseConnectionState>(
    immediate ? "connecting" : "disconnected"
  );
  const [error, setError] = useState<Error | null>(null);
  const mountedRef = useRef(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeRef = useRef(false);

  const fetchPayload = useCallback(() => {
    if (!mountedRef.current) return;

    const fetches: Array<Promise<void>> = [];
    let newProjection: ProjectionResponse | null | undefined;
    let newEvents: WorkbenchEvent[] | null | undefined;

    if (mode === "projection" || mode === "both") {
      fetches.push(
        fetchCurrentProjection()
          .then((data) => {
            newProjection = data;
          })
          .catch(() => {
            newProjection = null;
          })
      );
    }

    if (mode === "events" || mode === "both") {
      fetches.push(
        fetchEvents()
          .then((data) => {
            newEvents = data.events ?? null;
          })
          .catch(() => {
            newEvents = null;
          })
      );
    }

    Promise.allSettled(fetches).then((results) => {
      if (!mountedRef.current) return;
      const allOk = results.every((r) => r.status === "fulfilled");
      if (allOk) {
        setConnectionState("connected");
        setError(null);
      } else {
        setConnectionState("error");
        const firstErr = results.find(
          (r): r is PromiseRejectedResult => r.status === "rejected"
        );
        if (firstErr) {
          setError(firstErr.reason instanceof Error ? firstErr.reason : new Error(String(firstErr.reason)));
        }
      }

      setPayload({
        type: mode === "events" ? "events" : "projection",
        projection: newProjection,
        events: newEvents,
        timestamp: new Date().toISOString()
      });
    });
  }, [mode]);

  const startPolling = useCallback(() => {
    if (pollIntervalMs <= 0 || !mountedRef.current) return;
    activeRef.current = true;
    setConnectionState("connecting");
    setError(null);
    fetchPayload();
    intervalRef.current = setInterval(() => {
      if (mountedRef.current && activeRef.current) {
        fetchPayload();
      }
    }, pollIntervalMs);
  }, [pollIntervalMs, fetchPayload]);

  const stopPolling = useCallback(() => {
    activeRef.current = false;
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const reconnect = useCallback(() => {
    stopPolling();
    startPolling();
  }, [stopPolling, startPolling]);

  useEffect(() => {
    mountedRef.current = true;
    if (immediate) {
      startPolling();
    }
    return () => {
      mountedRef.current = false;
      stopPolling();
    };
  }, [immediate, startPolling, stopPolling]);

  return { payload, connectionState, error, reconnect };
}

/**
 * useWorkbenchEvents —— 仅拉取事件账本的单次 hooks。
 * 作为 useWorkbenchSse 的轻量替代，不支持自动轮询。
 */
export function useWorkbenchEvents(options: { immediate?: boolean } = {}) {
  const { immediate = true } = options;
  const [events, setEvents] = useState<WorkbenchEvent[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchEvents()
      .then((data) => {
        if (mountedRef.current) {
          setEvents(data.events ?? null);
          setLoading(false);
        }
      })
      .catch((err: Error) => {
        if (mountedRef.current) {
          setError(err);
          setLoading(false);
        }
      });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    if (immediate) refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh, immediate]);

  return { events, loading, error, refresh };
}
