"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { SnapshotResponse } from "@/lib/api/projection";
import { fetchSnapshot } from "@/lib/api/projection";

/** useSnapshot 的返回值。 */
export interface UseSnapshotResult {
  snapshot: SnapshotResponse | null;
  loading: boolean;
  error: Error | null;
  refresh: () => void;
}

/**
 * useSnapshot —— 获取指定 snapshot 的 projection-ready workflow state。
 *
 * - 使用 `fetchSnapshot(id)` 从 `/api/workbench/snapshot?id=<id>` 拉取。
 * - 传入空 id 时不发起请求，返回 loading=false / snapshot=null。
 * - 支持手动 refresh，用于操作员切换历史 snapshot 查看。
 */
export function useSnapshot(id: string | undefined): UseSnapshotResult {
  const [snapshot, setSnapshot] = useState<SnapshotResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(() => {
    if (!id) {
      setSnapshot(null);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    fetchSnapshot(id)
      .then((data) => {
        if (mountedRef.current) {
          setSnapshot(data);
          setLoading(false);
        }
      })
      .catch((err: Error) => {
        if (mountedRef.current) {
          setError(err);
          setLoading(false);
        }
      });
  }, [id]);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  return { snapshot, loading, error, refresh };
}
