"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  ProjectionResponse,
  ProjectionHistoryResponse
} from "@/lib/api/projection";
import {
  fetchCurrentProjection,
  fetchProjectionHistory
} from "@/lib/api/projection";

/** useProjection 的可选配置。 */
export interface UseProjectionOptions {
  /** 自动轮询间隔（毫秒），0 或 undefined 表示不轮询。默认 5000。 */
  pollIntervalMs?: number;
  /** 是否在挂载时立即拉取。默认 true。 */
  immediate?: boolean;
}

/** useProjection 的返回值。 */
export interface UseProjectionResult {
  projection: ProjectionResponse | null;
  loading: boolean;
  error: Error | null;
  refresh: () => void;
}

/**
 * useProjection —— 获取一屏 workbench projection 的 React hook。
 *
 * - 基于 `fetchCurrentProjection()` 封装，内置 loading / error / refresh 态。
 * - 支持可选自动轮询，适用于工作台首页的一屏状态刷新。
 * - 组件卸载时自动清除轮询 timer。
 */
export function useProjection(
  options: UseProjectionOptions = {}
): UseProjectionResult {
  const { pollIntervalMs = 5000, immediate = true } = options;
  const [projection, setProjection] = useState<ProjectionResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchCurrentProjection()
      .then((data) => {
        if (mountedRef.current) {
          setProjection(data);
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
    if (immediate) {
      refresh();
    }
    return () => {
      mountedRef.current = false;
    };
  }, [refresh, immediate]);

  useEffect(() => {
    if (!pollIntervalMs || pollIntervalMs <= 0) return;
    const id = setInterval(refresh, pollIntervalMs);
    return () => clearInterval(id);
  }, [refresh, pollIntervalMs]);

  return { projection, loading, error, refresh };
}

/** useProjectionHistory 的返回值。 */
export interface UseProjectionHistoryResult {
  history: ProjectionHistoryResponse | null;
  loading: boolean;
  error: Error | null;
  refresh: () => void;
}

/**
 * useProjectionHistory —— 获取 projection 历史列表的 React hook。
 */
export function useProjectionHistory(
  options: { immediate?: boolean } = {}
): UseProjectionHistoryResult {
  const { immediate = true } = options;
  const [history, setHistory] = useState<ProjectionHistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchProjectionHistory()
      .then((data) => {
        if (mountedRef.current) {
          setHistory(data);
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

  return { history, loading, error, refresh };
}
